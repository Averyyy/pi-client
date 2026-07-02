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

export function receiveRequestChunk(body: RequestChunkBody): PendingChunkResult | CompleteChunkResult {
	assertValidChunk(body);

	let pending = pendingRequests.get(body.requestId);
	if (!pending) {
		pending = { target: body.target, totalChunks: body.totalChunks, chunks: new Map() };
		pendingRequests.set(body.requestId, pending);
	}

	if (pending.target !== body.target || pending.totalChunks !== body.totalChunks) {
		throw new Error("Chunk metadata does not match the pending request");
	}
	const existing = pending.chunks.get(body.chunkIndex);
	if (existing) {
		if (existing.chunk !== body.chunk || existing.sha256 !== body.sha256) {
			throw new Error(`Duplicate chunk index does not match: ${body.chunkIndex}`);
		}
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

	pending.chunks.set(body.chunkIndex, { chunk: body.chunk, sha256: body.sha256 });

	if (pending.chunks.size !== pending.totalChunks) {
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

	const encodedChunks: string[] = [];
	for (let index = 0; index < pending.totalChunks; index++) {
		const chunk = pending.chunks.get(index);
		if (chunk === undefined) throw new Error(`Missing chunk index: ${index}`);
		encodedChunks.push(chunk.chunk);
	}

	pendingRequests.delete(body.requestId);
	return {
		complete: true,
		target: pending.target,
		bodyJson: Buffer.from(encodedChunks.join(""), "base64").toString("utf-8"),
	};
}

export function clearAllRequestChunks(): void {
	pendingRequests.clear();
}
