import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPiServerSessionEntries } from "../../src/core/pi-server-protocol.ts";
import {
	type CompactionEntry,
	calculateSessionManagerLogicalBytes,
	configureSessionManagerCapacityLimits,
	DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS,
	ENV_SESSION_MAX_ENTRIES,
	ENV_SESSION_MAX_FILE_BYTES,
	ENV_SESSION_MAX_LOGICAL_BYTES,
	getSessionManagerCapacityLimits,
	resetSessionManagerCapacityLimits,
	type SessionEntry,
	SessionManager,
	SessionManagerCapacityError,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const CAPACITY_ENVIRONMENT_NAMES = [
	ENV_SESSION_MAX_ENTRIES,
	ENV_SESSION_MAX_LOGICAL_BYTES,
	ENV_SESSION_MAX_FILE_BYTES,
] as const;

function makeEntry(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-31T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

function makeCompactionEntry(parentId: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id: "capacity-compaction",
		parentId,
		timestamp: "2026-07-31T00:00:01.000Z",
		summary: "compact",
		firstKeptEntryId,
		tokensBefore: 1,
	};
}

describe.sequential("SessionManager capacity", () => {
	let tempDir: string;
	let originalEnvironment: Map<string, string | undefined>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-capacity-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		originalEnvironment = new Map(CAPACITY_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
		for (const name of CAPACITY_ENVIRONMENT_NAMES) delete process.env[name];
		resetSessionManagerCapacityLimits();
	});

	afterEach(() => {
		resetSessionManagerCapacityLimits();
		for (const [name, value] of originalEnvironment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses stable defaults and accepts only explicit positive safe environment overrides", () => {
		const defaultFileBytes =
			DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxLogicalBytes +
			DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxEntries +
			1024 * 1024;
		expect(getSessionManagerCapacityLimits()).toEqual({
			...DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS,
			maxFileBytes: defaultFileBytes,
		});

		process.env[ENV_SESSION_MAX_ENTRIES] = String(DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxEntries + 1);
		process.env[ENV_SESSION_MAX_LOGICAL_BYTES] = String(DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxLogicalBytes + 1);
		process.env[ENV_SESSION_MAX_FILE_BYTES] = String(defaultFileBytes + 1);
		expect(getSessionManagerCapacityLimits()).toEqual({
			maxEntries: DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxEntries + 1,
			maxLogicalBytes: DEFAULT_SESSION_MANAGER_CAPACITY_LIMITS.maxLogicalBytes + 1,
			maxFileBytes: defaultFileBytes + 1,
		});

		process.env[ENV_SESSION_MAX_ENTRIES] = "0";
		expect(() => getSessionManagerCapacityLimits()).toThrow(
			`${ENV_SESSION_MAX_ENTRIES} must be a positive safe integer`,
		);
	});

	it("counts Unicode UTF-8 bytes at the exact logical boundary and rejects one byte over", () => {
		const entry = makeEntry("unicode", null, "汉字🙂");
		const logicalBytes = calculateSessionManagerLogicalBytes([entry]);
		expect(logicalBytes).toBe(Buffer.byteLength(JSON.stringify(entry), "utf8"));

		configureSessionManagerCapacityLimits({
			maxEntries: 1,
			maxLogicalBytes: logicalBytes,
			maxFileBytes: 1024 * 1024,
		});
		const session = SessionManager.inMemory(tempDir, { id: "unicode-session" });
		expect(() => session.replaceTree([entry], entry.id)).not.toThrow();

		const originalEntries = session.getEntries();
		const originalLeafId = session.getLeafId();
		configureSessionManagerCapacityLimits({ maxLogicalBytes: logicalBytes - 1 });
		let error: unknown;
		try {
			session.replaceTree([entry], entry.id);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SessionManagerCapacityError);
		expect(error).toMatchObject({
			resource: "logical_bytes",
			sessionId: "unicode-session",
			requested: logicalBytes,
			limit: logicalBytes - 1,
			retryable: false,
		});
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(originalLeafId);
	});

	it("preflights append entry count without changing the active leaf", () => {
		configureSessionManagerCapacityLimits({
			maxEntries: 1,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: 1024 * 1024,
		});
		const session = SessionManager.inMemory(tempDir, { id: "append-session" });
		const firstId = session.appendMessage(userMsg("first"));
		const originalEntries = session.getEntries();

		expect(() => session.appendMessage(userMsg("second"))).toThrowError(
			expect.objectContaining({
				resource: "entries",
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(firstId);

		expect(() => session.branchWithSummary(null, "would exceed capacity")).toThrow(SessionManagerCapacityError);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(firstId);
	});

	it("stats the file before load and accepts the exact artifact limit only", () => {
		const file = join(tempDir, "bounded.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "bounded",
			timestamp: "2026-07-31T00:00:00.000Z",
			cwd: tempDir,
		});
		writeFileSync(file, header);
		const exactBytes = Buffer.byteLength(header);
		configureSessionManagerCapacityLimits({
			maxEntries: 10,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: exactBytes,
		});

		expect(SessionManager.open(file, tempDir).getSessionId()).toBe("bounded");
		appendFileSync(file, " ");
		const originalFile = readFileSync(file);
		expect(() => SessionManager.open(file, tempDir)).toThrowError(
			expect.objectContaining({
				resource: "file_bytes",
				path: file,
				requested: exactBytes + 1,
				limit: exactBytes,
			}),
		);
		expect(readFileSync(file)).toEqual(originalFile);
	});

	it("enforces streaming entry capacity without modifying the oversized source", () => {
		const file = join(tempDir, "too-many.jsonl");
		const entries = [makeEntry("one", null, "一"), makeEntry("two", "one", "二")];
		const content = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "stream-capacity",
				timestamp: "2026-07-31T00:00:00.000Z",
				cwd: tempDir,
			}),
			...entries.map((entry) => JSON.stringify(entry)),
		].join("\n");
		writeFileSync(file, `${content}\n`);
		const originalFile = readFileSync(file);
		configureSessionManagerCapacityLimits({
			maxEntries: 1,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: 1024 * 1024,
		});

		expect(() => SessionManager.open(file, tempDir)).toThrowError(
			expect.objectContaining({
				resource: "entries",
				sessionId: "stream-capacity",
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(readFileSync(file)).toEqual(originalFile);
	});

	it("keeps the reconciled tree and file unchanged when replaceTree exceeds capacity", () => {
		const session = SessionManager.create(tempDir, tempDir, { id: "reconcile-session" });
		const firstId = session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const originalFile = readFileSync(sessionFile);
		const originalEntries = session.getEntries();
		const extraEntry = makeEntry("extra", leafId, "extra");
		configureSessionManagerCapacityLimits({
			maxEntries: 2,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: 1024 * 1024,
		});

		expect(() => session.replaceTree([...originalEntries, extraEntry], extraEntry.id)).toThrow(
			SessionManagerCapacityError,
		);
		expect(readFileSync(sessionFile)).toEqual(originalFile);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
		expect(session.getEntry(firstId)).toBeDefined();
	});

	it("rejects cyclic authoritative reconciliation before replacing memory or disk", () => {
		const session = SessionManager.create(tempDir, tempDir, { id: "cycle-session" });
		session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const originalFile = readFileSync(sessionFile);
		const originalEntries = session.getEntries();
		const first = makeEntry("cycle-a", "cycle-b", "a");
		const second = makeEntry("cycle-b", "cycle-a", "b");

		expect(() => session.replaceTree([first, second], second.id)).toThrow("parent cycle");
		expect(readFileSync(sessionFile)).toEqual(originalFile);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
	});

	it("preflights exact compaction append capacity before touching disk or memory", () => {
		const session = SessionManager.create(tempDir, tempDir, { id: "compact-session" });
		const firstId = session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const originalFile = readFileSync(sessionFile);
		const originalEntries = session.getEntries();
		const compaction = makeCompactionEntry(leafId, firstId);
		configureSessionManagerCapacityLimits({
			maxEntries: originalEntries.length,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: 1024 * 1024,
		});

		expect(() =>
			session.appendCompactionEntry(compaction, {
				baseEntryCount: originalEntries.length,
				baseLeafId: leafId,
				baseTreeHash: hashPiServerSessionEntries(originalEntries),
			}),
		).toThrow(SessionManagerCapacityError);
		expect(readFileSync(sessionFile)).toEqual(originalFile);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
	});

	it("rejects a branched-session replacement before changing the current session", () => {
		const session = SessionManager.create(tempDir, tempDir, { id: "branch-source" });
		session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const originalSessionId = session.getSessionId();
		const originalSessionFile = session.getSessionFile();
		const originalEntries = session.getEntries();
		const originalFiles = readdirSync(tempDir);
		configureSessionManagerCapacityLimits({
			maxEntries: 1,
			maxLogicalBytes: 1024 * 1024,
			maxFileBytes: 1024 * 1024,
		});

		expect(() => session.createBranchedSession(leafId)).toThrow(SessionManagerCapacityError);
		expect(session.getSessionId()).toBe(originalSessionId);
		expect(session.getSessionFile()).toBe(originalSessionFile);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
		expect(readdirSync(tempDir)).toEqual(originalFiles);
	});
});
