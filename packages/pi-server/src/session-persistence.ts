import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
	exportSessionState,
	markSessionPersisted,
	type PersistedSessionState,
	restoreSessionState,
	type SessionState,
	type SessionStaticContext,
} from "./session-store.ts";

const PERSISTED_SESSION_VERSION = 1;
const WAL_SNAPSHOT_INTERVAL = 32;
const REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

interface PersistedSessionFile {
	version: 1;
	session: PersistedSessionState;
}

interface PersistedSessionWalRecord {
	version: 1;
	sessionId: string;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
	updatedAt: number;
	staticContext: SessionStaticContext | undefined;
}

interface PersistedSessionMeta {
	entryCount: number;
	walRecords: number;
}

const persistedSessions = new Map<string, PersistedSessionMeta>();

function sessionFileName(sessionId: string): string {
	return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function sessionPath(sessionStoreDir: string, sessionId: string): string {
	return join(sessionStoreDir, sessionFileName(sessionId));
}

function walPath(sessionStoreDir: string, sessionId: string): string {
	return `${sessionPath(sessionStoreDir, sessionId)}.wal`;
}

function persistedSessionKey(sessionStoreDir: string, sessionId: string): string {
	return `${sessionStoreDir}\0${sessionId}`;
}

function isRetryableRenameError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return process.platform === "win32" && code === "EPERM";
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replaceFileSync(sourcePath: string, targetPath: string): void {
	for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt++) {
		try {
			renameSync(sourcePath, targetPath);
			return;
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) {
				throw error;
			}
			sleepSync(REPLACE_RETRY_DELAYS_MS[attempt]);
		}
	}
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string") {
		throw new Error(`${path} must be a string`);
	}
}

function assertNumber(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be a finite number`);
	}
}

function assertNullableString(value: unknown, path: string): asserts value is string | null {
	if (value !== null && typeof value !== "string") {
		throw new Error(`${path} must be a string or null`);
	}
}

function assertStaticContext(value: unknown): asserts value is SessionStaticContext | undefined {
	if (value === undefined) return;
	assertRecord(value, "session.staticContext");
	const systemPrompt = value.systemPrompt;
	if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
		throw new Error("session.staticContext.systemPrompt must be a string");
	}
	const tools = value.tools;
	if (tools !== undefined) {
		if (!Array.isArray(tools)) {
			throw new Error("session.staticContext.tools must be an array");
		}
		for (const [index, tool] of tools.entries()) {
			assertRecord(tool, `session.staticContext.tools[${index}]`);
			assertString(tool.name, `session.staticContext.tools[${index}].name`);
			assertString(tool.description, `session.staticContext.tools[${index}].description`);
			if (tool.parameters === undefined) {
				throw new Error(`session.staticContext.tools[${index}].parameters is required`);
			}
		}
	}
}

function assertSessionTreeEntries(value: unknown): asserts value is SessionTreeEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("session.entries must be an array");
	}
	for (const [index, entry] of value.entries()) {
		assertRecord(entry, `session.entries[${index}]`);
		assertString(entry.type, `session.entries[${index}].type`);
		assertString(entry.id, `session.entries[${index}].id`);
		assertNullableString(entry.parentId, `session.entries[${index}].parentId`);
		assertString(entry.timestamp, `session.entries[${index}].timestamp`);
		if (entry.type === "message") {
			assertRecord(entry.message, `session.entries[${index}].message`);
		}
	}
}

function assertPersistedSessionState(value: unknown): asserts value is PersistedSessionState {
	assertRecord(value, "session");
	assertString(value.sessionId, "session.sessionId");
	assertStaticContext(value.staticContext);
	assertSessionTreeEntries(value.entries);
	assertNullableString(value.leafId, "session.leafId");
	assertNumber(value.revision, "session.revision");
	assertNumber(value.createdAt, "session.createdAt");
	assertNumber(value.updatedAt, "session.updatedAt");
}

function assertPersistedWalRecord(
	value: unknown,
	sourcePath: string,
	lineNumber: number,
): asserts value is PersistedSessionWalRecord {
	const path = `${sourcePath}:${lineNumber}`;
	assertRecord(value, path);
	if (value.version !== PERSISTED_SESSION_VERSION) {
		throw new Error(`Unsupported persisted session WAL version in ${path}`);
	}
	assertString(value.sessionId, `${path}.sessionId`);
	assertNumber(value.baseEntryCount, `${path}.baseEntryCount`);
	assertSessionTreeEntries(value.entries);
	assertNullableString(value.leafId, `${path}.leafId`);
	assertNumber(value.revision, `${path}.revision`);
	assertNumber(value.updatedAt, `${path}.updatedAt`);
	assertStaticContext(value.staticContext);
}

function parsePersistedSessionFile(raw: string, sourcePath: string): PersistedSessionFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Persisted session file contains invalid JSON: ${sourcePath}`, { cause: error });
	}
	assertRecord(parsed, "persisted session file");
	if (parsed.version !== PERSISTED_SESSION_VERSION) {
		throw new Error(`Unsupported persisted session version in ${sourcePath}`);
	}
	assertPersistedSessionState(parsed.session);
	return {
		version: PERSISTED_SESSION_VERSION,
		session: parsed.session,
	};
}

function parseWalLine(raw: string, sourcePath: string, lineNumber: number): PersistedSessionWalRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Persisted session WAL contains invalid JSON: ${sourcePath}:${lineNumber}`, { cause: error });
	}
	assertPersistedWalRecord(parsed, sourcePath, lineNumber);
	return parsed;
}

function applyWalRecord(session: PersistedSessionState, record: PersistedSessionWalRecord): void {
	if (record.sessionId !== session.sessionId) {
		throw new Error(`Persisted session WAL sessionId does not match snapshot: ${record.sessionId}`);
	}
	if (record.baseEntryCount < session.entries.length) {
		if (record.baseEntryCount + record.entries.length <= session.entries.length) return;
		throw new Error(`Persisted session WAL overlaps snapshot for ${record.sessionId}`);
	}
	if (record.baseEntryCount !== session.entries.length) {
		throw new Error(`Persisted session WAL has a gap for ${record.sessionId}`);
	}
	session.entries.push(...record.entries.map((entry) => ({ ...entry })));
	session.leafId = record.leafId;
	session.revision = record.revision;
	session.updatedAt = record.updatedAt;
	session.staticContext = record.staticContext;
}

function applyPersistedWal(sessionStoreDir: string, session: PersistedSessionState): number {
	const filePath = walPath(sessionStoreDir, session.sessionId);
	if (!existsSync(filePath)) return 0;
	const lines = readFileSync(filePath, "utf-8").split("\n");
	let applied = 0;
	for (const [index, line] of lines.entries()) {
		if (!line) continue;
		applyWalRecord(session, parseWalLine(line, filePath, index + 1));
		applied++;
	}
	return applied;
}

export function loadPersistedSessions(sessionStoreDir: string): void {
	if (!existsSync(sessionStoreDir)) return;
	const entries = readdirSync(sessionStoreDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const filePath = join(sessionStoreDir, entry.name);
		const persisted = parsePersistedSessionFile(readFileSync(filePath, "utf-8"), filePath);
		const expectedFileName = sessionFileName(persisted.session.sessionId);
		if (entry.name !== expectedFileName) {
			throw new Error(`Persisted session file name does not match sessionId: ${filePath}`);
		}
		const walRecords = applyPersistedWal(sessionStoreDir, persisted.session);
		restoreSessionState(persisted.session);
		persistedSessions.set(persistedSessionKey(sessionStoreDir, persisted.session.sessionId), {
			entryCount: persisted.session.entries.length,
			walRecords,
		});
	}
}

function writeSnapshot(sessionStoreDir: string, session: SessionState): void {
	mkdirSync(sessionStoreDir, { recursive: true });
	const filePath = sessionPath(sessionStoreDir, session.sessionId);
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	const body: PersistedSessionFile = {
		version: PERSISTED_SESSION_VERSION,
		session: exportSessionState(session),
	};
	try {
		writeFileSync(tempPath, JSON.stringify(body), "utf-8");
		replaceFileSync(tempPath, filePath);
		rmSync(walPath(sessionStoreDir, session.sessionId), { force: true });
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function appendWalRecord(sessionStoreDir: string, session: SessionState, baseEntryCount: number): void {
	const record: PersistedSessionWalRecord = {
		version: PERSISTED_SESSION_VERSION,
		sessionId: session.sessionId,
		baseEntryCount,
		entries: session.persistenceChange?.kind === "wal" ? session.persistenceChange.entries : [],
		leafId: session.leafId,
		revision: session.revision,
		updatedAt: session.updatedAt,
		staticContext: session.staticContext,
	};
	appendFileSync(walPath(sessionStoreDir, session.sessionId), `${JSON.stringify(record)}\n`, "utf-8");
}

export function savePersistedSession(sessionStoreDir: string, session: SessionState): void {
	const key = persistedSessionKey(sessionStoreDir, session.sessionId);
	const meta = persistedSessions.get(key);
	if (meta && !session.persistenceChange) return;
	if (!meta || session.persistenceChange?.kind === "snapshot" || meta.walRecords >= WAL_SNAPSHOT_INTERVAL) {
		writeSnapshot(sessionStoreDir, session);
		persistedSessions.set(key, { entryCount: session.entries.length, walRecords: 0 });
		markSessionPersisted(session);
		return;
	}
	appendWalRecord(sessionStoreDir, session, meta.entryCount);
	persistedSessions.set(key, { entryCount: session.entries.length, walRecords: meta.walRecords + 1 });
	markSessionPersisted(session);
}

export function deletePersistedSession(sessionStoreDir: string, sessionId: string): void {
	rmSync(sessionPath(sessionStoreDir, sessionId), { force: true });
	rmSync(walPath(sessionStoreDir, sessionId), { force: true });
	persistedSessions.delete(persistedSessionKey(sessionStoreDir, sessionId));
}
