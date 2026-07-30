import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPiServerSessionEntries } from "../../src/core/pi-server-protocol.ts";
import {
	type CompactionEntry,
	type SessionEntry,
	SessionManager,
	setSessionManagerPersistenceTestHooks,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function makeCompactionEntry(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-07-31T00:00:00.000Z",
		summary: "durable summary",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

describe.sequential("SessionManager durable tree persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-durable-tree-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		setSessionManagerPersistenceTestHooks(undefined);
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createMaterializedSession(): {
		session: SessionManager;
		sessionFile: string;
		firstEntryId: string;
		leafId: string;
	} {
		const session = SessionManager.create(tempDir, tempDir);
		const firstEntryId = session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) {
			throw new Error("Expected a materialized session file");
		}
		return { session, sessionFile, firstEntryId, leafId };
	}

	it("preserves the original file and in-memory tree after bounded Windows EPERM rename retries", () => {
		const { session, sessionFile, firstEntryId, leafId } = createMaterializedSession();
		const originalContent = readFileSync(sessionFile);
		const originalEntryIds = session.getEntries().map((entry) => entry.id);
		const compaction = makeCompactionEntry("compact-rename-failure", leafId, firstEntryId);
		const nextEntries = [...session.getEntries(), compaction];
		let renameAttempts = 0;

		setSessionManagerPersistenceTestHooks({
			simulateWindowsRenameRetries: true,
			beforeRenameAttempt: () => {
				renameAttempts++;
				const error = new Error("target is locked") as Error & { code: string };
				error.code = "EPERM";
				throw error;
			},
		});

		expect(() => session.replaceTree(nextEntries, compaction.id)).toThrow("target is locked");
		expect(renameAttempts).toBe(5);
		expect(readFileSync(sessionFile)).toEqual(originalContent);
		expect(session.getEntries().map((entry) => entry.id)).toEqual(originalEntryIds);
		expect(session.getLeafId()).toBe(leafId);
		expect(readdirSync(tempDir).filter((name) => name.includes(".rewrite-"))).toEqual([]);
	});

	it("cleans the private temp file and preserves the original before replacement", () => {
		const { session, sessionFile, firstEntryId, leafId } = createMaterializedSession();
		const originalContent = readFileSync(sessionFile);
		const compaction = makeCompactionEntry("compact-temp-fsync-failure", leafId, firstEntryId);

		setSessionManagerPersistenceTestHooks({
			onAtomicRewriteStage: (stage) => {
				if (stage === "after_temp_fsync") {
					throw new Error("injected crash before replace");
				}
			},
		});

		expect(() => session.replaceTree([...session.getEntries(), compaction], compaction.id)).toThrow(
			"injected crash before replace",
		);
		expect(readFileSync(sessionFile)).toEqual(originalContent);
		expect(session.getEntry(compaction.id)).toBeUndefined();
		expect(session.getLeafId()).toBe(leafId);
		expect(readdirSync(tempDir).filter((name) => name.includes(".rewrite-"))).toEqual([]);
	});

	it("fails closed after a rewrite error that occurs after replacement", () => {
		const { session, sessionFile, firstEntryId, leafId } = createMaterializedSession();
		const originalEntries = session.getEntries();
		const compaction = makeCompactionEntry("compact-post-replace-failure", leafId, firstEntryId);

		setSessionManagerPersistenceTestHooks({
			onAtomicRewriteStage: (stage) => {
				if (stage === "after_replace") {
					throw new Error("injected crash after replace");
				}
			},
		});

		expect(() => session.replaceTree([...originalEntries, compaction], compaction.id)).toThrow("may have replaced");
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
		expect(readFileSync(sessionFile, "utf8")).toContain(compaction.id);
		expect(() => session.appendMessage(userMsg("must reopen"))).toThrow("indeterminate prior failure");
		expect(() => session.replaceTree(originalEntries, leafId)).toThrow("indeterminate prior failure");

		setSessionManagerPersistenceTestHooks(undefined);
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEntry(compaction.id)).toEqual(compaction);
		expect(reopened.getLeafId()).toBe(compaction.id);
	});

	it("recovers an exact compaction appended before an injected process failure without duplicating it", () => {
		const { session, sessionFile, firstEntryId, leafId } = createMaterializedSession();
		const baseEntries = session.getEntries();
		const base = {
			baseEntryCount: baseEntries.length,
			baseLeafId: leafId,
			baseTreeHash: hashPiServerSessionEntries(baseEntries),
		};
		const compaction = makeCompactionEntry("compact-crash-recovery", leafId, firstEntryId);

		setSessionManagerPersistenceTestHooks({
			onCompactionAppendStage: (stage) => {
				if (stage === "after_append") {
					throw new Error("injected process failure after append");
				}
			},
		});

		expect(() => session.appendCompactionEntry(compaction, base)).toThrow(
			"may have reached disk but was not committed in memory",
		);
		expect(session.getEntry(compaction.id)).toBeUndefined();
		expect(() => session.appendCompactionEntry(compaction, base)).toThrow("indeterminate prior failure");

		setSessionManagerPersistenceTestHooks(undefined);
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEntry(compaction.id)).toEqual(compaction);
		expect(reopened.appendCompactionEntry(compaction, base)).toBe(compaction.id);
		expect(reopened.getEntries().filter((entry) => entry.id === compaction.id)).toHaveLength(1);
		expect(readFileSync(sessionFile, "utf8").match(/compact-crash-recovery/g)).toHaveLength(1);
	});

	it("does not commit normal appends in memory after an indeterminate durable append", () => {
		const { session, sessionFile, leafId } = createMaterializedSession();
		const originalEntries = session.getEntries();
		setSessionManagerPersistenceTestHooks({
			onAppendStage: (stage) => {
				if (stage === "after_append") throw new Error("injected normal append failure");
			},
		});

		expect(() => session.appendMessage(userMsg("durable third message"))).toThrow(
			"may have reached disk but was not committed in memory",
		);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
		expect(() => session.appendMessage(userMsg("must fail closed"))).toThrow("indeterminate prior failure");

		setSessionManagerPersistenceTestHooks(undefined);
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEntries()).toHaveLength(originalEntries.length + 1);
		expect(reopened.getLeafId()).not.toBe(leafId);
	});

	it("rejects divergent base, leaf, parent, first-kept entry, and duplicate id without mutation", () => {
		const session = SessionManager.inMemory();
		const firstEntryId = session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const base = {
			baseEntryCount: 2,
			baseLeafId: leafId,
			baseTreeHash: hashPiServerSessionEntries(session.getEntries()),
		};
		const originalEntries = session.getEntries();

		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry("wrong-count", leafId, firstEntryId), {
				...base,
				baseEntryCount: 0,
			}),
		).toThrow("base entry count mismatch");
		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry("wrong-leaf", leafId, firstEntryId), {
				...base,
				baseLeafId: firstEntryId,
			}),
		).toThrow("base leaf mismatch");
		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry("wrong-hash", leafId, firstEntryId), {
				...base,
				baseTreeHash: "0".repeat(64),
			}),
		).toThrow("base tree hash mismatch");
		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry("wrong-parent", firstEntryId, firstEntryId), base),
		).toThrow("parent mismatch");
		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry("wrong-first-kept", leafId, "missing"), base),
		).toThrow("first-kept entry missing does not exist");
		expect(() =>
			session.appendCompactionEntry(makeCompactionEntry(firstEntryId, leafId, firstEntryId), base),
		).toThrow(`Compaction entry id ${firstEntryId} already exists`);
		expect(session.getEntries()).toEqual(originalEntries);
		expect(session.getLeafId()).toBe(leafId);
	});

	it("preserves native in-memory extension data while failing closed if it cannot hash the compact base", () => {
		const session = SessionManager.inMemory();
		const firstEntryId = session.appendMessage(userMsg("question"));
		const cyclicData: { self?: unknown } = {};
		cyclicData.self = cyclicData;
		const leafId = session.appendCustomEntry("cyclic-extension-state", cyclicData);
		const compaction = makeCompactionEntry("compact-unhashable-base", leafId, firstEntryId);

		const savedEntry = session.getEntry(leafId);
		expect(savedEntry?.type).toBe("custom");
		if (savedEntry?.type !== "custom") throw new Error("Expected custom entry");
		expect(savedEntry.data).toBe(cyclicData);
		expect(() =>
			session.appendCompactionEntry(compaction, {
				baseEntryCount: 2,
				baseLeafId: leafId,
				baseTreeHash: "0".repeat(64),
			}),
		).toThrow("local tree contains a non-serializable entry");
		expect(session.getEntry(compaction.id)).toBeUndefined();
	});

	it("appends one exact compaction delta to a large history without invoking a full rewrite", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const entryCount = 10_000;
		const entries: SessionEntry[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < entryCount; index++) {
			const id = `entry-${index}`;
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp: "2026-07-31T00:00:00.000Z",
				message: userMsg(`message-${index}`),
			});
			parentId = id;
		}
		session.replaceTree(entries, parentId);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const originalContent = readFileSync(sessionFile);
		const compaction = makeCompactionEntry("compact-large-history", parentId!, entries[5_000].id);
		const baseTreeHash = hashPiServerSessionEntries(entries);
		const rewriteStages: string[] = [];
		const appendStages: string[] = [];
		setSessionManagerPersistenceTestHooks({
			onAtomicRewriteStage: (stage) => rewriteStages.push(stage),
			onCompactionAppendStage: (stage) => appendStages.push(stage),
		});

		expect(
			session.appendCompactionEntry(compaction, {
				baseEntryCount: entryCount,
				baseLeafId: parentId,
				baseTreeHash,
			}),
		).toBe(compaction.id);

		const updatedContent = readFileSync(sessionFile);
		const expectedDelta = Buffer.from(`${JSON.stringify(compaction)}\n`);
		expect(rewriteStages).toEqual([]);
		expect(appendStages).toEqual(["after_append", "after_fsync"]);
		expect(updatedContent.subarray(0, originalContent.byteLength)).toEqual(originalContent);
		expect(updatedContent.subarray(originalContent.byteLength)).toEqual(expectedDelta);
		expect(session.getEntries()).toHaveLength(entryCount + 1);
		expect(session.getLeafId()).toBe(compaction.id);
	});
});
