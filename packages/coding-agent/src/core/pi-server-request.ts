import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_REQUEST_KB = 512;
const CHUNK_ENDPOINT = "/api/request/chunk";
const CHUNK_UPLOAD_CONCURRENCY = 4;

export interface PiServerRequestOptions {
	serverUrl: string;
	authToken: string;
	signal?: AbortSignal;
}

interface ChunkBody {
	requestId: string;
	target: string;
	chunkIndex: number;
	totalChunks: number;
	sha256: string;
	chunk: string;
}

interface ChunkAckBody {
	received: unknown;
	requestId: unknown;
	chunkIndex: unknown;
	totalChunks: unknown;
}

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

export function getMaxRequestBytes(): number {
	const raw = process.env.PI_CLIENT_MAX_REQUEST_KB;
	if (raw === undefined || raw === "") return DEFAULT_MAX_REQUEST_KB * 1024;

	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("PI_CLIENT_MAX_REQUEST_KB must be a positive number");
	}
	return Math.floor(value * 1024);
}

function makeHeaders(authToken: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChunkAckBody(value: unknown): value is ChunkAckBody {
	return (
		isRecord(value) && "received" in value && "requestId" in value && "chunkIndex" in value && "totalChunks" in value
	);
}

async function isChunkAck(
	response: Response,
	requestId: string,
	chunkIndex: number,
	totalChunks: number,
): Promise<boolean> {
	if (!response.headers.get("Content-Type")?.includes("application/json")) return false;
	try {
		const body = (await response.clone().json()) as unknown;
		return (
			isChunkAckBody(body) &&
			body.received === true &&
			body.requestId === requestId &&
			body.chunkIndex === chunkIndex &&
			body.totalChunks === totalChunks
		);
	} catch {
		return false;
	}
}

function chunkBodyFits(
	target: string,
	requestId: string,
	encodedLength: number,
	chunkLength: number,
	maxBytes: number,
): boolean {
	const total = Math.ceil(encodedLength / chunkLength);
	const body: ChunkBody = {
		requestId,
		target,
		chunkIndex: Math.max(0, total - 1),
		totalChunks: total,
		sha256: "0".repeat(64),
		chunk: "x".repeat(Math.min(chunkLength, encodedLength)),
	};
	return jsonByteLength(body) <= maxBytes;
}

function splitEncodedBody(target: string, requestId: string, encoded: string, maxBytes: number): string[] {
	if (!chunkBodyFits(target, requestId, encoded.length, 1, maxBytes)) {
		throw new Error("PI_CLIENT_MAX_REQUEST_KB is too small for pi-server chunk envelopes");
	}

	let low = 1;
	let high = encoded.length;
	let best = 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (chunkBodyFits(target, requestId, encoded.length, mid, maxBytes)) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	const chunks: string[] = [];
	for (let offset = 0; offset < encoded.length; offset += best) {
		chunks.push(encoded.slice(offset, offset + best));
	}
	return chunks;
}

export class ChunkRequest {
	options: PiServerRequestOptions;

	constructor(options: PiServerRequestOptions) {
		this.options = options;
	}

	async getJson(endpoint: string): Promise<Response> {
		return fetch(`${this.options.serverUrl}${endpoint}`, {
			method: "GET",
			headers: makeHeaders(this.options.authToken),
			signal: this.options.signal,
		});
	}

	async postJson(endpoint: string, body: unknown): Promise<Response> {
		const rawJson = JSON.stringify(body);
		const maxBytes = getMaxRequestBytes();
		if (Buffer.byteLength(rawJson, "utf-8") <= maxBytes) {
			return this.#postRawJson(endpoint, rawJson);
		}

		const requestId = randomUUID();
		const encoded = Buffer.from(rawJson, "utf-8").toString("base64");
		const chunks = splitEncodedBody(endpoint, requestId, encoded, maxBytes);
		let nextIndex = 0;
		let finalResponse: Response | undefined;
		let failureResponse: Response | undefined;

		const uploadWorker = async (): Promise<void> => {
			while (nextIndex < chunks.length && finalResponse === undefined && failureResponse === undefined) {
				const index = nextIndex;
				nextIndex++;
				const chunk = chunks[index];
				const chunkBody: ChunkBody = {
					requestId,
					target: endpoint,
					chunkIndex: index,
					totalChunks: chunks.length,
					sha256: sha256(chunk),
					chunk,
				};
				const response = await this.#postRawJson(CHUNK_ENDPOINT, JSON.stringify(chunkBody));
				if (finalResponse !== undefined || failureResponse !== undefined) return;
				if (!response.ok) {
					failureResponse = response;
					return;
				}
				if (!(await isChunkAck(response, requestId, index, chunks.length))) {
					finalResponse = response;
					return;
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(CHUNK_UPLOAD_CONCURRENCY, chunks.length) }, () => uploadWorker()),
		);

		if (failureResponse) return failureResponse;
		if (finalResponse) return finalResponse;

		throw new Error("No final chunk response received from pi-server");
	}

	async #postRawJson(endpoint: string, rawJson: string): Promise<Response> {
		return fetch(`${this.options.serverUrl}${endpoint}`, {
			method: "POST",
			headers: makeHeaders(this.options.authToken),
			body: rawJson,
			signal: this.options.signal,
		});
	}
}
