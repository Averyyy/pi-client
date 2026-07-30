import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_REQUEST_KB = 512;
const CHUNK_ENDPOINT = "/api/request/chunk";
const CHUNK_UPLOAD_CONCURRENCY = 4;
const CHUNK_MAX_TOTAL_CHUNKS = 4096;
const CHUNK_UPLOAD_RETRY_DELAYS_MS = [100, 250, 500] as const;
const LEGACY_CHUNK_ACK_MAX_BYTES = 4096;
const DEFAULT_CHUNK_REQUEST_MEMO_LIMIT = 128;
const DEFAULT_RESPONSE_NO_PROGRESS_TIMEOUT_MS = 90_000;
export const PI_SERVER_CHUNK_ACK_HEADER = "X-Pi-Chunk-Ack";
export const PI_SERVER_CHUNK_ACK_VALUE = "1";
export const PI_SERVER_CHUNK_FINAL_VALUE = "0";
export const PI_SERVER_CHUNK_SEGMENT_ENCODING = "base64-segment-v1";
export const PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;

export interface PiServerRequestOptions {
	serverUrl: string;
	authToken: string;
	signal?: AbortSignal;
	responseHeaderTimeoutMs?: number;
	maxChunkRequestMemos?: number;
}

interface ChunkBody {
	requestId: string;
	target: string;
	chunkIndex: number;
	totalChunks: number;
	sha256: string;
	chunk: string;
	encoding: typeof PI_SERVER_CHUNK_SEGMENT_ENCODING;
	rawTotalBytes: number;
	rawChunkBytes: number;
}

interface ChunkAckBody {
	received: unknown;
	requestId: unknown;
	chunkIndex: unknown;
	totalChunks: unknown;
}

interface ChunkRequestMemo {
	requestId: string;
	maxBytes: number;
}

interface ChunkResponseInspection {
	acknowledged: boolean;
	response?: Response;
}

interface BodyNoProgressState {
	readonly timeoutMs: number;
	deadlineMs: number;
}

export class PiServerTransportHeaderTimeoutError extends Error {
	readonly code = "PI_SERVER_TRANSPORT_HEADER_TIMEOUT";
	readonly timeoutMs: number;

	constructor(method: string, endpoint: string, timeoutMs: number) {
		super(`pi-server transport header timeout after ${timeoutMs} ms (ETIMEDOUT): ${method} ${endpoint}`);
		this.name = "PiServerTransportHeaderTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

class PiServerTransportBodyNoProgressError extends Error {
	constructor(timeoutMs: number) {
		super(`pi-server response made no progress for ${timeoutMs}ms`);
		this.name = "PiServerTransportBodyNoProgressError";
	}
}

export class PiServerChunkRequestMemoLimitError extends Error {
	readonly code = "PI_SERVER_CHUNK_REQUEST_MEMO_LIMIT";
	readonly limit: number;

	constructor(limit: number) {
		super(
			`pi-server chunk request identity limit (${limit}) reached; refusing to allocate a new requestId while prior requests remain uncertain`,
		);
		this.name = "PiServerChunkRequestMemoLimitError";
		this.limit = limit;
	}
}

export class PiServerChunkAckProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiServerChunkAckProtocolError";
	}
}

export class PiServerTransportBodyLimitError extends Error {
	readonly code = "PI_SERVER_TRANSPORT_BODY_LIMIT";
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`pi-server response body exceeded ${maxBytes} bytes`);
		this.name = "PiServerTransportBodyLimitError";
		this.maxBytes = maxBytes;
	}
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

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function isTransientChunkResponse(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForChunkRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChunkAckBody(value: unknown): value is ChunkAckBody {
	return (
		isRecord(value) && "received" in value && "requestId" in value && "chunkIndex" in value && "totalChunks" in value
	);
}

function getResponseNoProgressTimeoutMs(): number {
	const raw = process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS;
	const value = raw === undefined ? DEFAULT_RESPONSE_NO_PROGRESS_TIMEOUT_MS : Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS must be positive finite milliseconds");
	}
	return value;
}

function createBodyNoProgressState(): BodyNoProgressState {
	const timeoutMs = getResponseNoProgressTimeoutMs();
	return { timeoutMs, deadlineMs: Date.now() + timeoutMs };
}

async function readPiServerBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: BodyNoProgressState,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	while (true) {
		const remainingMs = state.deadlineMs - Date.now();
		if (remainingMs <= 0) {
			throw new PiServerTransportBodyNoProgressError(state.timeoutMs);
		}
		const result = await new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>(
			(resolve, reject) => {
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new PiServerTransportBodyNoProgressError(state.timeoutMs));
				}, remainingMs);
				timeout.unref();
				void reader.read().then(
					(value) => {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						resolve(value);
					},
					(error: unknown) => {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						reject(error);
					},
				);
			},
		);
		if (result.done || result.value.byteLength > 0) {
			if (!result.done) state.deadlineMs = Date.now() + state.timeoutMs;
			return result;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	}
}

export async function readPiServerResponseText(
	response: Response,
	maxBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
	if (
		(maxBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) ||
		maxBytes === Number.NEGATIVE_INFINITY
	) {
		throw new Error("pi-server response body limit must be positive safe-integer bytes or Infinity");
	}
	if (!response.body) throw new Error("pi-server response body was missing");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const noProgress = createBodyNoProgressState();
	let body = "";
	let bodyBytes = 0;
	try {
		while (true) {
			const result = await readPiServerBodyChunk(reader, noProgress);
			if (result.done) {
				body += decoder.decode();
				return body;
			}
			bodyBytes += result.value.byteLength;
			if (bodyBytes > maxBytes) {
				throw new PiServerTransportBodyLimitError(maxBytes);
			}
			body += decoder.decode(result.value, { stream: true });
		}
	} catch (error) {
		void reader.cancel().catch(() => undefined);
		throw error;
	}
}

export async function readPiServerResponseJson(
	response: Response,
	maxBytes = Number.POSITIVE_INFINITY,
): Promise<unknown> {
	return JSON.parse(await readPiServerResponseText(response, maxBytes)) as unknown;
}

function rebuildResponse(response: Response, body: ConstructorParameters<typeof Response>[0]): Response {
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function discardResponse(response: Response | undefined): Promise<void> {
	if (!response?.body || response.bodyUsed || response.body.locked) return;
	try {
		await response.body.cancel();
	} catch {
		// The response is already unusable and must not replace the selected final response.
	}
}

async function inspectLegacyChunkAck(
	response: Response,
	requestId: string,
	chunkIndex: number,
	totalChunks: number,
): Promise<ChunkResponseInspection> {
	const contentLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > LEGACY_CHUNK_ACK_MAX_BYTES) {
		return { acknowledged: false, response };
	}
	if (!response.body) return { acknowledged: false, response };
	const reader = response.body.getReader();
	const noProgress = createBodyNoProgressState();
	const chunks: Uint8Array[] = [];
	let bodyBytes = 0;
	try {
		while (true) {
			const result = await readPiServerBodyChunk(reader, noProgress);
			if (result.done) break;
			chunks.push(result.value);
			bodyBytes += result.value.byteLength;
			if (bodyBytes > LEGACY_CHUNK_ACK_MAX_BYTES) {
				let prefixIndex = 0;
				const rebuiltBody = new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (prefixIndex < chunks.length) {
							const prefix = chunks[prefixIndex];
							chunks[prefixIndex] = new Uint8Array();
							prefixIndex++;
							controller.enqueue(prefix);
							return;
						}
						try {
							const next = await readPiServerBodyChunk(reader, noProgress);
							if (next.done) {
								controller.close();
							} else {
								controller.enqueue(next.value);
							}
						} catch (error) {
							controller.error(error);
							void reader.cancel(error).catch(() => undefined);
						}
					},
					cancel(reason) {
						return reader.cancel(reason);
					},
				});
				return { acknowledged: false, response: rebuildResponse(response, rebuiltBody) };
			}
		}
	} catch (error) {
		void reader.cancel().catch(() => undefined);
		throw error;
	}

	const encoded = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		bodyBytes,
	);
	const rebuilt = rebuildResponse(response, encoded);
	try {
		const body = JSON.parse(encoded.toString("utf-8")) as unknown;
		const acknowledged =
			isChunkAckBody(body) &&
			body.received === true &&
			body.requestId === requestId &&
			body.chunkIndex === chunkIndex &&
			body.totalChunks === totalChunks;
		return acknowledged ? { acknowledged: true } : { acknowledged: false, response: rebuilt };
	} catch {
		return { acknowledged: false, response: rebuilt };
	}
}

async function inspectChunkResponse(
	response: Response,
	requestId: string,
	chunkIndex: number,
	totalChunks: number,
): Promise<ChunkResponseInspection> {
	const marker = response.headers.get(PI_SERVER_CHUNK_ACK_HEADER);
	if (marker === PI_SERVER_CHUNK_FINAL_VALUE) {
		return { acknowledged: false, response };
	}
	if (marker === PI_SERVER_CHUNK_ACK_VALUE) {
		if (!response.headers.get("Content-Type")?.includes("application/json")) {
			await discardResponse(response);
			throw new PiServerChunkAckProtocolError("pi-server chunk acknowledgement must use application/json");
		}
		const text = await readPiServerResponseText(response, LEGACY_CHUNK_ACK_MAX_BYTES);
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			throw new PiServerChunkAckProtocolError("pi-server chunk acknowledgement was not valid JSON");
		}
		if (
			!isChunkAckBody(body) ||
			body.received !== true ||
			body.requestId !== requestId ||
			body.chunkIndex !== chunkIndex ||
			body.totalChunks !== totalChunks
		) {
			throw new PiServerChunkAckProtocolError("pi-server chunk acknowledgement did not match its request envelope");
		}
		return { acknowledged: true };
	}
	if (marker !== null) {
		await discardResponse(response);
		throw new PiServerChunkAckProtocolError(
			`pi-server returned unsupported ${PI_SERVER_CHUNK_ACK_HEADER} value: ${marker}`,
		);
	}
	if (!response.headers.get("Content-Type")?.includes("application/json")) {
		return { acknowledged: false, response };
	}
	return inspectLegacyChunkAck(response, requestId, chunkIndex, totalChunks);
}

function getRawChunkLayout(
	target: string,
	requestId: string,
	rawBodyBytes: number,
	maxBytes: number,
): { rawChunkBytes: number; totalChunks: number } {
	let totalChunks = 1;
	while (true) {
		const emptyEnvelopeBytes = jsonByteLength({
			requestId,
			target,
			chunkIndex: totalChunks - 1,
			totalChunks,
			sha256: "0".repeat(64),
			chunk: "",
			encoding: PI_SERVER_CHUNK_SEGMENT_ENCODING,
			rawTotalBytes: rawBodyBytes,
			// Using the total body size here is conservative because every
			// derived chunk size is no larger and therefore has no more digits.
			rawChunkBytes: rawBodyBytes,
		} satisfies ChunkBody);
		const encodedChunkBytes = Math.floor((maxBytes - emptyEnvelopeBytes) / 4) * 4;
		const rawChunkBytes = Math.floor(encodedChunkBytes / 4) * 3;
		if (rawChunkBytes <= 0) {
			throw new Error("PI_CLIENT_MAX_REQUEST_KB is too small for pi-server chunk envelopes");
		}
		const nextTotalChunks = Math.ceil(rawBodyBytes / rawChunkBytes);
		if (nextTotalChunks > CHUNK_MAX_TOTAL_CHUNKS) {
			throw new Error(`pi-server chunk request exceeds the ${CHUNK_MAX_TOTAL_CHUNKS}-chunk protocol limit`);
		}
		if (nextTotalChunks === totalChunks) {
			return { rawChunkBytes, totalChunks };
		}
		if (nextTotalChunks < totalChunks) {
			throw new Error("pi-server chunk layout did not converge monotonically");
		}
		totalChunks = nextTotalChunks;
	}
}

export class ChunkRequest {
	options: PiServerRequestOptions;
	readonly #chunkRequestMemos = new Map<string, ChunkRequestMemo>();
	readonly #maxChunkRequestMemos: number;

	constructor(options: PiServerRequestOptions) {
		const maxChunkRequestMemos = options.maxChunkRequestMemos ?? DEFAULT_CHUNK_REQUEST_MEMO_LIMIT;
		if (!Number.isSafeInteger(maxChunkRequestMemos) || maxChunkRequestMemos <= 0) {
			throw new Error("maxChunkRequestMemos must be a positive safe integer");
		}
		this.options = options;
		this.#maxChunkRequestMemos = maxChunkRequestMemos;
	}

	async getJson(endpoint: string): Promise<Response> {
		return this.#fetchWithResponseHeaderTimeout(endpoint, {
			method: "GET",
			headers: makeHeaders(this.options.authToken),
		});
	}

	async deleteJson(endpoint: string): Promise<Response> {
		return this.#fetchWithResponseHeaderTimeout(endpoint, {
			method: "DELETE",
			headers: makeHeaders(this.options.authToken),
		});
	}

	async postJson(endpoint: string, body: unknown): Promise<Response> {
		const rawBody = Buffer.from(JSON.stringify(body), "utf-8");
		const memoKey = `${endpoint}\0${sha256(rawBody)}`;
		let memo = this.#chunkRequestMemos.get(memoKey);
		const maxBytes = memo?.maxBytes ?? getMaxRequestBytes();
		if (memo === undefined && rawBody.byteLength <= maxBytes) {
			return this.#postRawJson(endpoint, rawBody.toString("utf-8"));
		}

		if (memo === undefined) {
			if (this.#chunkRequestMemos.size >= this.#maxChunkRequestMemos) {
				throw new PiServerChunkRequestMemoLimitError(this.#maxChunkRequestMemos);
			}
			memo = { requestId: randomUUID(), maxBytes };
			this.#chunkRequestMemos.set(memoKey, memo);
		}

		const { requestId } = memo;
		let layout: { rawChunkBytes: number; totalChunks: number };
		try {
			layout = getRawChunkLayout(endpoint, requestId, rawBody.byteLength, memo.maxBytes);
		} catch (error) {
			if (this.#chunkRequestMemos.get(memoKey) === memo) {
				this.#chunkRequestMemos.delete(memoKey);
			}
			throw error;
		}
		let nextIndex = 0;
		let finalResponse: Response | undefined;
		let transientFailureResponse: Response | undefined;
		let fatalError: unknown;

		const stopped = () => finalResponse !== undefined || fatalError !== undefined;
		const replaceTransientFailureResponse = async (response: Response): Promise<void> => {
			const previous = transientFailureResponse;
			transientFailureResponse = response;
			if (previous !== response) await discardResponse(previous);
		};

		const uploadChunk = async (index: number): Promise<void> => {
			const start = index * layout.rawChunkBytes;
			const chunk = rawBody
				.subarray(start, Math.min(start + layout.rawChunkBytes, rawBody.byteLength))
				.toString("base64");
			let lastError: unknown;
			let lastTransientResponse: Response | undefined;

			try {
				for (let attempt = 0; attempt <= CHUNK_UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
					if (stopped()) return;
					if (attempt > 0) {
						await waitForChunkRetry(CHUNK_UPLOAD_RETRY_DELAYS_MS[attempt - 1], this.options.signal);
						if (stopped()) return;
					}

					const chunkBody: ChunkBody = {
						requestId,
						target: endpoint,
						chunkIndex: index,
						totalChunks: layout.totalChunks,
						sha256: sha256(chunk),
						chunk,
						encoding: PI_SERVER_CHUNK_SEGMENT_ENCODING,
						rawTotalBytes: rawBody.byteLength,
						rawChunkBytes: layout.rawChunkBytes,
					};

					try {
						let response = await this.#postRawJson(CHUNK_ENDPOINT, JSON.stringify(chunkBody));
						if (stopped()) {
							await discardResponse(response);
							return;
						}
						if (response.ok) {
							const inspection = await inspectChunkResponse(response, requestId, index, layout.totalChunks);
							if (inspection.acknowledged) return;
							if (!inspection.response) {
								throw new PiServerChunkAckProtocolError(
									"pi-server chunk response inspection lost its response",
								);
							}
							response = inspection.response;
							if (stopped()) {
								await discardResponse(response);
								return;
							}
						}
						if (isTransientChunkResponse(response.status)) {
							await discardResponse(lastTransientResponse);
							lastTransientResponse = response;
							lastError = new Error(
								`pi-server chunk ${index + 1}/${layout.totalChunks} returned HTTP ${response.status}`,
							);
							continue;
						}
						if (finalResponse === undefined && fatalError === undefined) {
							finalResponse = response;
						} else {
							await discardResponse(response);
						}
						return;
					} catch (error) {
						if (this.options.signal?.aborted) {
							throw this.options.signal.reason ?? error;
						}
						if (
							error instanceof PiServerChunkAckProtocolError ||
							error instanceof PiServerTransportBodyLimitError
						) {
							fatalError = error;
							throw error;
						}
						lastError = error;
					}
				}

				if (lastTransientResponse !== undefined) {
					await replaceTransientFailureResponse(lastTransientResponse);
					lastTransientResponse = undefined;
				}
				if (lastError instanceof Error) {
					throw lastError;
				}
				throw new Error(`pi-server chunk ${index + 1}/${layout.totalChunks} failed after bounded retries`);
			} finally {
				if (stopped()) await discardResponse(lastTransientResponse);
			}
		};

		const uploadWorker = async (): Promise<void> => {
			while (!stopped()) {
				const index = nextIndex;
				if (index >= layout.totalChunks) return;
				nextIndex++;
				await uploadChunk(index);
			}
		};

		const results = await Promise.allSettled(
			Array.from({ length: Math.min(CHUNK_UPLOAD_CONCURRENCY, layout.totalChunks) }, () => uploadWorker()),
		);

		if (fatalError !== undefined) {
			await discardResponse(finalResponse);
			await discardResponse(transientFailureResponse);
			throw fatalError;
		}
		if (this.options.signal?.aborted) {
			await discardResponse(finalResponse);
			await discardResponse(transientFailureResponse);
			throw this.options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		}
		if (finalResponse !== undefined) {
			await discardResponse(transientFailureResponse);
			if (this.#chunkRequestMemos.get(memoKey) === memo) {
				this.#chunkRequestMemos.delete(memoKey);
			}
			return finalResponse;
		}
		if (transientFailureResponse !== undefined) {
			return transientFailureResponse;
		}
		for (const result of results) {
			if (result.status === "rejected") {
				throw result.reason;
			}
		}

		throw new Error("No final chunk response received from pi-server");
	}

	async #postRawJson(endpoint: string, rawJson: string): Promise<Response> {
		return this.#fetchWithResponseHeaderTimeout(endpoint, {
			method: "POST",
			headers: makeHeaders(this.options.authToken),
			body: rawJson,
		});
	}

	async #fetchWithResponseHeaderTimeout(endpoint: string, init: RequestInit): Promise<Response> {
		const timeoutMs = this.options.responseHeaderTimeoutMs ?? PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("responseHeaderTimeoutMs must be a positive finite number");
		}

		const method = init.method ?? "GET";
		const timeoutError = new PiServerTransportHeaderTimeoutError(method, endpoint, timeoutMs);
		const timeoutController = new AbortController();
		const signal = this.options.signal
			? AbortSignal.any([this.options.signal, timeoutController.signal])
			: timeoutController.signal;
		const timeout = setTimeout(() => {
			timeoutController.abort(timeoutError);
		}, timeoutMs);
		timeout.unref();

		try {
			return await fetch(`${this.options.serverUrl}${endpoint}`, {
				...init,
				signal,
			});
		} catch (error) {
			if (timeoutController.signal.aborted && !this.options.signal?.aborted) {
				throw timeoutError;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}
