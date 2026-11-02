import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import * as piServerClient from "../../src/core/pi-server-client.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

interface CompactionQueueUI {
	session: AgentSession;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	flushCompactionQueue(options: { willRetry: boolean }): Promise<void>;
}

describe("Pi-server manual compaction queue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(["steer", "followUp"] as const)(
		"flushes queued %s input after remote compaction completes",
		async (mode) => {
			const harness = await createHarness();
			harnesses.push(harness);
			vi.stubEnv("PI_SERVER_MODE", "true");
			const firstKeptEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "old input" }],
				timestamp: Date.now() - 1000,
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
			harness.session.refreshContext();
			const serverSession = SessionManager.inMemory();
			serverSession.replaceTree(harness.sessionManager.getEntries(), harness.sessionManager.getLeafId());
			const compactionEntryId = serverSession.appendCompaction("remote summary", firstKeptEntryId, 100);
			const result = {
				compaction: { summary: "remote summary", firstKeptEntryId, tokensBefore: 100 },
				compactionEntry: serverSession.getEntry(compactionEntryId),
				entries: serverSession.getEntries(),
				leafId: serverSession.getLeafId(),
				messages: serverSession.buildSessionContext().messages,
			} as unknown as piServerClient.PiServerCompactionResult;
			let releaseCompaction = () => {};
			const compactReleased = new Promise<void>((resolve) => {
				releaseCompaction = resolve;
			});
			let markCompactionStarted = () => {};
			const compactStarted = new Promise<void>((resolve) => {
				markCompactionStarted = resolve;
			});
			vi.spyOn(piServerClient, "compactPiServer").mockImplementation(async () => {
				markCompactionStarted();
				await compactReleased;
				return result;
			});
			const ui = {
				session: harness.session,
				compactionQueuedMessages: [] as CompactionQueueUI["compactionQueuedMessages"],
				flushCompactionQueue: Reflect.get(
					InteractiveMode.prototype,
					"flushCompactionQueue",
				) as CompactionQueueUI["flushCompactionQueue"],
				isExtensionCommand: () => false,
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};
			harness.setResponses([
				fauxAssistantMessage("first reply"),
				...(mode === "followUp" ? [fauxAssistantMessage("second reply")] : []),
				fauxAssistantMessage("follow-up reply"),
			]);
			let queueFlush: Promise<void> | undefined;
			const settled = new Promise<void>((resolve) => {
				harness.session.subscribe((event) => {
					if (event.type === "compaction_end") {
						queueFlush = ui.flushCompactionQueue({ willRetry: event.willRetry });
					}
					if (event.type === "agent_settled") resolve();
				});
			});
			const compact = harness.session.compact();
			await compactStarted;
			ui.compactionQueuedMessages.push(
				{ text: "first queued input", mode },
				{ text: "second queued input", mode },
				{ text: "follow-up input", mode: "followUp" },
			);
			expect(harness.session.isCompacting).toBe(true);
			await expect(harness.session.prompt("direct RPC input", { source: "rpc" })).rejects.toThrow(
				"compaction is in progress",
			);
			expect(ui.compactionQueuedMessages).toHaveLength(3);
			expect(harness.faux.state.callCount).toBe(0);
			releaseCompaction();
			await compact;
			await queueFlush;
			expect(ui.showError).not.toHaveBeenCalled();
			await settled;
			const committedInputs = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
				);
			expect(committedInputs).toEqual(["old input", "first queued input", "second queued input", "follow-up input"]);
			expect(ui.compactionQueuedMessages).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.faux.state.callCount).toBe(mode === "steer" ? 2 : 3);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.isCompacting).toBe(false);
		},
	);
});
