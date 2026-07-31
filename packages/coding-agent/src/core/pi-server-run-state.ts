import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RUN_STATE_VERSION = 1;
const RUN_STATE_MAX_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_MAX_CHARS = 1024;

interface PiServerRunStateBase {
	version: typeof RUN_STATE_VERSION;
	sequence: number;
	timestamp: number;
}

export interface PiServerPendingRunState extends PiServerRunStateBase {
	kind: "run";
	serverHash: string;
	sessionId: string;
	runId: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	requestHash: string;
}

interface PiServerAcknowledgedRunState extends PiServerRunStateBase {
	kind: "ack";
	runId: string;
	resolution: PiServerRunAcknowledgementResolution;
}

type PiServerRunStateRecord = PiServerPendingRunState | PiServerAcknowledgedRunState;

export type PiServerRunAcknowledgementResolution =
	| "server_ack"
	| "server_authoritative_missing"
	| "server_authoritative_rebind";

interface PiServerRunStateEnvelope {
	payload: string;
	sha256: string;
}

export interface WritePiServerPendingRunInput {
	serverHash: string;
	sessionId: string;
	runId: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	requestHash: string;
	timestamp?: number;
}

interface ParsedPiServerRunState {
	nextSequence: number;
	pending: PiServerPendingRunState | undefined;
}

export interface PiServerRunStateLease {
	readonly path: string;
	readonly database: DatabaseSync;
	active: boolean;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function acquirePiServerRunStateLease(path: string): PiServerRunStateLease {
	const normalizedPath = resolve(path);
	const database = new DatabaseSync(`${normalizedPath}.lock.sqlite`);
	let transactionStarted = false;
	try {
		database.exec("PRAGMA busy_timeout = 0");
		database.exec("CREATE TABLE IF NOT EXISTS run_state_lock (id INTEGER PRIMARY KEY CHECK (id = 1))");
		database.exec("BEGIN IMMEDIATE");
		transactionStarted = true;
		return { path: normalizedPath, database, active: true };
	} catch (error) {
		if (transactionStarted) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Closing the connection below is the authoritative lock release.
			}
		}
		database.close();
		throw new Error(`Cannot acquire pi-server run lease for ${normalizedPath}; another process owns the session`, {
			cause: error,
		});
	}
}

export function releasePiServerRunStateLease(lease: PiServerRunStateLease): void {
	if (!lease.active) return;
	lease.active = false;
	try {
		lease.database.exec("ROLLBACK");
	} catch {
		// close() still releases the OS-backed SQLite transaction after connection failure.
	}
	try {
		lease.database.close();
	} catch {
		// The lease is already unusable and close() is idempotent at this abstraction boundary.
	}
}

function assertPiServerRunStateLease(path: string, lease: PiServerRunStateLease): void {
	if (!lease.active) {
		throw new Error("Cannot use a released pi-server run lease");
	}
	const normalizedPath = resolve(path);
	if (lease.path !== normalizedPath) {
		throw new Error(`Pi-server run lease path mismatch: expected ${normalizedPath}, received ${lease.path}`);
	}
}

function withRunStateLease<T>(path: string, lease: PiServerRunStateLease | undefined, operation: () => T): T {
	if (lease) {
		assertPiServerRunStateLease(path, lease);
		return operation();
	}
	const acquiredLease = acquirePiServerRunStateLease(path);
	try {
		return operation();
	} finally {
		releasePiServerRunStateLease(acquiredLease);
	}
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > IDENTIFIER_MAX_CHARS) {
		throw new Error(`${path} must be a non-empty string up to ${IDENTIFIER_MAX_CHARS} characters`);
	}
}

function assertHash(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${path} must be a 64-character hex digest`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative safe integer`);
	}
}

function parseRecord(payload: string, lineNumber: number): PiServerRunStateRecord {
	let value: unknown;
	try {
		value = JSON.parse(payload) as unknown;
	} catch (error) {
		throw new Error(`pi-server run state payload is invalid JSON at line ${lineNumber}`, { cause: error });
	}
	assertObject(value, `pi-server run state line ${lineNumber}`);
	if (value.version !== RUN_STATE_VERSION) {
		throw new Error(`Unsupported pi-server run state version at line ${lineNumber}`);
	}
	assertNonNegativeSafeInteger(value.sequence, `pi-server run state line ${lineNumber}.sequence`);
	assertNonNegativeSafeInteger(value.timestamp, `pi-server run state line ${lineNumber}.timestamp`);
	if (value.kind === "ack") {
		assertIdentifier(value.runId, `pi-server run state line ${lineNumber}.runId`);
		if (
			value.resolution !== "server_ack" &&
			value.resolution !== "server_authoritative_missing" &&
			value.resolution !== "server_authoritative_rebind"
		) {
			throw new Error(`pi-server run state acknowledgement resolution is invalid at line ${lineNumber}`);
		}
		return {
			version: RUN_STATE_VERSION,
			kind: "ack",
			sequence: value.sequence,
			timestamp: value.timestamp,
			runId: value.runId,
			resolution: value.resolution,
		};
	}
	if (value.kind !== "run") {
		throw new Error(`Unsupported pi-server run state record kind at line ${lineNumber}`);
	}
	assertHash(value.serverHash, `pi-server run state line ${lineNumber}.serverHash`);
	assertIdentifier(value.sessionId, `pi-server run state line ${lineNumber}.sessionId`);
	assertIdentifier(value.runId, `pi-server run state line ${lineNumber}.runId`);
	assertHash(value.baseTreeHash, `pi-server run state line ${lineNumber}.baseTreeHash`);
	assertNonNegativeSafeInteger(value.baseEntryCount, `pi-server run state line ${lineNumber}.baseEntryCount`);
	if (value.baseLeafId !== null) {
		assertIdentifier(value.baseLeafId, `pi-server run state line ${lineNumber}.baseLeafId`);
	}
	assertHash(value.requestHash, `pi-server run state line ${lineNumber}.requestHash`);
	return {
		version: RUN_STATE_VERSION,
		kind: "run",
		sequence: value.sequence,
		timestamp: value.timestamp,
		serverHash: value.serverHash,
		sessionId: value.sessionId,
		runId: value.runId,
		baseTreeHash: value.baseTreeHash,
		baseEntryCount: value.baseEntryCount,
		baseLeafId: value.baseLeafId,
		requestHash: value.requestHash,
	};
}

function parseRunStateFile(path: string): ParsedPiServerRunState {
	if (!existsSync(path)) {
		return { nextSequence: 0, pending: undefined };
	}
	const encoded = readFileSync(path);
	if (encoded.byteLength > RUN_STATE_MAX_BYTES) {
		throw new Error(`pi-server run state exceeds ${RUN_STATE_MAX_BYTES} bytes: ${path}`);
	}
	const content = encoded.toString("utf-8");
	const hasCompleteTail = content.endsWith("\n");
	const lines = content.split("\n");
	if (!hasCompleteTail) {
		lines.pop();
	}
	let expectedSequence = 0;
	let pending: PiServerPendingRunState | undefined;
	for (const [index, line] of lines.entries()) {
		if (line.length === 0) continue;
		let envelopeValue: unknown;
		try {
			envelopeValue = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(`pi-server run state envelope is invalid JSON at line ${index + 1}`, { cause: error });
		}
		assertObject(envelopeValue, `pi-server run state envelope line ${index + 1}`);
		if (typeof envelopeValue.payload !== "string") {
			throw new Error(`pi-server run state envelope payload must be a string at line ${index + 1}`);
		}
		assertHash(envelopeValue.sha256, `pi-server run state envelope line ${index + 1}.sha256`);
		if (sha256(envelopeValue.payload) !== envelopeValue.sha256) {
			throw new Error(`pi-server run state checksum mismatch at line ${index + 1}`);
		}
		const record = parseRecord(envelopeValue.payload, index + 1);
		if (record.sequence !== expectedSequence) {
			throw new Error(
				`pi-server run state sequence mismatch at line ${index + 1}: expected ${expectedSequence}, received ${record.sequence}`,
			);
		}
		expectedSequence++;
		if (record.kind === "run") {
			if (pending) {
				throw new Error(`pi-server run state contains a new run before ${pending.runId} was acknowledged`);
			}
			pending = record;
		} else {
			if (!pending || pending.runId !== record.runId) {
				throw new Error(`pi-server run state acknowledgement does not match the pending run at line ${index + 1}`);
			}
			pending = undefined;
		}
	}
	return { nextSequence: expectedSequence, pending };
}

function appendRecord(path: string, record: PiServerRunStateRecord): void {
	const payload = JSON.stringify(record);
	const envelope: PiServerRunStateEnvelope = { payload, sha256: sha256(payload) };
	const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf-8");
	const existing = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
	const validBytes = existing.lastIndexOf(0x0a) + 1;
	if (validBytes !== existing.byteLength) {
		truncateSync(path, validBytes);
	}
	const existingBytes = validBytes;
	if (existingBytes + encoded.byteLength > RUN_STATE_MAX_BYTES) {
		throw new Error(`pi-server run state would exceed ${RUN_STATE_MAX_BYTES} bytes: ${path}`);
	}
	const fileExisted = existsSync(path);
	const handle = openSync(path, "a", 0o600);
	try {
		let written = 0;
		while (written < encoded.byteLength) {
			const bytesWritten = writeSync(handle, encoded, written, encoded.byteLength - written);
			if (bytesWritten === 0) {
				throw new Error(`Failed to make progress writing pi-server run state: ${path}`);
			}
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

export function getPiServerRunStatePath(sessionFile: string): string {
	return `${sessionFile}.pi-server-runs.jsonl`;
}

export function hashPiServerIdentity(serverUrl: string): string {
	return sha256(serverUrl);
}

export function readPiServerPendingRun(
	path: string,
	lease?: PiServerRunStateLease,
): PiServerPendingRunState | undefined {
	if (lease) {
		assertPiServerRunStateLease(path, lease);
	}
	// The append-only checksum envelope makes an unlocked observer read safe: a concurrent
	// incomplete final record is ignored. Lifecycle decisions pass the owning lease.
	return parseRunStateFile(path).pending;
}

export function writePiServerPendingRun(
	path: string,
	input: WritePiServerPendingRunInput,
	lease?: PiServerRunStateLease,
): PiServerPendingRunState {
	return withRunStateLease(path, lease, () => {
		const state = parseRunStateFile(path);
		if (state.pending) {
			throw new Error(`pi-server run ${state.pending.runId} must be acknowledged before starting another run`);
		}
		if (state.nextSequence > 0) {
			// All earlier runs are acknowledged. Truncating before the new durable marker is safe:
			// the caller cannot submit the new provider request until this function returns.
			truncateSync(path, 0);
			state.nextSequence = 0;
		}
		const timestamp = input.timestamp ?? Date.now();
		assertNonNegativeSafeInteger(timestamp, "pi-server run state timestamp");
		assertHash(input.serverHash, "pi-server run state serverHash");
		assertIdentifier(input.sessionId, "pi-server run state sessionId");
		assertIdentifier(input.runId, "pi-server run state runId");
		assertHash(input.baseTreeHash, "pi-server run state baseTreeHash");
		assertNonNegativeSafeInteger(input.baseEntryCount, "pi-server run state baseEntryCount");
		if (input.baseLeafId !== null) {
			assertIdentifier(input.baseLeafId, "pi-server run state baseLeafId");
		}
		assertHash(input.requestHash, "pi-server run state requestHash");
		const record: PiServerPendingRunState = {
			version: RUN_STATE_VERSION,
			kind: "run",
			sequence: state.nextSequence,
			timestamp,
			serverHash: input.serverHash,
			sessionId: input.sessionId,
			runId: input.runId,
			baseTreeHash: input.baseTreeHash,
			baseEntryCount: input.baseEntryCount,
			baseLeafId: input.baseLeafId,
			requestHash: input.requestHash,
		};
		appendRecord(path, record);
		return record;
	});
}

export function acknowledgePiServerPendingRun(
	path: string,
	runId: string,
	timestamp = Date.now(),
	lease?: PiServerRunStateLease,
	resolution: PiServerRunAcknowledgementResolution = "server_ack",
): void {
	withRunStateLease(path, lease, () => {
		const state = parseRunStateFile(path);
		if (!state.pending) return;
		if (state.pending.runId !== runId) {
			throw new Error(`Cannot acknowledge pi-server run ${runId}; pending run is ${state.pending.runId}`);
		}
		assertNonNegativeSafeInteger(timestamp, "pi-server run acknowledgement timestamp");
		appendRecord(path, {
			version: RUN_STATE_VERSION,
			kind: "ack",
			sequence: state.nextSequence,
			timestamp,
			runId,
			resolution,
		});
	});
}
