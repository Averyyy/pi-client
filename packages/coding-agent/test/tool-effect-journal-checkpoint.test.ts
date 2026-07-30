import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	acceptToolEffectResult,
	beginSessionToolEffect,
	beginToolEffect,
	beginToolEffectFinalization,
	checkpointToolEffectJournal,
	commitSessionToolEffect,
	commitToolEffect,
	getToolEffectJournalPath,
	inspectToolEffect,
	markToolEffectFailed,
	readDurableToolEffects,
	recoverToolEffects,
	setToolEffectJournalTestHooks,
	ToolEffectJournalCapacityError,
	ToolEffectUnknownOutcomeError,
	writeToolEffectFinalResult,
	writeToolEffectResult,
} from "../src/core/tool-effect-journal.ts";

const temporaryDirectories: string[] = [];
const environmentNames = [
	"PI_TOOL_EFFECT_MAX_UNRESOLVED_EFFECTS",
	"PI_TOOL_EFFECT_MAX_UNRESOLVED_BYTES",
	"PI_TOOL_EFFECT_CHECKPOINT_RECORDS",
	"PI_TOOL_EFFECT_CHECKPOINT_BYTES",
	"PI_TOOL_EFFECT_WINDOWS_RENAME_RETRIES",
] as const;
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));

interface ToolCallFixture {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function createSession(
	calls: ToolCallFixture[],
	id = "tool-effect-checkpoint",
): {
	manager: SessionManager;
	assistantEntryId: string;
	journalPath: string;
	sessionFile: string;
} {
	const directory = mkdtempSync(join(tmpdir(), "pi-tool-effect-checkpoint-"));
	temporaryDirectories.push(directory);
	const manager = SessionManager.create(directory, directory, { id });
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "run tools" }], timestamp: 1 });
	const assistantEntryId = manager.appendMessage(
		fauxAssistantMessage(
			calls.map((call) => ({ ...fauxToolCall(call.name, call.arguments), id: call.id })),
			{ stopReason: "toolUse", timestamp: 2 },
		),
	);
	manager.flushSessionFile();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persistent session file");
	return { manager, assistantEntryId, journalPath: getToolEffectJournalPath(sessionFile), sessionFile };
}

function beginDirect(
	journalPath: string,
	assistantEntryId: string,
	call: ToolCallFixture,
	index: number,
	sessionId = "tool-effect-checkpoint",
) {
	return beginToolEffect(journalPath, {
		sessionId,
		assistantEntryId,
		toolCallId: call.id,
		toolName: call.name,
		toolCallIndex: index,
		arguments: call.arguments,
		timestamp: 10 + index,
	});
}

function result(call: Pick<ToolCallFixture, "id" | "name">, text: string, timestamp: number): ToolResultMessage {
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

function decodeRecords(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { payload: string })
		.map(({ payload }) => JSON.parse(payload) as Record<string, unknown>);
}

function encodeRecord(record: Record<string, unknown>): string {
	const payload = JSON.stringify(record);
	return `${JSON.stringify({ payload, sha256: createHash("sha256").update(payload).digest("hex") })}\n`;
}

function createErrnoError(code: string): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

afterEach(() => {
	setToolEffectJournalTestHooks(undefined);
	for (const name of environmentNames) {
		const value = originalEnvironment.get(name);
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("tool effect journal checkpoints", () => {
	it("removes only committed effects and preserves interleaved unresolved recovery phases exactly", () => {
		const committed = { id: "call-committed", name: "committed", arguments: { order: 0 } };
		const finalizationUnknown = { id: "call-finalizing", name: "finalizing", arguments: { order: 1 } };
		const executionUnknown = { id: "call-unknown", name: "unknown", arguments: { order: 2 } };
		const durable = { id: "call-durable", name: "durable", arguments: { order: 3 } };
		const calls = [committed, finalizationUnknown, executionUnknown, durable];
		const { manager, assistantEntryId, journalPath, sessionFile } = createSession(calls);
		const intents = calls.map((call, index) => beginDirect(journalPath, assistantEntryId, call, index));

		const committedResult = result(committed, "committed result", 20);
		writeToolEffectResult(journalPath, intents[0]!.effectId, committedResult);
		const committedEntryId = manager.appendMessage(committedResult);
		manager.flushSessionFile();
		commitToolEffect(journalPath, intents[0]!.effectId, committedEntryId);

		const finalizationResult = result(finalizationUnknown, "execution result", 21);
		writeToolEffectResult(journalPath, intents[1]!.effectId, finalizationResult);
		beginToolEffectFinalization(journalPath, intents[1]!.effectId, 22);
		const durableResult = result(durable, "durable result", 23);
		writeToolEffectResult(journalPath, intents[3]!.effectId, durableResult);

		const previous = readFileSync(journalPath);
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		const records = decodeRecords(journalPath);
		expect(records[0]).toEqual(
			expect.objectContaining({
				kind: "checkpoint",
				checkpointVersion: 1,
				generation: 1,
				previousRecordCount: 9,
				previousSha256: createHash("sha256").update(previous).digest("hex"),
				snapshotRecordCount: 6,
			}),
		);
		expect(records.map((record) => record.kind)).toEqual([
			"checkpoint",
			"intent",
			"result",
			"finalization",
			"intent",
			"intent",
			"result",
		]);
		expect(readDurableToolEffects(journalPath).map((effect) => effect.intent.toolCallId)).toEqual([
			finalizationUnknown.id,
			executionUnknown.id,
			durable.id,
		]);

		const resumed = SessionManager.open(sessionFile);
		let unknown: ToolEffectUnknownOutcomeError | undefined;
		try {
			recoverToolEffects(resumed);
		} catch (error) {
			if (error instanceof ToolEffectUnknownOutcomeError) unknown = error;
		}
		expect(unknown?.effects.map(({ toolCallId, phase }) => ({ toolCallId, phase }))).toEqual([
			{ toolCallId: finalizationUnknown.id, phase: "finalization_unknown" },
			{ toolCallId: executionUnknown.id, phase: "execution_unknown" },
		]);

		acceptToolEffectResult(resumed, intents[1]!.effectId, finalizationResult);
		markToolEffectFailed(resumed, intents[2]!.effectId);
		expect(recoverToolEffects(resumed).recoveredToolCallIds).toEqual([durable.id]);
		const toolCallIds = resumed
			.buildSessionContext()
			.messages.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.map((message) => message.toolCallId);
		expect(toolCallIds).toEqual(calls.map((call) => call.id));
		expect(new Set(toolCallIds).size).toBe(calls.length);
	});

	it("automatically checkpoints only after the session result was fsynced and committed", () => {
		process.env.PI_TOOL_EFFECT_CHECKPOINT_RECORDS = "3";
		const call = { id: "call-auto", name: "auto", arguments: {} };
		const { manager, journalPath } = createSession([call], "auto-checkpoint");
		beginSessionToolEffect(manager, { toolCallId: call.id, toolName: call.name, args: call.arguments });
		const toolResult = result(call, "done", 30);
		writeToolEffectResult(journalPath, readDurableToolEffects(journalPath)[0]!.intent.effectId, toolResult);
		const sessionEntryId = manager.appendMessage(toolResult);
		manager.flushSessionFile();
		commitSessionToolEffect(manager, toolResult, sessionEntryId);

		expect(decodeRecords(journalPath).map((record) => record.kind)).toEqual(["checkpoint"]);
		expect(readDurableToolEffects(journalPath)).toEqual([]);
	});

	it("preserves finalization-pending and finalized results across a checkpoint", () => {
		const pending = { id: "call-pending-final", name: "pending", arguments: {} };
		const finalized = { id: "call-finalized", name: "finalized", arguments: {} };
		const { manager, assistantEntryId, journalPath } = createSession([pending, finalized], "checkpoint-finalization");
		const pendingIntent = beginDirect(journalPath, assistantEntryId, pending, 0, "checkpoint-finalization");
		const finalizedIntent = beginDirect(journalPath, assistantEntryId, finalized, 1, "checkpoint-finalization");
		const pendingResult = result(pending, "execution pending finalization", 31);
		const executionResult = result(finalized, "execution result", 32);
		const finalResult = result(finalized, "final transformed result", 33);
		writeToolEffectResult(journalPath, pendingIntent.effectId, pendingResult, { finalizationPending: true });
		writeToolEffectResult(journalPath, finalizedIntent.effectId, executionResult, { finalizationPending: true });
		writeToolEffectFinalResult(journalPath, finalizedIntent.effectId, finalResult, 34);

		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		expect(inspectToolEffect(manager, pendingIntent.effectId).phase).toBe("finalization_unknown");
		expect(inspectToolEffect(manager, finalizedIntent.effectId).phase).toBe("result_durable");
		expect(
			readDurableToolEffects(journalPath).find((effect) => effect.intent.effectId === finalizedIntent.effectId),
		).toEqual(expect.objectContaining({ result: finalResult }));
	});

	it("keeps the old committed journal after checkpoint failure and recovers without repeating the tool", () => {
		process.env.PI_TOOL_EFFECT_CHECKPOINT_RECORDS = "3";
		const call = { id: "call-checkpoint-failure", name: "write", arguments: {} };
		const { manager, journalPath, sessionFile } = createSession([call], "checkpoint-failure");
		beginSessionToolEffect(manager, { toolCallId: call.id, toolName: call.name, args: call.arguments });
		const toolResult = result(call, "side effect already happened", 40);
		writeToolEffectResult(journalPath, readDurableToolEffects(journalPath)[0]!.intent.effectId, toolResult);
		const sessionEntryId = manager.appendMessage(toolResult);
		manager.flushSessionFile();
		const beforeCommit = readFileSync(journalPath, "utf8");
		setToolEffectJournalTestHooks({
			onCheckpointStage: (stage) => {
				if (stage === "before_replace") throw new Error("injected checkpoint failure");
			},
		});
		expect(() => commitSessionToolEffect(manager, toolResult, sessionEntryId)).toThrow("injected checkpoint failure");
		const afterFailure = readFileSync(journalPath, "utf8");
		expect(afterFailure.startsWith(beforeCommit)).toBe(true);
		expect(decodeRecords(journalPath).map((record) => record.kind)).toEqual(["intent", "result", "commit"]);

		setToolEffectJournalTestHooks(undefined);
		const resumed = SessionManager.open(sessionFile);
		expect(recoverToolEffects(resumed)).toEqual({ recoveredToolCallIds: [], acknowledgedToolCallIds: [] });
		expect(resumed.buildSessionContext().messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(decodeRecords(journalPath).map((record) => record.kind)).toEqual(["checkpoint"]);
	});

	it("leaves the source byte-for-byte intact at every pre-replace crash point", () => {
		for (const stage of ["after_temp_open", "after_temp_write", "after_temp_fsync", "before_replace"] as const) {
			const call = { id: `call-${stage}`, name: "write", arguments: {} };
			const { assistantEntryId, journalPath } = createSession([call], `crash-${stage}`);
			beginDirect(journalPath, assistantEntryId, call, 0, `crash-${stage}`);
			const before = readFileSync(journalPath);
			setToolEffectJournalTestHooks({
				onCheckpointStage: (current) => {
					if (current === stage) throw new Error(`crash at ${stage}`);
				},
			});
			expect(() => checkpointToolEffectJournal(journalPath)).toThrow(`crash at ${stage}`);
			expect(readFileSync(journalPath)).toEqual(before);
			expect(readDurableToolEffects(journalPath)).toHaveLength(1);
			expect(readdirSync(dirname(journalPath)).some((name) => name.includes(".checkpoint-"))).toBe(false);
			setToolEffectJournalTestHooks(undefined);
		}
	});

	it("recovers the exact unresolved state from every post-replace crash point", () => {
		for (const stage of ["after_replace", "before_directory_fsync", "after_directory_fsync"] as const) {
			const call = { id: `call-${stage}`, name: "write", arguments: {} };
			const { assistantEntryId, journalPath } = createSession([call], `post-replace-${stage}`);
			const intent = beginDirect(journalPath, assistantEntryId, call, 0, `post-replace-${stage}`);
			const toolResult = result(call, "durable unresolved result", 45);
			writeToolEffectResult(journalPath, intent.effectId, toolResult);
			setToolEffectJournalTestHooks({
				onCheckpointStage: (current) => {
					if (current === stage) throw new Error(`crash at ${stage}`);
				},
			});
			expect(() => checkpointToolEffectJournal(journalPath)).toThrow(`crash at ${stage}`);
			expect(readDurableToolEffects(journalPath)).toEqual([
				expect.objectContaining({ result: toolResult, committedSessionEntryId: undefined }),
			]);
			expect(decodeRecords(journalPath)[0]).toEqual(expect.objectContaining({ kind: "checkpoint", generation: 1 }));
			setToolEffectJournalTestHooks(undefined);
			expect(checkpointToolEffectJournal(journalPath)).toBe(true);
			expect(decodeRecords(journalPath)[0]).toEqual(expect.objectContaining({ kind: "checkpoint", generation: 2 }));
		}
	});

	it("retries Windows EPERM a bounded number of times and never deletes the source on failure", () => {
		if (process.platform !== "win32") return;
		process.env.PI_TOOL_EFFECT_WINDOWS_RENAME_RETRIES = "2";
		const call = { id: "call-rename-failure", name: "write", arguments: {} };
		const { assistantEntryId, journalPath } = createSession([call], "rename-failure");
		beginDirect(journalPath, assistantEntryId, call, 0, "rename-failure");
		const before = readFileSync(journalPath);
		let attempts = 0;
		setToolEffectJournalTestHooks({
			beforeRenameAttempt: () => {
				attempts++;
				throw createErrnoError("EPERM");
			},
		});
		expect(() => checkpointToolEffectJournal(journalPath)).toThrow();
		expect(attempts).toBe(3);
		expect(readFileSync(journalPath)).toEqual(before);

		attempts = 0;
		setToolEffectJournalTestHooks({
			beforeRenameAttempt: () => {
				attempts++;
				if (attempts < 3) throw createErrnoError("EPERM");
			},
		});
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		expect(attempts).toBe(3);
		expect(decodeRecords(journalPath)[0]?.kind).toBe("checkpoint");
	});

	it("fails admission before a new side effect without truncating oversized unresolved state", () => {
		const first = { id: "call-capacity-first", name: "first", arguments: {} };
		const second = { id: "call-capacity-second", name: "second", arguments: {} };
		const { assistantEntryId, journalPath } = createSession([first, second], "capacity");
		const intent = beginDirect(journalPath, assistantEntryId, first, 0, "capacity");
		writeToolEffectResult(journalPath, intent.effectId, result(first, "x".repeat(4096), 50));
		const before = readFileSync(journalPath);
		process.env.PI_TOOL_EFFECT_MAX_UNRESOLVED_BYTES = "1024";

		expect(() => beginDirect(journalPath, assistantEntryId, second, 1, "capacity")).toThrow(
			ToolEffectJournalCapacityError,
		);
		expect(readFileSync(journalPath)).toEqual(before);
		expect(readDurableToolEffects(journalPath)[0]?.result).toEqual(result(first, "x".repeat(4096), 50));
	});

	it("enforces the unresolved effect-count admission limit before writing a new intent", () => {
		process.env.PI_TOOL_EFFECT_MAX_UNRESOLVED_EFFECTS = "2";
		const calls = [
			{ id: "call-count-1", name: "first", arguments: {} },
			{ id: "call-count-2", name: "second", arguments: {} },
			{ id: "call-count-3", name: "third", arguments: {} },
		];
		const { assistantEntryId, journalPath } = createSession(calls, "count-capacity");
		beginDirect(journalPath, assistantEntryId, calls[0]!, 0, "count-capacity");
		beginDirect(journalPath, assistantEntryId, calls[1]!, 1, "count-capacity");
		const before = readFileSync(journalPath);

		expect(() => beginDirect(journalPath, assistantEntryId, calls[2]!, 2, "count-capacity")).toThrow(
			ToolEffectJournalCapacityError,
		);
		expect(readFileSync(journalPath)).toEqual(before);
		expect(readDurableToolEffects(journalPath)).toHaveLength(2);
	});

	it("chains each checkpoint to the exact preceding record count and file hash", () => {
		const call = { id: "call-chain", name: "write", arguments: {} };
		const { assistantEntryId, journalPath } = createSession([call], "checkpoint-chain");
		const intent = beginDirect(journalPath, assistantEntryId, call, 0, "checkpoint-chain");
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		const first = readFileSync(journalPath);
		writeToolEffectResult(journalPath, intent.effectId, result(call, "done", 60));
		const secondSource = readFileSync(journalPath);
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);

		expect(decodeRecords(journalPath)[0]).toEqual(
			expect.objectContaining({
				kind: "checkpoint",
				generation: 2,
				previousRecordCount: 3,
				previousSha256: createHash("sha256").update(secondSource).digest("hex"),
			}),
		);
		expect(secondSource.subarray(0, first.byteLength)).toEqual(first);
	});

	it("compacts twenty thousand committed effects to a bounded integrity checkpoint", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tool-effect-stress-"));
		temporaryDirectories.push(directory);
		const journalPath = join(directory, "stress.jsonl.tool-effects.jsonl");
		const effectCount = 20_000;
		const lines: string[] = [];
		let sequence = 0;
		for (let index = 0; index < effectCount; index++) {
			const effectId = createHash("sha256").update(`effect-${index}`).digest("hex");
			const toolCallId = `call-${index}`;
			lines.push(
				encodeRecord({
					version: 1,
					kind: "intent",
					sequence: sequence++,
					timestamp: index,
					effectId,
					sessionId: "stress",
					assistantEntryId: `assistant-${index}`,
					toolCallId,
					toolName: "stress",
					toolCallIndex: 0,
					argumentsHash: createHash("sha256").update("{}").digest("hex"),
				}),
				encodeRecord({
					version: 1,
					kind: "result",
					sequence: sequence++,
					timestamp: index,
					effectId,
					message: {
						role: "toolResult",
						toolCallId,
						toolName: "stress",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: index,
					},
				}),
				encodeRecord({
					version: 1,
					kind: "commit",
					sequence: sequence++,
					timestamp: index,
					effectId,
					sessionEntryId: `entry-${index}`,
				}),
			);
		}
		writeFileSync(journalPath, lines.join(""), { encoding: "utf8", mode: 0o600 });
		const before = readFileSync(journalPath);
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);

		const records = decodeRecords(journalPath);
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(
			expect.objectContaining({
				kind: "checkpoint",
				previousRecordCount: effectCount * 3,
				previousSha256: createHash("sha256").update(before).digest("hex"),
				snapshotRecordCount: 0,
			}),
		);
		expect(statSync(journalPath).size).toBeLessThan(1024);
		expect(readDurableToolEffects(journalPath)).toEqual([]);
	});

	it("rejects a complete but truncated checkpoint snapshot instead of dropping an unresolved effect", () => {
		const call = { id: "call-snapshot-integrity", name: "write", arguments: {} };
		const { assistantEntryId, journalPath } = createSession([call], "snapshot-integrity");
		beginDirect(journalPath, assistantEntryId, call, 0, "snapshot-integrity");
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
		writeFileSync(journalPath, `${lines[0]}\n`, "utf8");
		expect(() => readDurableToolEffects(journalPath)).toThrow("checkpoint snapshot is incomplete");
	});

	it("creates owner-only checkpoint files on platforms with POSIX modes", () => {
		const call = { id: "call-mode", name: "write", arguments: {} };
		const { assistantEntryId, journalPath } = createSession([call], "checkpoint-mode");
		beginDirect(journalPath, assistantEntryId, call, 0, "checkpoint-mode");
		expect(checkpointToolEffectJournal(journalPath)).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(journalPath).mode & 0o777).toBe(0o600);
		}
	});
});
