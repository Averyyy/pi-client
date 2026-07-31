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
	"/api/session/drop-last-assistant-error",
	"/api/session/compact",
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
}

interface RequestChunk {
	chunk: string;
	sha256: string;
}

interface PendingRequest {
	target: string;
	totalChunks: number;
	chunks: Map<number, RequestChunk>;
	receivedBytes: number;
	updatedAtMs: number;
}

interface CompletedRequest {
	target: string;
	totalChunks: number;
	bodyJson: string;
	completedChunkIndex: number;
	completedAtMs: number;
	chunks: Map<number, RequestChunk>;
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
}

const pendingRequests = new Map<string, PendingRequest>();
const completedRequests = new Map<string, CompletedRequest>();
let pendingRequestBytes = 0;

export const REQUEST_CHUNK_PENDING_TTL_MS = 5 * 60 * 1000;
export const REQUEST_CHUNK_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const REQUEST_CHUNK_COMPLETED_TTL_MS = 60 * 1000;

interface ReceiveRequestChunkOptions {
	nowMs?: number;
	pendingTtlMs?: number;
	maxPendingBytes?: number;
	completedTtlMs?: number;
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

function cleanupExpiredRequests(nowMs: number, pendingTtlMs: number, completedTtlMs: number): void {
	for (const [requestId, pending] of pendingRequests) {
		if (nowMs - pending.updatedAtMs > pendingTtlMs) {
			deletePendingRequest(requestId, pending);
		}
	}
	for (const [requestId, completed] of completedRequests) {
		if (nowMs - completed.completedAtMs > completedTtlMs) {
			completedRequests.delete(requestId);
		}
	}
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
	cleanupExpiredRequests(
		nowMs,
		options.pendingTtlMs ?? REQUEST_CHUNK_PENDING_TTL_MS,
		options.completedTtlMs ?? REQUEST_CHUNK_COMPLETED_TTL_MS,
	);

	const completed = completedRequests.get(body.requestId);
	if (completed) {
		if (completed.target !== body.target || completed.totalChunks !== body.totalChunks) {
			throw new Error("Chunk metadata does not match the completed request");
		}
		const existing = completed.chunks.get(body.chunkIndex);
		if (!existing || existing.chunk !== body.chunk || existing.sha256 !== body.sha256) {
			throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
		}
		if (body.chunkIndex === completed.completedChunkIndex) {
			return {
				complete: true,
				target: completed.target,
				bodyJson: completed.bodyJson,
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
			pending.updatedAtMs = nowMs;
			return makeAck(body);
		}
	}

	const chunkBytes = Buffer.byteLength(body.chunk, "utf-8");
	cleanupForPendingBytes(chunkBytes, options.maxPendingBytes ?? REQUEST_CHUNK_MAX_PENDING_BYTES, body.requestId);
	if (!pending) {
		pending = {
			target: body.target,
			totalChunks: body.totalChunks,
			chunks: new Map(),
			receivedBytes: 0,
			updatedAtMs: nowMs,
		};
		pendingRequests.set(body.requestId, pending);
	}
	pending.chunks.set(body.chunkIndex, { chunk: body.chunk, sha256: body.sha256 });
	pending.receivedBytes += chunkBytes;
	pending.updatedAtMs = nowMs;
	pendingRequestBytes += chunkBytes;

	if (pending.chunks.size !== pending.totalChunks) {
		return makeAck(body);
	}

	const encodedChunks: string[] = [];
	for (let index = 0; index < pending.totalChunks; index++) {
		const chunk = pending.chunks.get(index);
		if (chunk === undefined) throw new Error(`Missing chunk index: ${index}`);
		encodedChunks.push(chunk.chunk);
	}

	deletePendingRequest(body.requestId, pending);
	const bodyJson = Buffer.from(encodedChunks.join(""), "base64").toString("utf-8");
	completedRequests.set(body.requestId, {
		target: pending.target,
		totalChunks: pending.totalChunks,
		bodyJson,
		completedChunkIndex: body.chunkIndex,
		completedAtMs: nowMs,
		chunks: pending.chunks,
	});
	return {
		complete: true,
		target: pending.target,
		bodyJson,
	};
}

export function clearAllRequestChunks(): void {
	pendingRequests.clear();
	completedRequests.clear();
	pendingRequestBytes = 0;
}
