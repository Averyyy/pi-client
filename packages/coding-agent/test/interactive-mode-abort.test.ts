import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type AbortSession = {
	isAborting: boolean;
	abortError?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
};

type TestMode = {
	isInitialized?: boolean;
	runtimeHost: { session: AbortSession };
	session: AbortSession;
	sessionAbortError?: string;
	activeStatusIndicator?: { kind: "working"; dispose: ReturnType<typeof vi.fn> };
	clearStatusIndicator?: ReturnType<typeof vi.fn>;
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory: ReturnType<typeof vi.fn>;
		setText: ReturnType<typeof vi.fn>;
		getText: () => string;
	};
	ui: {
		requestRender: ReturnType<typeof vi.fn>;
		addInputListener?: (listener: (data: string) => unknown) => () => void;
	};
	footer?: { invalidate: ReturnType<typeof vi.fn> };
	keybindings: { matches: ReturnType<typeof vi.fn> };
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	flushPendingBashComponents?: ReturnType<typeof vi.fn>;
	submitStreamingMessage?: (text: string, behavior: "steer" | "followUp") => Promise<void>;
	showAbortError?: ReturnType<typeof vi.fn>;
	showAbortingStatusIndicator?: ReturnType<typeof vi.fn>;
	showCancellationFailedStatusIndicator?: ReturnType<typeof vi.fn>;
	refreshStatusIndicator?: ReturnType<typeof vi.fn>;
	isInteractiveCommand?: ReturnType<typeof vi.fn>;
	requestAbort?: ReturnType<typeof vi.fn>;
	abortInputListenerCleanup?: () => void;
};

function getPrivateMethod<T extends (...args: never[]) => unknown>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

function createSession(overrides: Partial<AbortSession> = {}): AbortSession {
	return {
		isAborting: false,
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("InteractiveMode cancellation boundary", () => {
	test("keeps the working indicator through agent_end until settlement", async () => {
		const session = createSession({ isStreaming: true });
		const activeIndicator = { kind: "working" as const, dispose: vi.fn() };
		const mode = {
			isInitialized: true,
			runtimeHost: { session },
			session,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			pendingTools: new Map(),
			streamingComponent: undefined,
			activeStatusIndicator: activeIndicator as typeof activeIndicator | undefined,
			abortingStatusActive: false,
			statusContainer: { clear: vi.fn(), addChild: vi.fn() },
			options: { tuiMode: "fullscreen" as const },
			ui: { requestRender: vi.fn() },
			clearStatusIndicator: vi.fn(() => {
				activeIndicator.dispose();
				mode.activeStatusIndicator = undefined;
			}),
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		};
		const handleEvent = getPrivateMethod<(event: { type: string }) => Promise<void>>("handleEvent");

		await handleEvent.call(mode, { type: "agent_end" });
		expect(mode.activeStatusIndicator).toBe(activeIndicator);

		session.isStreaming = false;
		await handleEvent.call(mode, { type: "agent_settled" });
		expect(mode.activeStatusIndicator).toBeUndefined();
		expect(activeIndicator.dispose).toHaveBeenCalledTimes(1);
	});

	test("queues submit and follow-up input while aborting", async () => {
		const session = createSession({ isAborting: true });
		const mode: TestMode = {
			runtimeHost: { session },
			session,
			defaultEditor: {},
			editor: {
				addToHistory: vi.fn(),
				setText: vi.fn(),
				getText: () => "",
			},
			ui: { requestRender: vi.fn() },
			keybindings: { matches: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			footer: { invalidate: vi.fn() },
			flushPendingBashComponents: vi.fn(),
			isInteractiveCommand: vi.fn(() => false),
		};
		mode.submitStreamingMessage =
			getPrivateMethod<(text: string, behavior: "steer" | "followUp") => Promise<void>>(
				"submitStreamingMessage",
			).bind(mode);
		const setupSubmit = getPrivateMethod<() => void>("setupEditorSubmitHandler");
		setupSubmit.call(mode);

		await mode.defaultEditor.onSubmit?.("queued prompt");
		expect(session.prompt).toHaveBeenCalledWith("queued prompt", { streamingBehavior: "steer" });

		mode.editor.getText = () => "queued follow-up";
		const handleFollowUp = getPrivateMethod<() => Promise<void>>("handleFollowUp");
		await handleFollowUp.call(mode);
		expect(session.prompt).toHaveBeenCalledWith("queued follow-up", { streamingBehavior: "followUp" });
	});

	test("ignores repeated Esc until cancellation fails, then allows a retry", () => {
		const session = createSession({ isAborting: true });
		const mode: TestMode = {
			runtimeHost: { session },
			session,
			get sessionAbortError() {
				return session.abortError;
			},
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: () => "" },
			ui: { requestRender: vi.fn() },
			keybindings: { matches: vi.fn(() => true) },
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			showAbortingStatusIndicator: vi.fn(),
			refreshStatusIndicator: vi.fn(),
		};
		const requestAbort = getPrivateMethod<() => void>("requestAbort");

		requestAbort.call(mode);
		expect(session.abort).not.toHaveBeenCalled();

		session.abortError = "server did not confirm cancellation";
		requestAbort.call(mode);
		expect(session.abort).toHaveBeenCalledTimes(1);
	});

	test("consumes repeated interrupts at the renderer boundary while allowing retry", () => {
		const session = createSession({ isAborting: true });
		let listener: ((data: string) => unknown) | undefined;
		const mode: TestMode = {
			runtimeHost: { session },
			session,
			get sessionAbortError() {
				return session.abortError;
			},
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: () => "" },
			ui: {
				requestRender: vi.fn(),
				addInputListener: vi.fn((nextListener: (data: string) => unknown) => {
					listener = nextListener;
					return vi.fn();
				}),
			},
			keybindings: { matches: vi.fn(() => true) },
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			requestAbort: vi.fn(),
		};
		const bind = getPrivateMethod<() => void>("bindAbortInputListener");
		bind.call(mode);
		expect(listener?.("escape")).toEqual({ consume: true });
		expect(mode.requestAbort).not.toHaveBeenCalled();

		session.abortError = "server did not confirm cancellation";
		expect(listener?.("escape")).toEqual({ consume: true });
		expect(mode.requestAbort).toHaveBeenCalledTimes(1);
	});

	test("renders an abort error without releasing the aborting state", async () => {
		const session = createSession({ isAborting: true, abortError: "remote cancellation failed" });
		const mode: TestMode = {
			runtimeHost: { session },
			session,
			isInitialized: true,
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: () => "" },
			ui: { requestRender: vi.fn() },
			keybindings: { matches: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			showAbortError: vi.fn(),
			showAbortingStatusIndicator: vi.fn(),
			showCancellationFailedStatusIndicator: vi.fn(),
			footer: { invalidate: vi.fn() },
		};
		const handleEvent = getPrivateMethod<(event: unknown) => Promise<void>>("handleEvent");

		await handleEvent.call(mode, { type: "abort_error", errorMessage: "remote cancellation failed" });
		expect(mode.showCancellationFailedStatusIndicator).toHaveBeenCalledTimes(1);
		expect(mode.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
