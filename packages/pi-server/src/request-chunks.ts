import { Buffer } from "node:buffer";

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
	index: number;
	total: number;
	chunk: string;
}

interface PendingRequest {
	target: string;
	total: number;
	chunks: Map<number, string>;
}

interface ChunkAck {
	received: true;
	requestId: string;
	index: number;
	total: number;
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

function assertValidChunk(body: RequestChunkBody): void {
	if (!body.requestId) throw new Error("requestId is required");
	if (!ALLOWED_TARGETS.has(body.target)) throw new Error(`Unsupported chunk target: ${body.target}`);
	if (!Number.isInteger(body.total) || body.total <= 0) throw new Error("total must be a positive integer");
	if (!Number.isInteger(body.index) || body.index < 0 || body.index >= body.total) {
		throw new Error("index must be an integer within the chunk range");
	}
	if (typeof body.chunk !== "string") throw new Error("chunk must be a string");
}

export function receiveRequestChunk(body: RequestChunkBody): PendingChunkResult | CompleteChunkResult {
	assertValidChunk(body);

	let pending = pendingRequests.get(body.requestId);
	if (!pending) {
		pending = { target: body.target, total: body.total, chunks: new Map() };
		pendingRequests.set(body.requestId, pending);
	}

	if (pending.target !== body.target || pending.total !== body.total) {
		throw new Error("Chunk metadata does not match the pending request");
	}
	if (pending.chunks.has(body.index)) {
		throw new Error(`Duplicate chunk index: ${body.index}`);
	}

	pending.chunks.set(body.index, body.chunk);

	if (pending.chunks.size !== pending.total) {
		return {
			complete: false,
			ack: {
				received: true,
				requestId: body.requestId,
				index: body.index,
				total: body.total,
			},
		};
	}

	const encodedChunks: string[] = [];
	for (let index = 0; index < pending.total; index++) {
		const chunk = pending.chunks.get(index);
		if (chunk === undefined) throw new Error(`Missing chunk index: ${index}`);
		encodedChunks.push(chunk);
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
