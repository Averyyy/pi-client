import type { Api, Model } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AuthStatus } from "../src/core/provider-composer.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import type { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import type { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
	this: object,
	searchTerm: string,
) => Promise<Model<Api> | undefined>;
const createBaseAutocompleteProvider = Reflect.get(InteractiveMode.prototype, "createBaseAutocompleteProvider") as (
	this: object,
) => AutocompleteProvider;
const updateAvailableProviderCount = Reflect.get(InteractiveMode.prototype, "updateAvailableProviderCount") as (
	this: object,
) => void;
const showOAuthSelector = Reflect.get(InteractiveMode.prototype, "showOAuthSelector") as (
	this: object,
	mode: "logout",
) => Promise<void>;
const showModelsSelector = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;

describe("interactive model availability", () => {
	let harness: Harness | undefined;
	const selectors: ModelSelectorComponent[] = [];

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		for (const selector of selectors.splice(0)) selector.dispose();
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses current availability and metadata for scoped commands, completions, and provider counts", async () => {
		harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
				{ id: "other", name: "Other" },
			],
		});
		const [one, two, other] = harness.models;
		const currentOne = { ...one, name: "Current One" };
		let available = [currentOne, other];
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => available);
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
		harness.session.setScopedModels([{ model: two }, { model: one }]);
		const setAvailableProviderCount = vi.fn();
		const context = {
			session: harness.session,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			skillCommands: new Map(),
			footerDataProvider: { setAvailableProviderCount },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		};
		const autocomplete = createBaseAutocompleteProvider.call(context);
		const line = "/model ";
		const suggestions = () =>
			autocomplete.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

		expect(await findExactModelMatch.call(context, one.id)).toBe(currentOne);
		expect(await findExactModelMatch.call(context, two.id)).toBeUndefined();
		expect((await suggestions())?.items.map((item) => item.value)).toEqual([`${one.provider}/${one.id}`]);
		updateAvailableProviderCount.call(context);
		expect(setAvailableProviderCount).toHaveBeenLastCalledWith(1);

		available = [other];
		expect(await findExactModelMatch.call(context, one.id)).toBeUndefined();
		expect(await suggestions()).toBeNull();
		updateAvailableProviderCount.call(context);
		expect(setAvailableProviderCount).toHaveBeenLastCalledWith(0);
		expect(refresh).not.toHaveBeenCalled();
		expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual([two.id, one.id]);
	});

	it("keeps an unavailable scope empty and permits switching explicitly to all available models", async () => {
		harness = await createHarness({
			models: [
				{ id: "scoped", name: "Scoped" },
				{ id: "other", name: "Other" },
			],
		});
		const [scoped, other] = harness.models;
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([other]);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selected = vi.fn();
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			scoped,
			harness.session.modelRuntime,
			[{ model: scoped }],
			selected,
			() => {},
		);
		selectors.push(selector);
		await vi.waitFor(() => expect(stripAnsi(selector.render(100).join("\n"))).toContain("Model catalogs refreshed."));
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("No matching models");
		selector.handleInput("\r");
		expect(selected).not.toHaveBeenCalled();

		selector.handleInput("\t");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain(`${other.id} [`);
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("No matching models");
	});

	it("selects the current scoped model object after a catalog refresh", async () => {
		harness = await createHarness({ models: [{ id: "scoped", name: "Old Name" }] });
		const stale = harness.models[0];
		const current = { ...stale, name: "Current Name", contextWindow: stale.contextWindow * 2 };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([current]);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selected = vi.fn();
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			stale,
			harness.session.modelRuntime,
			[{ model: stale }],
			selected,
			() => {},
		);
		selectors.push(selector);
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(current);
	});

	it.each(["none", "available subset", "available subset and other models"])(
		"preserves configured unavailable scope entries after /models refresh with %s available",
		async (availability) => {
			harness = await createHarness({
				models: [
					{ id: "one", name: "One" },
					{ id: "two", name: "Two" },
					{ id: "other", name: "Other" },
				],
			});
			const [one, two, other] = harness.models;
			harness.session.setScopedModels([{ model: two }, { model: one }]);
			const available =
				availability === "none" ? [other] : availability === "available subset" ? [one] : [one, other];
			vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(available);
			vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
			let selector: ScopedModelsSelectorComponent | undefined;
			let dispose: (() => void) | undefined;
			const context = {
				session: harness.session,
				settingsManager: harness.settingsManager,
				showStatus: vi.fn(),
				updateAvailableProviderCount: vi.fn(),
				ui: { requestRender: vi.fn() },
				showSelector: (
					factory: (done: () => void) => { component: ScopedModelsSelectorComponent; dispose?: () => void },
				) => {
					const created = factory(() => {});
					selector = created.component;
					dispose = created.dispose;
				},
			};
			showModelsSelector.call(context);
			const scopedSelector = selector;
			if (!scopedSelector) throw new Error("Expected scoped-model selector");
			try {
				await vi.waitFor(() =>
					expect(stripAnsi(scopedSelector.render(100).join("\n"))).toContain("Model catalogs refreshed."),
				);
				expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual([two.id, one.id]);
				expect(stripAnsi(scopedSelector.render(100).join("\n"))).toContain(
					`${two.provider}/${two.id} [unavailable]`,
				);
			} finally {
				dispose?.();
			}
		},
	);

	it("cycles with current scoped metadata and preserves the configured thinking level", async () => {
		harness = await createHarness({
			models: [
				{ id: "one", name: "One", reasoning: true },
				{ id: "two", name: "Two", reasoning: true },
				{ id: "unavailable", name: "Unavailable", reasoning: true },
			],
		});
		const [one, two, unavailable] = harness.models;
		const currentTwo = { ...two, name: "Current Two", contextWindow: two.contextWindow * 2 };
		const snapshot = vi
			.spyOn(harness.session.modelRuntime, "getAvailableSnapshot")
			.mockReturnValue([one, currentTwo]);
		harness.session.setScopedModels([{ model: one }, { model: unavailable }, { model: two, thinkingLevel: "high" }]);
		await harness.session.setModel(one);

		const result = await harness.session.cycleModel();
		expect(result?.model).toBe(currentTwo);
		expect(result?.thinkingLevel).toBe("high");
		expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual([one.id, unavailable.id, two.id]);
		snapshot.mockReturnValue([]);
		await expect(harness.session.cycleModel()).resolves.toBeUndefined();
	});
});

describe("logout availability feedback", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => vi.unstubAllEnvs());

	const cases: Array<{
		name: string;
		status: AuthStatus;
		configured: boolean;
		remote?: boolean;
		expected?: string;
	}> = [
		{
			name: "environment",
			status: { configured: true, source: "environment", label: "HF_TOKEN" },
			configured: true,
			expected: "environment (HF_TOKEN)",
		},
		{
			name: "runtime API key",
			status: { configured: true, source: "runtime" },
			configured: true,
			expected: "a runtime API key",
		},
		{
			name: "models.json API key",
			status: { configured: true, source: "models_json_key" },
			configured: true,
			expected: "models.json configuration",
		},
		{
			name: "models.json command",
			status: { configured: true, source: "models_json_command" },
			configured: true,
			expected: "a models.json credential command",
		},
		{
			name: "extension",
			status: { configured: true, source: "fallback" },
			configured: true,
			expected: "extension configuration",
		},
		{
			name: "client environment in pi-server mode",
			status: { configured: true, source: "environment", label: "HF_TOKEN" },
			configured: true,
			remote: true,
			expected: "environment (HF_TOKEN)",
		},
		{ name: "no remaining authentication", status: { configured: false }, configured: false },
	];

	it.each(cases)(
		"reports $name after removing a stored credential",
		async ({ status, configured, remote, expected }) => {
			vi.stubEnv("PI_SERVER_MODE", remote ? "true" : "false");
			let selector: OAuthSelectorComponent | undefined;
			const logout = vi.fn().mockResolvedValue(undefined);
			const context = {
				session: {
					modelRuntime: { logout, hasConfiguredAuth: () => configured, getProviderAuthStatus: () => status },
				},
				getLogoutProviderOptions: async () => [
					{ id: "huggingface", name: "Hugging Face", authType: "api_key" as const },
				],
				updateAvailableProviderCount: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				showSelector: (factory: (done: () => void) => { component: OAuthSelectorComponent }) => {
					selector = factory(() => {}).component;
				},
			};
			await showOAuthSelector.call(context, "logout");
			if (!selector) throw new Error("Expected logout selector");
			selector.handleInput("\r");
			const action = "Removed stored API key for Hugging Face";
			await vi.waitFor(() =>
				expect(context.showStatus).toHaveBeenCalledWith(
					expected ? `${action}. Models remain available through ${expected}.` : action,
				),
			);
			expect(context.showError).not.toHaveBeenCalled();
			expect(context.updateAvailableProviderCount).toHaveBeenCalledOnce();
			expect(logout).toHaveBeenCalledWith("huggingface", { signal: expect.any(AbortSignal) });
		},
	);
});
