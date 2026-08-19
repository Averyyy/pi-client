import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedSessions, savePersistedSession } from "../src/session-persistence.ts";
import { appendMessages, clearAllSessions, getSession } from "../src/session-store.ts";

function sessionFilePath(sessionStoreDir: string, sessionId: string): string {
	const fileName = `${createHash("sha256").update(sessionId).digest("hex")}.json`;
	return join(sessionStoreDir, fileName);
}

function snapshot(sessionId: string, entries: unknown[], leafId: string | null) {
	return {
		version: 1,
		session: {
			sessionId,
			staticContext: { systemPrompt: "test", tools: [] },
			entries,
			leafId,
			revision: entries.length,
			createdAt: 1000,
			updatedAt: 1000,
		},
	};
}

function userEntry(id: string, parentId: string | null, content: string, timestamp: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content, timestamp },
	};
}

describe("session-persistence WAL torn tail recovery", () => {
	let testDir: string;

	beforeEach(() => {
		clearAllSessions();
		testDir = mkdtempSync(join(tmpdir(), "pi-server-torn-wal-"));
	});

	afterEach(() => {
		clearAllSessions();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("recovers a torn tail, truncates it, and can persist again", () => {
		const sessionId = "test-session-torn";
		const entry1 = userEntry("entry-1", null, "hello", 1000);
		const entry2 = userEntry("entry-2", "entry-1", "world", 2000);
		const sessionFile = sessionFilePath(testDir, sessionId);
		const walFile = `${sessionFile}.wal`;
		writeFileSync(sessionFile, JSON.stringify(snapshot(sessionId, [entry1], "entry-1")));
		const completeRecord = {
			version: 1,
			sessionId,
			baseEntryCount: 1,
			entries: [entry2],
			leafId: "entry-2",
			revision: 2,
			updatedAt: 2000,
			staticContext: { systemPrompt: "test", tools: [] },
		};
		const tornRecord = '{"version":1,"sessionId":"test-session-torn","baseEntryCount":2';
		writeFileSync(walFile, `${JSON.stringify(completeRecord)}\n${tornRecord}`);

		expect(() => loadPersistedSessions(testDir)).not.toThrow();
		expect(getSession(sessionId)?.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2"]);
		expect(readFileSync(walFile, "utf8")).toBe(`${JSON.stringify(completeRecord)}\n`);

		const updated = appendMessages(sessionId, [{ role: "user", content: "after restart", timestamp: 3000 }]);
		savePersistedSession(testDir, updated);
		clearAllSessions();
		loadPersistedSessions(testDir);
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual([
			"hello",
			"world",
			"after restart",
		]);
	});

	it("handles a torn line followed by a trailing newline", () => {
		const sessionId = "test-session-torn-newline";
		const sessionFile = sessionFilePath(testDir, sessionId);
		const walFile = `${sessionFile}.wal`;
		writeFileSync(sessionFile, JSON.stringify(snapshot(sessionId, [], null)));
		writeFileSync(walFile, '{"version":1,"sessionId":"test-session-torn-newline"\n\n');

		expect(() => loadPersistedSessions(testDir)).not.toThrow();
		expect(getSession(sessionId)?.entries).toEqual([]);
		expect(readFileSync(walFile, "utf8")).toBe("");
	});

	it("ignores stale WAL records left behind after a newer snapshot rename", () => {
		const sessionId = "test-session-stale-wal";
		const entry1 = userEntry("entry-1", null, "one", 1000);
		const entry2 = userEntry("entry-2", "entry-1", "two", 2000);
		const sessionFile = sessionFilePath(testDir, sessionId);
		const walFile = `${sessionFile}.wal`;
		const currentSnapshot = snapshot(sessionId, [entry1, entry2], "entry-2");
		currentSnapshot.session.revision = 2;
		writeFileSync(sessionFile, JSON.stringify(currentSnapshot));
		writeFileSync(
			walFile,
			`${JSON.stringify({
				version: 1,
				sessionId,
				baseEntryCount: 2,
				entries: [],
				leafId: "entry-1",
				revision: 1,
				updatedAt: 1500,
				staticContext: { systemPrompt: "stale", tools: [] },
			})}\n`,
		);

		loadPersistedSessions(testDir);
		expect(getSession(sessionId)?.leafId).toBe("entry-2");
		expect(getSession(sessionId)?.revision).toBe(2);
		expect(getSession(sessionId)?.staticContext?.systemPrompt).toBe("test");
	});

	it("does not treat a complete invalid tail record as a torn line", () => {
		const sessionId = "test-session-invalid-tail";
		const sessionFile = sessionFilePath(testDir, sessionId);
		const walFile = `${sessionFile}.wal`;
		writeFileSync(sessionFile, JSON.stringify(snapshot(sessionId, [], null)));
		const invalidCompleteRecord = {
			version: 999,
			sessionId,
			baseEntryCount: 0,
			entries: [],
			leafId: null,
			revision: 1,
			updatedAt: 2000,
			staticContext: { systemPrompt: "test", tools: [] },
		};
		writeFileSync(walFile, JSON.stringify(invalidCompleteRecord));

		expect(() => loadPersistedSessions(testDir)).not.toThrow();
		expect(getSession(sessionId)).toBeUndefined();
		expect(readFileSync(walFile, "utf8")).toBe(JSON.stringify(invalidCompleteRecord));
	});
});
