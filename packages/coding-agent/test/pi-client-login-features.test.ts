import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthInteraction, createProvider, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import { type Component, Container, setKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { RADIUS_MCP_URL } from "../src/core/radius.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import {
	type AuthSelectorProvider,
	OAuthSelectorComponent,
} from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

type Selector = { component: Component; dispose?: () => void };
type LoginMethods = {
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[];
	showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void;
	showLoginProviderSelector(authType?: "oauth" | "api_key", initialSearchInput?: string): void;
	showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
	handleReloadCommand(): Promise<void>;
};

const model: Model<"fixture"> = {
	id: "balanced",
	name: "Balanced",
	provider: "radius",
	api: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("pi-client interactive login features", () => {
	let dir: string;
	let selectors: Selector[];
	let currentSelector: Selector | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-login-features-"));
		selectors = [];
		currentSelector = undefined;
		setKeybindings(new KeybindingsManager());
		vi.stubEnv(ENV_AGENT_DIR, dir);
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("This UI fixture must not make network requests"));
	});
	afterEach(() => {
		for (const selector of selectors) selector.dispose?.();
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	function fixture(configured = false) {
		const credential: OAuthCredential = {
			type: "oauth",
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires: Date.now() + 3600000,
		};
		const login = vi.fn(async (interaction: AuthInteraction) => {
			await interaction.prompt({ type: "manual_code", message: "Paste fixture code:", signal: interaction.signal });
			configured = true;
			return credential;
		});
		const forbidden = (): never => {
			throw new Error("Login UI must not invoke inference");
		};
		const providers = [false, true].map((subscription) =>
			createProvider({
				id: subscription ? "subscription-fixture" : "radius",
				name: subscription ? "Subscription fixture" : "Radius",
				models: [],
				auth: {
					oauth: {
						name: subscription ? "Subscription" : "Radius account",
						isSubscription: subscription,
						login,
						refresh: async (stored) => stored,
						toAuth: async (stored) => ({ apiKey: stored.access }),
					},
					apiKey: { name: "Fixture API key", resolve: async () => undefined },
				},
				api: { stream: forbidden, streamSimple: forbidden },
			}),
		);
		const editor = new Text("fixture editor", 0, 0);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const reload = vi.fn(async (options: { beforeSessionStart: () => void }) => options.beforeSessionStart());
		const context = Object.defineProperties(Object.create(InteractiveMode.prototype), {
			session: { writable: true },
			sessionManager: { writable: true },
			settingsManager: { writable: true },
		}) as LoginMethods;
		const mode = Object.assign(context, {
			editor,
			editorContainer,
			ui: { requestRender: vi.fn(), setFocus: vi.fn() } as unknown as TUI,
			sessionManager: { getCwd: () => dir },
			settingsManager: {
				getOrCreateDeviceId: () => "fixture-device",
				getHideThinkingBlock: () => false,
				getOutputPad: () => 1,
			},
			session: {
				model,
				isStreaming: false,
				isCompacting: false,
				reload,
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				modelRuntime: {
					getProviders: () => providers,
					getProvider: (id: string) => providers.find((provider) => provider.id === id),
					getProviderAuthStatus: () => ({ configured, source: "stored", label: "stored credential" }),
					isUsingOAuth: () => configured,
					getAvailableSnapshot: () => [model],
					getError: () => undefined,
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
					login: vi.fn(async (_id: string, method: string, interaction: AuthInteraction) => {
						expect(method).toBe("oauth");
						return login(interaction);
					}),
				},
			},
			showSelector: (create: (done: () => void) => Selector) => {
				const selector = create(() => {
					selector.dispose?.();
					currentSelector = undefined;
				});
				selectors.push(selector);
				currentSelector = selector;
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			checkDaxnutsEasterEgg: vi.fn(),
			resetExtensionUI: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			keybindings: { reload: vi.fn() },
			applyRuntimeSettings: vi.fn(),
			themeController: { applyFromSettings: vi.fn() },
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			showLoadedResources: vi.fn(),
			maybeSaveImplicitProjectTrustAfterReload: () => false,
		});
		return { mode, login, reload, editorContainer };
	}

	function output(): string {
		if (!currentSelector) throw new Error("Expected an active selector");
		return stripAnsi(currentSelector.component.render(200).join("\n"));
	}

	function input(value: string): void {
		if (!currentSelector?.component.handleInput) throw new Error("Expected an input selector");
		currentSelector.component.handleInput(value);
	}

	it.each([false, true])("offers Radius last at the top level with configured=%s", (configured) => {
		const { mode } = fixture(configured);
		mode.showLoginAuthTypeSelector();
		const text = output();
		expect(text.indexOf("Sign in with an account")).toBeLessThan(text.indexOf("Sign in with an API key"));
		expect(text.indexOf("Sign in with an API key")).toBeLessThan(text.indexOf("Sign in with Radius"));
		expect(text).toContain(configured ? "✓ configured" : "not configured");
		input("j");
		input("j");
		expect(output()).toContain("→ Sign in with Radius");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it.each(["missing", "existing-oauth"])(
		"signs in, configures global provider auth, and reloads for %s MCP",
		async (existing) => {
			const mcpPath = join(dir, "mcp.json");
			if (existing === "existing-oauth") {
				writeFileSync(
					mcpPath,
					JSON.stringify({
						mcpServers: {
							"radius-account": {
								url: RADIUS_MCP_URL,
								oauth: { clientName: "fixture" },
								headers: { "X-Fixture": "kept" },
							},
							other: { command: "fixture-command" },
						},
					}),
				);
			}
			const { mode, login, reload, editorContainer } = fixture();
			mode.showLoginAuthTypeSelector();
			input("j");
			input("j");
			input("\n");
			const dialog = editorContainer.children[0];
			expect(dialog).toBeInstanceOf(LoginDialogComponent);
			if (!(dialog instanceof LoginDialogComponent)) throw new Error("Missing login dialog");
			dialog.handleInput("fixture-code");
			dialog.handleInput("\n");
			await vi.waitFor(() => expect(output()).toContain("Configure Radius MCP"));
			expect(login).toHaveBeenCalledTimes(1);
			input("\n");
			await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
			await vi.waitFor(() =>
				expect(mode.showStatus).toHaveBeenCalledWith(expect.stringContaining("Reloaded keybindings")),
			);
			const config = JSON.parse(readFileSync(mcpPath, "utf8")) as {
				mcpServers: Record<
					string,
					{
						url?: string;
						auth?: { provider: string };
						oauth?: unknown;
						headers?: Record<string, string>;
						command?: string;
					}
				>;
			};
			const name = existing === "existing-oauth" ? "radius-account" : "radius";
			expect(config.mcpServers[name]).toMatchObject({ url: RADIUS_MCP_URL, auth: { provider: "radius" } });
			expect(config.mcpServers[name]).not.toHaveProperty("oauth");
			if (existing === "existing-oauth") {
				expect(config.mcpServers[name].headers).toEqual({ "X-Fixture": "kept" });
				expect(config.mcpServers.other).toEqual({ command: "fixture-command" });
			}
			expect(mode.showError).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["top-level", "provider-search"])("cancels Radius login back to the originating %s menu", async (origin) => {
		const { mode, reload, editorContainer } = fixture();
		if (origin === "top-level") {
			mode.showLoginAuthTypeSelector();
			input("j");
			input("j");
		} else {
			mode.showLoginProviderSelector("oauth", "Radius");
		}
		input("\n");
		const dialog = editorContainer.children[0];
		if (!(dialog instanceof LoginDialogComponent)) throw new Error("Missing login dialog");
		dialog.handleInput("\x1b");
		await vi.waitFor(() =>
			expect(output()).toContain(
				origin === "top-level" ? "Select authentication method:" : "Select provider to configure:",
			),
		);
		if (origin === "provider-search") {
			expect(output()).toContain("Radius");
			expect(output()).not.toContain("Subscription fixture");
		}
		expect(reload).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "mcp.json"))).toBe(false);
		expect(mode.showError).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("labels Radius OAuth as an account and subscription-backed OAuth as a subscription", () => {
		const { mode } = fixture(true);
		const providers = mode.getLoginProviderOptions();
		const selector = new OAuthSelectorComponent(
			"login",
			providers,
			() => {},
			() => {},
		);
		const text = stripAnsi(selector.render(200).join("\n"));
		expect(text).toContain("Radius [account]");
		expect(text).toContain("Radius [API key] • account configured");
		expect(text).toContain("Subscription fixture [subscription]");
		expect(text).toContain("Subscription fixture [API key] • subscription configured");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
