import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function eventStreamResponse(events: unknown[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

describe("streamProxy", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("returns an error result when the response ends without a terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => eventStreamResponse([{ type: "start" }])),
		);

		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.invalid" });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy stream ended before a terminal response event");
	});

	it("accepts a terminal event in the final SSE line without a trailing newline", async () => {
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}`),
							);
							controller.close();
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.invalid" });
		expect((await stream.result()).stopReason).toBe("stop");
	});

	it("fails a response body that makes no progress", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel,
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 50,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(51);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy response made no progress for 50ms");
		expect(cancel).toHaveBeenCalled();
	});

	it("does not treat recurring zero-byte chunks as response progress", async () => {
		vi.useFakeTimers();
		let interval: ReturnType<typeof setInterval> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							interval = setInterval(() => controller.enqueue(new Uint8Array()), 10);
						},
						cancel() {
							if (interval) clearInterval(interval);
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 50,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(51);

		expect((await resultPromise).errorMessage).toBe("Proxy response made no progress for 50ms");
	});

	it("resets the no-progress timeout after every non-empty chunk", async () => {
		vi.useFakeTimers();
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							setTimeout(
								() => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n`)),
								40,
							);
							setTimeout(() => {
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}`),
								);
								controller.close();
							}, 80);
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 50,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(81);

		expect((await resultPromise).stopReason).toBe("stop");
	});

	it("times out while waiting for proxy response headers", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 50,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(51);

		expect((await resultPromise).errorMessage).toBe("Proxy response made no progress for 50ms");
	});

	it("times out while reading a stalled proxy error body", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(new ReadableStream<Uint8Array>({}), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 50,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(51);

		expect((await resultPromise).errorMessage).toBe("Proxy response made no progress for 50ms");
	});

	it("returns a terminal error for an invalid no-progress timeout without calling fetch", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseNoProgressTimeoutMs: 0,
			},
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("responseNoProgressTimeoutMs must be a positive safe integer");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds a fragmented SSE event even when body chunks keep making progress", async () => {
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: 1234"));
							controller.enqueue(encoder.encode("56789"));
							controller.close();
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseMaxEventBytes: 12,
			},
		);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy response event exceeded 12 bytes");
	});

	it("returns a terminal error for an invalid maximum event size without calling fetch", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.invalid",
				responseMaxEventBytes: 0,
			},
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("responseMaxEventBytes must be a positive safe integer");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves terminal response metadata and diagnostics", async () => {
		const diagnostics = [
			{
				type: "provider_transport_failure",
				timestamp: 123,
				error: { name: "Error", message: "websocket failed" },
				details: { transport: "websocket", fallback: "sse" },
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				eventStreamResponse([
					{ type: "start" },
					{
						type: "done",
						reason: "stop",
						usage,
						responseModel: "resolved-model",
						responseId: "response-1",
						diagnostics,
					},
				]),
			),
		);

		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.invalid" });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBe("resolved-model");
		expect(result.responseId).toBe("response-1");
		expect(result.diagnostics).toEqual(diagnostics);
	});

	it("cancels the proxy response reader immediately after a terminal event", async () => {
		const cancel = vi.fn();
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
							);
						},
						cancel,
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);

		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.invalid" });
		expect((await stream.result()).stopReason).toBe("stop");
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Terminal response received"));
	});

	it("preserves redacted thinking and tool-call thought signatures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				eventStreamResponse([
					{ type: "start" },
					{ type: "thinking_start", contentIndex: 0 },
					{
						type: "thinking_end",
						contentIndex: 0,
						content: "[Reasoning redacted]",
						contentSignature: "opaque-thinking",
						redacted: true,
					},
					{ type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "lookup" },
					{ type: "toolcall_delta", contentIndex: 1, delta: '{"query":"stale"}' },
					{
						type: "toolcall_end",
						contentIndex: 1,
						thoughtSignature: "opaque-tool-thought",
						toolCall: {
							type: "toolCall",
							id: "call-1",
							name: "lookup",
							arguments: { query: "pi" },
						},
					},
					{
						type: "done",
						reason: "toolUse",
						usage,
						api: "openai-responses",
						provider: "resolved-provider",
						model: "resolved-model",
						timestamp: 456,
					},
				]),
			),
		);

		const stream = streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.invalid" });
		const result = await stream.result();

		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "opaque-thinking",
				redacted: true,
			},
			{
				type: "toolCall",
				id: "call-1",
				name: "lookup",
				arguments: { query: "pi" },
				thoughtSignature: "opaque-tool-thought",
			},
		]);
		expect(result).toMatchObject({
			api: "openai-responses",
			provider: "resolved-provider",
			model: "resolved-model",
			timestamp: 456,
		});
	});
});
