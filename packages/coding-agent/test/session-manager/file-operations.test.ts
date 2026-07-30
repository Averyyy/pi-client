import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionHeader(file: string, cwd: string, id: string, prefix = ""): void {
		writeFileSync(
			file,
			`${prefix}${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd,
			})}\n`,
		);
	}

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow(`Malformed session JSONL at ${file}:1`);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("rejects malformed lines instead of silently dropping history", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(() => loadEntriesFromFile(file)).toThrow(`Malformed session JSONL at ${file}:2`);
	});

	it("rejects a torn final append instead of resuming with truncated history", () => {
		const file = join(tempDir, "torn-final.jsonl");
		const original =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n{"type":"message"';
		writeFileSync(file, original);
		expect(() => SessionManager.open(file, tempDir)).toThrow(`Malformed session JSONL at ${file}:2`);
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it.each([
		["leading blank lines", "\n  \n", "leading-blank"],
		["a multi-buffer header", "", "a".repeat(8192)],
	])("reads cwd from a session with %s", (_description, prefix, sessionId) => {
		const file = join(tempDir, "header.jsonl");
		const storedCwd = join(tempDir, "stored-project");
		writeSessionHeader(file, storedCwd, sessionId, prefix);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe(sessionId);
		expect(sessionManager.getCwd()).toBe(storedCwd);
	});

	it("rejects malformed content before a valid header", () => {
		const file = join(tempDir, "malformed-prefix.jsonl");
		writeSessionHeader(file, tempDir, "valid-header", "not json\n");
		expect(() => SessionManager.open(file, tempDir)).toThrow(`Malformed session JSONL at ${file}:1`);
	});

	it("opens compatible sessions beyond the discovery scan limit", () => {
		const storedCwd = join(tempDir, "stored-project");
		const overrideCwd = join(tempDir, "override-project");
		const cases = [{ name: "large-header", id: "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1), prefix: "" }];

		for (const { name, id, prefix } of cases) {
			const file = join(tempDir, `${name}.jsonl`);
			writeSessionHeader(file, storedCwd, id, prefix);
			for (const cwdOverride of [undefined, overrideCwd]) {
				const sessionManager = SessionManager.open(file, tempDir, cwdOverride);
				expect(sessionManager.getSessionId()).toBe(id);
				expect(sessionManager.getCwd()).toBe(cwdOverride ?? storedCwd);
			}
		}
	});

	it("streams session files larger than the read buffer", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		appendFileSync(
			file,
			`${" ".repeat(2 * 1024 * 1024)}\n{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n`,
		);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips oversized corrupt files and returns a valid session", () => {
		const invalid = join(tempDir, "oversized.jsonl");
		const valid = join(tempDir, "valid.jsonl");
		writeFileSync(invalid, "x".repeat(HEADER_SCAN_LIMIT_BYTES + 1));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("flushes an existing persisted session file and skips non-materialized sessions", () => {
		const sessionFile = createPersistedSession(projectA, "durable reply");
		const session = SessionManager.open(sessionFile, tempDir);

		expect(() => session.flushSessionFile()).not.toThrow();
		expect(readFileSync(sessionFile, "utf-8")).toContain("reply to durable reply");
		expect(() => SessionManager.inMemory(projectA).flushSessionFile()).not.toThrow();

		rmSync(sessionFile);
		expect(() => session.flushSessionFile()).not.toThrow();
	});

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});

	it("drains concurrent session readers before surfacing corruption", async () => {
		for (let index = 0; index < 12; index++) {
			writeFileSync(join(tempDir, `corrupt-${index}.jsonl`), `{"type":"session"\n`);
		}

		await expect(SessionManager.listAll(tempDir)).rejects.toThrow("Malformed session JSONL");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionManager.open(nonSessionFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${nonSessionFile}`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of initialized empty file work correctly", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = SessionManager.open(emptyFile, tempDir);
		const sessionId = sm1.getSessionId();

		const sm2 = SessionManager.open(emptyFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
