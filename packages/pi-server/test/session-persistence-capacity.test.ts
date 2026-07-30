import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configureSessionPersistenceArtifactLimits,
	loadPersistedSessions,
	preflightPersistedSession,
	resetSessionPersistenceArtifactLimits,
	SessionPersistenceCapacityError,
	savePersistedSession,
} from "../src/session-persistence.ts";
import {
	appendSessionEntries,
	clearAllSessions,
	configureSessionCapacityLimits,
	getSession,
	replaceSessionTree,
	resetSessionCapacityLimits,
} from "../src/session-store.ts";

function customEntry(id: string, parentId: string | null = null, text = id): SessionTreeEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-31T00:00:00.000Z",
		customType: "persistence-capacity",
		data: { text },
	};
}

function sessionBasePath(sessionStoreDir: string, sessionId: string): string {
	return join(sessionStoreDir, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function snapshotDirectory(directory: string): Map<string, Buffer> {
	return new Map(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]));
}

describe.sequential("session persistence capacity admission", () => {
	let tempDir: string;

	beforeEach(() => {
		clearAllSessions();
		resetSessionCapacityLimits();
		resetSessionPersistenceArtifactLimits();
		tempDir = mkdtempSync(join(tmpdir(), "pi-server-persistence-capacity-"));
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		clearAllSessions();
		resetSessionCapacityLimits();
		resetSessionPersistenceArtifactLimits();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("accepts the exact snapshot artifact boundary and rejects one byte above it before reading", () => {
		const sessionId = "snapshot-artifact-capacity";
		savePersistedSession(tempDir, replaceSessionTree(sessionId, [customEntry("entry", null, "界🙂")], "entry"));
		const snapshotPath = sessionBasePath(tempDir, sessionId);
		const snapshotBytes = statSync(snapshotPath).size;

		clearAllSessions();
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: snapshotBytes });
		expect(() => loadPersistedSessions(tempDir)).not.toThrow();
		expect(getSession(sessionId)?.entries).toHaveLength(1);

		clearAllSessions();
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: snapshotBytes - 1 });
		let thrown: unknown;
		try {
			loadPersistedSessions(tempDir);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionPersistenceCapacityError);
		expect(thrown).toMatchObject({
			code: "PI_SERVER_SESSION_PERSISTENCE_CAPACITY_EXCEEDED",
			retryable: false,
			resource: "snapshot_artifact_bytes",
			path: snapshotPath,
			requested: snapshotBytes,
			limit: snapshotBytes - 1,
		});
		expect(getSession(sessionId)).toBeUndefined();
	});

	it("rejects an oversized WAL without truncating or deleting any artifact", () => {
		const sessionId = "wal-artifact-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		appendSessionEntries(sessionId, [customEntry("second", first.id)], "second");
		savePersistedSession(tempDir, session);
		const walPath = `${sessionBasePath(tempDir, sessionId)}.wal`;
		appendFileSync(walPath, "uncommitted-tail");
		const before = snapshotDirectory(tempDir);
		const walBytes = statSync(walPath).size;

		clearAllSessions();
		configureSessionPersistenceArtifactLimits({ maxWalBytes: walBytes - 1 });
		expect(() => loadPersistedSessions(tempDir)).toThrowError(
			expect.objectContaining({
				resource: "wal_artifact_bytes",
				sessionId,
				path: walPath,
				requested: walBytes,
				limit: walBytes - 1,
			}),
		);
		expect(getSession(sessionId)).toBeUndefined();
		expect(snapshotDirectory(tempDir)).toEqual(before);
	});

	it("checks every WAL transition and leaves startup state and files untouched on overflow", () => {
		const sessionId = "wal-transition-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		appendSessionEntries(sessionId, [customEntry("second", first.id)], "second");
		savePersistedSession(tempDir, session);
		const before = snapshotDirectory(tempDir);

		clearAllSessions();
		configureSessionCapacityLimits({ maxEntriesPerSession: 1 });
		expect(() => loadPersistedSessions(tempDir)).toThrowError(
			expect.objectContaining({
				resource: "session_entries",
				sessionId,
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(getSession(sessionId)).toBeUndefined();
		expect(snapshotDirectory(tempDir)).toEqual(before);
	});

	it("stages all sessions before enforcing aggregate capacity", () => {
		for (const sessionId of ["batch-a", "batch-b"]) {
			const entry = customEntry(`${sessionId}-entry`);
			savePersistedSession(tempDir, replaceSessionTree(sessionId, [entry], entry.id));
		}
		const before = snapshotDirectory(tempDir);

		clearAllSessions();
		configureSessionCapacityLimits({ maxAggregateEntries: 1 });
		expect(() => loadPersistedSessions(tempDir)).toThrowError(
			expect.objectContaining({
				resource: "aggregate_entries",
				current: 0,
				requested: 2,
				limit: 1,
			}),
		);
		expect(getSession("batch-a")).toBeUndefined();
		expect(getSession("batch-b")).toBeUndefined();
		expect(snapshotDirectory(tempDir)).toEqual(before);
	});

	it("validates every staged tree before committing any restored session", () => {
		const validId = "staged-valid";
		const invalidId = "staged-invalid";
		const validEntry = customEntry("valid");
		const cyclicEntry = customEntry("cyclic", "cyclic");
		const state = (sessionId: string, entries: SessionTreeEntry[], leafId: string) => ({
			sessionId,
			entries,
			leafId,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		});
		writeFileSync(
			sessionBasePath(tempDir, validId),
			JSON.stringify({ version: 1, session: state(validId, [validEntry], validEntry.id) }),
		);
		writeFileSync(
			sessionBasePath(tempDir, invalidId),
			JSON.stringify({ version: 1, session: state(invalidId, [cyclicEntry], cyclicEntry.id) }),
		);

		expect(() => loadPersistedSessions(tempDir)).toThrow("parent cycle");
		expect(getSession(validId)).toBeUndefined();
		expect(getSession(invalidId)).toBeUndefined();
	});

	it("rejects oversized snapshot and head encodings before creating an artifact", () => {
		const sessionId = "write-artifact-capacity";
		const session = replaceSessionTree(sessionId, [customEntry("entry")], "entry");

		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: 1 });
		expect(() => savePersistedSession(tempDir, session)).toThrowError(
			expect.objectContaining({ resource: "snapshot_artifact_bytes", sessionId }),
		);
		expect(readdirSync(tempDir)).toEqual([]);

		resetSessionPersistenceArtifactLimits();
		configureSessionPersistenceArtifactLimits({ maxHeadBytes: 1 });
		expect(() => savePersistedSession(tempDir, session)).toThrowError(
			expect.objectContaining({ resource: "head_artifact_bytes", sessionId }),
		);
		expect(readdirSync(tempDir)).toEqual([]);

		resetSessionPersistenceArtifactLimits();
		expect(() => savePersistedSession(tempDir, session)).not.toThrow();
	});

	it("checkpoints before a WAL write would exceed its artifact limit and remains restartable", () => {
		const sessionId = "wal-write-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		configureSessionPersistenceArtifactLimits({ maxWalBytes: 1 });
		appendSessionEntries(sessionId, [customEntry("second", first.id, "x".repeat(10_000))], "second");

		expect(() => savePersistedSession(tempDir, session)).not.toThrow();
		for (const name of readdirSync(tempDir).filter((candidate) => candidate.includes(".wal"))) {
			expect(statSync(join(tempDir, name)).size).toBeLessThanOrEqual(1);
		}

		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).not.toThrow();
		expect(getSession(sessionId)?.entries).toHaveLength(2);
	});

	it("preflights the exact WAL and head encodings without writing or advancing metadata", () => {
		const sessionId = "wal-preflight-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		appendSessionEntries(sessionId, [customEntry("second", first.id)], "second");
		const before = snapshotDirectory(tempDir);

		const plan = preflightPersistedSession(tempDir, session);
		expect(plan).toMatchObject({
			strategy: "wal",
			walArtifactBytes: expect.any(Number),
			headArtifactBytes: expect.any(Number),
		});
		expect(preflightPersistedSession(tempDir, session)).toEqual(plan);
		expect(snapshotDirectory(tempDir)).toEqual(before);

		configureSessionPersistenceArtifactLimits({ maxHeadBytes: plan.headArtifactBytes! });
		expect(preflightPersistedSession(tempDir, session)).toEqual(plan);
		configureSessionPersistenceArtifactLimits({ maxHeadBytes: plan.headArtifactBytes! - 1 });
		expect(() => preflightPersistedSession(tempDir, session)).toThrowError(
			expect.objectContaining({
				resource: "head_artifact_bytes",
				sessionId,
				requested: plan.headArtifactBytes,
				limit: plan.headArtifactBytes! - 1,
			}),
		);
		expect(snapshotDirectory(tempDir)).toEqual(before);

		resetSessionPersistenceArtifactLimits();
		savePersistedSession(tempDir, session);
		clearAllSessions();
		expect(() => loadPersistedSessions(tempDir)).not.toThrow();
		expect(getSession(sessionId)?.entries).toHaveLength(2);
	});

	it("preflights an explicitly selected snapshot at its exact artifact boundary without writing", () => {
		const sessionId = "snapshot-preflight-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		replaceSessionTree(sessionId, [first, customEntry("replacement", first.id, "replacement")], "replacement");
		const before = snapshotDirectory(tempDir);

		const plan = preflightPersistedSession(tempDir, session);
		expect(plan).toMatchObject({
			strategy: "snapshot",
			snapshotArtifactBytes: expect.any(Number),
			walArtifactBytes: 0,
			headArtifactBytes: expect.any(Number),
		});
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: plan.snapshotArtifactBytes! });
		expect(preflightPersistedSession(tempDir, session)).toEqual(plan);
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: plan.snapshotArtifactBytes! - 1 });
		expect(() => preflightPersistedSession(tempDir, session)).toThrowError(
			expect.objectContaining({
				resource: "snapshot_artifact_bytes",
				sessionId,
				requested: plan.snapshotArtifactBytes,
				limit: plan.snapshotArtifactBytes! - 1,
			}),
		);
		expect(snapshotDirectory(tempDir)).toEqual(before);
	});

	it("preflights the exact snapshot fallback when the selected WAL would exceed capacity", () => {
		const sessionId = "wal-fallback-preflight-capacity";
		const first = customEntry("first");
		const session = replaceSessionTree(sessionId, [first], first.id);
		savePersistedSession(tempDir, session);
		appendSessionEntries(sessionId, [customEntry("second", first.id, "fallback".repeat(1000))], "second");
		const before = snapshotDirectory(tempDir);
		configureSessionPersistenceArtifactLimits({ maxWalBytes: 1 });

		const plan = preflightPersistedSession(tempDir, session);
		expect(plan).toMatchObject({
			strategy: "snapshot",
			snapshotArtifactBytes: expect.any(Number),
			walArtifactBytes: 0,
			headArtifactBytes: expect.any(Number),
		});
		expect(snapshotDirectory(tempDir)).toEqual(before);

		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: plan.snapshotArtifactBytes! - 1 });
		expect(() => preflightPersistedSession(tempDir, session)).toThrowError(
			expect.objectContaining({
				resource: "snapshot_artifact_bytes",
				sessionId,
				requested: plan.snapshotArtifactBytes,
				limit: plan.snapshotArtifactBytes! - 1,
			}),
		);
		expect(snapshotDirectory(tempDir)).toEqual(before);
	});

	it("validates artifact limit configuration as positive safe integers", () => {
		expect(() => configureSessionPersistenceArtifactLimits({ maxHeadBytes: 0 })).toThrow(
			"maxHeadBytes must be a positive safe integer",
		);
		expect(() => configureSessionPersistenceArtifactLimits({ maxWalBytes: Number.POSITIVE_INFINITY })).toThrow(
			"maxWalBytes must be a positive safe integer",
		);
	});
});
