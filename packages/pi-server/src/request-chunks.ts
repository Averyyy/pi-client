import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const CHUNK_ENDPOINT = "/api/request/chunk";

const ALLOWED_TARGETS = new Set([
	"/api/session/init",
	"/api/session/update",
	"/api/session/sync",
	"/api/session/append",
	"/api/session/tree/sync",
	"/api/session/tree/append",
	"/api/session/tree/switch",
	"/api/session/compact",
	"/api/stream",
	"/api/generate-images",
	"/api/classify",
	"/api/provider-callback",
	"/api/cancel-deferred",
	"/api/receive",
	"/api/observer",
	"/api/accounts/login",
	"/api/accounts/login/reply",
	"/api/accounts/login/cancel",
	"/api/accounts/logout",
	"/api/accounts/refresh",
]);

export interface RequestChunkBody {
	requestId: string;
	target: string;
	chunkIndex: number;
	totalChunks: number;
	sha256: string;
	chunk: string;
}

export interface RequestVersion {
	version: number;
	deletion?: { sessionId: string; next: RequestVersion };
}

interface RequestChunk {
	chunk: string;
	sha256: string;
}

interface PendingRequest {
	requestVersion: RequestVersion;
	target: string;
	totalChunks: number;
	chunks: Map<number, RequestChunk>;
	receivedBytes: number;
	expiresAtMs: number;
}

interface CompletedRequest {
	requestVersion: RequestVersion;
	target: string;
	totalChunks: number;
	bodyJson: string;
	completedChunkIndex: number;
	expiresAtMs: number;
	retainedBytes: number;
	chunks: Map<number, string>;
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
	target: string;
	bodyJson: string;
	requestVersion: RequestVersion;
}

const pendingRequests = new Map<string, PendingRequest>();
const completedRequests = new Map<string, CompletedRequest>();
let pendingRequestBytes = 0;
let completedRequestBytes = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

export const REQUEST_CHUNK_PENDING_TTL_MS = 5 * 60 * 1000;
export const REQUEST_CHUNK_MAX_PENDING_BYTES = 1024 * 1024 * 1024;
export const REQUEST_CHUNK_COMPLETED_TTL_MS = 60 * 1000;
export const REQUEST_CHUNK_MAX_COMPLETED_BYTES = 1024 * 1024 * 1024;

interface ReceiveRequestChunkOptions {
	requestVersion?: RequestVersion;
	nowMs?: number;
	pendingTtlMs?: number;
	maxPendingBytes?: number;
	completedTtlMs?: number;
	maxCompletedBytes?: number;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertValidChunk(body: RequestChunkBody): void {
	if (!body.requestId) throw new Error("requestId is required");
	if (!ALLOWED_TARGETS.has(body.target)) throw new Error(`Unsupported chunk target: ${body.target}`);
	if (!Number.isInteger(body.totalChunks) || body.totalChunks <= 0) {
		throw new Error("totalChunks must be a positive integer");
	}
	if (!Number.isInteger(body.chunkIndex) || body.chunkIndex < 0 || body.chunkIndex >= body.totalChunks) {
		throw new Error("chunkIndex must be an integer within the chunk range");
	}
	if (typeof body.chunk !== "string") throw new Error("chunk must be a string");
	if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(body.sha256)) {
		throw new Error("sha256 must be a 64-character hex string");
	}
	if (sha256(body.chunk) !== body.sha256) {
		throw new Error(`Chunk checksum mismatch: ${body.chunkIndex}`);
	}
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
	pendingRequestBytes -= pending.receivedBytes;
}

function deleteCompletedRequest(requestId: string, completed: CompletedRequest): void {
	completedRequests.delete(requestId);
	completedRequestBytes -= completed.retainedBytes;
}

function cleanupExpiredRequests(nowMs: number): void {
	for (const [requestId, pending] of pendingRequests) {
		if (pending.expiresAtMs <= nowMs) {
			deletePendingRequest(requestId, pending);
		}
	}
	for (const [requestId, completed] of completedRequests) {
		if (completed.expiresAtMs <= nowMs) {
			deleteCompletedRequest(requestId, completed);
		}
	}
}

function scheduleCleanup(nowMs: number): void {
	if (cleanupTimer) clearTimeout(cleanupTimer);
	cleanupTimer = undefined;
	let expiresAtMs = Number.POSITIVE_INFINITY;
	for (const pending of pendingRequests.values()) expiresAtMs = Math.min(expiresAtMs, pending.expiresAtMs);
	for (const completed of completedRequests.values()) expiresAtMs = Math.min(expiresAtMs, completed.expiresAtMs);
	if (expiresAtMs === Number.POSITIVE_INFINITY) return;
	cleanupTimer = setTimeout(
		() => {
			cleanupTimer = undefined;
			const now = Date.now();
			cleanupExpiredRequests(now);
			scheduleCleanup(now);
		},
		Math.max(0, expiresAtMs - nowMs),
	);
	cleanupTimer.unref();
}

function cleanupForPendingBytes(extraBytes: number, maxPendingBytes: number, protectedRequestId: string): void {
	for (const [requestId, pending] of pendingRequests) {
		if (pendingRequestBytes + extraBytes <= maxPendingBytes) return;
		if (requestId !== protectedRequestId) {
			deletePendingRequest(requestId, pending);
		}
	}
	if (pendingRequestBytes + extraBytes > maxPendingBytes) {
		throw new Error("Request chunk pending bytes limit exceeded");
	}
}

export function receiveRequestChunk(
	body: RequestChunkBody,
	options: ReceiveRequestChunkOptions = {},
): PendingChunkResult | CompleteChunkResult {
	assertValidChunk(body);

	const nowMs = options.nowMs ?? Date.now();
	const requestVersion = options.requestVersion ?? { version: 0 };
	cleanupExpiredRequests(nowMs);

	const completed = completedRequests.get(body.requestId);
	if (completed) {
		if (completed.target !== body.target || completed.totalChunks !== body.totalChunks) {
			throw new Error("Chunk metadata does not match the completed request");
		}
		const existing = completed.chunks.get(body.chunkIndex);
		if (existing !== body.sha256) {
			throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
		}
		if (requestVersion.version < completed.requestVersion.version) completed.requestVersion = requestVersion;
		if (body.chunkIndex === completed.completedChunkIndex) {
			return {
				complete: true,
				target: completed.target,
				bodyJson: completed.bodyJson,
				requestVersion: completed.requestVersion,
			};
		}
		return makeAck(body);
	}

	let pending = pendingRequests.get(body.requestId);
	if (pending) {
		if (pending.target !== body.target || pending.totalChunks !== body.totalChunks) {
			throw new Error("Chunk metadata does not match the pending request");
		}
		const existing = pending.chunks.get(body.chunkIndex);
		if (existing) {
			if (existing.chunk !== body.chunk || existing.sha256 !== body.sha256) {
				throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
			}
			if (requestVersion.version < pending.requestVersion.version) pending.requestVersion = requestVersion;
			pending.expiresAtMs = nowMs + (options.pendingTtlMs ?? REQUEST_CHUNK_PENDING_TTL_MS);
			scheduleCleanup(nowMs);
			return makeAck(body);
		}
		if (requestVersion.version < pending.requestVersion.version) pending.requestVersion = requestVersion;
	}

	const chunkBytes = Buffer.byteLength(body.chunk, "utf-8");
	cleanupForPendingBytes(chunkBytes, options.maxPendingBytes ?? REQUEST_CHUNK_MAX_PENDING_BYTES, body.requestId);
	if (!pending) {
		pending = {
			requestVersion,
			target: body.target,
			totalChunks: body.totalChunks,
			chunks: new Map(),
			receivedBytes: 0,
			expiresAtMs: nowMs + (options.pendingTtlMs ?? REQUEST_CHUNK_PENDING_TTL_MS),
		};
		pendingRequests.set(body.requestId, pending);
	}
	pending.chunks.set(body.chunkIndex, { chunk: body.chunk, sha256: body.sha256 });
	pending.receivedBytes += chunkBytes;
	pending.expiresAtMs = nowMs + (options.pendingTtlMs ?? REQUEST_CHUNK_PENDING_TTL_MS);
	pendingRequestBytes += chunkBytes;

	if (pending.chunks.size !== pending.totalChunks) {
		scheduleCleanup(nowMs);
		return makeAck(body);
	}

	const encodedChunks: string[] = [];
	const completedChunks = new Map<number, string>();
	for (let index = 0; index < pending.totalChunks; index++) {
		const chunk = pending.chunks.get(index);
		if (chunk === undefined) throw new Error(`Missing chunk index: ${index}`);
		encodedChunks.push(chunk.chunk);
		completedChunks.set(index, chunk.sha256);
	}

	deletePendingRequest(body.requestId, pending);
	const bodyJson = Buffer.from(encodedChunks.join(""), "base64").toString("utf-8");
	const retainedBytes = Buffer.byteLength(bodyJson, "utf-8") + pending.chunks.size * 64;
	const maxCompletedBytes = options.maxCompletedBytes ?? REQUEST_CHUNK_MAX_COMPLETED_BYTES;
	if (retainedBytes > maxCompletedBytes) {
		scheduleCleanup(nowMs);
		throw new Error("Request chunk completed bytes limit exceeded");
	}
	for (const [requestId, completed] of completedRequests) {
		if (completedRequestBytes + retainedBytes <= maxCompletedBytes) break;
		deleteCompletedRequest(requestId, completed);
	}
	completedRequests.set(body.requestId, {
		requestVersion: pending.requestVersion,
		target: pending.target,
		totalChunks: pending.totalChunks,
		bodyJson,
		completedChunkIndex: body.chunkIndex,
		expiresAtMs: nowMs + (options.completedTtlMs ?? REQUEST_CHUNK_COMPLETED_TTL_MS),
		retainedBytes,
		chunks: completedChunks,
	});
	completedRequestBytes += retainedBytes;
	scheduleCleanup(nowMs);
	return {
		complete: true,
		target: pending.target,
		bodyJson,
		requestVersion: pending.requestVersion,
	};
}

export function clearAllRequestChunks(): void {
	if (cleanupTimer) clearTimeout(cleanupTimer);
	cleanupTimer = undefined;
	pendingRequests.clear();
	completedRequests.clear();
	pendingRequestBytes = 0;
	completedRequestBytes = 0;
}
