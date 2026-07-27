import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat without appending a duplicate compaction summary", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			restoreWorkingIndicator: vi.fn(),
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		expect(fakeThis.restoreWorkingIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("renders the full active branch instead of the compacted model context", () => {
		const branch = [
			{ type: "message", id: "old" },
			{ type: "compaction", id: "compact" },
		];
		const fakeThis = {
			chatContainer: { clear: vi.fn() },
			sessionManager: {
				getBranch: vi.fn().mockReturnValue(branch),
				buildContextEntries: vi.fn(),
			},
			renderSessionEntries: vi.fn(),
		};

		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => void;

		rebuildChatFromMessages.call(fakeThis);

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.sessionManager.getBranch).toHaveBeenCalledTimes(1);
		expect(fakeThis.sessionManager.buildContextEntries).not.toHaveBeenCalled();
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(branch);
	});

	test("keeps working active through agent_end and clears it at agent_settled", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			clearStatusIndicator: vi.fn(),
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_end" } | { type: "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_end" });

		expect(fakeThis.ui.terminal.setProgress).not.toHaveBeenCalled();
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();

		await handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(false);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledWith("working");
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
