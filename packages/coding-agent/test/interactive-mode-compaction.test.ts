import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			restoreWorkingStatusIndicatorIfStreaming: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
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
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(fakeThis.restoreWorkingStatusIndicatorIfStreaming).toHaveBeenCalledTimes(1);
	});

	test("restores the working indicator after compaction while the agent is still streaming", () => {
		const restoreWorkingStatusIndicatorIfStreaming = Reflect.get(
			InteractiveMode.prototype,
			"restoreWorkingStatusIndicatorIfStreaming",
		) as (this: {
			session: { isStreaming: boolean };
			workingVisible: boolean;
			activeStatusIndicator: { kind: string } | undefined;
			showWorkingStatusIndicator: ReturnType<typeof vi.fn>;
			settingsManager: { getShowTerminalProgress(): boolean };
			ui: { terminal: { setProgress: ReturnType<typeof vi.fn> } };
		}) => void;

		const createFakeThis = (
			overrides: { isStreaming?: boolean; workingVisible?: boolean; activeStatusIndicator?: { kind: string } } = {},
		) => ({
			session: { isStreaming: overrides.isStreaming ?? true },
			workingVisible: overrides.workingVisible ?? true,
			activeStatusIndicator: overrides.activeStatusIndicator,
			showWorkingStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { terminal: { setProgress: vi.fn() } },
		});

		const streaming = createFakeThis();
		restoreWorkingStatusIndicatorIfStreaming.call(streaming);
		expect(streaming.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(streaming.ui.terminal.setProgress).toHaveBeenCalledWith(true);

		const alreadyWorking = createFakeThis({ activeStatusIndicator: { kind: "working" } });
		restoreWorkingStatusIndicatorIfStreaming.call(alreadyWorking);
		expect(alreadyWorking.showWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(alreadyWorking.ui.terminal.setProgress).toHaveBeenCalledWith(true);

		const hidden = createFakeThis({ workingVisible: false });
		restoreWorkingStatusIndicatorIfStreaming.call(hidden);
		expect(hidden.showWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(hidden.ui.terminal.setProgress).toHaveBeenCalledWith(true);

		const idle = createFakeThis({ isStreaming: false });
		restoreWorkingStatusIndicatorIfStreaming.call(idle);
		expect(idle.showWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(idle.ui.terminal.setProgress).not.toHaveBeenCalled();
	});

	test("clears the working indicator on agent_settled instead of agent_end", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: { clear: vi.fn() },
			chatContainer: { removeChild: vi.fn() },
			clearStatusIndicator: vi.fn(),
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_end" | "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_end" });
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.terminal.setProgress).not.toHaveBeenCalled();

		await handleEvent.call(fakeThis, { type: "agent_settled" });
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledWith("working");
		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(false);
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});

	test("restores the working indicator after a retry indicator while still streaming", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryEscapeHandler: undefined as (() => void) | undefined,
			defaultEditor: { onEscape: vi.fn() },
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
			restoreWorkingStatusIndicatorIfStreaming: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "auto_retry_end"; success: boolean; attempt: number },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "auto_retry_end", success: true, attempt: 1 });

		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledWith("retry");
		expect(fakeThis.restoreWorkingStatusIndicatorIfStreaming).toHaveBeenCalledTimes(1);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
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
