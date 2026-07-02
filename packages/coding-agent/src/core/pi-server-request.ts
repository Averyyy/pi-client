import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_REQUEST_KB = 512;
const CHUNK_ENDPOINT = "/api/request/chunk";

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
		let response: Response | undefined;

		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			const chunkBody: ChunkBody = {
				requestId,
				target: endpoint,
				chunkIndex: index,
				totalChunks: chunks.length,
				sha256: sha256(chunk),
				chunk,
			};
			response = await this.#postRawJson(CHUNK_ENDPOINT, JSON.stringify(chunkBody));
			if (!response.ok || index === chunks.length - 1) {
				return response;
			}
		}

		throw new Error("No chunk response received from pi-server");
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
