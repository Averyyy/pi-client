import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const CHUNK_ENDPOINT = "/api/request/chunk";
export const REQUEST_CHUNK_SEGMENT_ENCODING = "base64-segment-v1";
const LEGACY_REQUEST_CHUNK_ENCODING = "legacy-base64-stream";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const ALLOWED_TARGETS = new Set([
	"/api/session/init",
	"/api/session/update",
	"/api/session/sync",
	"/api/session/append",
	"/api/session/tree/sync",
	"/api/session/tree/append",
	"/api/session/tree/switch",
	"/api/session/drop-last-assistant-error",
	"/api/session/run/cancel",
	"/api/session/compact",
	"/api/session/compact/cancel",
	"/api/stream",
	"/api/receive",
]);

export interface RequestChunkBody {
	requestId: string;
	target: string;
	chunkIndex: number;
	totalChunks: number;
	sha256: string;
	chunk: string;
	encoding?: string;
	rawTotalBytes?: number;
	rawChunkBytes?: number;
}

type RequestChunkEncoding = typeof LEGACY_REQUEST_CHUNK_ENCODING | typeof REQUEST_CHUNK_SEGMENT_ENCODING;

type RequestChunk =
	| {
			encoding: typeof LEGACY_REQUEST_CHUNK_ENCODING;
			encoded: string;
			sha256: string;
			retainedBytes: number;
	  }
	| {
			encoding: typeof REQUEST_CHUNK_SEGMENT_ENCODING;
			decoded: Buffer;
			sha256: string;
			retainedBytes: number;
	  };

interface PendingRequestBase {
	target: string;
	totalChunks: number;
	encoding: RequestChunkEncoding;
	receivedBytes: number;
	allocatedBytes: number;
	metadataBytes: number;
	tombstoneBytes: number;
	expiresAtMs: number;
}

interface StoredPendingRequest extends PendingRequestBase {
	layout: "stored";
	chunks: Map<number, RequestChunk>;
}

interface OffsetPendingRequest extends PendingRequestBase {
	layout: "offset";
	rawTotalBytes: number;
	rawChunkBytes: number;
	rawBody: Buffer;
	receivedChunks: Uint8Array;
	chunkHashes: Array<string | undefined>;
	receivedChunkCount: number;
}

type PendingRequest = StoredPendingRequest | OffsetPendingRequest;

interface CompletedRequest {
	target: string;
	totalChunks: number;
	encoding: RequestChunkEncoding;
	rawTotalBytes?: number;
	rawChunkBytes?: number;
	bodyJson: string;
	completedChunkIndex: number;
	chunkHashes: ReadonlyArray<string>;
	retainedBytes: number;
	expiresAtMs: number;
}

interface CompletedRequestTombstone {
	target: string;
	totalChunks: number;
	encoding: RequestChunkEncoding;
	rawTotalBytes?: number;
	rawChunkBytes?: number;
	retainedBytes: number;
	expiresAtMs: number;
}

interface ChunkAck {
	received: true;
	requestId: string;
	chunkIndex: number;
	totalChunks: number;
}

interface PendingChunkResult {
	complete: false;
	ack: ChunkAck;
}

interface CompleteChunkResult {
	complete: true;
	requestId: string;
	replayed: boolean;
	target: string;
	bodyJson: string;
}

const pendingRequests = new Map<string, PendingRequest>();
const completedRequests = new Map<string, CompletedRequest>();
const completedRequestTombstones = new Map<string, CompletedRequestTombstone>();
let pendingRequestBytes = 0;
let pendingRequestMetadataBytes = 0;
let pendingRequestTombstoneReservationBytes = 0;
let completedRequestBytes = 0;
let completedRequestTombstoneBytes = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

export const REQUEST_CHUNK_PENDING_TTL_MS = 5 * 60 * 1000;
// Chunk transport base64-encodes the JSON body, whose file payloads may already
// be base64. Keep enough bounded headroom for the 64 MiB decoded receive limit.
export const REQUEST_CHUNK_MAX_PENDING_BYTES = 256 * 1024 * 1024;
export const REQUEST_CHUNK_MAX_TOTAL_CHUNKS = 4096;
export const REQUEST_CHUNK_MAX_REQUEST_ID_CHARS = 128;
export const REQUEST_CHUNK_MAX_PENDING_COUNT = 128;
export const REQUEST_CHUNK_MAX_PENDING_METADATA_BYTES = 32 * 1024 * 1024;
export const REQUEST_CHUNK_COMPLETED_TTL_MS = 60 * 1000;
export const REQUEST_CHUNK_MAX_COMPLETED_COUNT = 128;
export const REQUEST_CHUNK_MAX_COMPLETED_BYTES = 256 * 1024 * 1024;
export const REQUEST_CHUNK_TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;
export const REQUEST_CHUNK_MAX_TOMBSTONE_COUNT = 8192;
export const REQUEST_CHUNK_MAX_TOMBSTONE_BYTES = 4 * 1024 * 1024;

const REQUEST_CHUNK_PENDING_BASE_METADATA_BYTES = 256;
const REQUEST_CHUNK_PENDING_PER_CHUNK_METADATA_BYTES = 192;

interface ReceiveRequestChunkOptions {
	nowMs?: number;
	pendingTtlMs?: number;
	maxPendingBytes?: number;
	maxPendingCount?: number;
	maxPendingMetadataBytes?: number;
	completedTtlMs?: number;
	maxCompletedCount?: number;
	maxCompletedBytes?: number;
	tombstoneTtlMs?: number;
	maxTombstoneCount?: number;
	maxTombstoneBytes?: number;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function base64Value(characterCode: number): number {
	if (characterCode >= 65 && characterCode <= 90) return characterCode - 65;
	if (characterCode >= 97 && characterCode <= 122) return characterCode - 71;
	if (characterCode >= 48 && characterCode <= 57) return characterCode + 4;
	if (characterCode === 43) return 62;
	if (characterCode === 47) return 63;
	return -1;
}

function getCanonicalBase64DecodedBytes(value: string, label: string): number {
	if (value.length % 4 !== 0) {
		throw new Error(`${label} must be canonical padded base64`);
	}
	let padding = 0;
	if (value.endsWith("==")) {
		padding = 2;
	} else if (value.endsWith("=")) {
		padding = 1;
	}
	const dataLength = value.length - padding;
	for (let index = 0; index < dataLength; index++) {
		if (base64Value(value.charCodeAt(index)) < 0) {
			throw new Error(`${label} must be canonical padded base64`);
		}
	}
	for (let index = dataLength; index < value.length; index++) {
		if (value.charCodeAt(index) !== 61) {
			throw new Error(`${label} must be canonical padded base64`);
		}
	}
	if (
		(padding === 0 && dataLength % 4 !== 0) ||
		(padding === 1 && (dataLength % 4 !== 3 || (base64Value(value.charCodeAt(dataLength - 1)) & 0b11) !== 0)) ||
		(padding === 2 && (dataLength % 4 !== 2 || (base64Value(value.charCodeAt(dataLength - 1)) & 0b1111) !== 0))
	) {
		throw new Error(`${label} must be canonical padded base64`);
	}
	return (value.length / 4) * 3 - padding;
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
	getCanonicalBase64DecodedBytes(value, label);
	return Buffer.from(value, "base64");
}

function decodeRequestBody(rawBody: Buffer): string {
	try {
		return UTF8_DECODER.decode(rawBody);
	} catch {
		throw new Error("Decoded request body must be valid UTF-8");
	}
}

type ValidatedChunk =
	| {
			encoding: typeof LEGACY_REQUEST_CHUNK_ENCODING;
			layout: "stored";
			chunk: RequestChunk;
	  }
	| {
			encoding: typeof REQUEST_CHUNK_SEGMENT_ENCODING;
			layout: "stored";
			chunk: RequestChunk;
	  }
	| {
			encoding: typeof REQUEST_CHUNK_SEGMENT_ENCODING;
			layout: "offset";
			decodedBytes: number;
			rawTotalBytes: number;
			rawChunkBytes: number;
			offset: number;
			sha256: string;
			encoded: string;
	  };

function assertValidChunk(body: RequestChunkBody): ValidatedChunk {
	if (!body.requestId) throw new Error("requestId is required");
	if (typeof body.requestId !== "string" || body.requestId.length > REQUEST_CHUNK_MAX_REQUEST_ID_CHARS) {
		throw new Error(`requestId must not exceed ${REQUEST_CHUNK_MAX_REQUEST_ID_CHARS} characters`);
	}
	if (!ALLOWED_TARGETS.has(body.target)) throw new Error(`Unsupported chunk target: ${body.target}`);
	if (
		!Number.isInteger(body.totalChunks) ||
		body.totalChunks <= 0 ||
		body.totalChunks > REQUEST_CHUNK_MAX_TOTAL_CHUNKS
	) {
		throw new Error(`totalChunks must be an integer from 1 to ${REQUEST_CHUNK_MAX_TOTAL_CHUNKS}`);
	}
	if (!Number.isInteger(body.chunkIndex) || body.chunkIndex < 0 || body.chunkIndex >= body.totalChunks) {
		throw new Error("chunkIndex must be an integer within the chunk range");
	}
	if (typeof body.chunk !== "string") throw new Error("chunk must be a string");
	if (body.chunk.length === 0) throw new Error("chunk must not be empty");
	if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) {
		throw new Error("sha256 must be a canonical lowercase 64-character hex string");
	}
	if (sha256(body.chunk) !== body.sha256) {
		throw new Error(`Chunk checksum mismatch: ${body.chunkIndex}`);
	}
	if (body.encoding === undefined) {
		if (body.rawTotalBytes !== undefined || body.rawChunkBytes !== undefined) {
			throw new Error("raw chunk layout metadata requires base64-segment-v1 encoding");
		}
		return {
			encoding: LEGACY_REQUEST_CHUNK_ENCODING,
			layout: "stored",
			chunk: {
				encoding: LEGACY_REQUEST_CHUNK_ENCODING,
				encoded: body.chunk,
				sha256: body.sha256,
				retainedBytes: Buffer.byteLength(body.chunk, "utf-8"),
			},
		};
	}
	if (body.encoding !== REQUEST_CHUNK_SEGMENT_ENCODING) {
		throw new Error(`Unsupported chunk encoding: ${String(body.encoding)}`);
	}
	const decodedBytes = getCanonicalBase64DecodedBytes(body.chunk, `Chunk ${body.chunkIndex}`);
	if (body.rawTotalBytes === undefined && body.rawChunkBytes === undefined) {
		const decoded = Buffer.from(body.chunk, "base64");
		return {
			encoding: REQUEST_CHUNK_SEGMENT_ENCODING,
			layout: "stored",
			chunk: {
				encoding: REQUEST_CHUNK_SEGMENT_ENCODING,
				decoded,
				sha256: body.sha256,
				retainedBytes: decoded.byteLength,
			},
		};
	}
	if (body.rawTotalBytes === undefined || body.rawChunkBytes === undefined) {
		throw new Error("rawTotalBytes and rawChunkBytes must be supplied together");
	}
	if (
		!Number.isSafeInteger(body.rawTotalBytes) ||
		body.rawTotalBytes <= 0 ||
		body.rawTotalBytes > REQUEST_CHUNK_MAX_PENDING_BYTES
	) {
		throw new Error(`rawTotalBytes must be an integer from 1 to ${REQUEST_CHUNK_MAX_PENDING_BYTES}`);
	}
	if (
		!Number.isSafeInteger(body.rawChunkBytes) ||
		body.rawChunkBytes <= 0 ||
		body.rawChunkBytes > body.rawTotalBytes
	) {
		throw new Error("rawChunkBytes must be an integer within the raw request body");
	}
	if (Math.ceil(body.rawTotalBytes / body.rawChunkBytes) !== body.totalChunks) {
		throw new Error("totalChunks does not match the raw chunk layout");
	}
	const offset = body.chunkIndex * body.rawChunkBytes;
	const expectedBytes = Math.min(body.rawChunkBytes, body.rawTotalBytes - offset);
	if (expectedBytes <= 0 || decodedBytes !== expectedBytes) {
		throw new Error(`Chunk ${body.chunkIndex} byte length does not match the raw chunk layout`);
	}
	return {
		encoding: REQUEST_CHUNK_SEGMENT_ENCODING,
		layout: "offset",
		decodedBytes,
		rawTotalBytes: body.rawTotalBytes,
		rawChunkBytes: body.rawChunkBytes,
		offset,
		sha256: body.sha256,
		encoded: body.chunk,
	};
}

function makeAck(body: RequestChunkBody): PendingChunkResult {
	return {
		complete: false,
		ack: {
			received: true,
			requestId: body.requestId,
			chunkIndex: body.chunkIndex,
			totalChunks: body.totalChunks,
		},
	};
}

function deletePendingRequest(requestId: string, pending: PendingRequest): void {
	pendingRequests.delete(requestId);
	pendingRequestBytes -= pending.allocatedBytes;
	pendingRequestMetadataBytes -= pending.metadataBytes;
	pendingRequestTombstoneReservationBytes -= pending.tombstoneBytes;
}

function deleteCompletedRequest(requestId: string, completed: CompletedRequest): void {
	completedRequests.delete(requestId);
	completedRequestBytes -= completed.retainedBytes;
}

function deleteCompletedRequestTombstone(requestId: string, tombstone: CompletedRequestTombstone): void {
	completedRequestTombstones.delete(requestId);
	completedRequestTombstoneBytes -= tombstone.retainedBytes;
}

function cleanupExpiredRequests(nowMs: number): void {
	for (const [requestId, pending] of pendingRequests) {
		if (nowMs >= pending.expiresAtMs) {
			deletePendingRequest(requestId, pending);
		}
	}
	for (const [requestId, completed] of completedRequests) {
		if (nowMs >= completed.expiresAtMs) {
			deleteCompletedRequest(requestId, completed);
		}
	}
	for (const [requestId, tombstone] of completedRequestTombstones) {
		if (nowMs >= tombstone.expiresAtMs) {
			deleteCompletedRequestTombstone(requestId, tombstone);
		}
	}
}

function scheduleCleanupTimer(nowMs = Date.now()): void {
	if (cleanupTimer !== undefined) {
		clearTimeout(cleanupTimer);
		cleanupTimer = undefined;
	}

	let nextExpiryMs = Number.POSITIVE_INFINITY;
	for (const pending of pendingRequests.values()) {
		nextExpiryMs = Math.min(nextExpiryMs, pending.expiresAtMs);
	}
	for (const completed of completedRequests.values()) {
		nextExpiryMs = Math.min(nextExpiryMs, completed.expiresAtMs);
	}
	for (const tombstone of completedRequestTombstones.values()) {
		nextExpiryMs = Math.min(nextExpiryMs, tombstone.expiresAtMs);
	}
	if (!Number.isFinite(nextExpiryMs)) return;

	cleanupTimer = setTimeout(
		() => {
			cleanupTimer = undefined;
			cleanupExpiredRequests(Date.now());
			scheduleCleanupTimer();
		},
		Math.max(0, nextExpiryMs - nowMs),
	);
	cleanupTimer.unref();
}

function assertPositiveLimit(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
}

function calculatePendingMetadataBytes(body: RequestChunkBody): number {
	return (
		REQUEST_CHUNK_PENDING_BASE_METADATA_BYTES +
		body.totalChunks * REQUEST_CHUNK_PENDING_PER_CHUNK_METADATA_BYTES +
		Buffer.byteLength(body.requestId, "utf-8") +
		Buffer.byteLength(body.target, "utf-8") +
		Buffer.byteLength(body.encoding ?? LEGACY_REQUEST_CHUNK_ENCODING, "utf-8")
	);
}

function calculateTombstoneBytes(body: RequestChunkBody): number {
	return (
		192 +
		Buffer.byteLength(body.requestId, "utf-8") +
		Buffer.byteLength(body.target, "utf-8") +
		Buffer.byteLength(body.encoding ?? LEGACY_REQUEST_CHUNK_ENCODING, "utf-8")
	);
}

function cleanupForPendingCapacity(
	extraBytes: number,
	extraMetadataBytes: number,
	extraCount: number,
	maxPendingBytes: number,
	maxPendingMetadataBytes: number,
	maxPendingCount: number,
	protectedRequestId: string,
	protectedBytesAfterAdmission: number,
	protectedMetadataBytesAfterAdmission: number,
): void {
	assertPositiveLimit(maxPendingBytes, "maxPendingBytes");
	assertPositiveLimit(maxPendingMetadataBytes, "maxPendingMetadataBytes");
	assertPositiveLimit(maxPendingCount, "maxPendingCount");
	if (protectedBytesAfterAdmission > maxPendingBytes) {
		throw new Error("Request chunk pending bytes limit exceeded");
	}
	if (protectedMetadataBytesAfterAdmission > maxPendingMetadataBytes) {
		throw new Error("Request chunk pending metadata limit exceeded");
	}
	if (extraCount > maxPendingCount) {
		throw new Error("Request chunk pending count limit exceeded");
	}

	for (const [requestId, pending] of pendingRequests) {
		if (
			pendingRequestBytes + extraBytes <= maxPendingBytes &&
			pendingRequestMetadataBytes + extraMetadataBytes <= maxPendingMetadataBytes &&
			pendingRequests.size + extraCount <= maxPendingCount
		) {
			return;
		}
		if (requestId !== protectedRequestId) {
			deletePendingRequest(requestId, pending);
		}
	}
	if (pendingRequestBytes + extraBytes > maxPendingBytes) {
		throw new Error("Request chunk pending bytes limit exceeded");
	}
	if (pendingRequestMetadataBytes + extraMetadataBytes > maxPendingMetadataBytes) {
		throw new Error("Request chunk pending metadata limit exceeded");
	}
	if (pendingRequests.size + extraCount > maxPendingCount) {
		throw new Error("Request chunk pending count limit exceeded");
	}
}

function cleanupForTombstoneReservation(
	extraCount: number,
	extraBytes: number,
	maxTombstoneCount: number,
	maxTombstoneBytes: number,
	protectedRequestId: string,
): void {
	assertPositiveLimit(maxTombstoneCount, "maxTombstoneCount");
	assertPositiveLimit(maxTombstoneBytes, "maxTombstoneBytes");
	if (extraCount > maxTombstoneCount || extraBytes > maxTombstoneBytes) {
		throw new Error("Request chunk completed tombstone limit exceeded");
	}
	for (const [requestId, pending] of pendingRequests) {
		if (
			completedRequestTombstones.size + pendingRequests.size + extraCount <= maxTombstoneCount &&
			completedRequestTombstoneBytes + pendingRequestTombstoneReservationBytes + extraBytes <= maxTombstoneBytes
		) {
			return;
		}
		if (requestId !== protectedRequestId) deletePendingRequest(requestId, pending);
	}
	if (
		completedRequestTombstones.size + pendingRequests.size + extraCount > maxTombstoneCount ||
		completedRequestTombstoneBytes + pendingRequestTombstoneReservationBytes + extraBytes > maxTombstoneBytes
	) {
		throw new Error("Request chunk completed tombstone limit exceeded");
	}
}

function cacheCompletedRequest(
	requestId: string,
	completed: CompletedRequest,
	maxCompletedCount: number,
	maxCompletedBytes: number,
): void {
	if (maxCompletedCount <= 0 || completed.retainedBytes > maxCompletedBytes) return;

	for (const [completedRequestId, existing] of completedRequests) {
		if (
			completedRequests.size < maxCompletedCount &&
			completedRequestBytes + completed.retainedBytes <= maxCompletedBytes
		) {
			break;
		}
		deleteCompletedRequest(completedRequestId, existing);
	}
	if (
		completedRequests.size >= maxCompletedCount ||
		completedRequestBytes + completed.retainedBytes > maxCompletedBytes
	) {
		return;
	}

	completedRequests.set(requestId, completed);
	completedRequestBytes += completed.retainedBytes;
}

function cacheCompletedRequestTombstone(
	requestId: string,
	tombstone: CompletedRequestTombstone,
	maxTombstoneCount: number,
	maxTombstoneBytes: number,
): void {
	assertPositiveLimit(maxTombstoneCount, "maxTombstoneCount");
	assertPositiveLimit(maxTombstoneBytes, "maxTombstoneBytes");
	if (
		completedRequestTombstones.size >= maxTombstoneCount ||
		completedRequestTombstoneBytes + tombstone.retainedBytes > maxTombstoneBytes
	) {
		throw new Error("Request chunk completed tombstone limit exceeded");
	}
	completedRequestTombstones.set(requestId, tombstone);
	completedRequestTombstoneBytes += tombstone.retainedBytes;
}

function requestChunksEqual(left: RequestChunk, right: RequestChunk): boolean {
	if (left.encoding !== right.encoding || left.sha256 !== right.sha256) return false;
	if (left.encoding === LEGACY_REQUEST_CHUNK_ENCODING && right.encoding === LEGACY_REQUEST_CHUNK_ENCODING) {
		return left.encoded === right.encoded;
	}
	if (left.encoding === REQUEST_CHUNK_SEGMENT_ENCODING && right.encoding === REQUEST_CHUNK_SEGMENT_ENCODING) {
		return left.decoded.equals(right.decoded);
	}
	return false;
}

function requestLayoutMatches(
	request: Pick<PendingRequest, "encoding" | "layout"> | CompletedRequest | CompletedRequestTombstone,
	validated: ValidatedChunk,
): boolean {
	const requestUsesOffsetLayout =
		"rawTotalBytes" in request && request.rawTotalBytes !== undefined && request.rawChunkBytes !== undefined;
	if (validated.layout === "offset") {
		return (
			request.encoding === validated.encoding &&
			requestUsesOffsetLayout &&
			request.rawTotalBytes === validated.rawTotalBytes &&
			request.rawChunkBytes === validated.rawChunkBytes
		);
	}
	return request.encoding === validated.encoding && !requestUsesOffsetLayout;
}

function assembleBodyJson(pending: PendingRequest): string {
	if (pending.layout === "offset") {
		if (pending.receivedBytes !== pending.rawTotalBytes) {
			throw new Error("Decoded request chunk byte count did not match the raw chunk layout");
		}
		const rawBody = pending.rawBody;
		pending.rawBody = Buffer.alloc(0);
		return decodeRequestBody(rawBody);
	}

	if (pending.encoding === LEGACY_REQUEST_CHUNK_ENCODING) {
		const encodedChunks: string[] = [];
		for (let index = 0; index < pending.totalChunks; index++) {
			const chunk = pending.chunks.get(index);
			if (!chunk || chunk.encoding !== LEGACY_REQUEST_CHUNK_ENCODING) {
				throw new Error(`Missing legacy chunk index: ${index}`);
			}
			encodedChunks.push(chunk.encoded);
			pending.chunks.delete(index);
		}
		return decodeRequestBody(decodeCanonicalBase64(encodedChunks.join(""), "Legacy request body"));
	}

	const rawBody = Buffer.allocUnsafe(pending.receivedBytes);
	let offset = 0;
	for (let index = 0; index < pending.totalChunks; index++) {
		const chunk = pending.chunks.get(index);
		if (!chunk || chunk.encoding !== REQUEST_CHUNK_SEGMENT_ENCODING) {
			throw new Error(`Missing ${REQUEST_CHUNK_SEGMENT_ENCODING} chunk index: ${index}`);
		}
		chunk.decoded.copy(rawBody, offset);
		offset += chunk.decoded.byteLength;
		pending.chunks.delete(index);
	}
	if (offset !== rawBody.byteLength) {
		throw new Error("Decoded request chunk byte count did not match pending accounting");
	}
	return decodeRequestBody(rawBody);
}

export function receiveRequestChunk(
	body: RequestChunkBody,
	options: ReceiveRequestChunkOptions = {},
): PendingChunkResult | CompleteChunkResult {
	const validated = assertValidChunk(body);

	const nowMs = options.nowMs ?? Date.now();
	const pendingTtlMs = options.pendingTtlMs ?? REQUEST_CHUNK_PENDING_TTL_MS;
	const completedTtlMs = options.completedTtlMs ?? REQUEST_CHUNK_COMPLETED_TTL_MS;
	const tombstoneTtlMs = options.tombstoneTtlMs ?? REQUEST_CHUNK_TOMBSTONE_TTL_MS;
	assertPositiveLimit(pendingTtlMs, "pendingTtlMs");
	assertPositiveLimit(completedTtlMs, "completedTtlMs");
	assertPositiveLimit(tombstoneTtlMs, "tombstoneTtlMs");
	cleanupExpiredRequests(nowMs);

	const completed = completedRequests.get(body.requestId);
	if (completed) {
		if (
			completed.target !== body.target ||
			completed.totalChunks !== body.totalChunks ||
			!requestLayoutMatches(completed, validated)
		) {
			throw new Error("Chunk metadata does not match the completed request");
		}
		const existingHash = completed.chunkHashes[body.chunkIndex];
		if (existingHash !== body.sha256) {
			throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
		}
		if (body.chunkIndex === completed.completedChunkIndex) {
			return {
				complete: true,
				requestId: body.requestId,
				replayed: true,
				target: completed.target,
				bodyJson: completed.bodyJson,
			};
		}
		return makeAck(body);
	}

	const tombstone = completedRequestTombstones.get(body.requestId);
	if (tombstone) {
		if (
			tombstone.target !== body.target ||
			tombstone.totalChunks !== body.totalChunks ||
			!requestLayoutMatches(tombstone, validated)
		) {
			throw new Error("Chunk metadata does not match the completed request tombstone");
		}
		throw new Error("Chunk request already completed; target response is no longer replayable");
	}

	let pending = pendingRequests.get(body.requestId);
	if (pending) {
		if (
			pending.target !== body.target ||
			pending.totalChunks !== body.totalChunks ||
			!requestLayoutMatches(pending, validated)
		) {
			throw new Error("Chunk metadata does not match the pending request");
		}
		if (pending.layout === "offset" && validated.layout === "offset") {
			const existingHash = pending.chunkHashes[body.chunkIndex];
			if (existingHash !== undefined) {
				if (existingHash !== body.sha256) {
					throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
				}
				pending.expiresAtMs = nowMs + pendingTtlMs;
				scheduleCleanupTimer(nowMs);
				return makeAck(body);
			}
		} else if (pending.layout === "stored" && validated.layout === "stored") {
			const existing = pending.chunks.get(body.chunkIndex);
			if (existing && !requestChunksEqual(existing, validated.chunk)) {
				throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
			}
			if (existing) {
				pending.expiresAtMs = nowMs + pendingTtlMs;
				scheduleCleanupTimer(nowMs);
				return makeAck(body);
			}
		} else {
			throw new Error("Chunk layout does not match the pending request");
		}
	}

	const maxPendingBytes = options.maxPendingBytes ?? REQUEST_CHUNK_MAX_PENDING_BYTES;
	const maxPendingMetadataBytes = options.maxPendingMetadataBytes ?? REQUEST_CHUNK_MAX_PENDING_METADATA_BYTES;
	const maxPendingCount = options.maxPendingCount ?? REQUEST_CHUNK_MAX_PENDING_COUNT;
	const maxTombstoneCount = options.maxTombstoneCount ?? REQUEST_CHUNK_MAX_TOMBSTONE_COUNT;
	const maxTombstoneBytes = options.maxTombstoneBytes ?? REQUEST_CHUNK_MAX_TOMBSTONE_BYTES;
	const metadataBytes = pending?.metadataBytes ?? calculatePendingMetadataBytes(body);
	const tombstoneBytes = pending?.tombstoneBytes ?? calculateTombstoneBytes(body);
	const chunkBytes = pending?.layout === "offset" || validated.layout === "offset" ? 0 : validated.chunk.retainedBytes;
	const allocatedBytes = pending?.allocatedBytes ?? (validated.layout === "offset" ? validated.rawTotalBytes : 0);
	const protectedBytesAfterAdmission = allocatedBytes + chunkBytes;
	cleanupForPendingCapacity(
		pending ? chunkBytes : allocatedBytes + chunkBytes,
		pending ? 0 : metadataBytes,
		pending ? 0 : 1,
		maxPendingBytes,
		maxPendingMetadataBytes,
		maxPendingCount,
		body.requestId,
		protectedBytesAfterAdmission,
		metadataBytes,
	);
	cleanupForTombstoneReservation(
		pending ? 0 : 1,
		pending ? 0 : tombstoneBytes,
		maxTombstoneCount,
		maxTombstoneBytes,
		body.requestId,
	);
	if (!pending) {
		if (validated.layout === "offset") {
			pending = {
				target: body.target,
				totalChunks: body.totalChunks,
				encoding: validated.encoding,
				layout: "offset",
				rawTotalBytes: validated.rawTotalBytes,
				rawChunkBytes: validated.rawChunkBytes,
				rawBody: Buffer.allocUnsafe(validated.rawTotalBytes),
				receivedChunks: new Uint8Array(body.totalChunks),
				chunkHashes: new Array<string | undefined>(body.totalChunks),
				receivedChunkCount: 0,
				receivedBytes: 0,
				allocatedBytes: validated.rawTotalBytes,
				metadataBytes,
				tombstoneBytes,
				expiresAtMs: nowMs + pendingTtlMs,
			};
		} else {
			pending = {
				target: body.target,
				totalChunks: body.totalChunks,
				encoding: validated.encoding,
				layout: "stored",
				chunks: new Map(),
				receivedBytes: 0,
				allocatedBytes: 0,
				metadataBytes,
				tombstoneBytes,
				expiresAtMs: nowMs + pendingTtlMs,
			};
		}
		pendingRequests.set(body.requestId, pending);
		pendingRequestBytes += pending.allocatedBytes;
		pendingRequestMetadataBytes += pending.metadataBytes;
		pendingRequestTombstoneReservationBytes += pending.tombstoneBytes;
	}
	if (pending.layout === "offset" && validated.layout === "offset") {
		const written = pending.rawBody.write(validated.encoded, validated.offset, validated.decodedBytes, "base64");
		if (written !== validated.decodedBytes) {
			deletePendingRequest(body.requestId, pending);
			throw new Error(`Chunk ${body.chunkIndex} base64 decode did not fill its raw chunk range`);
		}
		pending.receivedChunks[body.chunkIndex] = 1;
		pending.chunkHashes[body.chunkIndex] = validated.sha256;
		pending.receivedChunkCount++;
		pending.receivedBytes += validated.decodedBytes;
	} else if (pending.layout === "stored" && validated.layout === "stored") {
		pending.chunks.set(body.chunkIndex, validated.chunk);
		pending.receivedBytes += validated.chunk.retainedBytes;
		pending.allocatedBytes += validated.chunk.retainedBytes;
		pendingRequestBytes += validated.chunk.retainedBytes;
	} else {
		deletePendingRequest(body.requestId, pending);
		throw new Error("Chunk layout changed while admitting the request");
	}
	pending.expiresAtMs = nowMs + pendingTtlMs;
	scheduleCleanupTimer(nowMs);

	const receivedChunkCount = pending.layout === "offset" ? pending.receivedChunkCount : pending.chunks.size;
	if (receivedChunkCount !== pending.totalChunks) {
		return makeAck(body);
	}

	const chunkHashes: string[] = [];
	if (pending.layout === "offset") {
		for (let index = 0; index < pending.totalChunks; index++) {
			const chunkHash = pending.chunkHashes[index];
			if (pending.receivedChunks[index] !== 1 || chunkHash === undefined) {
				throw new Error(`Missing ${REQUEST_CHUNK_SEGMENT_ENCODING} chunk index: ${index}`);
			}
			chunkHashes.push(chunkHash);
		}
	} else {
		for (let index = 0; index < pending.totalChunks; index++) {
			const chunk = pending.chunks.get(index);
			if (!chunk) throw new Error(`Missing chunk index: ${index}`);
			chunkHashes.push(chunk.sha256);
		}
	}
	deletePendingRequest(body.requestId, pending);
	const bodyJson = assembleBodyJson(pending);
	const retainedBytes =
		Buffer.byteLength(bodyJson, "utf-8") +
		Buffer.byteLength(pending.target, "utf-8") +
		Buffer.byteLength(pending.encoding, "utf-8") +
		Buffer.byteLength(body.requestId, "utf-8") +
		chunkHashes.length * 64;
	const completedMetadata = {
		target: pending.target,
		totalChunks: pending.totalChunks,
		encoding: pending.encoding,
		...(pending.layout === "offset"
			? { rawTotalBytes: pending.rawTotalBytes, rawChunkBytes: pending.rawChunkBytes }
			: {}),
	};
	cacheCompletedRequestTombstone(
		body.requestId,
		{
			...completedMetadata,
			retainedBytes: tombstoneBytes,
			expiresAtMs: nowMs + tombstoneTtlMs,
		},
		maxTombstoneCount,
		maxTombstoneBytes,
	);
	cacheCompletedRequest(
		body.requestId,
		{
			...completedMetadata,
			bodyJson,
			completedChunkIndex: body.chunkIndex,
			chunkHashes,
			retainedBytes,
			expiresAtMs: nowMs + completedTtlMs,
		},
		options.maxCompletedCount ?? REQUEST_CHUNK_MAX_COMPLETED_COUNT,
		options.maxCompletedBytes ?? REQUEST_CHUNK_MAX_COMPLETED_BYTES,
	);
	scheduleCleanupTimer(nowMs);
	return {
		complete: true,
		requestId: body.requestId,
		replayed: false,
		target: pending.target,
		bodyJson,
	};
}

export function getRequestChunkCacheStats(): {
	pendingCount: number;
	pendingBytes: number;
	pendingMetadataBytes: number;
	pendingPreallocatedBuffers: number;
	pendingStoredChunks: number;
	completedCount: number;
	completedBytes: number;
	tombstoneCount: number;
	tombstoneBytes: number;
} {
	let pendingPreallocatedBuffers = 0;
	let pendingStoredChunks = 0;
	for (const pending of pendingRequests.values()) {
		if (pending.layout === "offset") {
			pendingPreallocatedBuffers++;
		} else {
			pendingStoredChunks += pending.chunks.size;
		}
	}
	return {
		pendingCount: pendingRequests.size,
		pendingBytes: pendingRequestBytes,
		pendingMetadataBytes: pendingRequestMetadataBytes,
		pendingPreallocatedBuffers,
		pendingStoredChunks,
		completedCount: completedRequests.size,
		completedBytes: completedRequestBytes,
		tombstoneCount: completedRequestTombstones.size,
		tombstoneBytes: completedRequestTombstoneBytes,
	};
}

export function clearAllRequestChunks(): void {
	if (cleanupTimer !== undefined) {
		clearTimeout(cleanupTimer);
		cleanupTimer = undefined;
	}
	pendingRequests.clear();
	completedRequests.clear();
	completedRequestTombstones.clear();
	pendingRequestBytes = 0;
	pendingRequestMetadataBytes = 0;
	pendingRequestTombstoneReservationBytes = 0;
	completedRequestBytes = 0;
	completedRequestTombstoneBytes = 0;
}
