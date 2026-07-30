import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type AgentMessage,
	buildSessionContext,
	convertToLlm,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedSessions, savePersistedSession } from "../src/session-persistence.ts";
import {
	appendCompactionEntry,
	appendSessionEntries,
	clearAllSessions,
	getSession,
	getSessionBranch,
	replaceSessionTree,
	setStaticContext,
	switchSessionLeaf,
} from "../src/session-store.ts";

function decodeWalRecord(line: string): Record<string, unknown> {
	const parsed = JSON.parse(line) as Record<string, unknown>;
	return (parsed.version === 3 || parsed.version === 4 || parsed.version === 5) && typeof parsed.payload === "string"
		? (JSON.parse(parsed.payload) as Record<string, unknown>)
		: parsed;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function rewriteWalRecord(
	path: string,
	mutate: (record: Record<string, unknown>) => void,
): { byteLength: number; digest: string } {
	const envelope = JSON.parse(readFileSync(path, "utf-8").trim()) as Record<string, unknown>;
	if (typeof envelope.payload !== "string") throw new Error("WAL envelope payload is missing");
	const record = JSON.parse(envelope.payload) as Record<string, unknown>;
	mutate(record);
	const payload = JSON.stringify(record);
	const digest = sha256(payload);
	const encoded = `${JSON.stringify({ version: record.version, payload, sha256: digest })}\n`;
	writeFileSync(path, encoded, "utf-8");
	return { byteLength: Buffer.byteLength(encoded), digest };
}

function rewriteHeadRecord(path: string, mutate: (record: Record<string, unknown>) => void): void {
	const envelope = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	if (typeof envelope.payload !== "string") throw new Error("Head envelope payload is missing");
	const record = JSON.parse(envelope.payload) as Record<string, unknown>;
	mutate(record);
	const payload = JSON.stringify(record);
	writeFileSync(path, JSON.stringify({ version: 1, payload, sha256: sha256(payload) }), "utf-8");
}

describe("session-persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		clearAllSessions();
		tempDir = mkdtempSync(join(tmpdir(), "pi-server-session-persistence-"));
	});

	afterEach(() => {
		clearAllSessions();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("replaces an existing persisted session file with the latest tree", () => {
		const first = replaceSessionTree(
			"persist-overwrite",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"u1",
		);
		savePersistedSession(tempDir, first);

		const second = replaceSessionTree(
			"persist-overwrite",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
				{
					type: "message",
					id: "u2",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"u2",
		);
		savePersistedSession(tempDir, second);

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-overwrite")?.messages.map((message) => message.content)).toEqual(["one", "two"]);
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
	});

	it("persists appended tree entries through WAL without rewriting the snapshot", () => {
		const first = replaceSessionTree(
			"persist-wal",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"u1",
		);
		savePersistedSession(tempDir, first);
		const baseRevision = first.revision;

		const appended = appendSessionEntries(
			"persist-wal",
			[
				{
					type: "message",
					id: "u2",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"u2",
		);
		savePersistedSession(tempDir, appended);

		const jsonFile = readdirSync(tempDir).find((name) => name.endsWith(".json"));
		expect(jsonFile).toBeTruthy();
		const snapshot = readFileSync(join(tempDir, jsonFile!), "utf-8");
		expect(snapshot).toContain('"content":"one"');
		expect(snapshot).not.toContain('"content":"two"');
		const walFile = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(walFile).toBeTruthy();
		const walRecords = readFileSync(join(tempDir, walFile!), "utf-8").trim().split("\n").map(decodeWalRecord);
		expect(walRecords[0]).toMatchObject({
			version: 5,
			sequence: 0,
			baseRevision,
			baseEntryCount: 1,
			leafId: "u2",
		});
		expect(JSON.stringify(walRecords[0])).toContain('"content":"two"');

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-wal")?.messages.map((message) => message.content)).toEqual(["one", "two"]);
	});

	it("repairs only an uncommitted WAL tail and rejects committed checksum corruption", () => {
		const first = replaceSessionTree(
			"persist-torn-wal",
			[
				{
					type: "message",
					id: "torn-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "torn-one", timestamp: 1000 },
				},
			],
			"torn-u1",
		);
		savePersistedSession(tempDir, first);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				"persist-torn-wal",
				[
					{
						type: "message",
						id: "torn-u2",
						parentId: "torn-u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "torn-two", timestamp: 2000 },
					},
				],
				"torn-u2",
			),
		);
		const tornWalName = readdirSync(tempDir).find(
			(name) => name.endsWith(".wal") && readFileSync(join(tempDir, name), "utf-8").includes("torn-two"),
		);
		expect(tornWalName).toBeTruthy();
		const tornWalPath = join(tempDir, tornWalName!);
		appendFileSync(tornWalPath, '{"version":3,"payload":"torn"', "utf-8");

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-torn-wal")?.messages.map((message) => message.content)).toEqual([
			"torn-one",
			"torn-two",
		]);
		expect(readFileSync(tornWalPath, "utf-8").endsWith("\n")).toBe(true);

		const corrupt = replaceSessionTree(
			"persist-corrupt-wal",
			[
				{
					type: "message",
					id: "corrupt-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "corrupt-one", timestamp: 1000 },
				},
			],
			"corrupt-u1",
		);
		savePersistedSession(tempDir, corrupt);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				"persist-corrupt-wal",
				[
					{
						type: "message",
						id: "corrupt-u2",
						parentId: "corrupt-u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "corrupt-two", timestamp: 2000 },
					},
				],
				"corrupt-u2",
			),
		);
		const corruptWalName = readdirSync(tempDir).find(
			(name) => name.endsWith(".wal") && readFileSync(join(tempDir, name), "utf-8").includes("corrupt-two"),
		);
		expect(corruptWalName).toBeTruthy();
		const corruptWalPath = join(tempDir, corruptWalName!);
		const corrupted = readFileSync(corruptWalPath, "utf-8").replace(
			/"sha256":"[a-f0-9]{64}"/u,
			`"sha256":"${"0".repeat(64)}"`,
		);
		writeFileSync(corruptWalPath, corrupted, "utf-8");

		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).toThrow("Persisted session WAL checksum mismatch");
	});

	it("restores existing version 1 WAL records without clearing their static context", () => {
		const first = replaceSessionTree(
			"persist-v1-wal",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"u1",
		);
		setStaticContext("persist-v1-wal", { systemPrompt: "snapshot context", tools: [] });
		savePersistedSession(tempDir, first);
		const snapshotFile = readdirSync(tempDir).find((name) => name.endsWith(".json"));
		expect(snapshotFile).toBeTruthy();
		const durableSnapshot = JSON.parse(readFileSync(join(tempDir, snapshotFile!), "utf-8")) as {
			session: unknown;
		};
		writeFileSync(
			join(tempDir, snapshotFile!),
			JSON.stringify({ version: 1, session: durableSnapshot.session }),
			"utf-8",
		);
		for (const name of readdirSync(tempDir)) {
			if (name.includes(".head.") || name.endsWith(".wal")) {
				rmSync(join(tempDir, name), { force: true });
			}
		}
		appendFileSync(
			join(tempDir, `${snapshotFile}.wal`),
			`${JSON.stringify({
				version: 1,
				sessionId: "persist-v1-wal",
				baseEntryCount: 1,
				entries: [
					{
						type: "message",
						id: "u2",
						parentId: "u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "two", timestamp: 2000 },
					},
				],
				leafId: "u2",
				revision: first.revision + 1,
				updatedAt: first.updatedAt + 1,
				staticContext: { systemPrompt: "v1 context", tools: [] },
			})}\n`,
			"utf-8",
		);

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-v1-wal")?.messages.map((message) => message.content)).toEqual(["one", "two"]);
		expect(getSession("persist-v1-wal")?.staticContext).toEqual({ systemPrompt: "v1 context", tools: [] });
	});

	it("preserves complete compaction entries and rebuilds identical contexts after reload", () => {
		const retainedMessage: AgentMessage = {
			role: "user",
			content: "retained context",
			timestamp: 3000,
		};
		const cases: Array<{ sessionId: string; retainedTail: AgentMessage[]; fromHook?: boolean }> = [
			{ sessionId: "persist-compaction-tail", retainedTail: [retainedMessage], fromHook: true },
			{ sessionId: "persist-compaction-empty-tail", retainedTail: [] },
		];
		const usage = {
			input: 40,
			output: 20,
			cacheRead: 10,
			cacheWrite: 5,
			cacheWrite1h: 3,
			reasoning: 7,
			totalTokens: 75,
			cost: { input: 0.4, output: 0.2, cacheRead: 0.1, cacheWrite: 0.05, total: 0.75 },
		};
		const messagesBeforeReload = new Map<string, ReturnType<typeof convertToLlm>>();

		for (const { sessionId, retainedTail, fromHook } of cases) {
			const firstId = `${sessionId}-u1`;
			const keptId = `${sessionId}-u2`;
			const initial = replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: firstId,
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "old context", timestamp: 1000 },
					},
					{
						type: "message",
						id: keptId,
						parentId: firstId,
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "legacy kept context", timestamp: 2000 },
					},
				],
				keptId,
			);
			savePersistedSession(tempDir, initial);

			const { session, entry } = appendCompactionEntry(sessionId, {
				summary: `summary for ${sessionId}`,
				firstKeptEntryId: keptId,
				tokensBefore: 100,
				retainedTail,
				details: { source: "provider", sessionId },
				usage,
				...(fromHook !== undefined ? { fromHook } : {}),
			});
			savePersistedSession(tempDir, session);
			messagesBeforeReload.set(sessionId, session.messages);

			expect(Object.hasOwn(entry, "retainedTail")).toBe(true);
			expect(entry.retainedTail).toEqual(retainedTail);
			expect(entry.usage).toEqual(usage);
			expect(entry.details).toEqual({ source: "provider", sessionId });
			expect(entry.fromHook).toBe(fromHook);
		}

		clearAllSessions();
		loadPersistedSessions(tempDir);

		for (const { sessionId, retainedTail, fromHook } of cases) {
			const loaded = getSession(sessionId);
			expect(loaded).toBeDefined();
			if (!loaded) throw new Error(`Session ${sessionId} was not restored`);
			const entry = loaded.entries.at(-1);
			expect(entry?.type).toBe("compaction");
			if (entry?.type !== "compaction") throw new Error(`Session ${sessionId} did not restore its compaction`);
			expect(Object.hasOwn(entry, "retainedTail")).toBe(true);
			expect(entry.retainedTail).toEqual(retainedTail);
			expect(entry.usage).toEqual(usage);
			expect(entry.details).toEqual({ source: "provider", sessionId });
			expect(entry.fromHook).toBe(fromHook);

			const rebuiltMessages = convertToLlm(buildSessionContext(getSessionBranch(loaded)).messages);
			expect(loaded.messages).toEqual(rebuiltMessages);
			expect(loaded.messages).toEqual(messagesBeforeReload.get(sessionId));
		}
	});

	it("writes static context only when it changes and restores the latest value", () => {
		const largeDescription = "x".repeat(100_000);
		const first = replaceSessionTree(
			"persist-static-context",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"u1",
		);
		setStaticContext("persist-static-context", {
			systemPrompt: "first",
			tools: [{ name: "large", description: largeDescription, parameters: { type: "object" } }],
		});
		savePersistedSession(tempDir, first);

		const appended = appendSessionEntries(
			"persist-static-context",
			[
				{
					type: "message",
					id: "u2",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"u2",
		);
		savePersistedSession(tempDir, appended);
		const walFile = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(walFile).toBeTruthy();
		const walAfterAppend = readFileSync(join(tempDir, walFile!), "utf-8");
		expect(walAfterAppend).not.toContain(largeDescription);

		setStaticContext("persist-static-context", {
			systemPrompt: "second",
			tools: [{ name: "small", description: "changed", parameters: { type: "object" } }],
		});
		savePersistedSession(tempDir, getSession("persist-static-context")!);
		switchSessionLeaf("persist-static-context", "u1");
		savePersistedSession(tempDir, getSession("persist-static-context")!);

		const walLines = readFileSync(join(tempDir, walFile!), "utf-8").trim().split("\n").map(decodeWalRecord);
		expect(walLines).toHaveLength(3);
		expect(walLines[0]).not.toHaveProperty("staticContext");
		expect(walLines[1]).toHaveProperty("staticContext");
		expect(walLines[2]).not.toHaveProperty("staticContext");

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-static-context")?.staticContext?.systemPrompt).toBe("second");
		expect(getSession("persist-static-context")?.leafId).toBe("u1");
	});

	it("rolls back a complete WAL record fsynced before its durable head", () => {
		const first = replaceSessionTree(
			"persist-head-rollback",
			[
				{
					type: "message",
					id: "rollback-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"rollback-u1",
		);
		savePersistedSession(tempDir, first);
		const appended = appendSessionEntries(
			"persist-head-rollback",
			[
				{
					type: "message",
					id: "rollback-u2",
					parentId: "rollback-u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"rollback-u2",
		);
		expect(() =>
			savePersistedSession(tempDir, appended, {
				faultInjector: (point) => {
					if (point === "wal_after_sync_before_head") throw new Error("simulated WAL commit crash");
				},
			}),
		).toThrow("simulated WAL commit crash");
		const wal = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(wal).toBeTruthy();
		expect(readFileSync(join(tempDir, wal!)).byteLength).toBeGreaterThan(0);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession("persist-head-rollback")?.messages.map((message) => message.content)).toEqual(["one"]);
		expect(readFileSync(join(tempDir, wal!)).byteLength).toBe(0);
	});

	it("recovers an uncommitted WAL record before a same-process retry", () => {
		const sessionId = "persist-head-same-process-retry";
		savePersistedSession(
			tempDir,
			replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: "same-process-u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				"same-process-u1",
			),
		);
		const appended = appendSessionEntries(
			sessionId,
			[
				{
					type: "message",
					id: "same-process-u2",
					parentId: "same-process-u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"same-process-u2",
		);
		expect(() =>
			savePersistedSession(tempDir, appended, {
				faultInjector: (point) => {
					if (point === "wal_after_sync_before_head") {
						throw new Error("simulated same-process WAL commit crash");
					}
				},
			}),
		).toThrow("simulated same-process WAL commit crash");

		savePersistedSession(tempDir, appended);
		const wal = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(wal).toBeTruthy();
		expect(readFileSync(join(tempDir, wal!), "utf-8").trim().split("\n")).toHaveLength(1);
		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual(["one", "two"]);
	});

	it("rejects WAL truncation before the byte length committed by the durable head", () => {
		const first = replaceSessionTree(
			"persist-wal-rollback",
			[
				{
					type: "message",
					id: "wal-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"wal-u1",
		);
		savePersistedSession(tempDir, first);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				"persist-wal-rollback",
				[
					{
						type: "message",
						id: "wal-u2",
						parentId: "wal-u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "two", timestamp: 2000 },
					},
				],
				"wal-u2",
			),
		);
		const wal = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(wal).toBeTruthy();
		truncateSync(join(tempDir, wal!), 0);

		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).toThrow("shorter than its durable head");
	});

	it("rejects valid-checksum WAL sequence, revision, and digest chain mutations", () => {
		const cases: Array<{
			name: string;
			mutate: (record: Record<string, unknown>) => void;
			error: string;
		}> = [
			{
				name: "sequence",
				mutate: (record) => {
					record.sequence = 1;
				},
				error: "sequence mismatch",
			},
			{
				name: "unsafe-sequence",
				mutate: (record) => {
					record.sequence = 0.5;
				},
				error: "non-negative safe integer",
			},
			{
				name: "revision",
				mutate: (record) => {
					record.baseRevision = (record.baseRevision as number) + 1;
				},
				error: "revision chain mismatch",
			},
			{
				name: "previous-state",
				mutate: (record) => {
					record.previousStateDigest = "0".repeat(64);
				},
				error: "previous state digest mismatch",
			},
			{
				name: "post-state",
				mutate: (record) => {
					record.stateDigest = "0".repeat(64);
				},
				error: "post state digest mismatch",
			},
			{
				name: "wal-digest",
				mutate: (record) => {
					record.previousWalDigest = "0".repeat(64);
				},
				error: "digest chain mismatch",
			},
		];

		for (const testCase of cases) {
			const caseDir = mkdtempSync(join(tempDir, `${testCase.name}-`));
			const sessionId = `chain-${testCase.name}`;
			const firstId = `${testCase.name}-u1`;
			const secondId = `${testCase.name}-u2`;
			const first = replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: firstId,
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				firstId,
			);
			savePersistedSession(caseDir, first);
			savePersistedSession(
				caseDir,
				appendSessionEntries(
					sessionId,
					[
						{
							type: "message",
							id: secondId,
							parentId: firstId,
							timestamp: "2026-01-01T00:00:01.000Z",
							message: { role: "user", content: "two", timestamp: 2000 },
						},
					],
					secondId,
				),
			);
			const wal = readdirSync(caseDir).find((name) => name.endsWith(".wal"));
			expect(wal).toBeTruthy();
			const rewritten = rewriteWalRecord(join(caseDir, wal!), testCase.mutate);
			if (testCase.name === "unsafe-sequence") {
				const latestHead = readdirSync(caseDir).find((name) => name.endsWith(".head.1"));
				expect(latestHead).toBeTruthy();
				rewriteHeadRecord(join(caseDir, latestHead!), (record) => {
					record.walByteLength = rewritten.byteLength;
					record.walTailDigest = rewritten.digest;
				});
			}
			clearAllSessions();
			expect(() => loadPersistedSessions(caseDir)).toThrow(testCase.error);
			clearAllSessions();
		}
	});

	it("rolls back a new snapshot generation fsynced before its durable head", () => {
		const session = replaceSessionTree(
			"persist-orphan-snapshot",
			[
				{
					type: "message",
					id: "orphan-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"orphan-u1",
		);
		savePersistedSession(tempDir, session);
		const anchor = readdirSync(tempDir).find((name) => name.endsWith(".json"));
		expect(anchor).toBeTruthy();
		const updated = replaceSessionTree(
			"persist-orphan-snapshot",
			[
				{
					type: "message",
					id: "orphan-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
				{
					type: "message",
					id: "orphan-u2",
					parentId: "orphan-u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			"orphan-u2",
		);
		expect(() =>
			savePersistedSession(tempDir, updated, {
				faultInjector: (point) => {
					if (point === "snapshot_after_sync_before_head") throw new Error("simulated snapshot commit crash");
				},
			}),
		).toThrow("simulated snapshot commit crash");
		expect(readdirSync(tempDir)).toContain(`${anchor}.snapshot.1`);
		expect(readdirSync(tempDir)).toContain(`${anchor}.wal.1`);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession("persist-orphan-snapshot")?.messages.map((message) => message.content)).toEqual(["one"]);
		expect(readdirSync(tempDir)).not.toContain(`${anchor}.snapshot.1`);
		expect(readdirSync(tempDir)).not.toContain(`${anchor}.wal.1`);
	});

	it("rejects a durable head whose active rotated snapshot disappeared", () => {
		const sessionId = "persist-missing-active-snapshot";
		const entryId = "missing-u1";
		savePersistedSession(
			tempDir,
			replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: entryId,
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				entryId,
			),
		);
		let leaf: string | null = entryId;
		for (let index = 0; index < 33; index++) {
			leaf = leaf === null ? entryId : null;
			savePersistedSession(tempDir, switchSessionLeaf(sessionId, leaf));
		}
		const activeSnapshot = readdirSync(tempDir).find((name) => name.endsWith(".snapshot.1"));
		expect(activeSnapshot).toBeTruthy();
		rmSync(join(tempDir, activeSnapshot!));

		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).toThrow("snapshot referenced by durable head is missing");
	});

	it("rejects committed durable head checksum corruption", () => {
		const session = replaceSessionTree(
			"persist-corrupt-head",
			[
				{
					type: "message",
					id: "head-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"head-u1",
		);
		savePersistedSession(tempDir, session);
		const head = readdirSync(tempDir).find((name) => name.endsWith(".head.0"));
		expect(head).toBeTruthy();
		const corrupted = readFileSync(join(tempDir, head!), "utf-8").replace(
			/"sha256":"[a-f0-9]{64}"/u,
			`"sha256":"${"0".repeat(64)}"`,
		);
		writeFileSync(join(tempDir, head!), corrupted, "utf-8");

		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).toThrow("head checksum mismatch");
	});

	it("loads legacy version 2 and enveloped version 3 WAL records", () => {
		const sessionId = "persist-v2-v3-wal";
		const anchorName = `${sha256(sessionId)}.json`;
		writeFileSync(
			join(tempDir, anchorName),
			JSON.stringify({
				version: 1,
				session: {
					sessionId,
					entries: [
						{
							type: "message",
							id: "legacy-u1",
							parentId: null,
							timestamp: "2026-01-01T00:00:00.000Z",
							message: { role: "user", content: "one", timestamp: 1000 },
						},
					],
					leafId: "legacy-u1",
					revision: 1,
					createdAt: 1000,
					updatedAt: 1000,
				},
			}),
			"utf-8",
		);
		const version2 = {
			version: 2,
			sessionId,
			baseEntryCount: 1,
			entries: [
				{
					type: "message",
					id: "legacy-u2",
					parentId: "legacy-u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "two", timestamp: 2000 },
				},
			],
			leafId: "legacy-u2",
			revision: 2,
			updatedAt: 2000,
		};
		const version3 = {
			version: 3,
			sessionId,
			baseEntryCount: 2,
			entries: [
				{
					type: "message",
					id: "legacy-u3",
					parentId: "legacy-u2",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: { role: "user", content: "three", timestamp: 3000 },
				},
			],
			leafId: "legacy-u3",
			revision: 3,
			updatedAt: 3000,
		};
		const payload = JSON.stringify(version3);
		appendFileSync(
			join(tempDir, `${anchorName}.wal`),
			`${JSON.stringify(version2)}\n${JSON.stringify({ version: 3, payload, sha256: sha256(payload) })}\n`,
			"utf-8",
		);

		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual(["one", "two", "three"]);

		savePersistedSession(
			tempDir,
			appendSessionEntries(
				sessionId,
				[
					{
						type: "message",
						id: "legacy-u4",
						parentId: "legacy-u3",
						timestamp: "2026-01-01T00:00:03.000Z",
						message: { role: "user", content: "four", timestamp: 4000 },
					},
				],
				"legacy-u4",
			),
		);
		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual([
			"one",
			"two",
			"three",
			"four",
		]);
	});

	it("loads durable version 4 WAL records and appends version 5 transitions", () => {
		const sessionId = "persist-v4-v5-wal";
		const first = replaceSessionTree(
			sessionId,
			[
				{
					type: "message",
					id: "v4-u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
			],
			"v4-u1",
		);
		savePersistedSession(tempDir, first);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				sessionId,
				[
					{
						type: "message",
						id: "v4-u2",
						parentId: "v4-u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "two", timestamp: 2000 },
					},
				],
				"v4-u2",
			),
		);

		const snapshotName = readdirSync(tempDir).find((name) => name.endsWith(".json"));
		const walName = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		const headName = readdirSync(tempDir).find((name) => name.endsWith(".head.1"));
		expect(snapshotName).toBeTruthy();
		expect(walName).toBeTruthy();
		expect(headName).toBeTruthy();
		const snapshot = JSON.parse(readFileSync(join(tempDir, snapshotName!), "utf-8")) as {
			session: {
				sessionId: string;
				staticContext?: unknown;
				entries: SessionTreeEntry[];
				leafId: string | null;
				revision: number;
				createdAt: number;
				updatedAt: number;
			};
		};
		const walEnvelope = JSON.parse(readFileSync(join(tempDir, walName!), "utf-8").trim()) as {
			payload: string;
		};
		const walRecord = JSON.parse(walEnvelope.payload) as {
			version: number;
			entries: SessionTreeEntry[];
			leafId: string | null;
			revision: number;
			updatedAt: number;
			stateDigest: string;
			staticContextChanged: boolean;
			staticContext?: unknown;
		};
		const replayedState = structuredClone(snapshot.session);
		replayedState.entries.push(...structuredClone(walRecord.entries));
		replayedState.leafId = walRecord.leafId;
		replayedState.revision = walRecord.revision;
		replayedState.updatedAt = walRecord.updatedAt;
		if (walRecord.staticContextChanged) replayedState.staticContext = structuredClone(walRecord.staticContext);
		walRecord.version = 4;
		walRecord.stateDigest = sha256(JSON.stringify(replayedState));
		const version4Payload = JSON.stringify(walRecord);
		const version4Digest = sha256(version4Payload);
		const version4Encoded = `${JSON.stringify({
			version: 4,
			payload: version4Payload,
			sha256: version4Digest,
		})}\n`;
		writeFileSync(join(tempDir, walName!), version4Encoded, "utf-8");
		rewriteHeadRecord(join(tempDir, headName!), (record) => {
			record.walByteLength = Buffer.byteLength(version4Encoded);
			record.walTailDigest = version4Digest;
			record.stateDigest = walRecord.stateDigest;
		});

		clearAllSessions();
		loadPersistedSessions(tempDir);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				sessionId,
				[
					{
						type: "message",
						id: "v5-u3",
						parentId: "v4-u2",
						timestamp: "2026-01-01T00:00:02.000Z",
						message: { role: "user", content: "three", timestamp: 3000 },
					},
				],
				"v5-u3",
			),
		);

		const versions = readFileSync(join(tempDir, walName!), "utf-8")
			.trim()
			.split("\n")
			.map((line) => decodeWalRecord(line).version);
		expect(versions).toEqual([4, 5]);
		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual(["one", "two", "three"]);
	});

	it("checkpoints when WAL bytes exceed the proportional replay boundary", () => {
		const sessionId = "persist-byte-checkpoint";
		savePersistedSession(
			tempDir,
			replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: "byte-u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				"byte-u1",
			),
		);
		savePersistedSession(
			tempDir,
			appendSessionEntries(
				sessionId,
				[
					{
						type: "message",
						id: "byte-u2",
						parentId: "byte-u1",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: { role: "user", content: "x".repeat(1024 * 1024), timestamp: 2000 },
					},
				],
				"byte-u2",
			),
		);
		const initialWal = readdirSync(tempDir).find((name) => name.endsWith(".wal"));
		expect(initialWal).toBeTruthy();
		expect(readFileSync(join(tempDir, initialWal!)).byteLength).toBeGreaterThan(1024 * 1024);

		savePersistedSession(tempDir, switchSessionLeaf(sessionId, "byte-u1"));
		expect(readdirSync(tempDir).some((name) => name.endsWith(".snapshot.1"))).toBe(true);
		const rotatedWal = readdirSync(tempDir).find((name) => name.endsWith(".wal.1"));
		expect(rotatedWal).toBeTruthy();
		expect(readFileSync(join(tempDir, rotatedWal!)).byteLength).toBe(0);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.entries).toHaveLength(2);
		expect(getSession(sessionId)?.leafId).toBe("byte-u1");
	});

	it("rolls back a proportional checkpoint that crashes before its durable head", () => {
		const sessionId = "persist-proportional-checkpoint-crash";
		const entries: SessionTreeEntry[] = Array.from({ length: 64 }, (_, index) => ({
			type: "custom",
			id: `checkpoint-${index}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "checkpoint",
		}));
		const entryId = entries.at(-1)!.id;
		savePersistedSession(tempDir, replaceSessionTree(sessionId, entries, entryId));
		let expectedLeaf: string | null = entryId;
		for (let index = 0; index < entries.length; index++) {
			expectedLeaf = expectedLeaf === null ? entryId : null;
			savePersistedSession(tempDir, switchSessionLeaf(sessionId, expectedLeaf));
		}
		expect(expectedLeaf).toBe(entryId);
		const next = switchSessionLeaf(sessionId, null);
		expect(() =>
			savePersistedSession(tempDir, next, {
				faultInjector: (point) => {
					if (point === "snapshot_after_sync_before_head") {
						throw new Error("simulated proportional checkpoint crash");
					}
				},
			}),
		).toThrow("simulated proportional checkpoint crash");
		expect(readdirSync(tempDir).some((name) => name.endsWith(".snapshot.1"))).toBe(true);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.leafId).toBe(entryId);
		expect(readdirSync(tempDir).some((name) => name.endsWith(".snapshot.1"))).toBe(false);
	});

	it("recovers an uncommitted snapshot before a same-process retry", () => {
		const sessionId = "persist-snapshot-same-process-retry";
		const entryId = "same-process-snapshot-u1";
		savePersistedSession(
			tempDir,
			replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: entryId,
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				entryId,
			),
		);
		let leaf: string | null = entryId;
		for (let index = 0; index < 32; index++) {
			leaf = leaf === null ? entryId : null;
			savePersistedSession(tempDir, switchSessionLeaf(sessionId, leaf));
		}
		expect(leaf).toBe(entryId);
		const next = switchSessionLeaf(sessionId, null);
		expect(() =>
			savePersistedSession(tempDir, next, {
				faultInjector: (point) => {
					if (point === "snapshot_after_sync_before_head") {
						throw new Error("simulated same-process snapshot commit crash");
					}
				},
			}),
		).toThrow("simulated same-process snapshot commit crash");

		savePersistedSession(tempDir, next);
		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.leafId).toBeNull();
	});

	it("keeps 100k-entry mutation persistence linear and restartable", () => {
		const sessionId = "persist-100k-linear";
		const entries: SessionTreeEntry[] = Array.from({ length: 100_000 }, (_, index) => ({
			type: "custom",
			id: `large-${index}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "large",
		}));
		const entryId = entries.at(-1)!.id;
		savePersistedSession(tempDir, replaceSessionTree(sessionId, entries, entryId));

		const mutationStartedAt = performance.now();
		let expectedLeaf: string | null = entryId;
		for (let index = 0; index < 96; index++) {
			expectedLeaf = expectedLeaf === null ? entryId : null;
			savePersistedSession(tempDir, switchSessionLeaf(sessionId, expectedLeaf));
		}
		const mutationElapsedMs = performance.now() - mutationStartedAt;
		const names = readdirSync(tempDir);
		expect(names.filter((name) => name.includes(".snapshot."))).toEqual([]);
		const walName = names.find((name) => name.endsWith(".wal"));
		expect(walName).toBeTruthy();
		expect(readFileSync(join(tempDir, walName!), "utf-8").trim().split("\n")).toHaveLength(96);
		expect(mutationElapsedMs).toBeLessThan(5000);

		clearAllSessions();
		const reloadStartedAt = performance.now();
		loadPersistedSessions(tempDir);
		const reloadElapsedMs = performance.now() - reloadStartedAt;
		expect(getSession(sessionId)?.entries).toHaveLength(entries.length);
		expect(getSession(sessionId)?.leafId).toBe(expectedLeaf);
		expect(reloadElapsedMs).toBeLessThan(5000);
	});

	it("rotates through two durable snapshot slots without retaining unbounded generations", () => {
		const sessionId = "persist-bounded-generations";
		const entryId = "bounded-u1";
		savePersistedSession(
			tempDir,
			replaceSessionTree(
				sessionId,
				[
					{
						type: "message",
						id: entryId,
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "one", timestamp: 1000 },
					},
				],
				entryId,
			),
		);
		let expectedLeaf: string | null = entryId;
		for (let index = 0; index < 100; index++) {
			expectedLeaf = expectedLeaf === null ? entryId : null;
			savePersistedSession(tempDir, switchSessionLeaf(sessionId, expectedLeaf));
		}

		const names = readdirSync(tempDir);
		expect(names.filter((name) => name.includes(".snapshot."))).toHaveLength(2);
		expect(names.filter((name) => name.includes(".head."))).toHaveLength(2);
		expect(names.filter((name) => name.includes(".wal"))).toHaveLength(3);
		const headGenerations = names
			.filter((name) => name.includes(".head."))
			.map((name) => {
				const envelope = JSON.parse(readFileSync(join(tempDir, name), "utf-8")) as { payload: string };
				return (JSON.parse(envelope.payload) as { generation: number }).generation;
			});
		expect(Math.max(...headGenerations)).toBe(3);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		expect(getSession(sessionId)?.leafId).toBe(expectedLeaf);
	});
});
