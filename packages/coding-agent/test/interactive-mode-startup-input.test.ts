import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as crashLog from "../src/core/crash-log.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import * as versionCheck from "../src/utils/version-check.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type StartupRunContext = {
	init: () => Promise<void>;
	session: {
		model?: { provider: string; id: string; api: string };
		modelRuntime: Pick<ModelRuntime, "refresh" | "getError">;
	};
	options: InteractiveModeOptions;
	version: string;
	checkForPackageUpdates: () => Promise<string[]>;
	checkTmuxKeyboardSetup: () => Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	updateTerminalTitle: () => void;
	updateAvailableProviderCount: () => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	getUserInput: () => Promise<string>;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	run(this: StartupRunContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});

describe("InteractiveMode startup model catalog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function runStartup(
		refresh: () => Promise<ModelsRefreshResult>,
		catalogError?: string,
	): Promise<StartupRunContext> {
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.spyOn(versionCheck, "checkForNewPiVersion").mockResolvedValue(undefined);
		vi.spyOn(crashLog, "takeUnnotifiedCrash").mockReturnValue(undefined);
		const inputClosed = new Error("Input closed");
		const context: StartupRunContext = {
			init: async () => {},
			session: {
				model: { provider: "unknown", id: "unknown", api: "unknown" },
				modelRuntime: { refresh: vi.fn(refresh), getError: () => catalogError },
			},
			options: {},
			version: "1.0.0",
			checkForPackageUpdates: async () => [],
			checkTmuxKeyboardSetup: async () => undefined,
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			updateTerminalTitle: vi.fn(),
			updateAvailableProviderCount: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			getUserInput: async () => {
				throw inputClosed;
			},
		};
		await expect(interactiveModePrototype.run.call(context)).rejects.toBe(inputClosed);
		return context;
	}

	it("reports every failed client provider catalog", async () => {
		const context = await runStartup(async () => ({
			aborted: false,
			errors: new Map([
				["google-antigravity", new Error("503 Service Unavailable")],
				["devin", new Error("Account unavailable")],
			]),
		}));

		await vi.waitFor(() => expect(context.showWarning).toHaveBeenCalledTimes(2));
		expect(context.showWarning).toHaveBeenCalledWith(
			"Could not refresh google-antigravity model catalog: 503 Service Unavailable",
		);
		expect(context.showWarning).toHaveBeenCalledWith("Could not refresh devin model catalog: Account unavailable");
	});

	it("reports initial runtime and background provider catalog errors", async () => {
		const context = await runStartup(
			async () => ({ aborted: false, errors: new Map([["google-antigravity", new Error("Connection refused")]]) }),
			"google-antigravity: Connection refused",
		);

		await vi.waitFor(() => expect(context.updateAvailableProviderCount).toHaveBeenCalledOnce());
		expect(context.showError).toHaveBeenCalledExactlyOnceWith(
			"Model catalog error: google-antigravity: Connection refused",
		);
		expect(context.showWarning).toHaveBeenCalledExactlyOnceWith(
			"Could not refresh google-antigravity model catalog: Connection refused",
		);
	});

	it("reports a rejected background refresh", async () => {
		const context = await runStartup(async () => {
			throw new Error("Connection refused");
		});

		await vi.waitFor(() =>
			expect(context.showWarning).toHaveBeenCalledExactlyOnceWith(
				"Could not refresh model catalogs: Connection refused",
			),
		);
	});

	it("keeps cancelled background refreshes quiet", async () => {
		const context = await runStartup(async () => {
			throw new DOMException("Cancelled", "AbortError");
		});

		expect(context.showWarning).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});
});
