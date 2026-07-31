import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkRequest } from "../src/core/pi-server-request.ts";

interface CapturedRequestBody {
	requestId?: string;
	target?: string;
	chunkIndex?: number;
	totalChunks?: number;
	sha256?: string;
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
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
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
		const response = await request.postJson("/api/session/tree/sync", {
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
		});

		expect(response.ok).toBe(true);
		expect(capturedRequests.every((request) => request.bodyBytes <= maxBytes)).toBe(true);
		expect(capturedRequests.every((request) => request.url.endsWith("/api/request/chunk"))).toBe(true);
		expect(capturedRequests.some((request) => request.body.target === "/api/session/tree/sync")).toBe(true);
		expect(capturedRequests.every((request) => typeof request.body.sha256 === "string")).toBe(true);
	});

	it("does not add provider timeout signals to chunk uploads", async () => {
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
		expect(seenSignals.every((signal) => signal === controller.signal)).toBe(true);
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
