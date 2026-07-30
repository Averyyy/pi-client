import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ChunkRequest,
	PI_SERVER_CHUNK_ACK_HEADER,
	PI_SERVER_CHUNK_ACK_VALUE,
	PI_SERVER_CHUNK_FINAL_VALUE,
	PI_SERVER_CHUNK_SEGMENT_ENCODING,
	PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS,
	PiServerChunkRequestMemoLimitError,
	PiServerTransportHeaderTimeoutError,
	readPiServerResponseText,
} from "../src/core/pi-server-request.ts";

interface CapturedRequestBody {
	requestId?: string;
	target?: string;
	chunkIndex?: number;
	totalChunks?: number;
	sha256?: string;
	chunk?: string;
	encoding?: string;
	rawTotalBytes?: number;
	rawChunkBytes?: number;
}

function getNumberProperty(body: CapturedRequestBody, key: "chunkIndex" | "totalChunks"): number {
	const value = body[key];
	if (typeof value !== "number") {
		throw new Error(`Expected numeric ${key}`);
	}
	return value;
}

describe("ChunkRequest", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
		delete process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS;
	});

	it("routes oversized posts through chunk envelopes under the configured request size", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const maxBytes = 2 * 1024;
		const capturedRequests: {
			url: string;
			bodyBytes: number;
			body: CapturedRequestBody;
		}[] = [];

		const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = rawBody ? (JSON.parse(rawBody) as CapturedRequestBody) : {};
			capturedRequests.push({ url, bodyBytes: Buffer.byteLength(rawBody, "utf-8"), body });

			if (url.endsWith("/api/request/chunk")) {
				const chunkIndex = getNumberProperty(body, "chunkIndex");
				const totalChunks = getNumberProperty(body, "totalChunks");
				if (chunkIndex !== totalChunks - 1) {
					return new Response(
						JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("unexpected direct request", { status: 500 });
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const requestBody = {
			sessionId: "chunk-class-test",
			entries: [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "x".repeat(1024 * 1024), timestamp: 1000 },
				},
			],
			leafId: "u1",
		};
		const response = await request.postJson("/api/session/tree/sync", requestBody);

		expect(response.ok).toBe(true);
		expect(capturedRequests.every((request) => request.bodyBytes <= maxBytes)).toBe(true);
		expect(capturedRequests.every((request) => request.url.endsWith("/api/request/chunk"))).toBe(true);
		expect(capturedRequests.some((request) => request.body.target === "/api/session/tree/sync")).toBe(true);
		expect(capturedRequests.every((request) => /^[a-f0-9]{64}$/.test(request.body.sha256 ?? ""))).toBe(true);
		expect(capturedRequests.every((request) => request.body.encoding === PI_SERVER_CHUNK_SEGMENT_ENCODING)).toBe(
			true,
		);
		expect(
			capturedRequests.every(
				(request) => request.body.rawTotalBytes === Buffer.byteLength(JSON.stringify(requestBody)),
			),
		).toBe(true);
		const advertisedRawChunkBytes = capturedRequests[0]?.body.rawChunkBytes;
		expect(typeof advertisedRawChunkBytes).toBe("number");
		expect(capturedRequests.every((request) => request.body.rawChunkBytes === advertisedRawChunkBytes)).toBe(true);

		const orderedSegments = [...capturedRequests]
			.sort(
				(left, right) => getNumberProperty(left.body, "chunkIndex") - getNumberProperty(right.body, "chunkIndex"),
			)
			.map(({ body }) => {
				if (typeof body.chunk !== "string") throw new Error("Expected chunk string");
				expect(Buffer.from(body.chunk, "base64").toString("base64")).toBe(body.chunk);
				return Buffer.from(body.chunk, "base64");
			});
		const expectedRawBody = Buffer.from(JSON.stringify(requestBody), "utf-8");
		expect(
			orderedSegments.every(
				(segment, index) =>
					segment.byteLength ===
					Math.min(
						advertisedRawChunkBytes ?? 0,
						expectedRawBody.byteLength - index * (advertisedRawChunkBytes ?? 0),
					),
			),
		).toBe(true);
		expect(Buffer.concat(orderedSegments)).toEqual(expectedRawBody);
		expect(Math.max(...orderedSegments.map((segment) => segment.byteLength))).toBeLessThan(
			expectedRawBody.byteLength,
		);
	});

	it("independently pads and decodes the final raw segment", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "1";
		const capturedRequests: CapturedRequestBody[] = [];
		const requestBody = { content: "z".repeat(2048) };
		while (Buffer.byteLength(JSON.stringify(requestBody), "utf-8") % 3 === 0) {
			requestBody.content += "z";
		}

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			capturedRequests.push(body);
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (capturedRequests.length === totalChunks) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_FINAL_VALUE,
					},
				});
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_ACK_VALUE,
				},
			});
		});
		vi.stubGlobal("fetch", mockFetch);

		const response = await new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
		}).postJson("/api/session/tree/sync", requestBody);

		expect(response.ok).toBe(true);
		const orderedChunks = [...capturedRequests].sort(
			(left, right) => getNumberProperty(left, "chunkIndex") - getNumberProperty(right, "chunkIndex"),
		);
		expect(orderedChunks.slice(0, -1).every((body) => !body.chunk?.endsWith("="))).toBe(true);
		const lastChunk = orderedChunks.at(-1)?.chunk;
		expect(lastChunk).toMatch(/={1,2}$/);
		expect(
			Buffer.concat(
				orderedChunks.map((body) => {
					if (typeof body.chunk !== "string") throw new Error("Expected chunk string");
					return Buffer.from(body.chunk, "base64");
				}),
			).toString("utf-8"),
		).toBe(JSON.stringify(requestBody));
		expect(
			Buffer.from(
				orderedChunks
					.map((body) => {
						if (typeof body.chunk !== "string") throw new Error("Expected chunk string");
						return body.chunk;
					})
					.join(""),
				"base64",
			).toString("utf-8"),
		).toBe(JSON.stringify(requestBody));
	});

	it("keeps the caller abort signal active after chunk response headers", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const controller = new AbortController();
		const seenSignals: (AbortSignal | null | undefined)[] = [];

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			seenSignals.push(init?.signal);
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = rawBody ? (JSON.parse(rawBody) as CapturedRequestBody) : {};
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (chunkIndex !== totalChunks - 1) {
				return new Response(
					JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
			signal: controller.signal,
		});
		const response = await request.postJson("/api/stream", {
			sessionId: "chunk-timeout-test",
			content: "x".repeat(1024 * 1024),
		});

		expect(response.ok).toBe(true);
		expect(seenSignals.length).toBeGreaterThan(1);
		expect(seenSignals.every((signal) => signal !== controller.signal && signal?.aborted === false)).toBe(true);

		const abortReason = new DOMException("caller aborted", "AbortError");
		controller.abort(abortReason);
		expect(seenSignals.every((signal) => signal?.aborted === true && signal.reason === abortReason)).toBe(true);
	});

	it("times out a fetch that never returns response headers", async () => {
		vi.useFakeTimers();
		let seenSignal: AbortSignal | undefined;
		const mockFetch = vi.fn((_url: string, init?: RequestInit) => {
			seenSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				if (!seenSignal) {
					reject(new Error("Expected a request signal"));
					return;
				}
				seenSignal.addEventListener("abort", () => reject(seenSignal?.reason), { once: true });
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const responsePromise = request.getJson("/api/session/session-a/history");
		const rejection = expect(responsePromise).rejects.toMatchObject({
			name: "PiServerTransportHeaderTimeoutError",
			code: "PI_SERVER_TRANSPORT_HEADER_TIMEOUT",
			timeoutMs: PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS,
			message: `pi-server transport header timeout after ${PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS} ms (ETIMEDOUT): GET /api/session/session-a/history`,
		});

		await vi.advanceTimersByTimeAsync(PI_SERVER_RESPONSE_HEADER_TIMEOUT_MS - 1);
		expect(seenSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await rejection;
		expect(seenSignal?.reason).toBeInstanceOf(PiServerTransportHeaderTimeoutError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves caller abort errors while response headers are pending", async () => {
		vi.useFakeTimers();
		const callerController = new AbortController();
		const mockFetch = vi.fn((_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				if (!signal) {
					reject(new Error("Expected a request signal"));
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
			signal: callerController.signal,
			responseHeaderTimeoutMs: 100,
		});
		const responsePromise = request.getJson("/api/session/session-a/history");
		const abortReason = new DOMException("caller aborted", "AbortError");
		callerController.abort(abortReason);

		await expect(responsePromise).rejects.toBe(abortReason);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the header timer without consuming response body time", async () => {
		vi.useFakeTimers();
		const callerController = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			seenSignal = init?.signal ?? undefined;
			if (!seenSignal) throw new Error("Expected a request signal");

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						seenSignal?.addEventListener("abort", () => controller.error(seenSignal?.reason), { once: true });
					},
				}),
			);
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
			signal: callerController.signal,
			responseHeaderTimeoutMs: 100,
		});
		const response = await request.getJson("/api/stream");
		const bodyPromise = response.text();

		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(seenSignal?.aborted).toBe(false);

		callerController.abort(new DOMException("caller aborted", "AbortError"));
		await expect(bodyPromise).rejects.toMatchObject({ name: "AbortError" });
	});

	it("starts a fresh response header timeout for every uploaded chunk", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunks = new Set<number>();
		const seenSignals = new Set<AbortSignal>();

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.signal) seenSignals.add(init.signal);
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = JSON.parse(rawBody) as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 90);
			});
			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
			responseHeaderTimeoutMs: 100,
		});
		const responsePromise = request.postJson("/api/session/tree/sync", {
			sessionId: "chunk-independent-header-timeouts",
			content: "x".repeat(20 * 1024),
		});

		await vi.runAllTimersAsync();
		const response = await responsePromise;

		expect(response.ok).toBe(true);
		expect(mockFetch.mock.calls.length).toBeGreaterThan(4);
		expect(seenSignals.size).toBe(mockFetch.mock.calls.length);
		expect(Date.now()).toBeGreaterThan(100);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a chunk acknowledgement body that stops making progress", async () => {
		vi.useFakeTimers();
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS = "10";

		const mockFetch = vi.fn(async () => {
			return new Response(
				new ReadableStream<Uint8Array>({
					start() {
						// Headers arrive, but the acknowledgement body remains half-open.
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const post = request.postJson("/api/session/tree/sync", {
			sessionId: "chunk-stalled-ack",
			content: "x".repeat(20 * 1024),
		});
		const rejection = expect(post).rejects.toThrow("pi-server response made no progress for 10ms");

		await vi.runAllTimersAsync();
		await rejection;
		expect(mockFetch).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not treat an endless empty-byte microtask stream as response progress", async () => {
		vi.useFakeTimers();
		process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS = "10";
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array());
				},
			}),
		);

		const read = readPiServerResponseText(response);
		const rejection = expect(read).rejects.toThrow("pi-server response made no progress for 10ms");
		await vi.advanceTimersByTimeAsync(10);
		await rejection;
		expect(response.bodyUsed).toBe(true);
	});

	it("fails malformed explicit acknowledgement JSON without retrying that chunk", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const attemptsByChunk = new Map<number, number>();
		const responses: Response[] = [];
		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			attemptsByChunk.set(chunkIndex, (attemptsByChunk.get(chunkIndex) ?? 0) + 1);
			const response = new Response("{malformed", {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_ACK_VALUE,
				},
			});
			responses.push(response);
			return response;
		});
		vi.stubGlobal("fetch", mockFetch);

		await expect(
			new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" }).postJson(
				"/api/session/tree/sync",
				{ sessionId: "malformed-explicit-ack", content: "x".repeat(20 * 1024) },
			),
		).rejects.toMatchObject({ name: "PiServerChunkAckProtocolError" });
		expect([...attemptsByChunk.values()].every((attempts) => attempts === 1)).toBe(true);
		expect(responses.every((response) => response.bodyUsed)).toBe(true);
	});

	it("consumes every late ACK, transient failure, and losing final response", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		let releaseLateResponses: (() => void) | undefined;
		const lateResponseGate = new Promise<void>((resolve) => {
			releaseLateResponses = resolve;
		});
		const responses = new Map<number, Response>();
		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (chunkIndex !== 0) await lateResponseGate;
			const response =
				chunkIndex === 0
					? new Response(JSON.stringify({ ok: true, winner: true }), {
							status: 200,
							headers: {
								"Content-Type": "application/json",
								[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_FINAL_VALUE,
							},
						})
					: chunkIndex === 1
						? new Response(
								JSON.stringify({
									received: true,
									requestId: body.requestId,
									chunkIndex,
									totalChunks,
								}),
								{
									status: 200,
									headers: {
										"Content-Type": "application/json",
										[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_ACK_VALUE,
									},
								},
							)
						: chunkIndex === 2
							? new Response(JSON.stringify({ error: "late failure" }), {
									status: 503,
									headers: { "Content-Type": "application/json" },
								})
							: new Response(JSON.stringify({ ok: true, winner: false }), {
									status: 200,
									headers: {
										"Content-Type": "application/json",
										[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_FINAL_VALUE,
									},
								});
			responses.set(chunkIndex, response);
			return response;
		});
		vi.stubGlobal("fetch", mockFetch);

		const post = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" }).postJson(
			"/api/session/tree/sync",
			{ sessionId: "late-response-disposal", content: "x".repeat(20 * 1024) },
		);
		while (mockFetch.mock.calls.length < 4) await Promise.resolve();
		await Promise.resolve();
		releaseLateResponses?.();
		const response = await post;

		expect(response).toBe(responses.get(0));
		expect(response.bodyUsed).toBe(false);
		expect(responses.get(1)?.bodyUsed).toBe(true);
		expect(responses.get(2)?.bodyUsed).toBe(true);
		expect(responses.get(3)?.bodyUsed).toBe(true);
		expect(await response.json()).toEqual({ ok: true, winner: true });
	});

	it("consumes explicit acknowledgements once and returns an explicit final response unread", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunks = new Set<number>();
		const acknowledgementResponses: Response[] = [];
		const acknowledgementCloneSpies: Array<ReturnType<typeof vi.spyOn>> = [];
		let finalResponse: Response | undefined;
		let finalCloneSpy: ReturnType<typeof vi.spyOn> | undefined;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				finalResponse = new Response(JSON.stringify({ ok: true, source: "target" }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_FINAL_VALUE,
					},
				});
				finalCloneSpy = vi.spyOn(finalResponse, "clone");
				return finalResponse;
			}
			const acknowledgement = new Response(
				JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_ACK_VALUE,
					},
				},
			);
			acknowledgementResponses.push(acknowledgement);
			acknowledgementCloneSpies.push(vi.spyOn(acknowledgement, "clone"));
			return acknowledgement;
		});
		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const response = await request.postJson("/api/session/tree/sync", {
			sessionId: "explicit-chunk-protocol",
			content: "x".repeat(20 * 1024),
		});

		expect(response).toBe(finalResponse);
		expect(response.bodyUsed).toBe(false);
		expect(finalCloneSpy).not.toHaveBeenCalled();
		expect(acknowledgementResponses.length).toBeGreaterThan(0);
		expect(acknowledgementResponses.every((acknowledgement) => acknowledgement.bodyUsed)).toBe(true);
		expect(acknowledgementCloneSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
		expect(await response.json()).toEqual({ ok: true, source: "target" });
	});

	it("recognizes legacy acknowledgement bodies with one network read and rebuilds a small final response", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunks = new Set<number>();
		const legacyResponses: Response[] = [];
		const cloneSpies: Array<ReturnType<typeof vi.spyOn>> = [];
		let originalFinalResponse: Response | undefined;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			receivedChunks.add(chunkIndex);
			const response =
				receivedChunks.size === totalChunks
					? new Response(JSON.stringify({ ok: true, source: "legacy-target" }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						})
					: new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
			if (receivedChunks.size === totalChunks) originalFinalResponse = response;
			legacyResponses.push(response);
			cloneSpies.push(vi.spyOn(response, "clone"));
			return response;
		});
		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const response = await request.postJson("/api/session/tree/sync", {
			sessionId: "legacy-chunk-protocol",
			content: "x".repeat(20 * 1024),
		});

		expect(response).not.toBe(originalFinalResponse);
		expect(originalFinalResponse?.bodyUsed).toBe(true);
		expect(legacyResponses.every((legacyResponse) => legacyResponse.bodyUsed)).toBe(true);
		expect(cloneSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
		expect(await response.json()).toEqual({ ok: true, source: "legacy-target" });
	});

	it("uploads chunks with at most four concurrent requests", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		let activeRequests = 0;
		let maxActiveRequests = 0;
		const receivedChunks = new Set<number>();

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = JSON.parse(rawBody) as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			activeRequests++;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5);
			});
			activeRequests--;
			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const response = await request.postJson("/api/session/tree/sync", {
			sessionId: "chunk-parallel-test",
			content: "x".repeat(1024 * 1024),
		});

		expect(response.ok).toBe(true);
		expect(mockFetch.mock.calls.length).toBeGreaterThan(4);
		expect(maxActiveRequests).toBe(4);
	});

	it.each(["network error", "HTTP 500"] as const)(
		"returns a concurrent final response after one chunk has a %s",
		async (failureKind) => {
			process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
			const receivedChunks = new Set<number>();
			const requestIds = new Set<string>();
			let injectedFailure = false;
			let targetExecutions = 0;

			const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
				const rawBody = (init?.body as string | undefined) ?? "";
				const body = JSON.parse(rawBody) as CapturedRequestBody;
				const chunkIndex = getNumberProperty(body, "chunkIndex");
				const totalChunks = getNumberProperty(body, "totalChunks");
				if (typeof body.requestId !== "string") throw new Error("Expected requestId");
				requestIds.add(body.requestId);
				receivedChunks.add(chunkIndex);

				if (chunkIndex === 0 && !injectedFailure) {
					injectedFailure = true;
					if (failureKind === "network error") {
						throw new TypeError("socket closed after chunk receipt");
					}
					return new Response(JSON.stringify({ error: "temporary proxy failure" }), {
						status: 500,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (receivedChunks.size === totalChunks && targetExecutions === 0) {
					targetExecutions++;
					return new Response(JSON.stringify({ ok: true, source: "target" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			});

			vi.stubGlobal("fetch", mockFetch);

			const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
			const response = await request.postJson("/api/session/tree/sync", {
				sessionId: "chunk-concurrent-final",
				content: "x".repeat(20 * 1024),
			});

			expect(await response.json()).toEqual({ ok: true, source: "target" });
			expect(requestIds.size).toBe(1);
			expect(targetExecutions).toBe(1);
		},
	);

	it("retries a lost completing-chunk response with the same request id", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunks = new Set<number>();
		const requestIds = new Set<string>();
		let completedChunkIndex: number | undefined;
		let droppedCompletionResponse = false;
		let targetExecutions = 0;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = JSON.parse(rawBody) as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (typeof body.requestId !== "string") throw new Error("Expected requestId");
			requestIds.add(body.requestId);

			if (completedChunkIndex !== undefined) {
				if (chunkIndex === completedChunkIndex) {
					return new Response(JSON.stringify({ ok: true, replayed: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				completedChunkIndex = chunkIndex;
				targetExecutions++;
				if (!droppedCompletionResponse) {
					droppedCompletionResponse = true;
					throw new TypeError("socket closed after target execution");
				}
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const response = await request.postJson("/api/session/tree/sync", {
			sessionId: "chunk-lost-completion-response",
			content: "x".repeat(20 * 1024),
		});

		expect(await response.json()).toEqual({ ok: true, replayed: true });
		expect(requestIds.size).toBe(1);
		expect(targetExecutions).toBe(1);
	});

	it("reuses the memoized request id when a later post retries an uncertain completion", async () => {
		vi.useFakeTimers();
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunks = new Set<number>();
		const requestIds = new Set<string>();
		let completedChunkIndex: number | undefined;
		let dropCompletionResponses = true;
		let targetExecutions = 0;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = JSON.parse(rawBody) as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (typeof body.requestId !== "string") throw new Error("Expected requestId");
			requestIds.add(body.requestId);

			if (completedChunkIndex !== undefined) {
				if (chunkIndex === completedChunkIndex) {
					if (dropCompletionResponses) {
						throw new TypeError("completion response lost");
					}
					return new Response(JSON.stringify({ ok: true, replayed: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				completedChunkIndex = chunkIndex;
				targetExecutions++;
				throw new TypeError("completion response lost");
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const body = {
			sessionId: "chunk-outer-retry",
			content: "x".repeat(20 * 1024),
		};
		const firstPost = request.postJson("/api/session/tree/sync", body);
		const firstRejection = expect(firstPost).rejects.toThrow("completion response lost");
		await vi.runAllTimersAsync();
		await firstRejection;

		dropCompletionResponses = false;
		const response = await request.postJson("/api/session/tree/sync", body);

		expect(await response.json()).toEqual({ ok: true, replayed: true });
		expect(requestIds.size).toBe(1);
		expect(targetExecutions).toBe(1);
	});

	it("clears the memoized request id after a deterministic final response", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const receivedChunksByRequest = new Map<string, Set<number>>();
		let targetExecutions = 0;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const rawBody = (init?.body as string | undefined) ?? "";
			const body = JSON.parse(rawBody) as CapturedRequestBody;
			const chunkIndex = getNumberProperty(body, "chunkIndex");
			const totalChunks = getNumberProperty(body, "totalChunks");
			if (typeof body.requestId !== "string") throw new Error("Expected requestId");
			let receivedChunks = receivedChunksByRequest.get(body.requestId);
			if (receivedChunks === undefined) {
				receivedChunks = new Set();
				receivedChunksByRequest.set(body.requestId, receivedChunks);
			}
			receivedChunks.add(chunkIndex);
			if (receivedChunks.size === totalChunks) {
				targetExecutions++;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ received: true, requestId: body.requestId, chunkIndex, totalChunks }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "token" });
		const body = {
			sessionId: "chunk-new-operation-after-final",
			content: "x".repeat(20 * 1024),
		};
		expect((await request.postJson("/api/session/tree/sync", body)).ok).toBe(true);
		expect((await request.postJson("/api/session/tree/sync", body)).ok).toBe(true);

		expect(receivedChunksByRequest.size).toBe(2);
		expect(targetExecutions).toBe(2);
	});

	it("bounds uncertain chunk identities fail-closed while reusing the same body request id", async () => {
		vi.useFakeTimers();
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const requestIdsBySession = new Map<string, Set<string>>();
		let currentSession = "";
		let resolveSession: string | undefined;

		const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string | undefined) ?? "") as CapturedRequestBody;
			if (typeof body.requestId !== "string" || typeof body.chunk !== "string") {
				throw new Error("Expected chunk request identity");
			}
			let requestIds = requestIdsBySession.get(currentSession);
			if (!requestIds) {
				requestIds = new Set();
				requestIdsBySession.set(currentSession, requestIds);
			}
			requestIds.add(body.requestId);
			if (resolveSession === currentSession) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						[PI_SERVER_CHUNK_ACK_HEADER]: PI_SERVER_CHUNK_FINAL_VALUE,
					},
				});
			}
			throw new TypeError("completion status is uncertain");
		});
		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({
			serverUrl: "http://pi-server.test",
			authToken: "token",
			maxChunkRequestMemos: 2,
		});
		const bodies = ["one", "two", "three"].map((suffix) => ({
			sessionId: `memo-${suffix}`,
			content: `memo-${suffix}-${"x".repeat(20 * 1024)}`,
		}));
		for (const body of bodies.slice(0, 2)) {
			currentSession = body.sessionId;
			const post = request.postJson("/api/session/tree/sync", body);
			const rejection = expect(post).rejects.toThrow("completion status is uncertain");
			await vi.runAllTimersAsync();
			await rejection;
		}

		const callsBeforeLimit = mockFetch.mock.calls.length;
		currentSession = bodies[2].sessionId;
		await expect(request.postJson("/api/session/tree/sync", bodies[2])).rejects.toMatchObject({
			name: "PiServerChunkRequestMemoLimitError",
			code: "PI_SERVER_CHUNK_REQUEST_MEMO_LIMIT",
			limit: 2,
		});
		expect(mockFetch).toHaveBeenCalledTimes(callsBeforeLimit);
		expect(requestIdsBySession.get("memo-one")?.size).toBe(1);

		resolveSession = "memo-one";
		currentSession = bodies[0].sessionId;
		const resolved = await request.postJson("/api/session/tree/sync", bodies[0]);
		expect(resolved.ok).toBe(true);
		expect(requestIdsBySession.get("memo-one")?.size).toBe(1);

		resolveSession = "memo-three";
		currentSession = bodies[2].sessionId;
		await expect(request.postJson("/api/session/tree/sync", bodies[2])).resolves.toMatchObject({ ok: true });
		expect(requestIdsBySession.get("memo-three")?.size).toBe(1);
		expect(() => new PiServerChunkRequestMemoLimitError(2)).not.toThrow();
	});

	it("uses the same pi-server request object for bodyless gets", async () => {
		const capturedRequests: { url: string; method?: string; body?: RequestInit["body"] }[] = [];
		const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
			capturedRequests.push({ url, method: init?.method, body: init?.body });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", mockFetch);

		const request = new ChunkRequest({ serverUrl: "http://pi-server.test", authToken: "" });
		const response = await request.getJson("/api/session/session-a/history");

		expect(response.ok).toBe(true);
		expect(capturedRequests).toEqual([
			{
				url: "http://pi-server.test/api/session/session-a/history",
				method: "GET",
				body: undefined,
			},
		]);
	});
});
