import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPersistedSessions } from "../src/session-persistence.ts";
import { getSession } from "../src/session-store.ts";

describe("session-persistence WAL torn tail recovery", () => {
	const testDir = join(process.cwd(), "test-tmp", "torn-wal");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("tolerates torn tail line in WAL and allows server startup", () => {
		const sessionId = "test-session-torn";
		const sessionFile = join(testDir, `${sessionId}.json`);
		const walFile = join(testDir, `${sessionId}.wal`);

		// Create a valid session snapshot
		const snapshot = {
			session: {
				sessionId,
				entries: [
					{
						id: "entry-1",
						parentId: null,
						type: "message" as const,
						message: {
							role: "user" as const,
							content: "hello",
							timestamp: 1000,
						},
					},
				],
				leafId: "entry-1",
				revision: 1,
				updatedAt: 1000,
				staticContext: {
					systemPrompt: "test",
					tools: [],
				},
			},
		};

		writeFileSync(sessionFile, JSON.stringify(snapshot));

		// Write WAL with one complete record and one torn tail line
		const completeRecord = {
			sessionId,
			baseEntryCount: 1,
			entries: [
				{
					id: "entry-2",
					parentId: "entry-1",
					type: "message" as const,
					message: {
						role: "assistant" as const,
						content: "world",
						api: "openai-completions" as const,
						provider: "openai" as const,
						model: "gpt-4",
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: 2000,
					},
				},
			],
			leafId: "entry-2",
			revision: 2,
			updatedAt: 2000,
			staticContext: {
				systemPrompt: "test",
				tools: [],
			},
		};

		const tornRecord = '{"sessionId":"test-session-torn","baseEntryCount":2,"entries":[{"id":"entry-3"';

		writeFileSync(walFile, JSON.stringify(completeRecord) + "\n" + tornRecord);

		// Load should succeed and discard the torn tail line
		expect(() => loadPersistedSessions(testDir)).not.toThrow();

		const session = getSession(sessionId);
		expect(session).toBeDefined();
		expect(session!.entries.length).toBe(2); // Only the complete records
		expect(session!.leafId).toBe("entry-2");
	});

	it("tolerates torn tail line at end with trailing newline", () => {
		const sessionId = "test-session-torn-newline";
		const sessionFile = join(testDir, `${sessionId}.json`);
		const walFile = join(testDir, `${sessionId}.wal`);

		const snapshot = {
			session: {
				sessionId,
				entries: [],
				leafId: null,
				revision: 0,
				updatedAt: 1000,
				staticContext: {
					systemPrompt: "test",
					tools: [],
				},
			},
		};

		writeFileSync(sessionFile, JSON.stringify(snapshot));

		// Torn line followed by empty line (common pattern)
		const tornRecord = '{"sessionId":"test-ses';
		writeFileSync(walFile, tornRecord + "\n");

		expect(() => loadPersistedSessions(testDir)).not.toThrow();

		const session = getSession(sessionId);
		expect(session).toBeDefined();
		expect(session!.entries.length).toBe(0);
	});

	it("throws on corrupted non-tail line", () => {
		const sessionId = "test-session-corrupt-middle";
		const sessionFile = join(testDir, `${sessionId}.json`);
		const walFile = join(testDir, `${sessionId}.wal`);

		const snapshot = {
			session: {
				sessionId,
				entries: [],
				leafId: null,
				revision: 0,
				updatedAt: 1000,
				staticContext: {
					systemPrompt: "test",
					tools: [],
				},
			},
		};

		writeFileSync(sessionFile, JSON.stringify(snapshot));

		// Corrupted line followed by another line (not tail)
		const corruptRecord = '{"sessionId":"corrupt';
		const validRecord = {
			sessionId,
			baseEntryCount: 0,
			entries: [],
			leafId: null,
			revision: 1,
			updatedAt: 2000,
			staticContext: {
				systemPrompt: "test",
				tools: [],
			},
		};

		writeFileSync(walFile, corruptRecord + "\n" + JSON.stringify(validRecord));

		expect(() => loadPersistedSessions(testDir)).toThrow(/invalid JSON/);
	});
});
