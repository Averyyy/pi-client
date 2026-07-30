import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, TextDecoder } from "node:util";

const JOURNAL_MAGIC = Buffer.from("PISRUNE2", "ascii");
const FRAME_MAGIC = Buffer.from("PIRF", "ascii");
const FRAME_VERSION = 2;
const FRAME_HEADER_BYTES = 82;
const FRAME_KIND_EVENT = 1;
const FRAME_KIND_TERMINAL = 2;
const FRAME_KIND_COMMIT = 3;
const MAX_FRAME_PAYLOAD_BYTES = 0xffffffff;
const EVENTS_FILE_NAME = "events.bin";
const META_FILE_PATTERN = /^meta-(\d{16})\.json$/;
const RUN_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_FILE_NAME = ".owner.sqlite";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RUN_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_RUNS = 2048;
const DEFAULT_ACKNOWLEDGED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TERMINAL_RESERVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 256;
const DEFAULT_MAX_BATCH_BYTES = DEFAULT_MAX_FRAME_BYTES;
const JOURNAL_CHECKPOINT_INTERVAL = 1024;
const WINDOWS_RENAME_RETRIES = 5;
const WINDOWS_RENAME_RETRY_BASE_MS = 10;
const WINDOWS_REMOVE_RETRIES = 5;
const WINDOWS_REMOVE_RETRY_BASE_MS = 10;
const WINDOWS_REMOVE_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_IO_NO_PROGRESS_TIMEOUT_MS = 120_000;

export const STREAM_RUN_RESTART_ERROR_MESSAGE =
	"pi-server restarted before the provider stream reached a durable terminal state";

export const STREAM_RUN_RESTART_ERROR_EVENT = `data: ${JSON.stringify({
	type: "error",
	reason: "error",
	errorMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
})}\n\n`;

export type StreamRunStatus = "running" | "completed" | "failed";
export type StreamRunTerminalStatus = Exclude<StreamRunStatus, "running">;

export interface StreamRunPersistenceOptions {
	rootDir: string;
	lockPath?: string;
	maxFrameBytes?: number;
	maxRunBytes?: number;
	maxTotalBytes?: number;
	maxRuns?: number;
	/** Must remain Infinity. Unacknowledged terminal runs are never removed automatically. */
	terminalTtlMs?: number;
	acknowledgedTtlMs?: number;
	terminalReserveBytes?: number;
	maxBatchEvents?: number;
	maxBatchBytes?: number;
	/** Bounds one filesystem operation, not the total run, recovery scan, or shutdown duration. */
	ioNoProgressTimeoutMs?: number;
	onFatalError?: (error: StreamRunPersistenceTimeoutError) => void;
	restartFailureEvent?: string;
	restartFailureMessage?: string;
	restartFailureTerminal?: (identity: { sessionId: string; runId: string; requestMac: string }) => {
		event: string;
		result?: unknown;
		errorMessage?: string;
	};
	now?: () => number;
	faultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>;
}

export type StreamRunPersistenceFaultPoint =
	| "journal_before_write"
	| "journal_after_partial_write"
	| "journal_before_sync"
	| "journal_after_sync"
	| "metadata_before_write"
	| "metadata_before_sync"
	| "metadata_before_rename"
	| "delete_before_remove"
	| "directory_before_sync";

export interface BeginStreamRunInput {
	sessionId: string;
	runId: string;
	requestMac: string;
}

export interface AppendStreamRunEventInput {
	sessionId: string;
	runId: string;
	event: string;
	expectedSeq?: number;
}

export interface AppendStreamRunEventsInput {
	sessionId: string;
	runId: string;
	events: readonly string[];
	expectedSeq?: number;
}

export interface SettleStreamRunInput {
	sessionId: string;
	runId: string;
	status: StreamRunTerminalStatus;
	event: string;
	result?: unknown;
	errorMessage?: string;
	expectedSeq?: number;
}

export interface StreamRunTerminal {
	status: StreamRunTerminalStatus;
	event: string;
	result?: unknown;
	errorMessage?: string;
	settledAt: number;
}

export interface StreamRunState {
	sessionId: string;
	runId: string;
	requestMac: string;
	status: StreamRunStatus;
	createdAt: number;
	updatedAt: number;
	acknowledgedAt?: number;
	nextSeq: number;
	journalBytes: number;
	diskBytes: number;
	terminal?: StreamRunTerminal;
}

export type StreamRunEventFrame =
	| {
			kind: "event";
			seq: number;
			event: string;
	  }
	| {
			kind: "terminal";
			seq: number;
			event: string;
			status: StreamRunTerminalStatus;
			result?: unknown;
			errorMessage?: string;
			settledAt: number;
	  };

export interface StreamRunRecoveryResult {
	runs: StreamRunState[];
	recoveredRunning: StreamRunState[];
	repairedTerminalMetadata: StreamRunState[];
	truncatedTails: Array<{ sessionId: string; runId: string }>;
	pruned: StreamRunPruneEntry[];
}

export interface StreamRunPruneEntry {
	sessionId: string;
	runId: string;
	reason: "ttl" | "quota";
	bytesFreed: number;
}

interface NormalizedOptions {
	rootDir: string;
	lockPath: string;
	maxFrameBytes: number;
	maxRunBytes: number;
	maxTotalBytes: number;
	maxRuns: number;
	acknowledgedTtlMs: number;
	terminalReserveBytes: number;
	maxBatchEvents: number;
	maxBatchBytes: number;
	ioNoProgressTimeoutMs: number;
	onFatalError?: (error: StreamRunPersistenceTimeoutError) => void;
	restartFailureEvent: string;
	restartFailureMessage: string;
	restartFailureTerminal?: StreamRunPersistenceOptions["restartFailureTerminal"];
	now: () => number;
	faultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>;
}

interface StoredMetadata {
	version: 1;
	generation: number;
	sessionId: string;
	runId: string;
	requestMac: string;
	status: StreamRunStatus;
	createdAt: number;
	updatedAt: number;
	acknowledgedAt?: number;
}

interface StoredMetadataEnvelope {
	payload: StoredMetadata;
	sha256: string;
}

interface StoredTerminalPayload {
	status: StreamRunTerminalStatus;
	event: string;
	result?: unknown;
	errorMessage?: string;
	settledAt: number;
}

interface RunRecord {
	key: string;
	directory: string;
	eventsPath: string;
	sessionId: string;
	runId: string;
	requestMac: string;
	status: StreamRunStatus;
	metadataStatus: StreamRunStatus;
	createdAt: number;
	updatedAt: number;
	acknowledgedAt?: number;
	metaGeneration: number;
	metaBytes: number;
	journalBytes: number;
	diskBytes: number;
	nextSeq: number;
	tailHash: Buffer;
	terminal?: StoredTerminalPayload;
	checkpoints: JournalCheckpoint[];
	activeReaders: Set<FileHandle>;
	terminalReservationBytes: number;
	tailTruncatedOnLoad: boolean;
}

interface JournalCheckpoint {
	seq: number;
	offset: number;
	previousHash: Buffer;
}

interface JournalScanResult {
	journalBytes: number;
	nextSeq: number;
	tailHash: Buffer;
	terminal?: StoredTerminalPayload;
	checkpoints: JournalCheckpoint[];
	tailTruncated: boolean;
}

interface ParsedEventFrame {
	kind: "event";
	seq: number;
	event: string;
	hash: Buffer;
	nextOffset: number;
}

interface ParsedTerminalFrame {
	kind: "terminal";
	seq: number;
	terminal: StoredTerminalPayload;
	hash: Buffer;
	nextOffset: number;
}

interface ParsedCommitFrame {
	kind: "commit";
	seq: number;
	firstSeq: number;
	count: number;
	hash: Buffer;
	nextOffset: number;
}

type ParsedFrame = ParsedEventFrame | ParsedTerminalFrame | ParsedCommitFrame;

interface IncompleteFrame {
	kind: "incomplete";
}

type FrameReadResult = ParsedFrame | IncompleteFrame;

export class StreamRunPersistenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamRunPersistenceError";
	}
}

export class StreamRunCorruptionError extends StreamRunPersistenceError {
	readonly runPath: string;

	constructor(runPath: string, detail: string) {
		super(`Corrupt stream run at ${runPath}: ${detail}`);
		this.name = "StreamRunCorruptionError";
		this.runPath = runPath;
	}
}

export class StreamRunConflictError extends StreamRunPersistenceError {
	constructor(message: string) {
		super(message);
		this.name = "StreamRunConflictError";
	}
}

export class StreamRunNotFoundError extends StreamRunPersistenceError {
	constructor(sessionId: string, runId: string) {
		super(`Stream run not found: ${sessionId}/${runId}`);
		this.name = "StreamRunNotFoundError";
	}
}

export class StreamRunStateError extends StreamRunPersistenceError {
	constructor(message: string) {
		super(message);
		this.name = "StreamRunStateError";
	}
}

export class StreamRunQuotaError extends StreamRunPersistenceError {
	constructor(message: string) {
		super(message);
		this.name = "StreamRunQuotaError";
	}
}

export class StreamRunBusyError extends StreamRunPersistenceError {
	constructor(sessionId: string, runId: string) {
		super(`Stream run has an active event reader: ${sessionId}/${runId}`);
		this.name = "StreamRunBusyError";
	}
}

export class StreamRunStoreLockedError extends StreamRunPersistenceError {
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`Stream run store is already owned by another process: ${lockPath}`);
		this.name = "StreamRunStoreLockedError";
		this.lockPath = lockPath;
	}
}

export class StreamRunPersistenceTimeoutError extends StreamRunPersistenceError {
	readonly operation: string;
	readonly timeoutMs: number;
	readonly #isUnderlyingOperationSettled: () => boolean;

	constructor(operation: string, timeoutMs: number, isUnderlyingOperationSettled = () => false) {
		super(`Stream run persistence ${operation} made no progress for ${timeoutMs}ms`);
		this.name = "StreamRunPersistenceTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
		this.#isUnderlyingOperationSettled = isUnderlyingOperationSettled;
	}

	isUnderlyingOperationSettled(): boolean {
		return this.#isUnderlyingOperationSettled();
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
	const allowed = new Set(allowedKeys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function freezeJsonValue(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	if (Array.isArray(value)) {
		for (const entry of value) freezeJsonValue(entry);
	} else {
		for (const entry of Object.values(value)) freezeJsonValue(entry);
	}
	Object.freeze(value);
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertIdentifier(value: string, label: string): void {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
		throw new StreamRunPersistenceError(`${label} must be a non-empty string without NUL bytes`);
	}
}

function assertRequestMac(value: string): void {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new StreamRunPersistenceError("requestMac must be a lowercase 64-character SHA-256 hex digest");
	}
}

function assertPositiveSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new StreamRunPersistenceError(`${label} must be a positive safe integer`);
	}
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new StreamRunPersistenceError(`${label} must be a non-negative safe integer`);
	}
}

function assertDuration(value: number, label: string): void {
	if (value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value < 0)) {
		throw new StreamRunPersistenceError(`${label} must be a non-negative safe integer or Infinity`);
	}
}

function normalizeOptions(options: StreamRunPersistenceOptions): NormalizedOptions {
	if (!options.rootDir) {
		throw new StreamRunPersistenceError("rootDir is required");
	}
	const rootDir = resolve(options.rootDir);
	if (dirname(rootDir) === rootDir) {
		throw new StreamRunPersistenceError("rootDir must not be a filesystem root");
	}
	const lockPath = resolve(options.lockPath ?? join(rootDir, LOCK_FILE_NAME));
	if (dirname(lockPath) === lockPath) {
		throw new StreamRunPersistenceError("lockPath must not be a filesystem root");
	}
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	const maxRunBytes = options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
	const terminalTtlMs = options.terminalTtlMs ?? Number.POSITIVE_INFINITY;
	const acknowledgedTtlMs = options.acknowledgedTtlMs ?? DEFAULT_ACKNOWLEDGED_TTL_MS;
	const terminalReserveBytes =
		options.terminalReserveBytes ?? Math.min(DEFAULT_TERMINAL_RESERVE_BYTES, Math.floor(maxRunBytes / 2));
	const maxBatchEvents = options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS;
	const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
	const ioNoProgressTimeoutMs = options.ioNoProgressTimeoutMs ?? DEFAULT_IO_NO_PROGRESS_TIMEOUT_MS;
	assertPositiveSafeInteger(maxFrameBytes, "maxFrameBytes");
	assertPositiveSafeInteger(maxRunBytes, "maxRunBytes");
	assertPositiveSafeInteger(maxTotalBytes, "maxTotalBytes");
	assertPositiveSafeInteger(maxRuns, "maxRuns");
	assertDuration(terminalTtlMs, "terminalTtlMs");
	assertDuration(acknowledgedTtlMs, "acknowledgedTtlMs");
	assertNonNegativeSafeInteger(terminalReserveBytes, "terminalReserveBytes");
	assertPositiveSafeInteger(maxBatchEvents, "maxBatchEvents");
	assertPositiveSafeInteger(maxBatchBytes, "maxBatchBytes");
	assertPositiveSafeInteger(ioNoProgressTimeoutMs, "ioNoProgressTimeoutMs");
	if (terminalTtlMs !== Number.POSITIVE_INFINITY) {
		throw new StreamRunPersistenceError(
			"terminalTtlMs must be Infinity because unacknowledged terminal runs cannot expire",
		);
	}
	if (maxFrameBytes > MAX_FRAME_PAYLOAD_BYTES) {
		throw new StreamRunPersistenceError("maxFrameBytes must fit the journal's uint32 length prefix");
	}
	if (terminalReserveBytes >= maxRunBytes) {
		throw new StreamRunPersistenceError("terminalReserveBytes must be smaller than maxRunBytes");
	}
	const restartFailureEvent = options.restartFailureEvent ?? STREAM_RUN_RESTART_ERROR_EVENT;
	const restartFailureMessage = options.restartFailureMessage ?? STREAM_RUN_RESTART_ERROR_MESSAGE;
	if (typeof restartFailureEvent !== "string" || restartFailureEvent.length === 0) {
		throw new StreamRunPersistenceError("restartFailureEvent must be a non-empty string");
	}
	if (typeof restartFailureMessage !== "string" || restartFailureMessage.length === 0) {
		throw new StreamRunPersistenceError("restartFailureMessage must be a non-empty string");
	}
	if (Buffer.byteLength(restartFailureEvent, "utf-8") > maxFrameBytes) {
		throw new StreamRunPersistenceError("restartFailureEvent exceeds maxFrameBytes");
	}
	const restartTerminalBytes = Buffer.byteLength(
		JSON.stringify({
			status: "failed",
			event: restartFailureEvent,
			errorMessage: restartFailureMessage,
			settledAt: Number.MAX_SAFE_INTEGER,
		}),
		"utf-8",
	);
	if (restartTerminalBytes > terminalReserveBytes) {
		throw new StreamRunPersistenceError("terminalReserveBytes must fit the durable restart failure terminal payload");
	}
	return {
		rootDir,
		lockPath,
		maxFrameBytes,
		maxRunBytes,
		maxTotalBytes,
		maxRuns,
		acknowledgedTtlMs,
		terminalReserveBytes,
		maxBatchEvents,
		maxBatchBytes,
		ioNoProgressTimeoutMs,
		onFatalError: options.onFatalError,
		restartFailureEvent,
		restartFailureMessage,
		restartFailureTerminal: options.restartFailureTerminal,
		now: options.now ?? (() => Date.now()),
		faultInjector: options.faultInjector,
	};
}

async function waitForFilesystemProgress<T>(promise: Promise<T>, operation: string, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let operationSettled = false;
	const observed = promise.then(
		(value) => {
			operationSettled = true;
			return value;
		},
		(error: unknown) => {
			operationSettled = true;
			throw error;
		},
	);
	const stalled = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() => reject(new StreamRunPersistenceTimeoutError(operation, timeoutMs, () => operationSettled)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([observed, stalled]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function runFaultInjector(
	faultInjector: ((point: StreamRunPersistenceFaultPoint) => void | Promise<void>) | undefined,
	point: StreamRunPersistenceFaultPoint,
	timeoutMs: number,
): Promise<void> {
	if (!faultInjector) return;
	await waitForFilesystemProgress(Promise.resolve(faultInjector(point)), `fault injector ${point}`, timeoutMs);
}

function sha256(value: Buffer | string): Buffer {
	return createHash("sha256").update(value).digest();
}

function sha256Hex(value: Buffer | string): string {
	return sha256(value).toString("hex");
}

function runDirectoryName(sessionId: string, runId: string): string {
	return sha256Hex(`${sessionId}\0${runId}`);
}

function journalGenesisHash(sessionId: string, runId: string, requestMac: string): Buffer {
	return sha256(`pi-stream-run-v1\0${sessionId}\0${runId}\0${requestMac}`);
}

function opaqueStringsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "utf-8");
	const rightBytes = Buffer.from(right, "utf-8");
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function metadataFileName(generation: number): string {
	return `meta-${generation.toString().padStart(16, "0")}.json`;
}

function metadataPayload(record: RunRecord, generation: number): StoredMetadata {
	if (!Number.isSafeInteger(generation) || generation <= 0) {
		throw new StreamRunStateError("Stream run metadata generation limit reached");
	}
	const payload: StoredMetadata = {
		version: 1,
		generation,
		sessionId: record.sessionId,
		runId: record.runId,
		requestMac: record.requestMac,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (record.acknowledgedAt !== undefined) {
		payload.acknowledgedAt = record.acknowledgedAt;
	}
	return payload;
}

function encodeMetadata(payload: StoredMetadata): Buffer {
	const envelope: StoredMetadataEnvelope = {
		payload,
		sha256: sha256Hex(JSON.stringify(payload)),
	};
	return Buffer.from(JSON.stringify(envelope), "utf-8");
}

function parseMetadata(runPath: string, fileName: string, encoded: Buffer): StoredMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded.toString("utf-8")) as unknown;
	} catch (error) {
		throw new StreamRunCorruptionError(
			runPath,
			`${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!isRecord(parsed) ||
		!hasOnlyKeys(parsed, ["payload", "sha256"]) ||
		!isRecord(parsed.payload) ||
		typeof parsed.sha256 !== "string" ||
		!SHA256_PATTERN.test(parsed.sha256)
	) {
		throw new StreamRunCorruptionError(runPath, `${fileName} has an invalid metadata envelope`);
	}
	if (!opaqueStringsEqual(parsed.sha256, sha256Hex(JSON.stringify(parsed.payload)))) {
		throw new StreamRunCorruptionError(runPath, `${fileName} checksum does not match`);
	}
	const payload = parsed.payload;
	if (
		!hasOnlyKeys(payload, [
			"version",
			"generation",
			"sessionId",
			"runId",
			"requestMac",
			"status",
			"createdAt",
			"updatedAt",
			"acknowledgedAt",
		]) ||
		payload.version !== 1 ||
		typeof payload.generation !== "number" ||
		!Number.isSafeInteger(payload.generation) ||
		payload.generation <= 0 ||
		typeof payload.sessionId !== "string" ||
		typeof payload.runId !== "string" ||
		typeof payload.requestMac !== "string" ||
		(payload.status !== "running" && payload.status !== "completed" && payload.status !== "failed") ||
		!isSafeTimestamp(payload.createdAt) ||
		!isSafeTimestamp(payload.updatedAt) ||
		payload.updatedAt < payload.createdAt ||
		(payload.acknowledgedAt !== undefined &&
			(!isSafeTimestamp(payload.acknowledgedAt) ||
				payload.acknowledgedAt < payload.createdAt ||
				payload.status === "running"))
	) {
		throw new StreamRunCorruptionError(runPath, `${fileName} has invalid metadata fields`);
	}
	assertIdentifier(payload.sessionId, "persisted sessionId");
	assertIdentifier(payload.runId, "persisted runId");
	assertRequestMac(payload.requestMac);
	const match = META_FILE_PATTERN.exec(fileName);
	if (!match || Number(match[1]) !== payload.generation) {
		throw new StreamRunCorruptionError(runPath, `${fileName} generation does not match its filename`);
	}
	return payload as unknown as StoredMetadata;
}

function validateMetadataHistory(runPath: string, metadata: readonly StoredMetadata[]): void {
	if (metadata.length === 0 || metadata[0].generation !== 1) {
		throw new StreamRunCorruptionError(runPath, "metadata history does not start at generation 1");
	}
	for (let index = 1; index < metadata.length; index++) {
		const previous = metadata[index - 1];
		const current = metadata[index];
		if (current.generation !== previous.generation + 1) {
			throw new StreamRunCorruptionError(runPath, "metadata generations are not contiguous");
		}
		if (
			current.sessionId !== previous.sessionId ||
			current.runId !== previous.runId ||
			!opaqueStringsEqual(current.requestMac, previous.requestMac) ||
			current.createdAt !== previous.createdAt
		) {
			throw new StreamRunCorruptionError(runPath, "metadata identity changed between generations");
		}
		if (
			(previous.status !== "running" && current.status !== previous.status) ||
			previous.updatedAt > current.updatedAt
		) {
			throw new StreamRunCorruptionError(runPath, "metadata state regressed between generations");
		}
		if (previous.acknowledgedAt !== undefined && current.acknowledgedAt !== previous.acknowledgedAt) {
			throw new StreamRunCorruptionError(runPath, "metadata acknowledgement changed between generations");
		}
	}
}

function normalizeTerminalPayload(input: SettleStreamRunInput, settledAt: number): StoredTerminalPayload {
	if (input.status !== "completed" && input.status !== "failed") {
		throw new StreamRunPersistenceError("terminal status must be completed or failed");
	}
	if (typeof input.event !== "string" || input.event.length === 0) {
		throw new StreamRunPersistenceError("terminal event must be a non-empty string");
	}
	if (input.status === "failed") {
		if (typeof input.errorMessage !== "string" || input.errorMessage.length === 0) {
			throw new StreamRunPersistenceError("failed stream runs require a non-empty errorMessage");
		}
	} else if (input.errorMessage !== undefined) {
		throw new StreamRunPersistenceError("completed stream runs must not include errorMessage");
	}
	const candidate: Record<string, unknown> = {
		status: input.status,
		event: input.event,
		settledAt,
	};
	if (input.result !== undefined) {
		candidate.result = input.result;
	}
	if (input.errorMessage !== undefined) {
		candidate.errorMessage = input.errorMessage;
	}
	let encoded: string;
	try {
		const serialized = JSON.stringify(candidate);
		if (serialized === undefined) {
			throw new Error("value is not JSON serializable");
		}
		encoded = serialized;
	} catch (error) {
		throw new StreamRunPersistenceError(
			`terminal payload is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseTerminalPayload("<new stream run>", Buffer.from(encoded, "utf-8"));
}

function parseTerminalPayload(runPath: string, encoded: Buffer): StoredTerminalPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(UTF8_DECODER.decode(encoded)) as unknown;
	} catch (error) {
		throw new StreamRunCorruptionError(
			runPath,
			`terminal frame is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!isRecord(parsed) ||
		!hasOnlyKeys(parsed, ["status", "event", "result", "errorMessage", "settledAt"]) ||
		(parsed.status !== "completed" && parsed.status !== "failed") ||
		typeof parsed.event !== "string" ||
		parsed.event.length === 0 ||
		!isSafeTimestamp(parsed.settledAt) ||
		(parsed.errorMessage !== undefined && typeof parsed.errorMessage !== "string") ||
		(parsed.status === "failed" && (typeof parsed.errorMessage !== "string" || parsed.errorMessage.length === 0)) ||
		(parsed.status === "completed" && parsed.errorMessage !== undefined)
	) {
		throw new StreamRunCorruptionError(runPath, "terminal frame has invalid fields");
	}
	freezeJsonValue(parsed);
	return parsed as unknown as StoredTerminalPayload;
}

function encodeTerminalPayload(payload: StoredTerminalPayload): Buffer {
	return Buffer.from(JSON.stringify(payload), "utf-8");
}

function createFrame(
	kind: number,
	seq: number,
	payload: Buffer,
	previousHash: Buffer,
): { encoded: Buffer; hash: Buffer } {
	if (!Number.isSafeInteger(seq) || seq < 0 || seq >= Number.MAX_SAFE_INTEGER) {
		throw new StreamRunStateError("Stream run sequence limit reached");
	}
	const header = Buffer.alloc(FRAME_HEADER_BYTES);
	FRAME_MAGIC.copy(header, 0);
	header.writeUInt8(FRAME_VERSION, 4);
	header.writeUInt8(kind, 5);
	header.writeBigUInt64BE(BigInt(seq), 6);
	header.writeUInt32BE(payload.length, 14);
	previousHash.copy(header, 18);
	const hash = createHash("sha256").update(header.subarray(0, 50)).update(payload).digest();
	hash.copy(header, 50);
	return { encoded: Buffer.concat([header, payload]), hash };
}

function encodeCommitPayload(firstSeq: number, count: number): Buffer {
	if (
		!Number.isSafeInteger(firstSeq) ||
		firstSeq < 0 ||
		!Number.isSafeInteger(count) ||
		count <= 0 ||
		count > 0xffffffff
	) {
		throw new StreamRunStateError("Stream run commit marker values are out of range");
	}
	const payload = Buffer.alloc(12);
	payload.writeBigUInt64BE(BigInt(firstSeq), 0);
	payload.writeUInt32BE(count, 8);
	return payload;
}

function parseCommitPayload(runPath: string, payload: Buffer): { firstSeq: number; count: number } {
	if (payload.length !== 12) {
		throw new StreamRunCorruptionError(runPath, "commit marker has an invalid payload length");
	}
	const rawFirstSeq = payload.readBigUInt64BE(0);
	const count = payload.readUInt32BE(8);
	if (rawFirstSeq > BigInt(Number.MAX_SAFE_INTEGER) || count === 0) {
		throw new StreamRunCorruptionError(runPath, "commit marker has invalid sequence metadata");
	}
	return { firstSeq: Number(rawFirstSeq), count };
}

async function readExactly(
	handle: FileHandle,
	buffer: Buffer,
	offset: number,
	length: number,
	position: number,
	timeoutMs: number,
): Promise<number> {
	let total = 0;
	while (total < length) {
		const result = await waitForFilesystemProgress(
			handle.read(buffer, offset + total, length - total, position + total),
			"read",
			timeoutMs,
		);
		if (result.bytesRead === 0) break;
		total += result.bytesRead;
	}
	return total;
}

async function writeExactly(handle: FileHandle, buffer: Buffer, position: number, timeoutMs: number): Promise<void> {
	let total = 0;
	while (total < buffer.length) {
		const result = await waitForFilesystemProgress(
			handle.write(buffer, total, buffer.length - total, position + total),
			"write",
			timeoutMs,
		);
		if (result.bytesWritten === 0) {
			throw new StreamRunPersistenceError("Filesystem write made no progress");
		}
		total += result.bytesWritten;
	}
}

async function syncDirectory(
	path: string,
	timeoutMs: number,
	faultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>,
): Promise<void> {
	if (process.platform === "win32") return;
	await runFaultInjector(faultInjector, "directory_before_sync", timeoutMs);
	const handle = await waitForFilesystemProgress(open(path, "r"), "open directory", timeoutMs);
	try {
		await waitForFilesystemProgress(handle.sync(), "fsync directory", timeoutMs);
	} finally {
		await waitForFilesystemProgress(handle.close(), "close directory", timeoutMs);
	}
}

async function renameDurably(
	source: string,
	target: string,
	parentDirectory: string,
	timeoutMs: number,
	faultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await runFaultInjector(faultInjector, "metadata_before_rename", timeoutMs);
			await waitForFilesystemProgress(rename(source, target), "rename metadata", timeoutMs);
			break;
		} catch (error) {
			if (errorCode(error) !== "EPERM" || attempt >= WINDOWS_RENAME_RETRIES - 1) {
				throw error;
			}
			await delay(WINDOWS_RENAME_RETRY_BASE_MS * (attempt + 1));
		}
	}
	await syncDirectory(parentDirectory, timeoutMs, faultInjector);
}

async function verifyJournalMagic(handle: FileHandle, runPath: string, size: number, timeoutMs: number): Promise<void> {
	if (size < JOURNAL_MAGIC.length) {
		throw new StreamRunCorruptionError(runPath, "event journal header is truncated");
	}
	const header = Buffer.alloc(JOURNAL_MAGIC.length);
	if (
		(await readExactly(handle, header, 0, header.length, 0, timeoutMs)) !== header.length ||
		!header.equals(JOURNAL_MAGIC)
	) {
		throw new StreamRunCorruptionError(runPath, "event journal magic does not match");
	}
}

async function readFrameAt(
	handle: FileHandle,
	runPath: string,
	position: number,
	endOffset: number,
	expectedSeq: number,
	expectedPreviousHash: Buffer,
	maxFrameBytes: number,
	timeoutMs: number,
): Promise<FrameReadResult> {
	const remaining = endOffset - position;
	if (remaining < FRAME_HEADER_BYTES) return { kind: "incomplete" };
	const header = Buffer.alloc(FRAME_HEADER_BYTES);
	if ((await readExactly(handle, header, 0, header.length, position, timeoutMs)) !== header.length) {
		return { kind: "incomplete" };
	}
	if (!header.subarray(0, 4).equals(FRAME_MAGIC)) {
		throw new StreamRunCorruptionError(runPath, `frame at byte ${position} has invalid magic`);
	}
	if (header.readUInt8(4) !== FRAME_VERSION) {
		throw new StreamRunCorruptionError(runPath, `frame at byte ${position} has unsupported version`);
	}
	const frameKind = header.readUInt8(5);
	if (frameKind !== FRAME_KIND_EVENT && frameKind !== FRAME_KIND_TERMINAL && frameKind !== FRAME_KIND_COMMIT) {
		throw new StreamRunCorruptionError(runPath, `frame at byte ${position} has invalid kind`);
	}
	const rawSeq = header.readBigUInt64BE(6);
	if (rawSeq > BigInt(Number.MAX_SAFE_INTEGER) || Number(rawSeq) !== expectedSeq) {
		throw new StreamRunCorruptionError(runPath, `frame at byte ${position} has an invalid sequence`);
	}
	const payloadLength = header.readUInt32BE(14);
	if (payloadLength > maxFrameBytes) {
		throw new StreamRunCorruptionError(runPath, `frame at byte ${position} exceeds maxFrameBytes`);
	}
	if (!header.subarray(18, 50).equals(expectedPreviousHash)) {
		throw new StreamRunCorruptionError(runPath, `frame ${expectedSeq} has an invalid previous hash`);
	}
	if (remaining < FRAME_HEADER_BYTES + payloadLength) return { kind: "incomplete" };
	const payload = Buffer.alloc(payloadLength);
	if (
		payloadLength > 0 &&
		(await readExactly(handle, payload, 0, payloadLength, position + FRAME_HEADER_BYTES, timeoutMs)) !== payloadLength
	) {
		return { kind: "incomplete" };
	}
	const expectedHash = createHash("sha256").update(header.subarray(0, 50)).update(payload).digest();
	const storedHash = header.subarray(50, 82);
	if (!timingSafeEqual(expectedHash, storedHash)) {
		throw new StreamRunCorruptionError(runPath, `frame ${expectedSeq} checksum does not match`);
	}
	const nextOffset = position + FRAME_HEADER_BYTES + payloadLength;
	if (frameKind === FRAME_KIND_COMMIT) {
		const commit = parseCommitPayload(runPath, payload);
		return {
			kind: "commit",
			seq: expectedSeq,
			firstSeq: commit.firstSeq,
			count: commit.count,
			hash: Buffer.from(storedHash),
			nextOffset,
		};
	}
	if (frameKind === FRAME_KIND_TERMINAL) {
		return {
			kind: "terminal",
			seq: expectedSeq,
			terminal: parseTerminalPayload(runPath, payload),
			hash: Buffer.from(storedHash),
			nextOffset,
		};
	}
	let event: string;
	try {
		event = UTF8_DECODER.decode(payload);
	} catch (error) {
		throw new StreamRunCorruptionError(
			runPath,
			`event frame ${expectedSeq} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		kind: "event",
		seq: expectedSeq,
		event,
		hash: Buffer.from(storedHash),
		nextOffset,
	};
}

async function scanJournal(
	eventsPath: string,
	maxFrameBytes: number,
	repairIncompleteTail: boolean,
	initialHash: Buffer,
	timeoutMs: number,
): Promise<JournalScanResult> {
	const handle = await waitForFilesystemProgress(
		open(eventsPath, repairIncompleteTail ? "r+" : "r"),
		"open journal",
		timeoutMs,
	);
	try {
		const fileStats = await waitForFilesystemProgress(handle.stat(), "stat journal", timeoutMs);
		await verifyJournalMagic(handle, eventsPath, fileStats.size, timeoutMs);
		let position = JOURNAL_MAGIC.length;
		let nextSeq = 0;
		let tailHash = initialHash;
		let terminal: StoredTerminalPayload | undefined;
		let transactionStartPosition = position;
		let transactionStartSeq = nextSeq;
		let transactionStartHash = tailHash;
		let transactionFrameCount = 0;
		let pendingTerminal: StoredTerminalPayload | undefined;
		const checkpoints: JournalCheckpoint[] = [
			{ seq: 0, offset: JOURNAL_MAGIC.length, previousHash: Buffer.from(initialHash) },
		];
		let tailTruncated = false;
		while (position < fileStats.size) {
			const parsed = await readFrameAt(
				handle,
				eventsPath,
				position,
				fileStats.size,
				nextSeq,
				tailHash,
				maxFrameBytes,
				timeoutMs,
			);
			if (parsed.kind === "incomplete") {
				if (!repairIncompleteTail) {
					throw new StreamRunCorruptionError(
						eventsPath,
						`event journal has an uncommitted or truncated tail at byte ${transactionStartPosition}`,
					);
				}
				await waitForFilesystemProgress(handle.truncate(transactionStartPosition), "truncate journal", timeoutMs);
				await waitForFilesystemProgress(handle.sync(), "fsync journal", timeoutMs);
				position = transactionStartPosition;
				nextSeq = transactionStartSeq;
				tailHash = transactionStartHash;
				tailTruncated = true;
				break;
			}
			if (terminal || (pendingTerminal && parsed.kind !== "commit")) {
				throw new StreamRunCorruptionError(eventsPath, "event journal contains data after its terminal frame");
			}
			position = parsed.nextOffset;
			tailHash = parsed.hash;
			if (parsed.kind === "commit") {
				if (
					transactionFrameCount === 0 ||
					parsed.firstSeq !== transactionStartSeq ||
					parsed.count !== transactionFrameCount
				) {
					throw new StreamRunCorruptionError(
						eventsPath,
						`commit marker at byte ${position} does not match its batch`,
					);
				}
				terminal = pendingTerminal;
				transactionStartPosition = position;
				transactionStartSeq = nextSeq;
				transactionStartHash = tailHash;
				transactionFrameCount = 0;
				pendingTerminal = undefined;
				const lastCheckpoint = checkpoints.at(-1);
				if (!lastCheckpoint || nextSeq - lastCheckpoint.seq >= JOURNAL_CHECKPOINT_INTERVAL) {
					checkpoints.push({
						seq: nextSeq,
						offset: position,
						previousHash: Buffer.from(tailHash),
					});
				}
				continue;
			}
			nextSeq++;
			transactionFrameCount++;
			if (parsed.kind === "terminal") pendingTerminal = parsed.terminal;
		}
		if (transactionFrameCount > 0) {
			if (!repairIncompleteTail) {
				throw new StreamRunCorruptionError(
					eventsPath,
					`event journal has an uncommitted tail at byte ${transactionStartPosition}`,
				);
			}
			await waitForFilesystemProgress(handle.truncate(transactionStartPosition), "truncate journal", timeoutMs);
			await waitForFilesystemProgress(handle.sync(), "fsync journal", timeoutMs);
			position = transactionStartPosition;
			nextSeq = transactionStartSeq;
			tailHash = transactionStartHash;
			tailTruncated = true;
		}
		return {
			journalBytes: position,
			nextSeq,
			tailHash,
			terminal,
			checkpoints,
			tailTruncated,
		};
	} finally {
		await waitForFilesystemProgress(handle.close(), "close journal", timeoutMs);
	}
}

function publicTerminal(terminal: StoredTerminalPayload): StreamRunTerminal {
	const result: StreamRunTerminal = {
		status: terminal.status,
		event: terminal.event,
		settledAt: terminal.settledAt,
	};
	if (terminal.result !== undefined) {
		result.result = terminal.result;
	}
	if (terminal.errorMessage !== undefined) {
		result.errorMessage = terminal.errorMessage;
	}
	return result;
}

function publicState(record: RunRecord, includeTerminal = true): StreamRunState {
	const state: StreamRunState = {
		sessionId: record.sessionId,
		runId: record.runId,
		requestMac: record.requestMac,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		nextSeq: record.nextSeq,
		journalBytes: record.journalBytes,
		diskBytes: record.diskBytes,
	};
	if (record.acknowledgedAt !== undefined) {
		state.acknowledgedAt = record.acknowledgedAt;
	}
	if (includeTerminal && record.terminal !== undefined) {
		state.terminal = publicTerminal(record.terminal);
	}
	return state;
}

function clonePruneEntry(entry: StreamRunPruneEntry): StreamRunPruneEntry {
	return { ...entry };
}

function cloneRecoveryResult(result: StreamRunRecoveryResult): StreamRunRecoveryResult {
	return {
		runs: result.runs.map((run) => ({ ...run })),
		recoveredRunning: result.recoveredRunning.map((run) => ({ ...run })),
		repairedTerminalMetadata: result.repairedTerminalMetadata.map((run) => ({ ...run })),
		truncatedTails: result.truncatedTails.map((run) => ({ ...run })),
		pruned: result.pruned.map(clonePruneEntry),
	};
}

export class StreamRunPersistence {
	readonly rootDir: string;
	readonly #options: NormalizedOptions;
	readonly #records = new Map<string, RunRecord>();
	readonly #readerHandles = new Set<FileHandle>();
	readonly #lockPath: string;
	#queue: Promise<void> = Promise.resolve();
	#initialized = false;
	#closing = false;
	#totalBytes = 0;
	#totalReservedBytes = 0;
	#lockDatabase?: DatabaseSync;
	#closePromise?: Promise<void>;
	#initialRecovery?: StreamRunRecoveryResult;
	#fatalError?: StreamRunPersistenceTimeoutError;

	constructor(options: StreamRunPersistenceOptions) {
		this.#options = normalizeOptions(options);
		this.rootDir = this.#options.rootDir;
		this.#lockPath = this.#options.lockPath;
	}

	initialize(): Promise<StreamRunRecoveryResult> {
		return this.#enqueue(async () => {
			if (this.#initialized && this.#initialRecovery) {
				await this.#assertLockOwned();
				return cloneRecoveryResult(this.#initialRecovery);
			}
			if (this.#closing) {
				throw new StreamRunPersistenceError("Stream run store is closing");
			}
			this.#records.clear();
			this.#totalBytes = 0;
			this.#totalReservedBytes = 0;
			await waitForFilesystemProgress(
				mkdir(this.rootDir, { recursive: true }),
				"create stream run root",
				this.#options.ioNoProgressTimeoutMs,
			);
			await this.#acquireLock();
			try {
				const rootEntries = await waitForFilesystemProgress(
					readdir(this.rootDir, { withFileTypes: true }),
					"read stream run root",
					this.#options.ioNoProgressTimeoutMs,
				);
				for (const entry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
					const entryPath = resolve(this.rootDir, entry.name);
					if (entryPath === this.#lockPath || entryPath.startsWith(`${this.#lockPath}-`)) continue;
					if (!entry.isDirectory() || !RUN_DIRECTORY_PATTERN.test(entry.name)) {
						throw new StreamRunCorruptionError(
							this.rootDir,
							`unexpected entry in stream run store: ${entry.name}`,
						);
					}
					const record = await this.#loadRunDirectory(entry);
					if (!record) continue;
					if (this.#records.has(record.key)) {
						throw new StreamRunCorruptionError(record.directory, "duplicate stream run identity");
					}
					this.#records.set(record.key, record);
					this.#totalBytes += record.diskBytes;
					this.#totalReservedBytes += record.terminalReservationBytes;
				}

				const recoveredRunning: StreamRunState[] = [];
				const repairedTerminalMetadata: StreamRunState[] = [];
				const truncatedTails: Array<{ sessionId: string; runId: string }> = [];
				for (const record of this.#records.values()) {
					if (record.tailTruncatedOnLoad) {
						truncatedTails.push({ sessionId: record.sessionId, runId: record.runId });
					}
					if (record.terminal) {
						if (
							record.terminal.settledAt < record.createdAt ||
							(record.status !== "running" && record.updatedAt < record.terminal.settledAt) ||
							(record.acknowledgedAt !== undefined && record.acknowledgedAt < record.terminal.settledAt)
						) {
							throw new StreamRunCorruptionError(
								record.directory,
								"terminal timestamps do not match metadata chronology",
							);
						}
						if (record.status === "running") {
							record.status = record.terminal.status;
							record.updatedAt = Math.max(record.updatedAt, record.terminal.settledAt);
							this.#releaseTerminalReservation(record);
							await this.#persistCurrentMetadata(record);
							repairedTerminalMetadata.push(publicState(record, false));
						} else if (record.status !== record.terminal.status) {
							throw new StreamRunCorruptionError(
								record.directory,
								"terminal frame status does not match metadata status",
							);
						}
						continue;
					}
					if (record.status !== "running") {
						throw new StreamRunCorruptionError(
							record.directory,
							"terminal metadata has no matching terminal journal frame",
						);
					}
					const settledAt = Math.max(record.updatedAt, this.#now());
					const restartTerminal = this.#options.restartFailureTerminal?.({
						sessionId: record.sessionId,
						runId: record.runId,
						requestMac: record.requestMac,
					});
					const terminal = normalizeTerminalPayload(
						{
							sessionId: record.sessionId,
							runId: record.runId,
							status: "failed",
							event: restartTerminal?.event ?? this.#options.restartFailureEvent,
							result: restartTerminal?.result,
							errorMessage: restartTerminal?.errorMessage ?? this.#options.restartFailureMessage,
						},
						settledAt,
					);
					if (Buffer.byteLength(encodeTerminalPayload(terminal)) > this.#options.terminalReserveBytes) {
						throw new StreamRunQuotaError(
							`Restart failure terminal exceeds terminalReserveBytes: ${record.sessionId}/${record.runId}`,
						);
					}
					await this.#appendStoredFrame(record, FRAME_KIND_TERMINAL, encodeTerminalPayload(terminal), terminal);
					record.status = "failed";
					record.updatedAt = settledAt;
					this.#releaseTerminalReservation(record);
					await this.#persistCurrentMetadata(record);
					recoveredRunning.push(publicState(record));
				}

				this.#initialized = true;
				const pruned = await this.#pruneInternal(this.#now(), true);
				const result: StreamRunRecoveryResult = {
					runs: [...this.#records.values()].map((record) => publicState(record, false)),
					recoveredRunning,
					repairedTerminalMetadata,
					truncatedTails,
					pruned,
				};
				this.#initialRecovery = cloneRecoveryResult(result);
				return cloneRecoveryResult(result);
			} catch (error) {
				this.#initialized = false;
				if (!(error instanceof StreamRunPersistenceTimeoutError)) await this.#releaseLock();
				throw error;
			}
		});
	}

	begin(input: BeginStreamRunInput): Promise<StreamRunState> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			assertIdentifier(input.sessionId, "sessionId");
			assertIdentifier(input.runId, "runId");
			assertRequestMac(input.requestMac);
			const key = runDirectoryName(input.sessionId, input.runId);
			const existing = this.#records.get(key);
			if (existing) {
				if (
					existing.sessionId !== input.sessionId ||
					existing.runId !== input.runId ||
					!opaqueStringsEqual(existing.requestMac, input.requestMac)
				) {
					throw new StreamRunConflictError(
						`runId is already bound to a different request: ${input.sessionId}/${input.runId}`,
					);
				}
				return publicState(existing);
			}
			const sessionBlocker = [...this.#records.values()].find(
				(record) => record.sessionId === input.sessionId && record.acknowledgedAt === undefined,
			);
			if (sessionBlocker) {
				throw new StreamRunConflictError(
					`Session already has an unacknowledged stream run: ${input.sessionId}/${sessionBlocker.runId}`,
				);
			}
			const now = this.#now();
			const directory = join(this.rootDir, key);
			const record: RunRecord = {
				key,
				directory,
				eventsPath: join(directory, EVENTS_FILE_NAME),
				sessionId: input.sessionId,
				runId: input.runId,
				requestMac: input.requestMac,
				status: "running",
				metadataStatus: "running",
				createdAt: now,
				updatedAt: now,
				metaGeneration: 0,
				metaBytes: 0,
				journalBytes: JOURNAL_MAGIC.length,
				diskBytes: JOURNAL_MAGIC.length,
				nextSeq: 0,
				tailHash: journalGenesisHash(input.sessionId, input.runId, input.requestMac),
				checkpoints: [
					{
						seq: 0,
						offset: JOURNAL_MAGIC.length,
						previousHash: journalGenesisHash(input.sessionId, input.runId, input.requestMac),
					},
				],
				activeReaders: new Set(),
				terminalReservationBytes: 0,
				tailTruncatedOnLoad: false,
			};
			const firstMetadata = metadataPayload(record, 1);
			const metadataBytes = encodeMetadata(firstMetadata);
			record.terminalReservationBytes = this.#terminalReservationBytes(record);
			if (record.diskBytes + metadataBytes.length + record.terminalReservationBytes > this.#options.maxRunBytes) {
				throw new StreamRunQuotaError("New stream run cannot fit its metadata and terminal reserve");
			}
			await this.#makeSpace(record.diskBytes + metadataBytes.length, record.terminalReservationBytes, 1);
			let directoryCreated = false;
			try {
				await waitForFilesystemProgress(
					mkdir(directory),
					"create stream run directory",
					this.#options.ioNoProgressTimeoutMs,
				);
				directoryCreated = true;
				await syncDirectory(this.rootDir, this.#options.ioNoProgressTimeoutMs, this.#options.faultInjector);
				const journalHandle = await waitForFilesystemProgress(
					open(record.eventsPath, "wx", 0o600),
					"create stream run journal",
					this.#options.ioNoProgressTimeoutMs,
				);
				try {
					await runFaultInjector(
						this.#options.faultInjector,
						"journal_before_write",
						this.#options.ioNoProgressTimeoutMs,
					);
					await writeExactly(journalHandle, JOURNAL_MAGIC, 0, this.#options.ioNoProgressTimeoutMs);
					await runFaultInjector(
						this.#options.faultInjector,
						"journal_before_sync",
						this.#options.ioNoProgressTimeoutMs,
					);
					await waitForFilesystemProgress(
						journalHandle.sync(),
						"fsync stream run journal",
						this.#options.ioNoProgressTimeoutMs,
					);
					await runFaultInjector(
						this.#options.faultInjector,
						"journal_after_sync",
						this.#options.ioNoProgressTimeoutMs,
					);
				} finally {
					await waitForFilesystemProgress(
						journalHandle.close(),
						"close stream run journal",
						this.#options.ioNoProgressTimeoutMs,
					);
				}
				await this.#writeMetadataFile(record, firstMetadata, metadataBytes);
			} catch (error) {
				if (directoryCreated && !(error instanceof StreamRunPersistenceTimeoutError)) {
					try {
						await waitForFilesystemProgress(
							rm(directory, { recursive: true, force: true }),
							"rollback stream run directory",
							this.#options.ioNoProgressTimeoutMs,
						);
					} catch {
						// Startup treats a header-only directory without committed metadata as an interrupted begin.
					}
				}
				throw error;
			}
			record.metaGeneration = 1;
			record.metaBytes = metadataBytes.length;
			record.diskBytes += metadataBytes.length;
			this.#records.set(key, record);
			this.#totalBytes += record.diskBytes;
			this.#totalReservedBytes += record.terminalReservationBytes;
			return publicState(record);
		});
	}

	rollbackUnstartedBegin(input: BeginStreamRunInput): Promise<void> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			assertIdentifier(input.sessionId, "sessionId");
			assertIdentifier(input.runId, "runId");
			assertRequestMac(input.requestMac);
			const record = this.#requireRun(input.sessionId, input.runId);
			if (!opaqueStringsEqual(record.requestMac, input.requestMac)) {
				throw new StreamRunConflictError(
					`runId is bound to a different request: ${input.sessionId}/${input.runId}`,
				);
			}
			if (
				record.status !== "running" ||
				record.nextSeq !== 0 ||
				record.terminal !== undefined ||
				record.activeReaders.size !== 0
			) {
				throw new StreamRunStateError(
					`Cannot roll back a stream run after execution started: ${input.sessionId}/${input.runId}`,
				);
			}
			await this.#deleteRecord(record);
		});
	}

	appendEvent(input: AppendStreamRunEventInput): Promise<StreamRunEventFrame> {
		return this.appendEvents({
			sessionId: input.sessionId,
			runId: input.runId,
			events: [input.event],
			expectedSeq: input.expectedSeq,
		}).then((frames) => {
			const frame = frames[0];
			if (!frame) {
				throw new StreamRunStateError("Single-event append did not produce an event frame");
			}
			return frame;
		});
	}

	appendEvents(input: AppendStreamRunEventsInput): Promise<StreamRunEventFrame[]> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const record = this.#requireRun(input.sessionId, input.runId);
			if (record.status !== "running") {
				throw new StreamRunStateError(
					`Cannot append an event to ${record.status} stream run: ${input.sessionId}/${input.runId}`,
				);
			}
			this.#assertExpectedSeq(record, input.expectedSeq);
			if (!Array.isArray(input.events) || input.events.length === 0) {
				throw new StreamRunPersistenceError("events must be a non-empty array");
			}
			if (input.events.length > this.#options.maxBatchEvents) {
				throw new StreamRunQuotaError(
					`Stream event batch exceeds maxBatchEvents (${this.#options.maxBatchEvents})`,
				);
			}
			let payloadBytes = 0;
			for (const event of input.events) {
				if (typeof event !== "string") {
					throw new StreamRunPersistenceError("each event must be a string");
				}
				const eventBytes = Buffer.byteLength(event, "utf-8");
				if (eventBytes > this.#options.maxFrameBytes) {
					throw new StreamRunQuotaError("Stream event exceeds maxFrameBytes");
				}
				payloadBytes += eventBytes;
				if (!Number.isSafeInteger(payloadBytes) || payloadBytes > this.#options.maxBatchBytes) {
					throw new StreamRunQuotaError(
						`Stream event batch exceeds maxBatchBytes (${this.#options.maxBatchBytes})`,
					);
				}
			}
			const frames: Array<{
				publicFrame: StreamRunEventFrame;
				encoded: Buffer;
				hash: Buffer;
			}> = [];
			let nextSeq = record.nextSeq;
			let tailHash = record.tailHash;
			let totalFrameBytes = 0;
			for (const event of input.events) {
				const payload = Buffer.from(event, "utf-8");
				const frame = createFrame(FRAME_KIND_EVENT, nextSeq, payload, tailHash);
				frames.push({
					publicFrame: { kind: "event", seq: nextSeq, event },
					encoded: frame.encoded,
					hash: frame.hash,
				});
				totalFrameBytes += frame.encoded.length;
				if (!Number.isSafeInteger(totalFrameBytes)) {
					throw new StreamRunQuotaError("Stream event batch byte size exceeds the safe integer limit");
				}
				nextSeq++;
				tailHash = frame.hash;
			}
			const commit = createFrame(
				FRAME_KIND_COMMIT,
				nextSeq,
				encodeCommitPayload(record.nextSeq, frames.length),
				tailHash,
			);
			totalFrameBytes += commit.encoded.length;
			const projectedRunBytes = record.diskBytes + totalFrameBytes + record.terminalReservationBytes;
			if (projectedRunBytes > this.#options.maxRunBytes) {
				throw new StreamRunQuotaError("Stream run exceeded maxRunBytes while preserving terminal reserve");
			}
			await this.#makeSpace(totalFrameBytes, 0, 0, record.key);
			const encodedBatch = Buffer.concat([...frames.map((frame) => frame.encoded), commit.encoded], totalFrameBytes);
			await this.#appendEncodedBatch(record, encodedBatch, commit.hash, frames.length);
			record.updatedAt = Math.max(record.updatedAt, this.#now());
			return frames.map((frame) => frame.publicFrame);
		});
	}

	settle(input: SettleStreamRunInput): Promise<StreamRunState> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const record = this.#requireRun(input.sessionId, input.runId);
			if (record.status !== "running") {
				if (record.terminal && this.#terminalMatchesInput(record.terminal, input)) {
					if (record.metadataStatus !== record.status) {
						await this.#persistCurrentMetadata(record);
					}
					return publicState(record);
				}
				throw new StreamRunConflictError(
					`Stream run already settled with different terminal data: ${input.sessionId}/${input.runId}`,
				);
			}
			this.#assertExpectedSeq(record, input.expectedSeq);
			const settledAt = Math.max(record.updatedAt, this.#now());
			const terminal = normalizeTerminalPayload(input, settledAt);
			const payload = encodeTerminalPayload(terminal);
			if (payload.length > this.#options.maxFrameBytes) {
				throw new StreamRunQuotaError("Terminal stream event exceeds maxFrameBytes");
			}
			if (payload.length > this.#options.terminalReserveBytes) {
				throw new StreamRunQuotaError("Terminal stream event exceeds terminalReserveBytes");
			}
			const frame = createFrame(FRAME_KIND_TERMINAL, record.nextSeq, payload, record.tailHash);
			const commit = createFrame(
				FRAME_KIND_COMMIT,
				record.nextSeq + 1,
				encodeCommitPayload(record.nextSeq, 1),
				frame.hash,
			);
			const terminalJournalBytes = frame.encoded.length + commit.encoded.length;
			const previousStatus = record.status;
			const previousUpdatedAt = record.updatedAt;
			record.status = terminal.status;
			record.updatedAt = settledAt;
			const nextMetadata = metadataPayload(record, record.metaGeneration + 1);
			const nextMetadataBytes = encodeMetadata(nextMetadata);
			record.status = previousStatus;
			record.updatedAt = previousUpdatedAt;
			if (record.diskBytes + terminalJournalBytes + nextMetadataBytes.length > this.#options.maxRunBytes) {
				throw new StreamRunQuotaError("Stream run terminal state exceeds maxRunBytes");
			}
			if (terminalJournalBytes + nextMetadataBytes.length > record.terminalReservationBytes) {
				throw new StreamRunQuotaError("Stream run terminal state exceeds its durable reservation");
			}
			await this.#makeSpace(
				terminalJournalBytes + nextMetadataBytes.length,
				-record.terminalReservationBytes,
				0,
				record.key,
			);
			await this.#appendStoredFrame(record, FRAME_KIND_TERMINAL, payload, terminal);
			record.status = terminal.status;
			record.updatedAt = settledAt;
			this.#releaseTerminalReservation(record);
			await this.#persistCurrentMetadata(record, nextMetadataBytes);
			return publicState(record);
		});
	}

	get(sessionId: string, runId: string): Promise<StreamRunState | undefined> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const record = this.#records.get(runDirectoryName(sessionId, runId));
			if (!record || record.sessionId !== sessionId || record.runId !== runId) return undefined;
			return publicState(record);
		});
	}

	list(): Promise<StreamRunState[]> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			return [...this.#records.values()].map((record) => publicState(record, false));
		});
	}

	async *iterateEvents(
		sessionId: string,
		runId: string,
		fromSeq = 0,
		signal?: AbortSignal,
	): AsyncGenerator<StreamRunEventFrame> {
		assertNonNegativeSafeInteger(fromSeq, "fromSeq");
		const snapshot = await this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const record = this.#requireRun(sessionId, runId);
			if (fromSeq > record.nextSeq) {
				throw new StreamRunConflictError(`fromSeq ${fromSeq} exceeds stream nextSeq ${record.nextSeq}`);
			}
			const checkpoint =
				[...record.checkpoints].reverse().find((candidate) => candidate.seq <= fromSeq) ?? record.checkpoints[0];
			if (!checkpoint) {
				throw new StreamRunCorruptionError(record.eventsPath, "stream run has no journal checkpoint");
			}
			const handle = await waitForFilesystemProgress(
				open(record.eventsPath, "r"),
				"open stream run reader",
				this.#options.ioNoProgressTimeoutMs,
			);
			record.activeReaders.add(handle);
			this.#readerHandles.add(handle);
			return {
				record,
				handle,
				endOffset: record.journalBytes,
				expectedNextSeq: record.nextSeq,
				checkpoint: {
					seq: checkpoint.seq,
					offset: checkpoint.offset,
					previousHash: Buffer.from(checkpoint.previousHash),
				},
			};
		});
		try {
			if (signal?.aborted) return;
			await verifyJournalMagic(
				snapshot.handle,
				snapshot.record.eventsPath,
				snapshot.endOffset,
				this.#options.ioNoProgressTimeoutMs,
			);
			let position = snapshot.checkpoint.offset;
			let nextSeq = snapshot.checkpoint.seq;
			let tailHash: Buffer<ArrayBufferLike> = snapshot.checkpoint.previousHash;
			let sawTerminal = false;
			let pendingTerminal = false;
			let transactionFirstSeq = nextSeq;
			let transactionFrameCount = 0;
			while (position < snapshot.endOffset) {
				if (signal?.aborted) return;
				const parsed = await readFrameAt(
					snapshot.handle,
					snapshot.record.eventsPath,
					position,
					snapshot.endOffset,
					nextSeq,
					tailHash,
					this.#options.maxFrameBytes,
					this.#options.ioNoProgressTimeoutMs,
				);
				if (parsed.kind === "incomplete") {
					throw new StreamRunCorruptionError(
						snapshot.record.eventsPath,
						`event journal tail is truncated at byte ${position}`,
					);
				}
				if (sawTerminal || (pendingTerminal && parsed.kind !== "commit")) {
					throw new StreamRunCorruptionError(
						snapshot.record.eventsPath,
						"event journal contains data after its terminal frame",
					);
				}
				position = parsed.nextOffset;
				tailHash = parsed.hash;
				if (parsed.kind === "commit") {
					if (
						transactionFrameCount === 0 ||
						parsed.firstSeq !== transactionFirstSeq ||
						parsed.count !== transactionFrameCount
					) {
						throw new StreamRunCorruptionError(
							snapshot.record.eventsPath,
							"event journal commit marker does not match its batch",
						);
					}
					sawTerminal = pendingTerminal;
					pendingTerminal = false;
					transactionFirstSeq = nextSeq;
					transactionFrameCount = 0;
					continue;
				}
				nextSeq++;
				transactionFrameCount++;
				if (parsed.kind === "terminal") pendingTerminal = true;
				if (parsed.seq < fromSeq) continue;
				if (parsed.kind === "event") {
					yield { kind: "event", seq: parsed.seq, event: parsed.event };
				} else if (parsed.kind === "terminal") {
					const frame: StreamRunEventFrame = {
						kind: "terminal",
						seq: parsed.seq,
						event: parsed.terminal.event,
						status: parsed.terminal.status,
						settledAt: parsed.terminal.settledAt,
					};
					if (parsed.terminal.result !== undefined) {
						frame.result = parsed.terminal.result;
					}
					if (parsed.terminal.errorMessage !== undefined) {
						frame.errorMessage = parsed.terminal.errorMessage;
					}
					yield frame;
				}
			}
			if (transactionFrameCount !== 0 || nextSeq !== snapshot.expectedNextSeq) {
				throw new StreamRunCorruptionError(
					snapshot.record.eventsPath,
					"event journal sequence count changed while reading",
				);
			}
		} finally {
			try {
				await waitForFilesystemProgress(
					snapshot.handle.close(),
					"close stream run reader",
					this.#options.ioNoProgressTimeoutMs,
				);
			} finally {
				this.#readerHandles.delete(snapshot.handle);
				snapshot.record.activeReaders.delete(snapshot.handle);
				await this.#enqueue(async () => {
					this.#readerHandles.delete(snapshot.handle);
					snapshot.record.activeReaders.delete(snapshot.handle);
				});
			}
		}
	}

	acknowledge(sessionId: string, runId: string): Promise<StreamRunState> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const record = this.#requireRun(sessionId, runId);
			if (record.status === "running") {
				throw new StreamRunStateError(`Cannot acknowledge a running stream run: ${sessionId}/${runId}`);
			}
			if (record.acknowledgedAt !== undefined) return publicState(record);
			const previousUpdatedAt = record.updatedAt;
			record.acknowledgedAt = Math.max(record.updatedAt, this.#now());
			record.updatedAt = record.acknowledgedAt;
			const metadataBytes = encodeMetadata(metadataPayload(record, record.metaGeneration + 1));
			if (record.diskBytes + metadataBytes.length > this.#options.maxRunBytes) {
				record.acknowledgedAt = undefined;
				record.updatedAt = previousUpdatedAt;
				throw new StreamRunQuotaError("Stream run acknowledgement exceeds maxRunBytes");
			}
			try {
				await this.#makeSpace(metadataBytes.length, 0, 0, record.key);
				await this.#persistCurrentMetadata(record, metadataBytes);
			} catch (error) {
				record.acknowledgedAt = undefined;
				record.updatedAt = previousUpdatedAt;
				throw error;
			}
			return publicState(record);
		});
	}

	delete(sessionId: string, runId: string): Promise<boolean> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			const key = runDirectoryName(sessionId, runId);
			const record = this.#records.get(key);
			if (!record || record.sessionId !== sessionId || record.runId !== runId) return false;
			if (record.status === "running") {
				throw new StreamRunStateError(`Cannot delete a running stream run: ${sessionId}/${runId}`);
			}
			await this.#deleteRecord(record);
			return true;
		});
	}

	prune(now = this.#now()): Promise<StreamRunPruneEntry[]> {
		return this.#enqueue(async () => {
			this.#assertInitialized();
			await this.#assertLockOwned();
			if (!isSafeTimestamp(now)) {
				throw new StreamRunPersistenceError("prune time must be a non-negative safe integer");
			}
			return this.#pruneInternal(now, true);
		});
	}

	async flush(): Promise<void> {
		await this.#queue;
		if (this.#fatalError) throw this.#fatalError;
		await this.#closeReaderHandles();
		await this.#queue;
		if (this.#fatalError) throw this.#fatalError;
		if (this.#initialized) await this.#assertLockOwned();
	}

	async close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = (async () => {
			try {
				await this.flush();
			} finally {
				this.#initialized = false;
				if (!this.#fatalError || this.#fatalError.isUnderlyingOperationSettled()) await this.#releaseLock();
			}
		})();
		return this.#closePromise;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const guardedOperation = async () => {
			if (this.#fatalError) throw this.#fatalError;
			try {
				return await operation();
			} catch (error) {
				if (error instanceof StreamRunPersistenceTimeoutError && !this.#fatalError) {
					this.#fatalError = error;
					queueMicrotask(() => this.#options.onFatalError?.(error));
				}
				throw error;
			}
		};
		const result = this.#queue.then(guardedOperation, guardedOperation);
		this.#queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#assertInitialized(): void {
		if (this.#fatalError) throw this.#fatalError;
		if (!this.#initialized) {
			throw new StreamRunPersistenceError("StreamRunPersistence.initialize() must complete first");
		}
	}

	async #closeReaderHandles(): Promise<void> {
		const handles = [...this.#readerHandles];
		this.#readerHandles.clear();
		for (const record of this.#records.values()) {
			for (const handle of handles) record.activeReaders.delete(handle);
		}
		const results = await Promise.allSettled(
			handles.map((handle) =>
				waitForFilesystemProgress(
					handle.close(),
					"close abandoned stream run reader",
					this.#options.ioNoProgressTimeoutMs,
				),
			),
		);
		const timeout = results.find(
			(result): result is PromiseRejectedResult =>
				result.status === "rejected" && result.reason instanceof StreamRunPersistenceTimeoutError,
		);
		if (timeout) throw timeout.reason;
	}

	async #acquireLock(): Promise<void> {
		if (this.#lockDatabase) {
			await this.#assertLockOwned();
			return;
		}
		await waitForFilesystemProgress(
			mkdir(dirname(this.#lockPath), { recursive: true }),
			"create stream run lock directory",
			this.#options.ioNoProgressTimeoutMs,
		);
		const database = new DatabaseSync(this.#lockPath);
		try {
			database.exec("PRAGMA busy_timeout = 0");
			database.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			database.close();
			const sqliteError = error as Error & { errcode?: number };
			if (sqliteError.errcode === 5 || /database is (?:locked|busy)/i.test(sqliteError.message)) {
				throw new StreamRunStoreLockedError(this.#lockPath);
			}
			throw error;
		}
		this.#lockDatabase = database;
	}

	async #assertLockOwned(): Promise<void> {
		if (!this.#lockDatabase?.isTransaction) {
			throw new StreamRunStoreLockedError(this.#lockPath);
		}
	}

	async #releaseLock(): Promise<void> {
		const database = this.#lockDatabase;
		this.#lockDatabase = undefined;
		if (!database) return;
		let rollbackError: unknown;
		try {
			if (database.isTransaction) database.exec("ROLLBACK");
		} catch (error) {
			rollbackError = error;
		} finally {
			database.close();
		}
		if (rollbackError !== undefined) throw rollbackError;
	}

	#now(): number {
		const value = this.#options.now();
		if (!isSafeTimestamp(value)) {
			throw new StreamRunPersistenceError("now() must return a non-negative safe integer");
		}
		return value;
	}

	#requireRun(sessionId: string, runId: string): RunRecord {
		assertIdentifier(sessionId, "sessionId");
		assertIdentifier(runId, "runId");
		const record = this.#records.get(runDirectoryName(sessionId, runId));
		if (!record || record.sessionId !== sessionId || record.runId !== runId) {
			throw new StreamRunNotFoundError(sessionId, runId);
		}
		return record;
	}

	#assertExpectedSeq(record: RunRecord, expectedSeq: number | undefined): void {
		if (expectedSeq === undefined) return;
		assertNonNegativeSafeInteger(expectedSeq, "expectedSeq");
		if (expectedSeq !== record.nextSeq) {
			throw new StreamRunConflictError(
				`Expected stream run sequence ${expectedSeq}, current sequence is ${record.nextSeq}`,
			);
		}
	}

	#terminalMatchesInput(terminal: StoredTerminalPayload, input: SettleStreamRunInput): boolean {
		const normalized = normalizeTerminalPayload(input, terminal.settledAt);
		if (
			terminal.status !== normalized.status ||
			terminal.event !== normalized.event ||
			terminal.errorMessage !== normalized.errorMessage
		) {
			return false;
		}
		return isDeepStrictEqual(terminal.result, normalized.result);
	}

	async #loadRunDirectory(entry: Dirent): Promise<RunRecord | undefined> {
		const directory = join(this.rootDir, entry.name);
		const entries = await waitForFilesystemProgress(
			readdir(directory, { withFileTypes: true }),
			"read stream run directory",
			this.#options.ioNoProgressTimeoutMs,
		);
		const metadataFiles: Array<{ name: string; encoded: Buffer; payload: StoredMetadata }> = [];
		let hasEventsFile = false;
		for (const child of entries) {
			if (child.name.endsWith(".tmp") && child.isFile()) {
				await waitForFilesystemProgress(
					rm(join(directory, child.name)),
					"remove interrupted stream run file",
					this.#options.ioNoProgressTimeoutMs,
				);
				continue;
			}
			if (child.name === EVENTS_FILE_NAME && child.isFile()) {
				hasEventsFile = true;
				continue;
			}
			if (child.isFile() && META_FILE_PATTERN.test(child.name)) {
				const encoded = await waitForFilesystemProgress(
					readFile(join(directory, child.name)),
					"read stream run metadata",
					this.#options.ioNoProgressTimeoutMs,
				);
				metadataFiles.push({
					name: child.name,
					encoded,
					payload: parseMetadata(directory, child.name, encoded),
				});
				continue;
			}
			throw new StreamRunCorruptionError(directory, `unexpected run entry: ${child.name}`);
		}
		if (metadataFiles.length === 0) {
			if (hasEventsFile) {
				const eventsStats = await waitForFilesystemProgress(
					stat(join(directory, EVENTS_FILE_NAME)),
					"stat stream run journal",
					this.#options.ioNoProgressTimeoutMs,
				);
				if (eventsStats.size > JOURNAL_MAGIC.length) {
					throw new StreamRunCorruptionError(directory, "event journal has frames but no committed metadata");
				}
			}
			await waitForFilesystemProgress(
				rm(directory, { recursive: true, force: true }),
				"remove interrupted stream run directory",
				this.#options.ioNoProgressTimeoutMs,
			);
			return undefined;
		}
		if (!hasEventsFile) {
			throw new StreamRunCorruptionError(directory, "committed metadata has no event journal");
		}
		metadataFiles.sort((left, right) => left.payload.generation - right.payload.generation);
		const metadata = metadataFiles.map((file) => file.payload);
		validateMetadataHistory(directory, metadata);
		const latest = metadata.at(-1);
		if (!latest) {
			throw new StreamRunCorruptionError(directory, "metadata history is empty");
		}
		if (runDirectoryName(latest.sessionId, latest.runId) !== entry.name) {
			throw new StreamRunCorruptionError(directory, "run directory name does not match metadata identity");
		}
		const eventsPath = join(directory, EVENTS_FILE_NAME);
		const scan = await scanJournal(
			eventsPath,
			this.#options.maxFrameBytes,
			true,
			journalGenesisHash(latest.sessionId, latest.runId, latest.requestMac),
			this.#options.ioNoProgressTimeoutMs,
		);
		const metaBytes = metadataFiles.reduce((total, file) => total + file.encoded.length, 0);
		const record: RunRecord = {
			key: entry.name,
			directory,
			eventsPath,
			sessionId: latest.sessionId,
			runId: latest.runId,
			requestMac: latest.requestMac,
			status: latest.status,
			metadataStatus: latest.status,
			createdAt: latest.createdAt,
			updatedAt: latest.updatedAt,
			acknowledgedAt: latest.acknowledgedAt,
			metaGeneration: latest.generation,
			metaBytes,
			journalBytes: scan.journalBytes,
			diskBytes: metaBytes + scan.journalBytes,
			nextSeq: scan.nextSeq,
			tailHash: scan.tailHash,
			terminal: scan.terminal,
			checkpoints: scan.checkpoints,
			activeReaders: new Set(),
			terminalReservationBytes: 0,
			tailTruncatedOnLoad: scan.tailTruncated,
		};
		if (record.status === "running" && !record.terminal) {
			record.terminalReservationBytes = this.#terminalReservationBytes(record);
		}
		if (record.diskBytes + record.terminalReservationBytes > this.#options.maxRunBytes) {
			throw new StreamRunQuotaError(`Persisted stream run exceeds maxRunBytes: ${record.sessionId}/${record.runId}`);
		}
		return record;
	}

	async #writeMetadataFile(record: RunRecord, payload: StoredMetadata, encoded: Buffer): Promise<void> {
		const finalPath = join(record.directory, metadataFileName(payload.generation));
		try {
			const existing = await waitForFilesystemProgress(
				readFile(finalPath),
				"read stream run metadata",
				this.#options.ioNoProgressTimeoutMs,
			);
			if (!existing.equals(encoded)) {
				throw new StreamRunCorruptionError(
					record.directory,
					`${metadataFileName(payload.generation)} already differs`,
				);
			}
			await syncDirectory(record.directory, this.#options.ioNoProgressTimeoutMs, this.#options.faultInjector);
			return;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const temporaryPath = join(record.directory, `.${metadataFileName(payload.generation)}.${randomUUID()}.tmp`);
		try {
			const handle = await waitForFilesystemProgress(
				open(temporaryPath, "wx", 0o600),
				"create stream run metadata",
				this.#options.ioNoProgressTimeoutMs,
			);
			try {
				await runFaultInjector(
					this.#options.faultInjector,
					"metadata_before_write",
					this.#options.ioNoProgressTimeoutMs,
				);
				await writeExactly(handle, encoded, 0, this.#options.ioNoProgressTimeoutMs);
				await runFaultInjector(
					this.#options.faultInjector,
					"metadata_before_sync",
					this.#options.ioNoProgressTimeoutMs,
				);
				await waitForFilesystemProgress(
					handle.sync(),
					"fsync stream run metadata",
					this.#options.ioNoProgressTimeoutMs,
				);
			} finally {
				await waitForFilesystemProgress(
					handle.close(),
					"close stream run metadata",
					this.#options.ioNoProgressTimeoutMs,
				);
			}
			await renameDurably(
				temporaryPath,
				finalPath,
				record.directory,
				this.#options.ioNoProgressTimeoutMs,
				this.#options.faultInjector,
			);
		} catch (error) {
			if (!(error instanceof StreamRunPersistenceTimeoutError)) {
				try {
					await waitForFilesystemProgress(
						rm(temporaryPath, { force: true }),
						"remove interrupted stream run metadata",
						this.#options.ioNoProgressTimeoutMs,
					);
				} catch {
					// A leftover temp file is ignored and removed during startup recovery.
				}
			}
			throw error;
		}
	}

	async #persistCurrentMetadata(record: RunRecord, preparedBytes?: Buffer): Promise<void> {
		if (record.metaGeneration >= Number.MAX_SAFE_INTEGER) {
			throw new StreamRunStateError("Stream run metadata generation limit reached");
		}
		const generation = record.metaGeneration + 1;
		const payload = metadataPayload(record, generation);
		const encoded = preparedBytes ?? encodeMetadata(payload);
		await this.#writeMetadataFile(record, payload, encoded);
		record.metaGeneration = generation;
		record.metadataStatus = record.status;
		record.metaBytes += encoded.length;
		record.diskBytes += encoded.length;
		this.#totalBytes += encoded.length;
	}

	async #appendStoredFrame(
		record: RunRecord,
		kind: number,
		payload: Buffer,
		terminal?: StoredTerminalPayload,
	): Promise<void> {
		const frame = createFrame(kind, record.nextSeq, payload, record.tailHash);
		const commit = createFrame(
			FRAME_KIND_COMMIT,
			record.nextSeq + 1,
			encodeCommitPayload(record.nextSeq, 1),
			frame.hash,
		);
		await this.#appendEncodedBatch(
			record,
			Buffer.concat([frame.encoded, commit.encoded], frame.encoded.length + commit.encoded.length),
			commit.hash,
			1,
		);
		if (terminal) record.terminal = terminal;
	}

	async #appendEncodedBatch(record: RunRecord, encoded: Buffer, finalHash: Buffer, frameCount: number): Promise<void> {
		if (
			!Number.isSafeInteger(frameCount) ||
			frameCount <= 0 ||
			record.nextSeq + frameCount > Number.MAX_SAFE_INTEGER
		) {
			throw new StreamRunStateError("Stream run sequence limit reached");
		}
		await this.#assertLockOwned();
		const committedJournalBytes = record.journalBytes;
		const handle = await waitForFilesystemProgress(
			open(record.eventsPath, "r+"),
			"open stream run journal",
			this.#options.ioNoProgressTimeoutMs,
		);
		let operationError: unknown;
		try {
			const fileStats = await waitForFilesystemProgress(
				handle.stat(),
				"stat stream run journal",
				this.#options.ioNoProgressTimeoutMs,
			);
			if (fileStats.size !== record.journalBytes) {
				throw new StreamRunCorruptionError(
					record.eventsPath,
					`journal size ${fileStats.size} does not match expected size ${record.journalBytes}`,
				);
			}
			await runFaultInjector(
				this.#options.faultInjector,
				"journal_before_write",
				this.#options.ioNoProgressTimeoutMs,
			);
			const splitAt = Math.max(1, Math.floor(encoded.length / 2));
			await writeExactly(
				handle,
				encoded.subarray(0, splitAt),
				record.journalBytes,
				this.#options.ioNoProgressTimeoutMs,
			);
			await runFaultInjector(
				this.#options.faultInjector,
				"journal_after_partial_write",
				this.#options.ioNoProgressTimeoutMs,
			);
			if (splitAt < encoded.length) {
				await writeExactly(
					handle,
					encoded.subarray(splitAt),
					record.journalBytes + splitAt,
					this.#options.ioNoProgressTimeoutMs,
				);
			}
			await runFaultInjector(
				this.#options.faultInjector,
				"journal_before_sync",
				this.#options.ioNoProgressTimeoutMs,
			);
			await waitForFilesystemProgress(
				handle.sync(),
				"fsync stream run journal",
				this.#options.ioNoProgressTimeoutMs,
			);
			await runFaultInjector(this.#options.faultInjector, "journal_after_sync", this.#options.ioNoProgressTimeoutMs);
		} catch (error) {
			operationError = error;
		}
		try {
			await waitForFilesystemProgress(
				handle.close(),
				"close stream run journal",
				this.#options.ioNoProgressTimeoutMs,
			);
		} catch (error) {
			operationError ??= error;
		}
		if (operationError instanceof StreamRunPersistenceTimeoutError) throw operationError;
		if (operationError !== undefined) {
			try {
				await this.#recoverAppendFailure(record, committedJournalBytes);
			} catch (recoveryError) {
				throw new StreamRunCorruptionError(
					record.eventsPath,
					`append failed (${
						operationError instanceof Error ? operationError.message : String(operationError)
					}) and rollback failed: ${
						recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
					}`,
				);
			}
			throw operationError;
		}
		record.journalBytes += encoded.length;
		record.diskBytes += encoded.length;
		record.nextSeq += frameCount;
		record.tailHash = finalHash;
		this.#totalBytes += encoded.length;
		const lastCheckpoint = record.checkpoints.at(-1);
		if (!lastCheckpoint || record.nextSeq - lastCheckpoint.seq >= JOURNAL_CHECKPOINT_INTERVAL) {
			record.checkpoints.push({
				seq: record.nextSeq,
				offset: record.journalBytes,
				previousHash: Buffer.from(finalHash),
			});
		}
	}

	async #recoverAppendFailure(record: RunRecord, committedJournalBytes: number): Promise<void> {
		const currentStats = await waitForFilesystemProgress(
			stat(record.eventsPath),
			"stat stream run journal rollback",
			this.#options.ioNoProgressTimeoutMs,
		);
		if (currentStats.size < committedJournalBytes) {
			throw new StreamRunCorruptionError(
				record.eventsPath,
				"append failure damaged already committed journal bytes",
			);
		}
		if (currentStats.size !== committedJournalBytes) {
			await waitForFilesystemProgress(
				truncate(record.eventsPath, committedJournalBytes),
				"truncate stream run journal rollback",
				this.#options.ioNoProgressTimeoutMs,
			);
		}
		const handle = await waitForFilesystemProgress(
			open(record.eventsPath, "r+"),
			"open stream run journal rollback",
			this.#options.ioNoProgressTimeoutMs,
		);
		try {
			await waitForFilesystemProgress(
				handle.sync(),
				"fsync stream run journal rollback",
				this.#options.ioNoProgressTimeoutMs,
			);
		} finally {
			await waitForFilesystemProgress(
				handle.close(),
				"close stream run journal rollback",
				this.#options.ioNoProgressTimeoutMs,
			);
		}
		const scan = await scanJournal(
			record.eventsPath,
			this.#options.maxFrameBytes,
			false,
			journalGenesisHash(record.sessionId, record.runId, record.requestMac),
			this.#options.ioNoProgressTimeoutMs,
		);
		if (
			scan.journalBytes !== committedJournalBytes ||
			scan.nextSeq !== record.nextSeq ||
			!scan.tailHash.equals(record.tailHash)
		) {
			throw new StreamRunCorruptionError(record.eventsPath, "append rollback did not restore the committed state");
		}
		record.checkpoints = scan.checkpoints;
		record.terminal = scan.terminal;
	}

	#terminalReservationBytes(record: RunRecord): number {
		if (record.metaGeneration >= Number.MAX_SAFE_INTEGER) {
			throw new StreamRunStateError("Stream run metadata generation limit reached");
		}
		const generation = record.metaGeneration === 0 ? 2 : record.metaGeneration + 1;
		const updatedAt = Number.MAX_SAFE_INTEGER;
		const completedMetadata = encodeMetadata({
			...metadataPayload(record, generation),
			status: "completed",
			updatedAt,
		}).length;
		const failedMetadata = encodeMetadata({
			...metadataPayload(record, generation),
			status: "failed",
			updatedAt,
		}).length;
		const payloadCapacity = Math.min(this.#options.terminalReserveBytes, this.#options.maxFrameBytes);
		const terminalFrameBytes = FRAME_HEADER_BYTES + payloadCapacity;
		const commitFrameBytes = FRAME_HEADER_BYTES + encodeCommitPayload(record.nextSeq, 1).length;
		return terminalFrameBytes + commitFrameBytes + Math.max(completedMetadata, failedMetadata);
	}

	#releaseTerminalReservation(record: RunRecord): void {
		if (record.terminalReservationBytes === 0) return;
		this.#totalReservedBytes -= record.terminalReservationBytes;
		record.terminalReservationBytes = 0;
	}

	async #makeSpace(
		additionalBytes: number,
		reservedBytesDelta: number,
		additionalRuns: number,
		protectedKey?: string,
	): Promise<void> {
		await this.#pruneExpired(this.#now());
		while (
			this.#records.size + additionalRuns > this.#options.maxRuns ||
			this.#totalBytes + this.#totalReservedBytes + additionalBytes + reservedBytesDelta >
				this.#options.maxTotalBytes
		) {
			const candidate = this.#oldestEvictableTerminal(protectedKey);
			if (!candidate) break;
			await this.#deleteRecord(candidate);
		}
		if (this.#records.size + additionalRuns > this.#options.maxRuns) {
			throw new StreamRunQuotaError("Stream run store exceeded maxRuns");
		}
		if (
			this.#totalBytes + this.#totalReservedBytes + additionalBytes + reservedBytesDelta >
			this.#options.maxTotalBytes
		) {
			throw new StreamRunQuotaError("Stream run store exceeded maxTotalBytes");
		}
	}

	#oldestEvictableTerminal(protectedKey?: string): RunRecord | undefined {
		return [...this.#records.values()]
			.filter(
				(record) =>
					record.key !== protectedKey &&
					record.status !== "running" &&
					record.acknowledgedAt !== undefined &&
					record.activeReaders.size === 0,
			)
			.sort((left, right) => {
				const leftTime = left.acknowledgedAt ?? left.updatedAt;
				const rightTime = right.acknowledgedAt ?? right.updatedAt;
				return leftTime - rightTime || left.createdAt - right.createdAt;
			})[0];
	}

	async #pruneExpired(now: number): Promise<StreamRunPruneEntry[]> {
		const pruned: StreamRunPruneEntry[] = [];
		for (const record of [...this.#records.values()]) {
			if (record.status === "running" || record.activeReaders.size > 0) continue;
			const acknowledgedExpired =
				record.acknowledgedAt !== undefined &&
				this.#options.acknowledgedTtlMs !== Number.POSITIVE_INFINITY &&
				now - record.acknowledgedAt >= this.#options.acknowledgedTtlMs;
			if (!acknowledgedExpired) continue;
			const bytesFreed = record.diskBytes;
			await this.#deleteRecord(record);
			pruned.push({
				sessionId: record.sessionId,
				runId: record.runId,
				reason: "ttl",
				bytesFreed,
			});
		}
		return pruned;
	}

	async #pruneInternal(now: number, enforceQuotas: boolean): Promise<StreamRunPruneEntry[]> {
		const pruned = await this.#pruneExpired(now);
		if (!enforceQuotas) return pruned;
		while (
			this.#records.size > this.#options.maxRuns ||
			this.#totalBytes + this.#totalReservedBytes > this.#options.maxTotalBytes
		) {
			const candidate = this.#oldestEvictableTerminal();
			if (!candidate) {
				throw new StreamRunQuotaError(
					"Stream run store exceeds its quota and has no acknowledged terminal run to evict",
				);
			}
			const bytesFreed = candidate.diskBytes;
			await this.#deleteRecord(candidate);
			pruned.push({
				sessionId: candidate.sessionId,
				runId: candidate.runId,
				reason: "quota",
				bytesFreed,
			});
		}
		return pruned;
	}

	async #deleteRecord(record: RunRecord): Promise<void> {
		if (record.activeReaders.size > 0) {
			throw new StreamRunBusyError(record.sessionId, record.runId);
		}
		const directory = resolve(record.directory);
		const expectedDirectory = resolve(this.rootDir, record.key);
		if (
			!RUN_DIRECTORY_PATTERN.test(record.key) ||
			directory !== expectedDirectory ||
			dirname(directory) !== this.rootDir
		) {
			throw new StreamRunStateError(
				`Refusing to delete stream run outside its resolved store directory: ${record.sessionId}/${record.runId}`,
			);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				await runFaultInjector(
					this.#options.faultInjector,
					"delete_before_remove",
					this.#options.ioNoProgressTimeoutMs,
				);
				await waitForFilesystemProgress(
					rm(directory, { recursive: true, force: false }),
					"remove stream run directory",
					this.#options.ioNoProgressTimeoutMs,
				);
				break;
			} catch (error) {
				const code = errorCode(error);
				if (!code || !WINDOWS_REMOVE_RETRY_CODES.has(code) || attempt >= WINDOWS_REMOVE_RETRIES - 1) {
					throw error;
				}
				await delay(WINDOWS_REMOVE_RETRY_BASE_MS * (attempt + 1));
			}
		}
		await syncDirectory(this.rootDir, this.#options.ioNoProgressTimeoutMs, this.#options.faultInjector);
		this.#records.delete(record.key);
		this.#totalBytes -= record.diskBytes;
		this.#totalReservedBytes -= record.terminalReservationBytes;
	}
}
