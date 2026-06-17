import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedSessions, savePersistedSession } from "../src/session-persistence.ts";
import { clearAllSessions, getSession, replaceSessionTree } from "../src/session-store.ts";

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
});
