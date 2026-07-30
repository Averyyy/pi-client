import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	acceptToolEffectResult,
	beginSessionToolEffect,
	beginToolEffect,
	beginToolEffectFinalization,
	commitSessionToolEffect,
	getToolEffectJournalPath,
	inspectToolEffect,
	markToolEffectFailed,
	readDurableToolEffects,
	recoverToolEffects,
	ToolEffectRecoveryRequiredError,
	ToolEffectUnknownOutcomeError,
	writeSessionToolEffectResult,
	writeToolEffectFinalResult,
	writeToolEffectResult,
} from "../src/core/tool-effect-journal.ts";

const temporaryDirectories: string[] = [];

function createPersistentToolSession(
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): {
	manager: SessionManager;
	assistantEntryId: string;
	journalPath: string;
} {
	const directory = mkdtempSync(join(tmpdir(), "pi-tool-effect-"));
	temporaryDirectories.push(directory);
	const manager = SessionManager.create(directory, directory, { id: "tool-effect-session" });
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "run tools" }], timestamp: 1 });
	const assistant = fauxAssistantMessage(
		toolCalls.map((call) => ({ ...fauxToolCall(call.name, call.arguments), id: call.id })),
		{ stopReason: "toolUse", timestamp: 2 },
	);
	const assistantEntryId = manager.appendMessage(assistant);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persistent session file");
	return {
		manager,
		assistantEntryId,
		journalPath: getToolEffectJournalPath(sessionFile),
	};
}

function begin(
	journalPath: string,
	assistantEntryId: string,
	call: { id: string; name: string; arguments: Record<string, unknown> },
	index: number,
) {
	return beginToolEffect(journalPath, {
		sessionId: "tool-effect-session",
		assistantEntryId,
		toolCallId: call.id,
		toolName: call.name,
		toolCallIndex: index,
		arguments: call.arguments,
		timestamp: 10 + index,
	});
}

function toolResult(call: { id: string; name: string }, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		details: { text },
		isError: false,
		timestamp,
	};
}

function appendJournalRecord(journalPath: string, record: Record<string, unknown>): void {
	const payload = JSON.stringify(record);
	appendFileSync(
		journalPath,
		`${JSON.stringify({ payload, sha256: createHash("sha256").update(payload).digest("hex") })}\n`,
		"utf8",
	);
}

describe("durable tool effect journal", () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recovers a durable result exactly once without executing the tool again", () => {
		const call = { id: "call-1", name: "write_external", arguments: { value: "done" } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		const result = toolResult(call, "external side effect completed", 20);
		writeToolEffectResult(journalPath, intent.effectId, result);

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed)).toEqual({
			recoveredToolCallIds: ["call-1"],
			acknowledgedToolCallIds: [],
		});
		expect(resumed.buildSessionContext().messages).toEqual([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "assistant" }),
			result,
		]);
		expect(readDurableToolEffects(journalPath)[0]?.committedSessionEntryId).toBe(resumed.getLeafId());

		const resumedAgain = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumedAgain)).toEqual({
			recoveredToolCallIds: [],
			acknowledgedToolCallIds: [],
		});
		expect(
			resumedAgain.buildSessionContext().messages.filter((message) => message.role === "toolResult"),
		).toHaveLength(1);
	});

	it("fails closed for an intent with an unknown outcome and never synthesizes a result", () => {
		const call = { id: "call-unknown", name: "charge_card", arguments: { cents: 100 } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		begin(journalPath, assistantEntryId, call, 0);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);

		expect(() => recoverToolEffects(resumed)).toThrow(ToolEffectUnknownOutcomeError);
		expect(resumed.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(() => begin(journalPath, assistantEntryId, call, 0)).toThrow(ToolEffectUnknownOutcomeError);
		expect(readFileSync(sessionFile, "utf8")).not.toContain("No result provided");
	});

	it("reports exact non-sensitive recovery metadata for an unknown outcome", () => {
		const call = {
			id: "call-unknown-metadata",
			name: "charge_card",
			arguments: { secretCard: "4111111111111111" },
		};
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");

		let thrown: unknown;
		try {
			recoverToolEffects(SessionManager.open(sessionFile));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ToolEffectUnknownOutcomeError);
		const unknown = thrown as ToolEffectUnknownOutcomeError;
		expect(unknown.effects).toEqual([
			{
				sessionId: manager.getSessionId(),
				sessionPath: sessionFile,
				journalPath,
				effectId: intent.effectId,
				toolCallId: call.id,
				toolName: call.name,
				phase: "execution_unknown",
			},
		]);
		expect(unknown.message).toContain(`effectId=${intent.effectId}`);
		expect(unknown.message).toContain(`journalPath=${journalPath}`);
		expect(unknown.message).not.toContain(call.arguments.secretCard);
	});

	it("explicitly marks an unknown effect failed without re-executing and is idempotent", () => {
		const call = { id: "call-mark-failed", name: "external_write", arguments: { value: "maybe-written" } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);

		expect(inspectToolEffect(manager, intent.effectId)).toEqual(
			expect.objectContaining({
				effectId: intent.effectId,
				toolCallId: call.id,
				toolName: call.name,
				phase: "execution_unknown",
			}),
		);
		const first = markToolEffectFailed(manager, intent.effectId);
		expect(first.alreadyResolved).toBe(false);
		const second = markToolEffectFailed(manager, intent.effectId);
		expect(second).toEqual(expect.objectContaining({ sessionEntryId: first.sessionEntryId, alreadyResolved: true }));
		const results = manager
			.buildSessionContext()
			.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(
			expect.objectContaining({
				toolCallId: call.id,
				toolName: call.name,
				isError: true,
			}),
		);
		expect(readDurableToolEffects(journalPath)[0]?.committedSessionEntryId).toBe(first.sessionEntryId);

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		expect(() => recoverToolEffects(SessionManager.open(sessionFile))).not.toThrow();
	});

	it("accepts an exact user result after the session append crash boundary without duplicating it", () => {
		const call = { id: "call-accept-result", name: "external_lookup", arguments: { key: "value" } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		const accepted = toolResult(call, "authoritative external result", 123);
		const persistedEntryId = manager.appendMessage(accepted);
		manager.flushSessionFile();

		const resolved = acceptToolEffectResult(manager, intent.effectId, structuredClone(accepted));
		expect(resolved).toEqual(
			expect.objectContaining({
				sessionEntryId: persistedEntryId,
				alreadyResolved: true,
			}),
		);
		expect(manager.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(readDurableToolEffects(journalPath)[0]).toEqual(
			expect.objectContaining({
				result: accepted,
				committedSessionEntryId: persistedEntryId,
			}),
		);
	});

	it("rejects an invalid or mismatched accepted result before changing session history", () => {
		const call = { id: "call-reject-result", name: "external_lookup", arguments: {} };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);

		expect(() =>
			acceptToolEffectResult(manager, intent.effectId, {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "unsupported", text: "invalid" }],
				isError: false,
				timestamp: 1,
			}),
		).toThrow("type must be text or image");
		expect(() =>
			acceptToolEffectResult(manager, intent.effectId, toolResult({ id: "different", name: call.name }, "wrong", 2)),
		).toThrow("identity does not match");
		expect(manager.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
		expect(readDurableToolEffects(journalPath)[0]?.result).toBeUndefined();
	});

	it("recovers parallel results in assistant source order even when they completed out of order", () => {
		const slow = { id: "call-slow", name: "slow", arguments: { order: 0 } };
		const fast = { id: "call-fast", name: "fast", arguments: { order: 1 } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([slow, fast]);
		const slowIntent = begin(journalPath, assistantEntryId, slow, 0);
		const fastIntent = begin(journalPath, assistantEntryId, fast, 1);
		writeToolEffectResult(journalPath, fastIntent.effectId, toolResult(fast, "fast result", 30));
		writeToolEffectResult(journalPath, slowIntent.effectId, toolResult(slow, "slow result", 31));

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed).recoveredToolCallIds).toEqual(["call-slow", "call-fast"]);
		expect(
			resumed
				.buildSessionContext()
				.messages.filter((message): message is ToolResultMessage => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual(["call-slow", "call-fast"]);
	});

	it("does not partially recover a parallel batch when one outcome is unknown", () => {
		const unknown = { id: "call-unknown-first", name: "unknown", arguments: { order: 0 } };
		const known = { id: "call-known-second", name: "known", arguments: { order: 1 } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([unknown, known]);
		begin(journalPath, assistantEntryId, unknown, 0);
		const knownIntent = begin(journalPath, assistantEntryId, known, 1);
		writeToolEffectResult(journalPath, knownIntent.effectId, toolResult(known, "known result", 35));

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(() => recoverToolEffects(resumed)).toThrow(ToolEffectUnknownOutcomeError);
		expect(resumed.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	it("acknowledges a session result persisted before the journal commit without duplicating it", () => {
		const call = { id: "call-persisted", name: "persist", arguments: { value: true } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		const result = toolResult(call, "persisted", 40);
		writeToolEffectResult(journalPath, intent.effectId, result);
		const resultEntryId = manager.appendMessage(result);
		manager.flushSessionFile();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed)).toEqual({
			recoveredToolCallIds: [],
			acknowledgedToolCallIds: ["call-persisted"],
		});
		expect(readDurableToolEffects(journalPath)[0]?.committedSessionEntryId).toBe(resultEntryId);
		expect(resumed.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("recovers after an earlier parallel result was persisted before its journal commit", () => {
		const first = { id: "call-first", name: "first", arguments: { order: 0 } };
		const second = { id: "call-second", name: "second", arguments: { order: 1 } };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([first, second]);
		const firstIntent = begin(journalPath, assistantEntryId, first, 0);
		const secondIntent = begin(journalPath, assistantEntryId, second, 1);
		const firstResult = toolResult(first, "first result", 45);
		writeToolEffectResult(journalPath, firstIntent.effectId, firstResult);
		writeToolEffectResult(journalPath, secondIntent.effectId, toolResult(second, "second result", 46));
		manager.appendMessage(firstResult);
		manager.flushSessionFile();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed)).toEqual({
			recoveredToolCallIds: ["call-second"],
			acknowledgedToolCallIds: ["call-first"],
		});
		expect(
			resumed
				.buildSessionContext()
				.messages.filter((message): message is ToolResultMessage => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual(["call-first", "call-second"]);
	});

	it("repairs only a torn final record and rejects committed-history corruption", () => {
		const call = { id: "call-torn", name: "torn", arguments: { value: 1 } };
		const { assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		appendFileSync(journalPath, '{"payload":"torn"', "utf8");
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "complete", 50));
		expect(readDurableToolEffects(journalPath)[0]?.result?.content).toEqual([{ type: "text", text: "complete" }]);

		const content = readFileSync(journalPath, "utf8");
		const corrupted = content.replace(/"sha256":"[a-f0-9]{64}"/, `"sha256":"${"0".repeat(64)}"`);
		writeFileSync(journalPath, corrupted, "utf8");
		expect(() => readDurableToolEffects(journalPath)).toThrow("checksum mismatch");
	});

	it("uses canonical arguments for stable identities and stores the sidecar with owner-only permissions", () => {
		const first = { id: "call-canonical", name: "canonical", arguments: { z: 1, a: { y: 2, x: 3 } } };
		const firstSession = createPersistentToolSession([first]);
		const firstIntent = begin(firstSession.journalPath, firstSession.assistantEntryId, first, 0);

		const second = { id: "call-canonical", name: "canonical", arguments: { a: { x: 3, y: 2 }, z: 1 } };
		const secondSession = createPersistentToolSession([second]);
		const secondIntent = begin(secondSession.journalPath, secondSession.assistantEntryId, second, 0);
		expect(secondIntent.argumentsHash).toBe(firstIntent.argumentsHash);
		if (process.platform !== "win32") {
			expect((statSync(firstSession.journalPath).mode & 0o777).toString(8)).toBe("600");
		}
		expect(firstSession.manager.getEntries().every((entry) => entry.type !== "custom")).toBe(true);
		expect(firstSession.manager.buildSessionContext().messages).toHaveLength(2);
	});

	it("requires explicit recovery before a durable result can be executed again", () => {
		const call = { id: "call-result", name: "result", arguments: {} };
		const { assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "done", 60));
		expect(() => begin(journalPath, assistantEntryId, call, 0)).toThrow(ToolEffectRecoveryRequiredError);
	});

	it("accepts an identical result retry but rejects a divergent duplicate", () => {
		const call = { id: "call-duplicate", name: "duplicate", arguments: {} };
		const { assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		const result = toolResult(call, "first", 65);
		writeToolEffectResult(journalPath, intent.effectId, result);
		expect(() => writeToolEffectResult(journalPath, intent.effectId, structuredClone(result))).not.toThrow();
		expect(() => writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "different", 66))).toThrow(
			"Divergent duplicate result",
		);
	});

	it("rejects a second durable result record even when its payload is identical", () => {
		const call = { id: "call-duplicate-record", name: "duplicate_record", arguments: {} };
		const { assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "durable", 67));

		const resultEnvelope = JSON.parse(readFileSync(journalPath, "utf8").trimEnd().split("\n")[1] ?? "") as {
			payload: string;
			sha256: string;
		};
		const duplicateResult = JSON.parse(resultEnvelope.payload) as Record<string, unknown>;
		duplicateResult.sequence = 2;
		appendJournalRecord(journalPath, duplicateResult);

		expect(() => readDurableToolEffects(journalPath)).toThrow("Duplicate tool effect result");
	});

	it("rejects an uncommitted session result that differs from the durable result", () => {
		const call = { id: "call-uncommitted-mismatch", name: "persist", arguments: {} };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "durable", 68));
		manager.appendMessage(toolResult(call, "different session value", 69));
		manager.flushSessionFile();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		expect(() => recoverToolEffects(SessionManager.open(sessionFile))).toThrow("does not match durable effect");
		expect(readDurableToolEffects(journalPath)[0]?.committedSessionEntryId).toBeUndefined();
	});

	it("recovers the exact final tool result after message lifecycle transformation", () => {
		const call = { id: "call-final", name: "finalize", arguments: {} };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "execution result", 70));
		beginToolEffectFinalization(journalPath, intent.effectId, 71);
		const finalResult = toolResult(call, "message_end result", 72);
		writeToolEffectFinalResult(journalPath, intent.effectId, finalResult, 73);

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed).recoveredToolCallIds).toEqual(["call-final"]);
		expect(resumed.buildSessionContext().messages.find((message) => message.role === "toolResult")).toEqual(
			finalResult,
		);
	});

	it("fails closed when final result transformation started but did not finish", () => {
		const call = { id: "call-final-unknown", name: "finalize", arguments: {} };
		const { manager, assistantEntryId, journalPath } = createPersistentToolSession([call]);
		const intent = begin(journalPath, assistantEntryId, call, 0);
		writeToolEffectResult(journalPath, intent.effectId, toolResult(call, "execution result", 74));
		beginToolEffectFinalization(journalPath, intent.effectId, 75);

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.open(sessionFile);
		expect(() => recoverToolEffects(resumed)).toThrow(ToolEffectUnknownOutcomeError);
		expect(resumed.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(false);
	});

	it("maps awaited tool lifecycle events to the persisted assistant entry", () => {
		const call = { id: "call-lifecycle", name: "lifecycle", arguments: { nested: { value: true } } };
		const { manager, journalPath } = createPersistentToolSession([call]);
		const intent = beginSessionToolEffect(manager, {
			toolCallId: call.id,
			toolName: call.name,
			args: { nested: { value: true } },
		});
		expect(intent?.toolCallIndex).toBe(0);
		const result = toolResult(call, "lifecycle complete", 70);
		writeSessionToolEffectResult(manager, result);
		const sessionEntryId = manager.appendMessage(result);
		manager.flushSessionFile();
		commitSessionToolEffect(manager, result, sessionEntryId);
		expect(readDurableToolEffects(journalPath)[0]).toEqual(
			expect.objectContaining({
				result,
				committedSessionEntryId: sessionEntryId,
			}),
		);
	});

	it("validates committed results across the full tree, including inactive branches", () => {
		const call = { id: "call-branch", name: "branch", arguments: {} };
		const { manager, assistantEntryId } = createPersistentToolSession([call]);
		beginSessionToolEffect(manager, { toolCallId: call.id, toolName: call.name, args: {} });
		const result = toolResult(call, "branch result", 75);
		writeSessionToolEffectResult(manager, result);
		const resultEntryId = manager.appendMessage(result);
		manager.flushSessionFile();
		commitSessionToolEffect(manager, result, resultEntryId);
		manager.branch(assistantEntryId);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "alternate branch" }], timestamp: 76 });
		manager.flushSessionFile();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		expect(() => recoverToolEffects(SessionManager.open(sessionFile))).not.toThrow();
	});

	it("rejects a committed journal result that is missing from or differs from the session tree", () => {
		const call = { id: "call-corrupt-commit", name: "corrupt", arguments: {} };
		const { manager, assistantEntryId } = createPersistentToolSession([call]);
		beginSessionToolEffect(manager, { toolCallId: call.id, toolName: call.name, args: {} });
		const durableResult = toolResult(call, "durable", 77);
		writeSessionToolEffectResult(manager, durableResult);
		const differentResult = toolResult(call, "different session value", 78);
		const resultEntryId = manager.appendMessage(differentResult);
		manager.flushSessionFile();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const journalPath = getToolEffectJournalPath(sessionFile);
		const effect = readDurableToolEffects(journalPath)[0];
		if (!effect) throw new Error("Expected durable tool effect");
		appendJournalRecord(journalPath, {
			version: 1,
			kind: "commit",
			sequence: 2,
			timestamp: 79,
			effectId: effect.intent.effectId,
			sessionEntryId: resultEntryId,
		});

		expect(() => recoverToolEffects(SessionManager.open(sessionFile))).toThrow("does not match session entry");

		manager.replaceTree(
			manager.getEntries().filter((entry) => entry.id !== resultEntryId),
			assistantEntryId,
		);
		expect(() => recoverToolEffects(SessionManager.open(sessionFile))).toThrow("does not match session entry");
	});

	it("keeps no-session native runs behaviorally unchanged without claiming durability", () => {
		const manager = SessionManager.inMemory();
		expect(
			beginSessionToolEffect(manager, {
				toolCallId: "call-memory",
				toolName: "memory",
				args: {},
			}),
		).toBeUndefined();
		const result = toolResult({ id: "call-memory", name: "memory" }, "done", 80);
		expect(() => writeSessionToolEffectResult(manager, result)).not.toThrow();
		expect(() => commitSessionToolEffect(manager, result, "entry-memory")).not.toThrow();
		expect(manager.getEntries()).toEqual([]);
	});
});
