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

	test("renders the latest compaction context and defers older branch entries", () => {
		const branch = [{ type: "message", id: "old" } as const, { type: "compaction", id: "compact" } as const];
		const contextEntries = [branch[1]];
		const getTranscriptEntriesForRender = Reflect.get(InteractiveMode.prototype, "getTranscriptEntriesForRender") as (
			this: object,
			reset?: boolean,
		) => unknown[];
		const fakeThis = {
			sessionManager: {
				getBranch: vi.fn().mockReturnValue(branch),
				buildContextEntries: vi.fn().mockReturnValue(contextEntries),
			},
			renderSessionEntries: vi.fn(),
			loadedTranscriptEntryIds: new Set<string>(),
			transcriptWindowInitialized: false,
			transcriptLatestCompactionId: undefined as string | undefined,
			transcriptLazyEntries: [] as typeof branch,
			getTranscriptEntriesForRender,
		};

		const renderedEntries = getTranscriptEntriesForRender.call(fakeThis);

		expect(fakeThis.sessionManager.getBranch).toHaveBeenCalledTimes(1);
		expect(fakeThis.sessionManager.buildContextEntries).toHaveBeenCalledTimes(1);
		expect(renderedEntries).toEqual(contextEntries);
		expect(fakeThis.transcriptLazyEntries).toEqual([branch[0]]);
	});

	test("loads older transcript entries in bounded batches", () => {
		const branch = Array.from({ length: 25 }, (_, index) => ({
			type: "message" as const,
			id: `old-${index}`,
		}));
		const contextEntries = [{ type: "compaction" as const, id: "latest" }];
		const fakeThis = {
			sessionManager: {
				getBranch: vi.fn().mockReturnValue(branch),
				buildContextEntries: vi.fn().mockReturnValue(contextEntries),
			},
			loadedTranscriptEntryIds: new Set<string>(),
			transcriptWindowInitialized: false,
			transcriptLatestCompactionId: undefined as string | undefined,
			transcriptLazyEntries: [] as typeof branch,
			loadingEarlierTranscript: false,
			session: { isStreaming: false },
			rebuildChatFromMessages: vi.fn(() => {
				getTranscriptEntriesForRender.call(fakeThis);
			}),
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const getTranscriptEntriesForRender = Reflect.get(InteractiveMode.prototype, "getTranscriptEntriesForRender") as (
			this: typeof fakeThis,
			reset?: boolean,
		) => unknown[];
		const loadEarlierTranscript = Reflect.get(InteractiveMode.prototype, "loadEarlierTranscript") as (
			this: typeof fakeThis,
		) => void;

		getTranscriptEntriesForRender.call(fakeThis, true);
		loadEarlierTranscript.call(fakeThis);

		expect(fakeThis.loadedTranscriptEntryIds.size).toBe(20);
		expect(fakeThis.loadedTranscriptEntryIds.has("old-4")).toBe(false);
		expect(fakeThis.loadedTranscriptEntryIds.has("old-5")).toBe(true);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Loaded 20 earlier transcript entries (5 remaining)");
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
