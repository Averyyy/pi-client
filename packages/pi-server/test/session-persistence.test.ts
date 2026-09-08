import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedSessions, savePersistedSession } from "../src/session-persistence.ts";
import {
	appendMessages,
	appendSessionEntries,
	clearAllSessions,
	getSession,
	replaceSessionTree,
	setStaticContext,
} from "../src/session-store.ts";

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
		expect(readFileSync(join(tempDir, walFile!), "utf-8")).toContain('"content":"two"');

		clearAllSessions();
		loadPersistedSessions(tempDir);

		expect(getSession("persist-wal")?.messages.map((message) => message.content)).toEqual(["one", "two"]);
	});

	it("persists changed static context through WAL across restart", () => {
		const sessionId = "persist-static-context";
		const initial = setStaticContext(sessionId, { systemPrompt: "old prompt", tools: [] });
		savePersistedSession(tempDir, initial);
		expect(initial.revision).toBe(1);

		const promptUpdated = setStaticContext(sessionId, { systemPrompt: "new prompt", tools: [] });
		savePersistedSession(tempDir, promptUpdated);
		const promptRevision = promptUpdated.revision;
		expect(promptRevision).toBe(2);

		const duplicate = setStaticContext(sessionId, { systemPrompt: "new prompt", tools: [] });
		savePersistedSession(tempDir, duplicate);
		expect(duplicate.revision).toBe(promptRevision);

		clearAllSessions();
		loadPersistedSessions(tempDir);
		const promptRestored = getSession(sessionId);
		expect(promptRestored?.staticContext).toEqual({ systemPrompt: "new prompt", tools: [] });
		expect(promptRestored?.revision).toBe(promptRevision);

		const toolsUpdated = setStaticContext(sessionId, {
			systemPrompt: "new prompt",
			tools: [{ name: "read", description: "Read a file", parameters: {} }],
		});
		savePersistedSession(tempDir, toolsUpdated);
		const toolsRevision = toolsUpdated.revision;
		expect(toolsRevision).toBe(promptRevision + 1);
		const staticContextHash = toolsUpdated.staticContextHash;

		clearAllSessions();
		loadPersistedSessions(tempDir);

		const restored = getSession(sessionId);
		expect(restored?.staticContext).toEqual(toolsUpdated.staticContext);
		expect(restored?.staticContextHash).toBe(staticContextHash);
		expect(restored?.revision).toBe(toolsRevision);
	});

	it("keeps static context updates after message WAL records and a snapshot cycle", () => {
		const sessionId = "persist-static-context-cycle";
		const initial = setStaticContext(sessionId, { systemPrompt: "v0", tools: [] });
		savePersistedSession(tempDir, initial);
		const withMessage = appendMessages(sessionId, [{ role: "user", content: "message", timestamp: 1000 }]);
		savePersistedSession(tempDir, withMessage);

		for (let index = 1; index <= 33; index++) {
			const updated = setStaticContext(sessionId, { systemPrompt: `v${index}`, tools: [] });
			savePersistedSession(tempDir, updated);
		}

		clearAllSessions();
		loadPersistedSessions(tempDir);

		const restored = getSession(sessionId);
		expect(restored?.staticContext?.systemPrompt).toBe("v33");
		expect(restored?.messages.map((message) => message.content)).toEqual(["message"]);
		expect(restored?.revision).toBe(35);
	});
});
