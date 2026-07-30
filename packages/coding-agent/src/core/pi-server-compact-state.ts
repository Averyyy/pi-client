import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const COMPACT_STATE_VERSION = 1;
const COMPACT_STATE_MAX_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_MAX_CHARS = 4096;
const ERROR_MAX_CHARS = 1024 * 1024;

interface PiServerCompactStateBase {
	version: typeof COMPACT_STATE_VERSION;
	sequence: number;
	timestamp: number;
}

export interface PiServerPendingCompactState extends PiServerCompactStateBase {
	kind: "compact";
	serverHash: string;
	sessionId: string;
	operationId: string;
	requestHash: string;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
	observation?: PiServerCompactObservationState;
}

export interface PiServerAppliedCompactState extends PiServerCompactStateBase {
	kind: "applied";
	operationId: string;
	requestHash: string;
	entryId: string;
	entryHash: string;
	updatedTreeHash: string;
	updatedLeafId: string;
	updatedRevision: number;
	resolution: "tree_applied";
}

export interface PiServerTerminalCompactState extends PiServerCompactStateBase {
	kind: "terminal";
	operationId: string;
	requestHash: string;
	httpStatus: number;
	error: string;
	operationDisposition: "terminal" | "not_started";
	status: "failed" | "rejected";
	resolution: "terminal_failed_observed" | "server_rejected";
}

export type PiServerCompactObservationState = PiServerAppliedCompactState | PiServerTerminalCompactState;

export type PiServerCompactAcknowledgementResolution =
	| "server_ack"
	| "server_missing_after_tree_applied"
	| "server_missing_after_terminal_failure"
	| "server_rejected_not_started";

interface PiServerAcknowledgedCompactState extends PiServerCompactStateBase {
	kind: "ack";
	operationId: string;
	resolution: PiServerCompactAcknowledgementResolution;
}

type PiServerCompactStateRecord =
	| PiServerPendingCompactState
	| PiServerCompactObservationState
	| PiServerAcknowledgedCompactState;

interface ParsedPiServerCompactState {
	nextSequence: number;
	pending: PiServerPendingCompactState | undefined;
}

export interface WritePiServerPendingCompactInput {
	serverHash: string;
	sessionId: string;
	operationId: string;
	requestHash: string;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
	timestamp?: number;
}

export interface WritePiServerAppliedCompactInput {
	operationId: string;
	requestHash: string;
	entryId: string;
	entryHash: string;
	updatedTreeHash: string;
	updatedLeafId: string;
	updatedRevision: number;
	timestamp?: number;
}

export interface WritePiServerTerminalCompactInput {
	operationId: string;
	requestHash: string;
	httpStatus: number;
	error: string;
	operationDisposition: "terminal" | "not_started";
	status: "failed" | "rejected";
	timestamp?: number;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > IDENTIFIER_MAX_CHARS || value.includes("\0")) {
		throw new Error(`${path} must be a non-empty string without NUL bytes`);
	}
}

function assertHash(value: unknown, path: string, allowEmpty = false): asserts value is string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && !SHA256_PATTERN.test(value)) ||
		(allowEmpty && value !== "" && !SHA256_PATTERN.test(value))
	) {
		throw new Error(`${path} must be ${allowEmpty ? "empty or " : ""}a lowercase SHA-256 digest`);
	}
}

function assertError(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > ERROR_MAX_CHARS || value.includes("\0")) {
		throw new Error(`${path} must be a non-empty string without NUL bytes`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative safe integer`);
	}
}

function parsePayload(payload: string, lineNumber: number): PiServerCompactStateRecord {
	let value: unknown;
	try {
		value = JSON.parse(payload) as unknown;
	} catch (error) {
		throw new Error(`pi-server compact state payload is invalid JSON at line ${lineNumber}`, { cause: error });
	}
	assertObject(value, `pi-server compact state line ${lineNumber}`);
	if (value.version !== COMPACT_STATE_VERSION) {
		throw new Error(`Unsupported pi-server compact state version at line ${lineNumber}`);
	}
	assertNonNegativeSafeInteger(value.sequence, `pi-server compact state line ${lineNumber}.sequence`);
	assertNonNegativeSafeInteger(value.timestamp, `pi-server compact state line ${lineNumber}.timestamp`);
	if (value.kind === "ack") {
		assertIdentifier(value.operationId, `pi-server compact state line ${lineNumber}.operationId`);
		if (
			value.resolution !== "server_ack" &&
			value.resolution !== "server_missing_after_tree_applied" &&
			value.resolution !== "server_missing_after_terminal_failure" &&
			value.resolution !== "server_rejected_not_started"
		) {
			throw new Error(`pi-server compact state acknowledgement resolution is invalid at line ${lineNumber}`);
		}
		return {
			version: COMPACT_STATE_VERSION,
			kind: "ack",
			sequence: value.sequence,
			timestamp: value.timestamp,
			operationId: value.operationId,
			resolution: value.resolution,
		};
	}
	if (value.kind === "applied") {
		assertIdentifier(value.operationId, `pi-server compact state line ${lineNumber}.operationId`);
		assertHash(value.requestHash, `pi-server compact state line ${lineNumber}.requestHash`);
		assertIdentifier(value.entryId, `pi-server compact state line ${lineNumber}.entryId`);
		assertHash(value.entryHash, `pi-server compact state line ${lineNumber}.entryHash`);
		assertHash(value.updatedTreeHash, `pi-server compact state line ${lineNumber}.updatedTreeHash`);
		assertIdentifier(value.updatedLeafId, `pi-server compact state line ${lineNumber}.updatedLeafId`);
		assertNonNegativeSafeInteger(value.updatedRevision, `pi-server compact state line ${lineNumber}.updatedRevision`);
		if (value.resolution !== "tree_applied") {
			throw new Error(`pi-server compact applied resolution is invalid at line ${lineNumber}`);
		}
		return {
			version: COMPACT_STATE_VERSION,
			kind: "applied",
			sequence: value.sequence,
			timestamp: value.timestamp,
			operationId: value.operationId,
			requestHash: value.requestHash,
			entryId: value.entryId,
			entryHash: value.entryHash,
			updatedTreeHash: value.updatedTreeHash,
			updatedLeafId: value.updatedLeafId,
			updatedRevision: value.updatedRevision,
			resolution: value.resolution,
		};
	}
	if (value.kind === "terminal") {
		assertIdentifier(value.operationId, `pi-server compact state line ${lineNumber}.operationId`);
		assertHash(value.requestHash, `pi-server compact state line ${lineNumber}.requestHash`);
		if (
			!Number.isSafeInteger(value.httpStatus) ||
			(value.httpStatus as number) < 100 ||
			(value.httpStatus as number) > 599
		) {
			throw new Error(`pi-server compact terminal HTTP status is invalid at line ${lineNumber}`);
		}
		assertError(value.error, `pi-server compact state line ${lineNumber}.error`);
		if (
			(value.operationDisposition !== "terminal" && value.operationDisposition !== "not_started") ||
			(value.status !== "failed" && value.status !== "rejected") ||
			(value.operationDisposition === "terminal" && value.status !== "failed") ||
			(value.operationDisposition === "not_started" && value.status !== "rejected")
		) {
			throw new Error(`pi-server compact terminal disposition is invalid at line ${lineNumber}`);
		}
		const expectedResolution =
			value.operationDisposition === "terminal" ? "terminal_failed_observed" : "server_rejected";
		if (value.resolution !== expectedResolution) {
			throw new Error(`pi-server compact terminal resolution is invalid at line ${lineNumber}`);
		}
		return {
			version: COMPACT_STATE_VERSION,
			kind: "terminal",
			sequence: value.sequence,
			timestamp: value.timestamp,
			operationId: value.operationId,
			requestHash: value.requestHash,
			httpStatus: value.httpStatus as number,
			error: value.error,
			operationDisposition: value.operationDisposition,
			status: value.status,
			resolution: expectedResolution,
		};
	}
	if (value.kind !== "compact") {
		throw new Error(`Unsupported pi-server compact state record kind at line ${lineNumber}`);
	}
	assertHash(value.serverHash, `pi-server compact state line ${lineNumber}.serverHash`);
	assertIdentifier(value.sessionId, `pi-server compact state line ${lineNumber}.sessionId`);
	assertIdentifier(value.operationId, `pi-server compact state line ${lineNumber}.operationId`);
	assertHash(value.requestHash, `pi-server compact state line ${lineNumber}.requestHash`);
	assertHash(value.baseStaticContextHash, `pi-server compact state line ${lineNumber}.baseStaticContextHash`, true);
	assertHash(value.baseTreeHash, `pi-server compact state line ${lineNumber}.baseTreeHash`);
	assertNonNegativeSafeInteger(value.baseEntryCount, `pi-server compact state line ${lineNumber}.baseEntryCount`);
	if (value.baseLeafId !== null) {
		assertIdentifier(value.baseLeafId, `pi-server compact state line ${lineNumber}.baseLeafId`);
	}
	assertNonNegativeSafeInteger(value.baseRevision, `pi-server compact state line ${lineNumber}.baseRevision`);
	return {
		version: COMPACT_STATE_VERSION,
		kind: "compact",
		sequence: value.sequence,
		timestamp: value.timestamp,
		serverHash: value.serverHash,
		sessionId: value.sessionId,
		operationId: value.operationId,
		requestHash: value.requestHash,
		baseStaticContextHash: value.baseStaticContextHash,
		baseTreeHash: value.baseTreeHash,
		baseEntryCount: value.baseEntryCount,
		baseLeafId: value.baseLeafId,
		baseRevision: value.baseRevision,
	};
}

function parseCompactStateFile(path: string): ParsedPiServerCompactState {
	if (!existsSync(path)) return { nextSequence: 0, pending: undefined };
	const encoded = readFileSync(path);
	if (encoded.byteLength > COMPACT_STATE_MAX_BYTES) {
		throw new Error(`pi-server compact state exceeds ${COMPACT_STATE_MAX_BYTES} bytes: ${path}`);
	}
	const content = encoded.toString("utf-8");
	const lines = content.split("\n");
	if (!content.endsWith("\n")) lines.pop();
	let expectedSequence = 0;
	let pending: PiServerPendingCompactState | undefined;
	for (const [index, line] of lines.entries()) {
		if (!line) continue;
		let envelope: unknown;
		try {
			envelope = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(`pi-server compact state envelope is invalid JSON at line ${index + 1}`, {
				cause: error,
			});
		}
		assertObject(envelope, `pi-server compact state envelope line ${index + 1}`);
		if (typeof envelope.payload !== "string") {
			throw new Error(`pi-server compact state envelope payload must be a string at line ${index + 1}`);
		}
		assertHash(envelope.sha256, `pi-server compact state envelope line ${index + 1}.sha256`);
		if (sha256(envelope.payload) !== envelope.sha256) {
			throw new Error(`pi-server compact state checksum mismatch at line ${index + 1}`);
		}
		const record = parsePayload(envelope.payload, index + 1);
		if (record.sequence !== expectedSequence) {
			throw new Error(
				`pi-server compact state sequence mismatch at line ${index + 1}: expected ${expectedSequence}, received ${record.sequence}`,
			);
		}
		expectedSequence++;
		if (record.kind === "compact") {
			if (pending) {
				throw new Error(
					`pi-server compact state contains a new operation before ${pending.operationId} was acknowledged`,
				);
			}
			pending = record;
		} else if (record.kind === "applied" || record.kind === "terminal") {
			if (
				!pending ||
				pending.operationId !== record.operationId ||
				pending.requestHash !== record.requestHash ||
				pending.observation
			) {
				throw new Error(
					`pi-server compact state observation does not match the pending operation at line ${index + 1}`,
				);
			}
			pending = { ...pending, observation: record };
		} else {
			if (!pending || pending.operationId !== record.operationId) {
				throw new Error(
					`pi-server compact state acknowledgement does not match the pending operation at line ${index + 1}`,
				);
			}
			pending = undefined;
		}
	}
	return { nextSequence: expectedSequence, pending };
}

function appendRecord(path: string, record: PiServerCompactStateRecord): void {
	const payload = JSON.stringify(record);
	const encoded = Buffer.from(`${JSON.stringify({ payload, sha256: sha256(payload) })}\n`, "utf-8");
	const existing = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
	const validBytes = existing.lastIndexOf(0x0a) + 1;
	if (validBytes !== existing.byteLength) truncateSync(path, validBytes);
	if (validBytes + encoded.byteLength > COMPACT_STATE_MAX_BYTES) {
		throw new Error(`pi-server compact state would exceed ${COMPACT_STATE_MAX_BYTES} bytes: ${path}`);
	}
	const fileExisted = existsSync(path);
	const handle = openSync(path, "a", 0o600);
	try {
		let written = 0;
		while (written < encoded.byteLength) {
			const bytesWritten = writeSync(handle, encoded, written, encoded.byteLength - written);
			if (bytesWritten === 0) throw new Error(`Failed to make progress writing pi-server compact state: ${path}`);
			written += bytesWritten;
		}
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	if (!fileExisted && process.platform !== "win32") {
		const directoryHandle = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
	}
}

function withCompactStateLock<T>(path: string, operation: () => T): T {
	const normalizedPath = resolve(path);
	const database = new DatabaseSync(`${normalizedPath}.lock.sqlite`);
	let transactionStarted = false;
	try {
		database.exec("PRAGMA busy_timeout = 0");
		database.exec("CREATE TABLE IF NOT EXISTS compact_state_lock (id INTEGER PRIMARY KEY CHECK (id = 1))");
		database.exec("BEGIN IMMEDIATE");
		transactionStarted = true;
		return operation();
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot update pi-server compact state ${normalizedPath}: ${details}`, { cause: error });
	} finally {
		if (transactionStarted) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Closing the connection is the authoritative lock release.
			}
		}
		database.close();
	}
}

export function getPiServerCompactStatePath(sessionFile: string): string {
	return `${sessionFile}.pi-server-compacts.jsonl`;
}

export function readPiServerPendingCompact(path: string): PiServerPendingCompactState | undefined {
	return parseCompactStateFile(path).pending;
}

export function writePiServerPendingCompact(
	path: string,
	input: WritePiServerPendingCompactInput,
): PiServerPendingCompactState {
	return withCompactStateLock(path, () => {
		const state = parseCompactStateFile(path);
		if (state.pending) {
			throw new Error(
				`pi-server compaction ${state.pending.operationId} must be acknowledged before starting another compaction`,
			);
		}
		if (state.nextSequence > 0) {
			truncateSync(path, 0);
			state.nextSequence = 0;
		}
		const timestamp = input.timestamp ?? Date.now();
		assertNonNegativeSafeInteger(timestamp, "pi-server compact state timestamp");
		assertHash(input.serverHash, "pi-server compact state serverHash");
		assertIdentifier(input.sessionId, "pi-server compact state sessionId");
		assertIdentifier(input.operationId, "pi-server compact state operationId");
		assertHash(input.requestHash, "pi-server compact state requestHash");
		assertHash(input.baseStaticContextHash, "pi-server compact state baseStaticContextHash", true);
		assertHash(input.baseTreeHash, "pi-server compact state baseTreeHash");
		assertNonNegativeSafeInteger(input.baseEntryCount, "pi-server compact state baseEntryCount");
		if (input.baseLeafId !== null) assertIdentifier(input.baseLeafId, "pi-server compact state baseLeafId");
		assertNonNegativeSafeInteger(input.baseRevision, "pi-server compact state baseRevision");
		const record: PiServerPendingCompactState = {
			version: COMPACT_STATE_VERSION,
			kind: "compact",
			sequence: state.nextSequence,
			timestamp,
			serverHash: input.serverHash,
			sessionId: input.sessionId,
			operationId: input.operationId,
			requestHash: input.requestHash,
			baseStaticContextHash: input.baseStaticContextHash,
			baseTreeHash: input.baseTreeHash,
			baseEntryCount: input.baseEntryCount,
			baseLeafId: input.baseLeafId,
			baseRevision: input.baseRevision,
		};
		appendRecord(path, record);
		return record;
	});
}

export function writePiServerAppliedCompact(
	path: string,
	input: WritePiServerAppliedCompactInput,
): PiServerAppliedCompactState {
	return withCompactStateLock(path, () => {
		const state = parseCompactStateFile(path);
		const pending = state.pending;
		if (!pending || pending.operationId !== input.operationId || pending.requestHash !== input.requestHash) {
			throw new Error("Cannot record an applied pi-server compaction without its matching pending operation");
		}
		assertIdentifier(input.entryId, "pi-server compact applied entryId");
		assertHash(input.entryHash, "pi-server compact applied entryHash");
		assertHash(input.updatedTreeHash, "pi-server compact applied updatedTreeHash");
		assertIdentifier(input.updatedLeafId, "pi-server compact applied updatedLeafId");
		assertNonNegativeSafeInteger(input.updatedRevision, "pi-server compact applied updatedRevision");
		if (pending.observation) {
			if (
				pending.observation.kind !== "applied" ||
				pending.observation.entryId !== input.entryId ||
				pending.observation.entryHash !== input.entryHash ||
				pending.observation.updatedTreeHash !== input.updatedTreeHash ||
				pending.observation.updatedLeafId !== input.updatedLeafId ||
				pending.observation.updatedRevision !== input.updatedRevision
			) {
				throw new Error("Pi-server compaction already has a divergent durable observation");
			}
			return pending.observation;
		}
		const timestamp = input.timestamp ?? Date.now();
		assertNonNegativeSafeInteger(timestamp, "pi-server compact applied timestamp");
		const record: PiServerAppliedCompactState = {
			version: COMPACT_STATE_VERSION,
			kind: "applied",
			sequence: state.nextSequence,
			timestamp,
			operationId: input.operationId,
			requestHash: input.requestHash,
			entryId: input.entryId,
			entryHash: input.entryHash,
			updatedTreeHash: input.updatedTreeHash,
			updatedLeafId: input.updatedLeafId,
			updatedRevision: input.updatedRevision,
			resolution: "tree_applied",
		};
		appendRecord(path, record);
		return record;
	});
}

export function writePiServerTerminalCompact(
	path: string,
	input: WritePiServerTerminalCompactInput,
): PiServerTerminalCompactState {
	return withCompactStateLock(path, () => {
		const state = parseCompactStateFile(path);
		const pending = state.pending;
		if (!pending || pending.operationId !== input.operationId || pending.requestHash !== input.requestHash) {
			throw new Error("Cannot record a terminal pi-server compaction without its matching pending operation");
		}
		if (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
			throw new Error("pi-server compact terminal HTTP status is invalid");
		}
		assertError(input.error, "pi-server compact terminal error");
		if (
			(input.operationDisposition === "terminal" && input.status !== "failed") ||
			(input.operationDisposition === "not_started" && input.status !== "rejected")
		) {
			throw new Error("pi-server compact terminal disposition is invalid");
		}
		if (pending.observation) {
			if (
				pending.observation.kind !== "terminal" ||
				pending.observation.httpStatus !== input.httpStatus ||
				pending.observation.error !== input.error ||
				pending.observation.operationDisposition !== input.operationDisposition ||
				pending.observation.status !== input.status
			) {
				throw new Error("Pi-server compaction already has a divergent durable observation");
			}
			return pending.observation;
		}
		const timestamp = input.timestamp ?? Date.now();
		assertNonNegativeSafeInteger(timestamp, "pi-server compact terminal timestamp");
		const record: PiServerTerminalCompactState = {
			version: COMPACT_STATE_VERSION,
			kind: "terminal",
			sequence: state.nextSequence,
			timestamp,
			operationId: input.operationId,
			requestHash: input.requestHash,
			httpStatus: input.httpStatus,
			error: input.error,
			operationDisposition: input.operationDisposition,
			status: input.status,
			resolution: input.operationDisposition === "terminal" ? "terminal_failed_observed" : "server_rejected",
		};
		appendRecord(path, record);
		return record;
	});
}

export function acknowledgePiServerPendingCompact(
	path: string,
	operationId: string,
	resolution: PiServerCompactAcknowledgementResolution = "server_ack",
	timestamp = Date.now(),
): void {
	withCompactStateLock(path, () => {
		const state = parseCompactStateFile(path);
		if (!state.pending) return;
		if (state.pending.operationId !== operationId) {
			throw new Error(
				`Cannot acknowledge pi-server compaction ${operationId}; pending operation is ${state.pending.operationId}`,
			);
		}
		assertNonNegativeSafeInteger(timestamp, "pi-server compact acknowledgement timestamp");
		appendRecord(path, {
			version: COMPACT_STATE_VERSION,
			kind: "ack",
			sequence: state.nextSequence,
			timestamp,
			operationId,
			resolution,
		});
	});
}
