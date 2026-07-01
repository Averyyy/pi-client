import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
	exportSessionState,
	type PersistedSessionState,
	restoreSessionState,
	type SessionState,
	type SessionStaticContext,
} from "./session-store.ts";

const PERSISTED_SESSION_VERSION = 1;
const REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

interface PersistedSessionFile {
	version: 1;
	session: PersistedSessionState;
}

function sessionFileName(sessionId: string): string {
	return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function sessionPath(sessionStoreDir: string, sessionId: string): string {
	return join(sessionStoreDir, sessionFileName(sessionId));
}

function isRetryableReplaceError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replaceFileSync(sourcePath: string, targetPath: string): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt++) {
		try {
			renameSync(sourcePath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableReplaceError(error)) {
				throw error;
			}
			try {
				rmSync(targetPath, { force: true });
				renameSync(sourcePath, targetPath);
				return;
			} catch (replaceError) {
				lastError = replaceError;
				if (!isRetryableReplaceError(replaceError) || attempt === REPLACE_RETRY_DELAYS_MS.length) {
					throw replaceError;
				}
				sleepSync(REPLACE_RETRY_DELAYS_MS[attempt]);
			}
		}
	}
	throw lastError;
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
		restoreSessionState(persisted.session);
	}
}

export function savePersistedSession(sessionStoreDir: string, session: SessionState): void {
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
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

export function deletePersistedSession(sessionStoreDir: string, sessionId: string): void {
	rmSync(sessionPath(sessionStoreDir, sessionId), { force: true });
}
