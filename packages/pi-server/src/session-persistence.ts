import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
	calculateSessionLogicalBytes,
	exportSessionState,
	getSession,
	getSessionCapacityLimits,
	getSessionCapacityUsage,
	markSessionPersisted,
	type PersistedSessionState,
	restoreSessionState,
	type SessionState,
	type SessionStaticContext,
	validatePersistedSessionState,
} from "./session-store.ts";

const LEGACY_SESSION_VERSION = 1;
const DURABLE_SESSION_VERSION = 2;
const LEGACY_DURABLE_WAL_VERSION = 4;
const DURABLE_WAL_VERSION = 5;
const HEAD_VERSION = 1;
const MIN_WAL_RECORDS_PER_SNAPSHOT = 32;
const MIN_WAL_BYTES_PER_SNAPSHOT = 1024 * 1024;
const REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;
const SESSION_ARTIFACT_PATTERN = /^([a-f0-9]{64}\.json)\.(?:head|snapshot|wal)\.[01]$/u;
const LEGACY_WAL_PATTERN = /^([a-f0-9]{64}\.json)\.wal$/u;
const ZERO_DIGEST = "0".repeat(64);

export type SessionPersistenceFaultPoint = "wal_after_sync_before_head" | "snapshot_after_sync_before_head";

export interface SessionPersistenceOptions {
	faultInjector?: (point: SessionPersistenceFaultPoint) => void;
}

export interface SessionPersistenceArtifactLimits {
	maxSnapshotBytes: number;
	maxWalBytes: number;
	maxHeadBytes: number;
}

export interface SessionPersistencePreflightResult {
	strategy: "none" | "snapshot" | "wal";
	snapshotArtifactBytes?: number;
	walArtifactBytes?: number;
	headArtifactBytes?: number;
}

export type SessionPersistenceCapacityResource =
	| "snapshot_artifact_bytes"
	| "wal_artifact_bytes"
	| "head_artifact_bytes"
	| "session_entries"
	| "session_logical_bytes"
	| "aggregate_entries"
	| "aggregate_logical_bytes"
	| "loaded_sessions";

export class SessionPersistenceCapacityError extends Error {
	readonly code = "PI_SERVER_SESSION_PERSISTENCE_CAPACITY_EXCEEDED";
	readonly retryable = false as const;
	readonly resource: SessionPersistenceCapacityResource;
	readonly sessionId: string;
	readonly path: string;
	readonly current: number;
	readonly requested: number;
	readonly limit: number;

	constructor(input: {
		resource: SessionPersistenceCapacityResource;
		sessionId: string;
		path: string;
		current: number;
		requested: number;
		limit: number;
	}) {
		super(
			`Persisted session capacity exceeded: resource=${input.resource}, session=${input.sessionId}, path=${input.path}, requested=${input.requested}, limit=${input.limit}`,
		);
		this.name = "SessionPersistenceCapacityError";
		this.resource = input.resource;
		this.sessionId = input.sessionId;
		this.path = input.path;
		this.current = input.current;
		this.requested = input.requested;
		this.limit = input.limit;
	}
}

const SESSION_ARTIFACT_ENVELOPE_OVERHEAD_BYTES = 1024 * 1024;
const WAL_ARTIFACT_ENCODING_MULTIPLIER = 2;
const DEFAULT_MAX_HEAD_BYTES = 64 * 1024;
let artifactLimitOverrides: Partial<SessionPersistenceArtifactLimits> = {};

function defaultArtifactLimits(): SessionPersistenceArtifactLimits {
	const capacity = getSessionCapacityLimits();
	const maxSnapshotBytes =
		capacity.maxLogicalBytesPerSession + capacity.maxEntriesPerSession + SESSION_ARTIFACT_ENVELOPE_OVERHEAD_BYTES;
	const maxWalBytes =
		capacity.maxLogicalBytesPerSession * WAL_ARTIFACT_ENCODING_MULTIPLIER +
		capacity.maxEntriesPerSession * WAL_ARTIFACT_ENCODING_MULTIPLIER +
		SESSION_ARTIFACT_ENVELOPE_OVERHEAD_BYTES * WAL_ARTIFACT_ENCODING_MULTIPLIER;
	if (!Number.isSafeInteger(maxSnapshotBytes) || !Number.isSafeInteger(maxWalBytes)) {
		throw new RangeError("Session capacity limits are too large to derive safe persistence artifact limits");
	}
	return {
		maxSnapshotBytes,
		maxWalBytes,
		maxHeadBytes: DEFAULT_MAX_HEAD_BYTES,
	};
}

export function getSessionPersistenceArtifactLimits(): SessionPersistenceArtifactLimits {
	return { ...defaultArtifactLimits(), ...artifactLimitOverrides };
}

export function configureSessionPersistenceArtifactLimits(
	overrides: Partial<SessionPersistenceArtifactLimits>,
): SessionPersistenceArtifactLimits {
	for (const [name, value] of Object.entries(overrides)) {
		if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
			throw new RangeError(`${name} must be a positive safe integer`);
		}
	}
	artifactLimitOverrides = { ...artifactLimitOverrides, ...overrides };
	return getSessionPersistenceArtifactLimits();
}

export function resetSessionPersistenceArtifactLimits(): void {
	artifactLimitOverrides = {};
}

interface PersistedSessionFileV1 {
	version: 1;
	session: PersistedSessionState;
}

interface PersistedSessionFileV2 {
	version: 2;
	generation: number;
	stateDigest: string;
	session: PersistedSessionState;
}

type PersistedSessionFile = PersistedSessionFileV1 | PersistedSessionFileV2;

interface PersistedSessionWalRecordV1 {
	version: 1;
	sessionId: string;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
	updatedAt: number;
	staticContext: SessionStaticContext | undefined;
}

interface PersistedSessionWalRecordV2 {
	version: 2;
	sessionId: string;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
	updatedAt: number;
	staticContext?: SessionStaticContext;
}

interface PersistedSessionWalRecordV3 {
	version: 3;
	sessionId: string;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
	updatedAt: number;
	staticContext?: SessionStaticContext;
}

type LegacyWalRecord = PersistedSessionWalRecordV1 | PersistedSessionWalRecordV2 | PersistedSessionWalRecordV3;

interface PersistedSessionWalRecordV4 {
	version: 4;
	sessionId: string;
	generation: number;
	sequence: number;
	baseRevision: number;
	revision: number;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	updatedAt: number;
	previousStateDigest: string;
	stateDigest: string;
	previousWalDigest: string;
	staticContextChanged: boolean;
	staticContext?: SessionStaticContext | null;
}

interface PersistedSessionWalRecordV5 {
	version: 5;
	sessionId: string;
	generation: number;
	sequence: number;
	baseRevision: number;
	revision: number;
	baseEntryCount: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	updatedAt: number;
	previousStateDigest: string;
	stateDigest: string;
	previousWalDigest: string;
	staticContextChanged: boolean;
	staticContext?: SessionStaticContext | null;
}

type DurableWalRecord = PersistedSessionWalRecordV4 | PersistedSessionWalRecordV5;

interface PersistedWalEnvelope {
	version: 3 | 4 | 5;
	payload: string;
	sha256: string;
}

interface PersistedSessionHeadRecord {
	version: 1;
	sessionId: string;
	sequence: number;
	generation: number;
	previousHeadDigest: string;
	snapshotSha256: string;
	snapshotStateDigest: string;
	snapshotRevision: number;
	snapshotEntryCount: number;
	walRecordCount: number;
	walByteLength: number;
	walTailDigest: string;
	stateDigest: string;
	revision: number;
	entryCount: number;
}

interface PersistedSessionHeadEnvelope {
	version: 1;
	payload: string;
	sha256: string;
}

interface ParsedHeadRecord {
	record: PersistedSessionHeadRecord;
	digest: string;
}

interface LegacySessionMeta {
	format: "legacy";
	entryCount: number;
	walRecords: number;
	revision: number;
}

interface DurableSessionMeta {
	format: "durable";
	generation: number;
	headSequence: number;
	headDigest: string;
	snapshotSha256: string;
	snapshotStateDigest: string;
	snapshotRevision: number;
	snapshotEntryCount: number;
	snapshotByteLength: number;
	entryCount: number;
	walRecords: number;
	walByteLength: number;
	walTailDigest: string;
	stateDigest: string;
	revision: number;
}

type PersistedSessionMeta = LegacySessionMeta | DurableSessionMeta;

const persistedSessions = new Map<string, PersistedSessionMeta>();
const sessionsNeedingRecovery = new Set<string>();

type SessionArtifactKind = "snapshot" | "wal" | "head";

interface StagedSessionCapacity {
	entryCount: number;
	logicalBytes: number;
}

function persistenceCapacityError(
	resource: SessionPersistenceCapacityResource,
	sessionId: string,
	path: string,
	current: number,
	requested: number,
	limit: number,
): SessionPersistenceCapacityError {
	return new SessionPersistenceCapacityError({ resource, sessionId, path, current, requested, limit });
}

function artifactLimit(kind: SessionArtifactKind): {
	resource: Extract<
		SessionPersistenceCapacityResource,
		"snapshot_artifact_bytes" | "wal_artifact_bytes" | "head_artifact_bytes"
	>;
	limit: number;
} {
	const limits = getSessionPersistenceArtifactLimits();
	switch (kind) {
		case "snapshot":
			return { resource: "snapshot_artifact_bytes", limit: limits.maxSnapshotBytes };
		case "wal":
			return { resource: "wal_artifact_bytes", limit: limits.maxWalBytes };
		case "head":
			return { resource: "head_artifact_bytes", limit: limits.maxHeadBytes };
	}
}

function readBoundedArtifactSync(path: string, kind: SessionArtifactKind, sessionId: string): Buffer<ArrayBufferLike> {
	const { resource, limit } = artifactLimit(kind);
	const size = statSync(path).size;
	if (size > limit) {
		throw persistenceCapacityError(resource, sessionId, path, 0, size, limit);
	}
	const encoded = readFileSync(path);
	if (encoded.byteLength > limit) {
		throw persistenceCapacityError(resource, sessionId, path, 0, encoded.byteLength, limit);
	}
	return encoded;
}

function assertArtifactWriteSize(
	path: string,
	kind: SessionArtifactKind,
	sessionId: string,
	current: number,
	requested: number,
): void {
	const { resource, limit } = artifactLimit(kind);
	if (requested > limit) {
		throw persistenceCapacityError(resource, sessionId, path, current, requested, limit);
	}
}

function assertStagedSessionCapacity(
	sessionId: string,
	path: string,
	current: StagedSessionCapacity,
	next: StagedSessionCapacity,
): void {
	const limits = getSessionCapacityLimits();
	const usage = getSessionCapacityUsage();
	const existing = getSession(sessionId);
	if (!existing && usage.loadedSessions + 1 > limits.maxLoadedSessions) {
		throw persistenceCapacityError(
			"loaded_sessions",
			sessionId,
			path,
			usage.loadedSessions,
			usage.loadedSessions + 1,
			limits.maxLoadedSessions,
		);
	}
	if (next.entryCount > limits.maxEntriesPerSession) {
		throw persistenceCapacityError(
			"session_entries",
			sessionId,
			path,
			current.entryCount,
			next.entryCount,
			limits.maxEntriesPerSession,
		);
	}
	if (next.logicalBytes > limits.maxLogicalBytesPerSession) {
		throw persistenceCapacityError(
			"session_logical_bytes",
			sessionId,
			path,
			current.logicalBytes,
			next.logicalBytes,
			limits.maxLogicalBytesPerSession,
		);
	}
	const requestedAggregateEntries = usage.entryCount - (existing?.entries.length ?? 0) + next.entryCount;
	if (requestedAggregateEntries > limits.maxAggregateEntries) {
		throw persistenceCapacityError(
			"aggregate_entries",
			sessionId,
			path,
			usage.entryCount,
			requestedAggregateEntries,
			limits.maxAggregateEntries,
		);
	}
	const requestedAggregateLogicalBytes = usage.logicalBytes - (existing?.logicalBytes ?? 0) + next.logicalBytes;
	if (requestedAggregateLogicalBytes > limits.maxAggregateLogicalBytes) {
		throw persistenceCapacityError(
			"aggregate_logical_bytes",
			sessionId,
			path,
			usage.logicalBytes,
			requestedAggregateLogicalBytes,
			limits.maxAggregateLogicalBytes,
		);
	}
}

function createStagedSessionCapacity(session: PersistedSessionState, path: string): StagedSessionCapacity {
	const staged = {
		entryCount: session.entries.length,
		logicalBytes: calculateSessionLogicalBytes(session.staticContext, session.entries),
	};
	assertStagedSessionCapacity(session.sessionId, path, { entryCount: 0, logicalBytes: 0 }, staged);
	return staged;
}

function nextWalCapacity(
	session: PersistedSessionState,
	record: LegacyWalRecord | DurableWalRecord,
	current: StagedSessionCapacity,
): StagedSessionCapacity {
	let nextStaticContext = session.staticContext;
	if (record.version === 1) {
		nextStaticContext = record.staticContext;
	} else if (record.version === 2 || record.version === 3) {
		if (Object.hasOwn(record, "staticContext")) nextStaticContext = record.staticContext;
	} else if (record.staticContextChanged) {
		nextStaticContext = record.staticContext === null ? undefined : record.staticContext;
	}
	return {
		entryCount: current.entryCount + record.entries.length,
		logicalBytes:
			current.logicalBytes -
			calculateSessionLogicalBytes(session.staticContext, []) +
			calculateSessionLogicalBytes(nextStaticContext, []) +
			calculateSessionLogicalBytes(undefined, record.entries),
	};
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function stateDigest(session: PersistedSessionState): string {
	return sha256(JSON.stringify(session));
}

function walTransitionStateDigest(
	record: Omit<PersistedSessionWalRecordV5, "stateDigest"> | PersistedSessionWalRecordV5,
): string {
	return sha256(
		JSON.stringify({
			previousStateDigest: record.previousStateDigest,
			sessionId: record.sessionId,
			baseRevision: record.baseRevision,
			revision: record.revision,
			baseEntryCount: record.baseEntryCount,
			entries: record.entries,
			leafId: record.leafId,
			updatedAt: record.updatedAt,
			staticContextChanged: record.staticContextChanged,
			...(record.staticContextChanged ? { staticContext: record.staticContext ?? null } : {}),
		}),
	);
}

function sessionFileName(sessionId: string): string {
	return `${sha256(sessionId)}.json`;
}

function sessionPath(sessionStoreDir: string, sessionId: string): string {
	return join(sessionStoreDir, sessionFileName(sessionId));
}

function snapshotPath(sessionStoreDir: string, sessionId: string, generation: number): string {
	const basePath = sessionPath(sessionStoreDir, sessionId);
	return generation === 0 ? basePath : `${basePath}.snapshot.${generation % 2}`;
}

function walPath(sessionStoreDir: string, sessionId: string, generation: number): string {
	const basePath = sessionPath(sessionStoreDir, sessionId);
	return generation === 0 ? `${basePath}.wal` : `${basePath}.wal.${generation % 2}`;
}

function headPath(sessionStoreDir: string, sessionId: string, sequence: number): string {
	return `${sessionPath(sessionStoreDir, sessionId)}.head.${sequence % 2}`;
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

function writeAllSync(handle: number, encoded: Buffer): void {
	let offset = 0;
	while (offset < encoded.byteLength) {
		const written = writeSync(handle, encoded, offset, encoded.byteLength - offset);
		if (written === 0) {
			throw new Error("Filesystem write made no progress");
		}
		offset += written;
	}
}

function syncDirectorySync(path: string): void {
	if (process.platform === "win32") return;
	const handle = openSync(path, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function ensureDurableDirectorySync(path: string): void {
	if (existsSync(path)) return;
	const missingDirectories: string[] = [];
	let current = path;
	while (!existsSync(current)) {
		missingDirectories.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	mkdirSync(path, { recursive: true });
	for (const directory of missingDirectories.reverse()) {
		syncDirectorySync(dirname(directory));
	}
}

function writeDurableFileSync(path: string, encoded: Buffer): void {
	const handle = openSync(path, "wx", 0o600);
	try {
		writeAllSync(handle, encoded);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function replaceDurableFileSync(path: string, encoded: Buffer): void {
	const tempPath = `${path}.${randomUUID()}.tmp`;
	try {
		writeDurableFileSync(tempPath, encoded);
		replaceFileSync(tempPath, path);
		syncDirectorySync(dirname(path));
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function appendDurableFileSync(path: string, encoded: Buffer): void {
	const existed = existsSync(path);
	const handle = openSync(path, "a", 0o600);
	try {
		writeAllSync(handle, encoded);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	if (!existed) syncDirectorySync(dirname(path));
}

function truncateDurableFileSync(path: string, length: number): void {
	truncateSync(path, length);
	const handle = openSync(path, "r+");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

type SessionRecoveryAction = () => void;

function performOrDeferRecovery(action: SessionRecoveryAction, recoveryActions?: SessionRecoveryAction[]): void {
	if (recoveryActions) {
		recoveryActions.push(action);
	} else {
		action();
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

function assertBoolean(value: unknown, path: string): asserts value is boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${path} must be a boolean`);
	}
}

function assertDigest(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${path} must be a 64-character lowercase hex digest`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative safe integer`);
	}
}

function assertNullableString(value: unknown, path: string): asserts value is string | null {
	if (value !== null && typeof value !== "string") {
		throw new Error(`${path} must be a string or null`);
	}
}

function assertStaticContext(
	value: unknown,
	path = "session.staticContext",
): asserts value is SessionStaticContext | undefined {
	if (value === undefined) return;
	assertRecord(value, path);
	const systemPrompt = value.systemPrompt;
	if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
		throw new Error(`${path}.systemPrompt must be a string`);
	}
	const tools = value.tools;
	if (tools !== undefined) {
		if (!Array.isArray(tools)) {
			throw new Error(`${path}.tools must be an array`);
		}
		for (const [index, tool] of tools.entries()) {
			assertRecord(tool, `${path}.tools[${index}]`);
			assertString(tool.name, `${path}.tools[${index}].name`);
			assertString(tool.description, `${path}.tools[${index}].description`);
			if (tool.parameters === undefined) {
				throw new Error(`${path}.tools[${index}].parameters is required`);
			}
		}
	}
}

function assertSessionTreeEntries(value: unknown, path = "session.entries"): asserts value is SessionTreeEntry[] {
	if (!Array.isArray(value)) {
		throw new Error(`${path} must be an array`);
	}
	for (const [index, entry] of value.entries()) {
		assertRecord(entry, `${path}[${index}]`);
		assertString(entry.type, `${path}[${index}].type`);
		assertString(entry.id, `${path}[${index}].id`);
		assertNullableString(entry.parentId, `${path}[${index}].parentId`);
		assertString(entry.timestamp, `${path}[${index}].timestamp`);
		if (entry.type === "message") {
			assertRecord(entry.message, `${path}[${index}].message`);
		}
	}
}

function assertPersistedSessionState(value: unknown, path = "session"): asserts value is PersistedSessionState {
	assertRecord(value, path);
	assertString(value.sessionId, `${path}.sessionId`);
	assertStaticContext(value.staticContext, `${path}.staticContext`);
	assertSessionTreeEntries(value.entries, `${path}.entries`);
	assertNullableString(value.leafId, `${path}.leafId`);
	assertNonNegativeSafeInteger(value.revision, `${path}.revision`);
	assertNonNegativeSafeInteger(value.createdAt, `${path}.createdAt`);
	assertNonNegativeSafeInteger(value.updatedAt, `${path}.updatedAt`);
}

function parseJson(raw: string, message: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(message, { cause: error });
	}
}

function parsePersistedSessionFile(raw: string, sourcePath: string): PersistedSessionFile {
	const parsed = parseJson(raw, `Persisted session file contains invalid JSON: ${sourcePath}`);
	assertRecord(parsed, "persisted session file");
	if (parsed.version !== LEGACY_SESSION_VERSION && parsed.version !== DURABLE_SESSION_VERSION) {
		throw new Error(`Unsupported persisted session version in ${sourcePath}`);
	}
	assertPersistedSessionState(parsed.session);
	if (parsed.version === LEGACY_SESSION_VERSION) {
		return { version: LEGACY_SESSION_VERSION, session: parsed.session };
	}
	assertNonNegativeSafeInteger(parsed.generation, `${sourcePath}.generation`);
	assertDigest(parsed.stateDigest, `${sourcePath}.stateDigest`);
	const actualStateDigest = stateDigest(parsed.session);
	if (parsed.stateDigest !== actualStateDigest) {
		throw new Error(`Persisted session snapshot state digest mismatch: ${sourcePath}`);
	}
	return {
		version: DURABLE_SESSION_VERSION,
		generation: parsed.generation,
		stateDigest: parsed.stateDigest,
		session: parsed.session,
	};
}

function assertLegacyWalRecord(
	value: unknown,
	sourcePath: string,
	lineNumber: number,
): asserts value is LegacyWalRecord {
	const path = `${sourcePath}:${lineNumber}`;
	assertRecord(value, path);
	if (value.version !== 1 && value.version !== 2 && value.version !== 3) {
		throw new Error(`Unsupported persisted session WAL version in ${path}`);
	}
	assertString(value.sessionId, `${path}.sessionId`);
	assertNonNegativeSafeInteger(value.baseEntryCount, `${path}.baseEntryCount`);
	assertSessionTreeEntries(value.entries, `${path}.entries`);
	assertNullableString(value.leafId, `${path}.leafId`);
	assertNonNegativeSafeInteger(value.revision, `${path}.revision`);
	assertNonNegativeSafeInteger(value.updatedAt, `${path}.updatedAt`);
	if (value.version === 1 || Object.hasOwn(value, "staticContext")) {
		assertStaticContext(value.staticContext, `${path}.staticContext`);
	}
}

function parseLegacyWalLine(raw: string, sourcePath: string, lineNumber: number): LegacyWalRecord {
	const parsed = parseJson(raw, `Persisted session WAL contains invalid JSON: ${sourcePath}:${lineNumber}`);
	assertRecord(parsed, `${sourcePath}:${lineNumber}`);
	if (parsed.version !== 3 || typeof parsed.payload !== "string" || typeof parsed.sha256 !== "string") {
		assertLegacyWalRecord(parsed, sourcePath, lineNumber);
		return parsed;
	}
	assertDigest(parsed.sha256, `${sourcePath}:${lineNumber}.sha256`);
	if (sha256(parsed.payload) !== parsed.sha256) {
		throw new Error(`Persisted session WAL checksum mismatch: ${sourcePath}:${lineNumber}`);
	}
	const payload = parseJson(
		parsed.payload,
		`Persisted session WAL payload contains invalid JSON: ${sourcePath}:${lineNumber}`,
	);
	assertLegacyWalRecord(payload, sourcePath, lineNumber);
	if (payload.version !== 3) {
		throw new Error(`Persisted session WAL envelope payload version mismatch: ${sourcePath}:${lineNumber}`);
	}
	return payload;
}

function assertDurableWalRecord(
	value: unknown,
	sourcePath: string,
	lineNumber: number,
): asserts value is DurableWalRecord {
	const path = `${sourcePath}:${lineNumber}`;
	assertRecord(value, path);
	if (value.version !== LEGACY_DURABLE_WAL_VERSION && value.version !== DURABLE_WAL_VERSION) {
		throw new Error(`Unsupported durable session WAL version in ${path}`);
	}
	assertString(value.sessionId, `${path}.sessionId`);
	assertNonNegativeSafeInteger(value.generation, `${path}.generation`);
	assertNonNegativeSafeInteger(value.sequence, `${path}.sequence`);
	assertNonNegativeSafeInteger(value.baseRevision, `${path}.baseRevision`);
	assertNonNegativeSafeInteger(value.revision, `${path}.revision`);
	assertNonNegativeSafeInteger(value.baseEntryCount, `${path}.baseEntryCount`);
	assertSessionTreeEntries(value.entries, `${path}.entries`);
	assertNullableString(value.leafId, `${path}.leafId`);
	assertNonNegativeSafeInteger(value.updatedAt, `${path}.updatedAt`);
	assertDigest(value.previousStateDigest, `${path}.previousStateDigest`);
	assertDigest(value.stateDigest, `${path}.stateDigest`);
	assertDigest(value.previousWalDigest, `${path}.previousWalDigest`);
	assertBoolean(value.staticContextChanged, `${path}.staticContextChanged`);
	if (value.staticContextChanged) {
		if (!Object.hasOwn(value, "staticContext")) {
			throw new Error(`${path}.staticContext is required when staticContextChanged is true`);
		}
		if (value.staticContext !== null) {
			assertStaticContext(value.staticContext, `${path}.staticContext`);
		}
	} else if (Object.hasOwn(value, "staticContext")) {
		throw new Error(`${path}.staticContext must be omitted when staticContextChanged is false`);
	}
}

function parseDurableWalLine(
	raw: string,
	sourcePath: string,
	lineNumber: number,
): { record: DurableWalRecord; digest: string } {
	const parsed = parseJson(raw, `Persisted session WAL contains invalid JSON: ${sourcePath}:${lineNumber}`);
	assertRecord(parsed, `${sourcePath}:${lineNumber}`);
	if (parsed.version !== LEGACY_DURABLE_WAL_VERSION && parsed.version !== DURABLE_WAL_VERSION) {
		throw new Error(`Expected durable session WAL envelope in ${sourcePath}:${lineNumber}`);
	}
	assertString(parsed.payload, `${sourcePath}:${lineNumber}.payload`);
	assertDigest(parsed.sha256, `${sourcePath}:${lineNumber}.sha256`);
	const digest = sha256(parsed.payload);
	if (digest !== parsed.sha256) {
		throw new Error(`Persisted session WAL checksum mismatch: ${sourcePath}:${lineNumber}`);
	}
	const payload = parseJson(
		parsed.payload,
		`Persisted session WAL payload contains invalid JSON: ${sourcePath}:${lineNumber}`,
	);
	assertDurableWalRecord(payload, sourcePath, lineNumber);
	if (payload.version !== parsed.version) {
		throw new Error(`Persisted session WAL envelope payload version mismatch: ${sourcePath}:${lineNumber}`);
	}
	return { record: payload, digest };
}

function assertHeadRecord(value: unknown, sourcePath: string): asserts value is PersistedSessionHeadRecord {
	assertRecord(value, sourcePath);
	if (value.version !== HEAD_VERSION) {
		throw new Error(`Unsupported persisted session head version in ${sourcePath}`);
	}
	assertString(value.sessionId, `${sourcePath}.sessionId`);
	assertNonNegativeSafeInteger(value.sequence, `${sourcePath}.sequence`);
	assertNonNegativeSafeInteger(value.generation, `${sourcePath}.generation`);
	assertDigest(value.previousHeadDigest, `${sourcePath}.previousHeadDigest`);
	assertDigest(value.snapshotSha256, `${sourcePath}.snapshotSha256`);
	assertDigest(value.snapshotStateDigest, `${sourcePath}.snapshotStateDigest`);
	assertNonNegativeSafeInteger(value.snapshotRevision, `${sourcePath}.snapshotRevision`);
	assertNonNegativeSafeInteger(value.snapshotEntryCount, `${sourcePath}.snapshotEntryCount`);
	assertNonNegativeSafeInteger(value.walRecordCount, `${sourcePath}.walRecordCount`);
	assertNonNegativeSafeInteger(value.walByteLength, `${sourcePath}.walByteLength`);
	assertDigest(value.walTailDigest, `${sourcePath}.walTailDigest`);
	assertDigest(value.stateDigest, `${sourcePath}.stateDigest`);
	assertNonNegativeSafeInteger(value.revision, `${sourcePath}.revision`);
	assertNonNegativeSafeInteger(value.entryCount, `${sourcePath}.entryCount`);
}

function parseHeadFile(path: string, slot: number, sessionId: string): ParsedHeadRecord {
	const parsed = parseJson(
		readBoundedArtifactSync(path, "head", sessionId).toString("utf-8"),
		`Persisted session head contains invalid JSON: ${path}`,
	);
	assertRecord(parsed, path);
	if (parsed.version !== HEAD_VERSION) {
		throw new Error(`Unsupported persisted session head envelope version in ${path}`);
	}
	assertString(parsed.payload, `${path}.payload`);
	assertDigest(parsed.sha256, `${path}.sha256`);
	const digest = sha256(parsed.payload);
	if (digest !== parsed.sha256) {
		throw new Error(`Persisted session head checksum mismatch: ${path}`);
	}
	const payload = parseJson(parsed.payload, `Persisted session head payload contains invalid JSON: ${path}`);
	assertHeadRecord(payload, path);
	if (payload.sequence % 2 !== slot) {
		throw new Error(`Persisted session head is stored in the wrong slot: ${path}`);
	}
	return { record: payload, digest };
}

function readLatestHead(sessionStoreDir: string, sessionId: string): ParsedHeadRecord | undefined {
	const heads: ParsedHeadRecord[] = [];
	for (const slot of [0, 1]) {
		const path = headPath(sessionStoreDir, sessionId, slot);
		if (existsSync(path)) heads.push(parseHeadFile(path, slot, sessionId));
	}
	if (heads.length === 0) return undefined;
	heads.sort((left, right) => left.record.sequence - right.record.sequence);
	if (heads.length === 1) {
		const only = heads[0];
		if (only.record.sequence !== 0 || only.record.previousHeadDigest !== ZERO_DIGEST) {
			throw new Error(`Persisted session head chain is incomplete for ${sessionId}`);
		}
		return only;
	}
	const [previous, latest] = heads;
	if (latest.record.sequence !== previous.record.sequence + 1) {
		throw new Error(`Persisted session head sequence is not contiguous for ${sessionId}`);
	}
	if (latest.record.previousHeadDigest !== previous.digest) {
		throw new Error(`Persisted session head digest chain mismatch for ${sessionId}`);
	}
	if (latest.record.sessionId !== previous.record.sessionId) {
		throw new Error(`Persisted session head sessionId chain mismatch for ${sessionId}`);
	}
	return latest;
}

function applyLegacyWalRecord(
	session: PersistedSessionState,
	record: LegacyWalRecord,
	capacity: StagedSessionCapacity,
	sourcePath: string,
): void {
	if (record.sessionId !== session.sessionId) {
		throw new Error(`Persisted session WAL sessionId does not match snapshot: ${record.sessionId}`);
	}
	if (record.baseEntryCount < session.entries.length) {
		if (record.baseEntryCount + record.entries.length <= session.entries.length) {
			const existingEntries = session.entries.slice(
				record.baseEntryCount,
				record.baseEntryCount + record.entries.length,
			);
			if (!isDeepStrictEqual(existingEntries, record.entries)) {
				throw new Error(`Persisted session WAL diverges from snapshot for ${record.sessionId}`);
			}
			return;
		}
		throw new Error(`Persisted session WAL overlaps snapshot for ${record.sessionId}`);
	}
	if (record.baseEntryCount !== session.entries.length) {
		throw new Error(`Persisted session WAL has a gap for ${record.sessionId}`);
	}
	if (record.revision < session.revision) {
		throw new Error(`Persisted session WAL revision regresses for ${record.sessionId}`);
	}
	if (record.updatedAt < session.updatedAt) {
		throw new Error(`Persisted session WAL updatedAt regresses for ${record.sessionId}`);
	}
	const nextCapacity = nextWalCapacity(session, record, capacity);
	assertStagedSessionCapacity(session.sessionId, sourcePath, capacity, nextCapacity);
	session.entries = session.entries.concat(structuredClone(record.entries));
	session.leafId = record.leafId;
	session.revision = record.revision;
	session.updatedAt = record.updatedAt;
	if (record.version === 1 || Object.hasOwn(record, "staticContext")) {
		session.staticContext = record.staticContext === undefined ? undefined : structuredClone(record.staticContext);
	}
	capacity.entryCount = nextCapacity.entryCount;
	capacity.logicalBytes = nextCapacity.logicalBytes;
}

function readCommittedLegacyWal(
	path: string,
	sessionId: string,
	recoveryActions?: SessionRecoveryAction[],
): { encoded: Buffer; lines: string[] } {
	const encoded = readBoundedArtifactSync(path, "wal", sessionId);
	const lastNewline = encoded.lastIndexOf(0x0a);
	const committedBytes = lastNewline + 1;
	if (committedBytes !== encoded.byteLength) {
		performOrDeferRecovery(() => truncateDurableFileSync(path, committedBytes), recoveryActions);
	}
	const lines = encoded.subarray(0, committedBytes).toString("utf-8").split("\n").filter(Boolean);
	return { encoded: encoded.subarray(0, committedBytes), lines };
}

function applyLegacyWal(
	sessionStoreDir: string,
	session: PersistedSessionState,
	capacity: StagedSessionCapacity,
	recoveryActions?: SessionRecoveryAction[],
): number {
	const path = walPath(sessionStoreDir, session.sessionId, 0);
	if (!existsSync(path)) return 0;
	const { lines } = readCommittedLegacyWal(path, session.sessionId, recoveryActions);
	for (const [index, line] of lines.entries()) {
		applyLegacyWalRecord(session, parseLegacyWalLine(line, path, index + 1), capacity, path);
	}
	return lines.length;
}

function applyDurableWalRecord(
	session: PersistedSessionState,
	record: DurableWalRecord,
	recordDigest: string,
	expectedGeneration: number,
	expectedSequence: number,
	expectedStateDigest: string,
	expectedWalDigest: string,
	capacity: StagedSessionCapacity,
	sourcePath: string,
): { stateDigest: string; walDigest: string } {
	if (record.sessionId !== session.sessionId) {
		throw new Error(`Persisted session WAL sessionId does not match snapshot: ${record.sessionId}`);
	}
	if (record.generation !== expectedGeneration) {
		throw new Error(`Persisted session WAL generation mismatch for ${record.sessionId}`);
	}
	if (record.sequence !== expectedSequence) {
		throw new Error(`Persisted session WAL sequence mismatch for ${record.sessionId}`);
	}
	if (record.baseRevision !== session.revision || record.revision <= record.baseRevision) {
		throw new Error(`Persisted session WAL revision chain mismatch for ${record.sessionId}`);
	}
	if (record.baseEntryCount !== session.entries.length) {
		throw new Error(`Persisted session WAL entry chain mismatch for ${record.sessionId}`);
	}
	if (record.previousStateDigest !== expectedStateDigest) {
		throw new Error(`Persisted session WAL previous state digest mismatch for ${record.sessionId}`);
	}
	if (record.previousWalDigest !== expectedWalDigest) {
		throw new Error(`Persisted session WAL digest chain mismatch for ${record.sessionId}`);
	}
	if (record.updatedAt < session.updatedAt) {
		throw new Error(`Persisted session WAL updatedAt regresses for ${record.sessionId}`);
	}
	const nextCapacity = nextWalCapacity(session, record, capacity);
	assertStagedSessionCapacity(session.sessionId, sourcePath, capacity, nextCapacity);
	session.entries = session.entries.concat(structuredClone(record.entries));
	session.leafId = record.leafId;
	session.revision = record.revision;
	session.updatedAt = record.updatedAt;
	if (record.staticContextChanged) {
		session.staticContext =
			record.staticContext === null || record.staticContext === undefined
				? undefined
				: structuredClone(record.staticContext);
	}
	const actualStateDigest =
		record.version === LEGACY_DURABLE_WAL_VERSION ? stateDigest(session) : walTransitionStateDigest(record);
	if (record.stateDigest !== actualStateDigest) {
		throw new Error(`Persisted session WAL post state digest mismatch for ${record.sessionId}`);
	}
	capacity.entryCount = nextCapacity.entryCount;
	capacity.logicalBytes = nextCapacity.logicalBytes;
	return { stateDigest: actualStateDigest, walDigest: recordDigest };
}

function readDurableWal(
	sessionStoreDir: string,
	session: PersistedSessionState,
	head: PersistedSessionHeadRecord,
	capacity: StagedSessionCapacity,
	recoveryActions?: SessionRecoveryAction[],
): void {
	const path = walPath(sessionStoreDir, session.sessionId, head.generation);
	if (!existsSync(path)) {
		throw new Error(`Persisted session WAL is missing: ${path}`);
	}
	const encoded = readBoundedArtifactSync(path, "wal", session.sessionId);
	if (encoded.byteLength < head.walByteLength) {
		throw new Error(`Persisted session WAL is shorter than its durable head: ${path}`);
	}
	if (encoded.byteLength > head.walByteLength) {
		performOrDeferRecovery(() => truncateDurableFileSync(path, head.walByteLength), recoveryActions);
	}
	const committed = encoded.subarray(0, head.walByteLength);
	if (committed.byteLength > 0 && committed.at(-1) !== 0x0a) {
		throw new Error(`Persisted session WAL durable head does not end at a record boundary: ${path}`);
	}
	const lines = committed.toString("utf-8").split("\n").filter(Boolean);
	if (lines.length !== head.walRecordCount) {
		throw new Error(`Persisted session WAL record count does not match its durable head: ${path}`);
	}
	let expectedStateDigest = head.snapshotStateDigest;
	let expectedWalDigest = head.snapshotSha256;
	for (const [index, line] of lines.entries()) {
		const parsed = parseDurableWalLine(line, path, index + 1);
		const applied = applyDurableWalRecord(
			session,
			parsed.record,
			parsed.digest,
			head.generation,
			index,
			expectedStateDigest,
			expectedWalDigest,
			capacity,
			path,
		);
		expectedStateDigest = applied.stateDigest;
		expectedWalDigest = applied.walDigest;
	}
	if (
		expectedStateDigest !== head.stateDigest ||
		expectedWalDigest !== head.walTailDigest ||
		session.revision !== head.revision ||
		session.entries.length !== head.entryCount
	) {
		throw new Error(`Persisted session WAL final state does not match its durable head: ${path}`);
	}
}

function rollbackUncommittedFutureGeneration(
	sessionStoreDir: string,
	sessionId: string,
	headGeneration: number,
	recoveryActions?: SessionRecoveryAction[],
): void {
	const basePath = sessionPath(sessionStoreDir, sessionId);
	let removed = false;
	let deferredRemoval = false;
	for (const slot of [0, 1]) {
		const path = `${basePath}.snapshot.${slot}`;
		if (!existsSync(path)) continue;
		const parsed = parsePersistedSessionFile(
			readBoundedArtifactSync(path, "snapshot", sessionId).toString("utf-8"),
			path,
		);
		if (parsed.version !== DURABLE_SESSION_VERSION) {
			throw new Error(`Persisted session snapshot slot uses a legacy format: ${path}`);
		}
		createStagedSessionCapacity(parsed.session, path);
		if (parsed.generation % 2 !== slot) {
			throw new Error(`Persisted session snapshot is stored in the wrong slot: ${path}`);
		}
		if (parsed.generation <= headGeneration) continue;
		if (parsed.generation !== headGeneration + 1) {
			throw new Error(`Persisted session snapshot generation is ahead of its durable head: ${path}`);
		}
		performOrDeferRecovery(() => {
			rmSync(path);
			rmSync(`${basePath}.wal.${slot}`, { force: true });
		}, recoveryActions);
		removed = recoveryActions === undefined;
		deferredRemoval = recoveryActions !== undefined;
	}
	if (removed) {
		syncDirectorySync(sessionStoreDir);
	} else if (recoveryActions && deferredRemoval) {
		recoveryActions.push(() => syncDirectorySync(sessionStoreDir));
	}
}

function loadDurableSession(
	sessionStoreDir: string,
	sessionId: string,
	head: ParsedHeadRecord,
	recoveryActions?: SessionRecoveryAction[],
): { session: PersistedSessionState; meta: DurableSessionMeta } {
	const record = head.record;
	if (record.sessionId !== sessionId) {
		throw new Error(`Persisted session head sessionId does not match snapshot: ${record.sessionId}`);
	}
	rollbackUncommittedFutureGeneration(sessionStoreDir, sessionId, record.generation, recoveryActions);
	const path = snapshotPath(sessionStoreDir, sessionId, record.generation);
	if (!existsSync(path)) {
		throw new Error(`Persisted session snapshot referenced by durable head is missing: ${path}`);
	}
	const encoded = readBoundedArtifactSync(path, "snapshot", sessionId);
	if (sha256(encoded) !== record.snapshotSha256) {
		throw new Error(`Persisted session snapshot checksum does not match its durable head: ${path}`);
	}
	const persisted = parsePersistedSessionFile(encoded.toString("utf-8"), path);
	if (persisted.version !== DURABLE_SESSION_VERSION || persisted.generation !== record.generation) {
		throw new Error(`Persisted session snapshot generation does not match its durable head: ${path}`);
	}
	if (
		persisted.stateDigest !== record.snapshotStateDigest ||
		persisted.session.revision !== record.snapshotRevision ||
		persisted.session.entries.length !== record.snapshotEntryCount
	) {
		throw new Error(`Persisted session snapshot state does not match its durable head: ${path}`);
	}
	const capacity = createStagedSessionCapacity(persisted.session, path);
	readDurableWal(sessionStoreDir, persisted.session, record, capacity, recoveryActions);
	return {
		session: persisted.session,
		meta: {
			format: "durable",
			generation: record.generation,
			headSequence: record.sequence,
			headDigest: head.digest,
			snapshotSha256: record.snapshotSha256,
			snapshotStateDigest: record.snapshotStateDigest,
			snapshotRevision: record.snapshotRevision,
			snapshotEntryCount: record.snapshotEntryCount,
			snapshotByteLength: encoded.byteLength,
			entryCount: record.entryCount,
			walRecords: record.walRecordCount,
			walByteLength: record.walByteLength,
			walTailDigest: record.walTailDigest,
			stateDigest: record.stateDigest,
			revision: record.revision,
		},
	};
}

function assertAnchoredArtifacts(sessionStoreDir: string, entries: Dirent<string>[]): void {
	const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
	for (const name of names) {
		const match = SESSION_ARTIFACT_PATTERN.exec(name) ?? LEGACY_WAL_PATTERN.exec(name);
		if (match && !names.has(match[1])) {
			throw new Error(`Persisted session artifact has no anchor snapshot: ${join(sessionStoreDir, name)}`);
		}
	}
}

interface StagedPersistedSession {
	session: PersistedSessionState;
	meta: PersistedSessionMeta;
	key: string;
	path: string;
}

function assertStagedSessionBatchCapacity(stagedSessions: readonly StagedPersistedSession[]): void {
	const limits = getSessionCapacityLimits();
	const usage = getSessionCapacityUsage();
	let requestedLoadedSessions = usage.loadedSessions;
	let requestedEntries = usage.entryCount;
	let requestedLogicalBytes = usage.logicalBytes;
	const stagedIds = new Set<string>();
	for (const staged of stagedSessions) {
		if (stagedIds.has(staged.session.sessionId)) {
			throw new Error(`Persisted session ${staged.session.sessionId} is staged more than once`);
		}
		stagedIds.add(staged.session.sessionId);
		const existing = getSession(staged.session.sessionId);
		if (!existing) requestedLoadedSessions++;
		requestedEntries += staged.session.entries.length - (existing?.entries.length ?? 0);
		requestedLogicalBytes +=
			calculateSessionLogicalBytes(staged.session.staticContext, staged.session.entries) -
			(existing?.logicalBytes ?? 0);
		if (requestedLoadedSessions > limits.maxLoadedSessions) {
			throw persistenceCapacityError(
				"loaded_sessions",
				staged.session.sessionId,
				staged.path,
				usage.loadedSessions,
				requestedLoadedSessions,
				limits.maxLoadedSessions,
			);
		}
		if (requestedEntries > limits.maxAggregateEntries) {
			throw persistenceCapacityError(
				"aggregate_entries",
				staged.session.sessionId,
				staged.path,
				usage.entryCount,
				requestedEntries,
				limits.maxAggregateEntries,
			);
		}
		if (requestedLogicalBytes > limits.maxAggregateLogicalBytes) {
			throw persistenceCapacityError(
				"aggregate_logical_bytes",
				staged.session.sessionId,
				staged.path,
				usage.logicalBytes,
				requestedLogicalBytes,
				limits.maxAggregateLogicalBytes,
			);
		}
	}
}

export function loadPersistedSessions(sessionStoreDir: string): void {
	if (!existsSync(sessionStoreDir)) return;
	const entries = readdirSync(sessionStoreDir, { withFileTypes: true });
	assertAnchoredArtifacts(sessionStoreDir, entries);
	const stagedSessions: StagedPersistedSession[] = [];
	const recoveryActions: SessionRecoveryAction[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) continue;
		const anchorPath = join(sessionStoreDir, entry.name);
		const unresolvedSessionId = `<unresolved:${entry.name}>`;
		const anchor = parsePersistedSessionFile(
			readBoundedArtifactSync(anchorPath, "snapshot", unresolvedSessionId).toString("utf-8"),
			anchorPath,
		);
		const expectedFileName = sessionFileName(anchor.session.sessionId);
		if (entry.name !== expectedFileName) {
			throw new Error(`Persisted session file name does not match sessionId: ${anchorPath}`);
		}
		const sessionId = anchor.session.sessionId;
		const capacity = createStagedSessionCapacity(anchor.session, anchorPath);
		const head = readLatestHead(sessionStoreDir, sessionId);
		if (head) {
			const loaded = loadDurableSession(sessionStoreDir, sessionId, head, recoveryActions);
			const key = persistedSessionKey(sessionStoreDir, sessionId);
			stagedSessions.push({ session: loaded.session, meta: loaded.meta, key, path: anchorPath });
			continue;
		}
		const basePath = sessionPath(sessionStoreDir, sessionId);
		if (
			anchor.version === DURABLE_SESSION_VERSION ||
			existsSync(`${basePath}.snapshot.0`) ||
			existsSync(`${basePath}.snapshot.1`) ||
			existsSync(`${basePath}.wal.0`) ||
			existsSync(`${basePath}.wal.1`)
		) {
			throw new Error(`Persisted session durable artifacts are missing their head for ${sessionId}`);
		}
		const walRecords = applyLegacyWal(sessionStoreDir, anchor.session, capacity, recoveryActions);
		const key = persistedSessionKey(sessionStoreDir, sessionId);
		stagedSessions.push({
			session: anchor.session,
			meta: {
				format: "legacy",
				entryCount: anchor.session.entries.length,
				walRecords,
				revision: anchor.session.revision,
			},
			key,
			path: anchorPath,
		});
	}
	assertStagedSessionBatchCapacity(stagedSessions);
	for (const staged of stagedSessions) {
		validatePersistedSessionState(staged.session);
	}
	for (const recoveryAction of recoveryActions) recoveryAction();
	for (const staged of stagedSessions) {
		restoreSessionState(staged.session);
	}
	for (const staged of stagedSessions) {
		persistedSessions.set(staged.key, staged.meta);
		sessionsNeedingRecovery.delete(staged.key);
	}
}

function encodeSnapshot(
	session: SessionState,
	generation: number,
): {
	encoded: Buffer;
	state: PersistedSessionState;
	stateDigest: string;
	snapshotDigest: string;
} {
	const state = exportSessionState(session);
	const digest = stateDigest(state);
	const body: PersistedSessionFileV2 = {
		version: DURABLE_SESSION_VERSION,
		generation,
		stateDigest: digest,
		session: state,
	};
	const encoded = Buffer.from(JSON.stringify(body), "utf-8");
	return { encoded, state, stateDigest: digest, snapshotDigest: sha256(encoded) };
}

function encodeHead(record: PersistedSessionHeadRecord): Buffer {
	const payload = JSON.stringify(record);
	const envelope: PersistedSessionHeadEnvelope = {
		version: HEAD_VERSION,
		payload,
		sha256: sha256(payload),
	};
	return Buffer.from(JSON.stringify(envelope), "utf-8");
}

function prepareHeadWrite(
	sessionStoreDir: string,
	sessionId: string,
	record: PersistedSessionHeadRecord,
): { path: string; encoded: Buffer; digest: string } {
	const path = headPath(sessionStoreDir, sessionId, record.sequence);
	const encoded = encodeHead(record);
	assertArtifactWriteSize(path, "head", sessionId, existsSync(path) ? statSync(path).size : 0, encoded.byteLength);
	const latest = readLatestHead(sessionStoreDir, sessionId);
	if (record.sequence === 0) {
		if (latest) {
			throw new Error(`Persisted session already has a durable head for ${sessionId}`);
		}
	} else if (
		!latest ||
		latest.record.sequence !== record.sequence - 1 ||
		latest.digest !== record.previousHeadDigest
	) {
		throw new Error(`Persisted session head changed before commit for ${sessionId}`);
	}
	if (existsSync(path)) {
		const existing = parseHeadFile(path, record.sequence % 2, sessionId);
		if (record.sequence < 2 || existing.record.sequence !== record.sequence - 2) {
			throw new Error(`Persisted session head slot contains an unexpected generation: ${path}`);
		}
	}
	return { path, encoded, digest: sha256(JSON.stringify(record)) };
}

function writeHeadRecord(sessionStoreDir: string, sessionId: string, record: PersistedSessionHeadRecord): string {
	const prepared = prepareHeadWrite(sessionStoreDir, sessionId, record);
	replaceDurableFileSync(prepared.path, prepared.encoded);
	return prepared.digest;
}

function assertSnapshotSlotCanBeReused(sessionStoreDir: string, sessionId: string, generation: number): void {
	const path = snapshotPath(sessionStoreDir, sessionId, generation);
	const wal = walPath(sessionStoreDir, sessionId, generation);
	if (generation === 0) {
		if (existsSync(path) || existsSync(wal)) {
			throw new Error(`Persisted session initial durable slot already exists for ${sessionId}`);
		}
		return;
	}
	if (!existsSync(path)) {
		if (existsSync(wal)) {
			throw new Error(`Persisted session WAL slot exists without its snapshot: ${wal}`);
		}
		return;
	}
	const existing = parsePersistedSessionFile(
		readBoundedArtifactSync(path, "snapshot", sessionId).toString("utf-8"),
		path,
	);
	if (existing.version !== DURABLE_SESSION_VERSION || existing.generation !== generation - 2) {
		throw new Error(`Persisted session snapshot slot contains an unexpected generation: ${path}`);
	}
}

interface SnapshotWritePlan {
	generation: number;
	headSequence: number;
	snapshot: ReturnType<typeof encodeSnapshot>;
	headRecord: PersistedSessionHeadRecord;
	nextSnapshotPath: string;
	nextWalPath: string;
	headArtifactBytes: number;
}

function prepareSnapshotWrite(
	sessionStoreDir: string,
	session: SessionState,
	meta: PersistedSessionMeta | undefined,
): SnapshotWritePlan {
	const generation = meta?.format === "durable" ? meta.generation + 1 : meta?.format === "legacy" ? 1 : 0;
	const headSequence = meta?.format === "durable" ? meta.headSequence + 1 : 0;
	const previousHeadDigest = meta?.format === "durable" ? meta.headDigest : ZERO_DIGEST;
	assertSnapshotSlotCanBeReused(sessionStoreDir, session.sessionId, generation);
	const snapshot = encodeSnapshot(session, generation);
	const headRecord: PersistedSessionHeadRecord = {
		version: HEAD_VERSION,
		sessionId: session.sessionId,
		sequence: headSequence,
		generation,
		previousHeadDigest,
		snapshotSha256: snapshot.snapshotDigest,
		snapshotStateDigest: snapshot.stateDigest,
		snapshotRevision: snapshot.state.revision,
		snapshotEntryCount: snapshot.state.entries.length,
		walRecordCount: 0,
		walByteLength: 0,
		walTailDigest: snapshot.snapshotDigest,
		stateDigest: snapshot.stateDigest,
		revision: snapshot.state.revision,
		entryCount: snapshot.state.entries.length,
	};
	const nextSnapshotPath = snapshotPath(sessionStoreDir, session.sessionId, generation);
	const nextWalPath = walPath(sessionStoreDir, session.sessionId, generation);
	assertArtifactWriteSize(
		nextSnapshotPath,
		"snapshot",
		session.sessionId,
		existsSync(nextSnapshotPath) ? statSync(nextSnapshotPath).size : 0,
		snapshot.encoded.byteLength,
	);
	assertArtifactWriteSize(nextWalPath, "wal", session.sessionId, 0, 0);
	const preparedHead = prepareHeadWrite(sessionStoreDir, session.sessionId, headRecord);
	return {
		generation,
		headSequence,
		snapshot,
		headRecord,
		nextSnapshotPath,
		nextWalPath,
		headArtifactBytes: preparedHead.encoded.byteLength,
	};
}

function writeSnapshot(
	sessionStoreDir: string,
	session: SessionState,
	meta: PersistedSessionMeta | undefined,
	faultInjector?: (point: SessionPersistenceFaultPoint) => void,
): DurableSessionMeta {
	ensureDurableDirectorySync(sessionStoreDir);
	const plan = prepareSnapshotWrite(sessionStoreDir, session, meta);
	replaceDurableFileSync(plan.nextSnapshotPath, plan.snapshot.encoded);
	replaceDurableFileSync(plan.nextWalPath, Buffer.alloc(0));
	faultInjector?.("snapshot_after_sync_before_head");
	const headDigest = writeHeadRecord(sessionStoreDir, session.sessionId, plan.headRecord);
	return {
		format: "durable",
		generation: plan.generation,
		headSequence: plan.headSequence,
		headDigest,
		snapshotSha256: plan.snapshot.snapshotDigest,
		snapshotStateDigest: plan.snapshot.stateDigest,
		snapshotRevision: plan.snapshot.state.revision,
		snapshotEntryCount: plan.snapshot.state.entries.length,
		snapshotByteLength: plan.snapshot.encoded.byteLength,
		entryCount: plan.snapshot.state.entries.length,
		walRecords: 0,
		walByteLength: 0,
		walTailDigest: plan.snapshot.snapshotDigest,
		stateDigest: plan.snapshot.stateDigest,
		revision: plan.snapshot.state.revision,
	};
}

function encodeWalRecord(record: PersistedSessionWalRecordV5): { encoded: Buffer; digest: string } {
	const payload = JSON.stringify(record);
	const digest = sha256(payload);
	const envelope: PersistedWalEnvelope = {
		version: DURABLE_WAL_VERSION,
		payload,
		sha256: digest,
	};
	return { encoded: Buffer.from(`${JSON.stringify(envelope)}\n`, "utf-8"), digest };
}

interface WalWritePlan {
	path: string;
	encodedRecord: ReturnType<typeof encodeWalRecord>;
	headRecord: PersistedSessionHeadRecord;
	headArtifactBytes: number;
}

function prepareWalWrite(sessionStoreDir: string, session: SessionState, meta: DurableSessionMeta): WalWritePlan {
	if (session.persistenceChange?.kind !== "wal") {
		throw new Error(`Session ${session.sessionId} does not have a WAL persistence change`);
	}
	if (session.revision <= meta.revision) {
		throw new Error(`Session ${session.sessionId} revision did not advance before WAL persistence`);
	}
	const path = walPath(sessionStoreDir, session.sessionId, meta.generation);
	if (!existsSync(path) || statSync(path).size !== meta.walByteLength) {
		throw new Error(`Session ${session.sessionId} WAL does not match its in-memory durable head`);
	}
	const recordWithoutStateDigest: Omit<PersistedSessionWalRecordV5, "stateDigest"> = {
		version: DURABLE_WAL_VERSION,
		sessionId: session.sessionId,
		generation: meta.generation,
		sequence: meta.walRecords,
		baseRevision: meta.revision,
		revision: session.revision,
		baseEntryCount: meta.entryCount,
		entries: session.entries.slice(meta.entryCount),
		leafId: session.leafId,
		updatedAt: session.updatedAt,
		previousStateDigest: meta.stateDigest,
		previousWalDigest: meta.walTailDigest,
		staticContextChanged: session.persistenceChange.staticContextChanged,
	};
	if (session.persistenceChange.staticContextChanged) {
		recordWithoutStateDigest.staticContext = session.staticContext ?? null;
	}
	const record: PersistedSessionWalRecordV5 = {
		...recordWithoutStateDigest,
		stateDigest: walTransitionStateDigest(recordWithoutStateDigest),
	};
	const encodedRecord = encodeWalRecord(record);
	const headRecord: PersistedSessionHeadRecord = {
		version: HEAD_VERSION,
		sessionId: session.sessionId,
		sequence: meta.headSequence + 1,
		generation: meta.generation,
		previousHeadDigest: meta.headDigest,
		snapshotSha256: meta.snapshotSha256,
		snapshotStateDigest: meta.snapshotStateDigest,
		snapshotRevision: meta.snapshotRevision,
		snapshotEntryCount: meta.snapshotEntryCount,
		walRecordCount: meta.walRecords + 1,
		walByteLength: meta.walByteLength + encodedRecord.encoded.byteLength,
		walTailDigest: encodedRecord.digest,
		stateDigest: record.stateDigest,
		revision: session.revision,
		entryCount: session.entries.length,
	};
	assertArtifactWriteSize(path, "wal", session.sessionId, meta.walByteLength, headRecord.walByteLength);
	const preparedHead = prepareHeadWrite(sessionStoreDir, session.sessionId, headRecord);
	return {
		path,
		encodedRecord,
		headRecord,
		headArtifactBytes: preparedHead.encoded.byteLength,
	};
}

function appendWalRecord(
	sessionStoreDir: string,
	session: SessionState,
	meta: DurableSessionMeta,
	faultInjector?: (point: SessionPersistenceFaultPoint) => void,
): DurableSessionMeta {
	const plan = prepareWalWrite(sessionStoreDir, session, meta);
	appendDurableFileSync(plan.path, plan.encodedRecord.encoded);
	faultInjector?.("wal_after_sync_before_head");
	const headDigest = writeHeadRecord(sessionStoreDir, session.sessionId, plan.headRecord);
	return {
		...meta,
		headSequence: plan.headRecord.sequence,
		headDigest,
		entryCount: plan.headRecord.entryCount,
		walRecords: plan.headRecord.walRecordCount,
		walByteLength: plan.headRecord.walByteLength,
		walTailDigest: plan.headRecord.walTailDigest,
		stateDigest: plan.headRecord.stateDigest,
		revision: plan.headRecord.revision,
	};
}

function recoverFailedCommit(
	sessionStoreDir: string,
	session: SessionState,
	key: string,
	meta: PersistedSessionMeta | undefined,
): void {
	if (!existsSync(sessionStoreDir)) {
		if (meta) {
			persistedSessions.set(key, meta);
		} else {
			persistedSessions.delete(key);
		}
		sessionsNeedingRecovery.delete(key);
		return;
	}
	syncDirectorySync(sessionStoreDir);
	const head = readLatestHead(sessionStoreDir, session.sessionId);
	if (!head) {
		if (meta?.format === "durable") {
			throw new Error(`Persisted session durable head disappeared during recovery for ${session.sessionId}`);
		}
		const uncommittedGeneration = meta?.format === "legacy" ? 1 : 0;
		rmSync(snapshotPath(sessionStoreDir, session.sessionId, uncommittedGeneration), { force: true });
		rmSync(walPath(sessionStoreDir, session.sessionId, uncommittedGeneration), { force: true });
		syncDirectorySync(sessionStoreDir);
		if (meta) {
			persistedSessions.set(key, meta);
		} else {
			persistedSessions.delete(key);
		}
		sessionsNeedingRecovery.delete(key);
		return;
	}

	const loaded = loadDurableSession(sessionStoreDir, session.sessionId, head);
	persistedSessions.set(key, loaded.meta);
	const current = exportSessionState(session);
	if (isDeepStrictEqual(current, loaded.session)) {
		markSessionPersisted(session);
		sessionsNeedingRecovery.delete(key);
		return;
	}
	if (session.persistenceChange?.kind === "wal") {
		if (
			loaded.session.entries.length > current.entries.length ||
			!isDeepStrictEqual(current.entries.slice(0, loaded.session.entries.length), loaded.session.entries)
		) {
			throw new Error(`Session ${session.sessionId} diverged from its recovered durable tree`);
		}
		session.persistenceChange = {
			kind: "wal",
			entries: current.entries.slice(loaded.session.entries.length),
			staticContextChanged: !isDeepStrictEqual(current.staticContext, loaded.session.staticContext),
		};
	}
	sessionsNeedingRecovery.delete(key);
}

function shouldWriteSnapshot(session: SessionState, meta: PersistedSessionMeta | undefined): boolean {
	return (
		!meta ||
		meta.format === "legacy" ||
		session.persistenceChange?.kind === "snapshot" ||
		// Keep replay proportional to the checkpoint while amortizing full serialization over equivalent growth.
		(meta.format === "durable" &&
			(meta.walRecords >= Math.max(MIN_WAL_RECORDS_PER_SNAPSHOT, meta.snapshotEntryCount) ||
				meta.walByteLength >= Math.max(MIN_WAL_BYTES_PER_SNAPSHOT, meta.snapshotByteLength)))
	);
}

export function preflightPersistedSession(
	sessionStoreDir: string,
	session: SessionState,
): SessionPersistencePreflightResult {
	const key = persistedSessionKey(sessionStoreDir, session.sessionId);
	if (sessionsNeedingRecovery.has(key)) {
		throw new Error(`Session ${session.sessionId} requires persistence recovery before it can be preflighted`);
	}
	const meta = persistedSessions.get(key);
	if (meta && !session.persistenceChange) return { strategy: "none" };
	if (shouldWriteSnapshot(session, meta)) {
		const plan = prepareSnapshotWrite(sessionStoreDir, session, meta);
		return {
			strategy: "snapshot",
			snapshotArtifactBytes: plan.snapshot.encoded.byteLength,
			walArtifactBytes: 0,
			headArtifactBytes: plan.headArtifactBytes,
		};
	}
	if (meta?.format !== "durable") {
		throw new Error(`Session ${session.sessionId} does not have durable persistence metadata`);
	}
	try {
		const plan = prepareWalWrite(sessionStoreDir, session, meta);
		return {
			strategy: "wal",
			walArtifactBytes: plan.headRecord.walByteLength,
			headArtifactBytes: plan.headArtifactBytes,
		};
	} catch (error) {
		if (!(error instanceof SessionPersistenceCapacityError) || error.resource !== "wal_artifact_bytes") {
			throw error;
		}
		const plan = prepareSnapshotWrite(sessionStoreDir, session, meta);
		return {
			strategy: "snapshot",
			snapshotArtifactBytes: plan.snapshot.encoded.byteLength,
			walArtifactBytes: 0,
			headArtifactBytes: plan.headArtifactBytes,
		};
	}
}

export function savePersistedSession(
	sessionStoreDir: string,
	session: SessionState,
	options: SessionPersistenceOptions = {},
): void {
	const key = persistedSessionKey(sessionStoreDir, session.sessionId);
	if (sessionsNeedingRecovery.has(key)) {
		recoverFailedCommit(sessionStoreDir, session, key, persistedSessions.get(key));
	}
	const meta = persistedSessions.get(key);
	if (meta && !session.persistenceChange) return;
	if (shouldWriteSnapshot(session, meta)) {
		try {
			const nextMeta = writeSnapshot(sessionStoreDir, session, meta, options.faultInjector);
			persistedSessions.set(key, nextMeta);
			markSessionPersisted(session);
		} catch (error) {
			if (!(error instanceof SessionPersistenceCapacityError)) sessionsNeedingRecovery.add(key);
			throw error;
		}
		return;
	}
	if (meta?.format !== "durable") {
		throw new Error(`Session ${session.sessionId} does not have durable persistence metadata`);
	}
	try {
		const nextMeta = appendWalRecord(sessionStoreDir, session, meta, options.faultInjector);
		persistedSessions.set(key, nextMeta);
		markSessionPersisted(session);
	} catch (error) {
		if (error instanceof SessionPersistenceCapacityError && error.resource === "wal_artifact_bytes") {
			try {
				const nextMeta = writeSnapshot(sessionStoreDir, session, meta, options.faultInjector);
				persistedSessions.set(key, nextMeta);
				markSessionPersisted(session);
				return;
			} catch (snapshotError) {
				if (!(snapshotError instanceof SessionPersistenceCapacityError)) sessionsNeedingRecovery.add(key);
				throw snapshotError;
			}
		}
		sessionsNeedingRecovery.add(key);
		throw error;
	}
}

export function deletePersistedSession(sessionStoreDir: string, sessionId: string): void {
	const paths = [
		`${sessionPath(sessionStoreDir, sessionId)}.head.0`,
		`${sessionPath(sessionStoreDir, sessionId)}.head.1`,
		`${sessionPath(sessionStoreDir, sessionId)}.snapshot.0`,
		`${sessionPath(sessionStoreDir, sessionId)}.snapshot.1`,
		`${sessionPath(sessionStoreDir, sessionId)}.wal.0`,
		`${sessionPath(sessionStoreDir, sessionId)}.wal.1`,
		`${sessionPath(sessionStoreDir, sessionId)}.wal`,
		sessionPath(sessionStoreDir, sessionId),
	];
	for (const path of paths) rmSync(path, { force: true });
	if (existsSync(sessionStoreDir)) syncDirectorySync(sessionStoreDir);
	const key = persistedSessionKey(sessionStoreDir, sessionId);
	persistedSessions.delete(key);
	sessionsNeedingRecovery.delete(key);
}
