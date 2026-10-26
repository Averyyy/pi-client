import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAntigravity, streamSimple as streamSimpleAntigravity } from "../src/api/google-antigravity.ts";
import { stream, streamSimple } from "../src/compat.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-antigravity"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "google-antigravity",
	provider: "google-antigravity",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const apiKey = JSON.stringify({ token: "test-token", projectId: "test-project" });

function sse(chunks: unknown[], fragmented = false): Response {
	const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""));
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				if (fragmented) {
					for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				} else controller.enqueue(bytes);
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

const stopped = { response: { candidates: [{ finishReason: "STOP" }] } };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Google Antigravity protocol", () => {
	it("sends Claude Opus high tool schemas through the supported parameters representation", async () => {
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		const parameters = Type.Object({
			amount: Type.Number({ exclusiveMinimum: 0 }),
			rows: Type.Array(Type.Object({ labels: Type.Record(Type.String(), Type.String()) })),
			mode: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
		});
		const result = await streamSimple(
			{ ...model, id: "claude-opus-4-6-thinking" },
			{ ...context, tools: [{ name: "configure", description: "Configure", parameters }] },
			{ apiKey, reasoning: "high", fetch: transport },
		).result();
		expect(result.stopReason).toBe("stop");
		const payload = JSON.parse(String(transport.mock.calls[0][1]?.body));
		expect(payload.model).toBe("claude-opus-4-6-thinking");
		expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 16384 });
		expect(payload.request.tools).toEqual([
			{
				functionDeclarations: [
					{
						name: "configure",
						description: "Configure",
						parameters: {
							type: "object",
							required: ["amount", "rows", "mode"],
							properties: {
								amount: {
									type: "number",
									description: 'Must satisfy JSON Schema constraints: {"exclusiveMinimum":0}',
								},
								rows: {
									type: "array",
									items: {
										type: "object",
										required: ["labels"],
										properties: {
											labels: {
												type: "object",
												description:
													'Must satisfy JSON Schema constraints: {"patternProperties":{"^.*$":{"type":"string"}}}',
											},
										},
									},
								},
								mode: {
									type: "string",
									enum: ["auto", "manual"],
								},
							},
						},
					},
				],
			},
		]);
	});

	it("sends normalized system instructions, tool deltas, and the subscription envelope through public dispatch", async () => {
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		const onPayload = vi.fn((payload: unknown) => payload);
		const onResponse = vi.fn();
		const result = await stream(
			{ ...model, headers: { "X-Model": "model" } },
			{
				systemPrompt: "Initial instructions",
				tools: [{ name: "old", description: "Old tool", parameters: Type.Object({}) }],
				messages: [
					...context.messages,
					{
						role: "system",
						content: "Current instructions",
						toolsRemoved: [{ name: "old" }],
						toolsAdded: [
							{ name: "read", description: "Read file", parameters: Type.Object({ path: Type.String() }) },
						],
						timestamp: 2,
					},
				],
			},
			{
				apiKey,
				fetch: transport,
				sessionId: "session",
				toolChoice: "any",
				onPayload,
				onResponse,
				headers: { "X-Caller": "caller" },
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(transport).toHaveBeenCalledOnce();
		const [url, init] = transport.mock.calls[0];
		expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token");
		expect(headers.get("user-agent")).toBe("antigravity/hub/2.23.0 darwin/arm64");
		expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		expect(headers.get("x-model")).toBe("model");
		expect(headers.get("x-caller")).toBe("caller");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			project: "test-project",
			model: model.id,
			userAgent: "antigravity",
			requestType: "agent",
			requestId: expect.stringMatching(/^agent-/),
			request: {
				sessionId: "session",
				systemInstruction: { parts: [{ text: "Initial instructions\n\nCurrent instructions" }] },
				contents: [{ role: "user", parts: [{ text: "Hello" }] }],
				tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "object", required: ["path"] } }] }],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			},
		});
		expect(onPayload).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledWith(
			{ status: 200, headers: { "content-type": "text/event-stream" } },
			expect.objectContaining({ id: model.id }),
		);
	});

	it("preserves thought, text, tool signatures, cache usage, and finish reason in byte-fragmented SSE", async () => {
		const chunks = [
			{
				response: {
					responseId: "response-1",
					modelVersion: "gemini-3.8-pro",
					candidates: [{ content: { parts: [{ thought: true, text: "想", thoughtSignature: "YWJj" }] } }],
				},
			},
			{
				response: {
					candidates: [
						{
							content: {
								parts: [
									{ thought: true, text: "法" },
									{ text: "Answer", thoughtSignature: "ZGVm" },
								],
							},
						},
					],
				},
			},
			{
				response: {
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: { id: "call-1", name: "read", args: { path: "file" } },
										thoughtSignature: "Z2hp",
									},
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 80,
						candidatesTokenCount: 10,
						thoughtsTokenCount: 5,
						totalTokenCount: 115,
					},
				},
			},
		];
		const onProviderStreamEvent = vi.fn();
		const source = stream(model, context, { apiKey, fetch: async () => sse(chunks, true), onProviderStreamEvent });
		const events: AssistantMessageEvent[] = [];
		for await (const event of source) events.push(event);
		const result = await source.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.rawStopReason).toBe("STOP");
		expect(result.responseId).toBe("response-1");
		expect(result.responseModel).toBe("gemini-3.8-pro");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "想法", thinkingSignature: "YWJj" },
			{ type: "text", text: "Answer", textSignature: "ZGVm" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" }, thoughtSignature: "Z2hp" },
		]);
		expect(result.usage).toMatchObject({ input: 20, output: 15, reasoning: 5, cacheRead: 80, totalTokens: 115 });
		expect(result.usage.cost.total).toBeCloseTo((20 * 3 + 15 * 15 + 80 * 0.3) / 1_000_000);
		expect(events.map((event) => event.type)).toContain("toolcall_end");
		expect(events.at(-1)?.type).toBe("done");
		expect(onProviderStreamEvent.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
	});

	it("keeps distinct signed parts and replays them on the next request", async () => {
		const result = await stream(model, context, {
			apiKey,
			fetch: async () =>
				sse([
					{
						response: {
							candidates: [
								{
									content: {
										parts: [
											{ thought: true, thoughtSignature: "YWJj" },
											{ text: "First", thoughtSignature: "ZGVm" },
											{ text: "Second", thoughtSignature: "Z2hp" },
										],
									},
									finishReason: "STOP",
								},
							],
						},
					},
				]),
		}).result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "", thinkingSignature: "YWJj" },
			{ type: "text", text: "First", textSignature: "ZGVm" },
			{ type: "text", text: "Second", textSignature: "Z2hp" },
		]);
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		await stream(
			model,
			{ messages: [...context.messages, result, { role: "user", content: "Continue", timestamp: 2 }] },
			{ apiKey, fetch: transport },
		).result();
		expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
			request: {
				contents: [
					{ role: "user", parts: [{ text: "Hello" }] },
					{
						role: "model",
						parts: [
							{ thought: true, text: "", thoughtSignature: "YWJj" },
							{ text: "First", thoughtSignature: "ZGVm" },
							{ text: "Second", thoughtSignature: "Z2hp" },
						],
					},
					{ role: "user", parts: [{ text: "Continue" }] },
				],
			},
		});
	});

	it("uses Gemini thinking levels through simple dispatch and preserves model endpoint/header overrides", async () => {
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		const gemini = {
			...model,
			id: "gemini-3-flash",
			baseUrl: "https://custom.example/",
			thinkingLevelMap: { off: "off", high: "high" },
		};
		const result = await streamSimple(gemini, context, {
			apiKey,
			reasoning: "high",
			fetch: transport,
			headers: { "User-Agent": "custom" },
		}).result();
		expect(result.stopReason).toBe("stop");
		const [url, init] = transport.mock.calls[0];
		expect(url).toBe("https://custom.example/v1internal:streamGenerateContent?alt=sse");
		expect(new Headers(init?.headers).get("user-agent")).toBe("custom");
		expect(new Headers(init?.headers).has("anthropic-beta")).toBe(false);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			request: { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } },
		});
	});

	it("keeps Gemini thinking hidden when simple dispatch has no reasoning request", async () => {
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		await streamSimple(
			{ ...model, id: "gemini-3.1-pro-high", thinkingLevelMap: { off: null, minimal: null, low: "low" } },
			context,
			{ apiKey, fetch: transport },
		).result();
		expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
			request: { generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } },
		});
		expect(String(transport.mock.calls[0][1]?.body)).not.toContain("includeThoughts");
	});

	it("uses shared retry policy on the same endpoint and reports response hooks for each attempt", async () => {
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }))
			.mockResolvedValueOnce(sse([stopped]));
		const onResponse = vi.fn();
		const result = await stream(model, context, { apiKey, fetch: transport, maxRetries: 1, onResponse }).result();
		expect(result.stopReason).toBe("stop");
		expect(transport.mock.calls.map(([url]) => url)).toEqual(
			Array(2).fill("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"),
		);
		expect(onResponse.mock.calls.map(([response]) => response.status)).toEqual([503, 200]);
	});

	it.each([403, 404])("surfaces HTTP %s without changing endpoints", async (status) => {
		const transport = vi.fn<typeof fetch>(async () => new Response('{"error":{"message":"denied"}}', { status }));
		const result = await stream(model, context, { apiKey, fetch: transport }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(String(status));
		expect(result.errorMessage).toContain("denied");
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([
		["invalid JSON", "data: {\n\n"],
		["missing response", "data: {}\n\n"],
		["truncated", 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n'],
		["provider error", 'data: {"error":{"message":"quota exhausted"}}\n\n'],
		["blocked", 'data: {"response":{"candidates":[{"finishReason":"SAFETY"}]}}\n\n'],
	])("reports %s streams as errors without replay", async (_name, body) => {
		const transport = vi.fn<typeof fetch>(
			async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		);
		const result = await stream(model, context, { apiKey, fetch: transport }).result();
		expect(result.stopReason).toBe("error");
		expect(transport).toHaveBeenCalledOnce();
	});

	it("keeps a token-limit stop after tool content", async () => {
		const result = await stream(model, context, {
			apiKey,
			fetch: async () =>
				sse([
					{
						response: {
							candidates: [
								{
									content: { parts: [{ functionCall: { name: "read", args: {} } }] },
									finishReason: "MAX_TOKENS",
								},
							],
						},
					},
				]),
		}).result();
		expect(result.stopReason).toBe("length");
	});

	it("throws synchronously when direct simple dispatch has no OAuth credentials", () => {
		expect(() => streamSimpleAntigravity(model, normalizeContext(context))).toThrow("requires OAuth authentication");
	});

	it("blocks direct inference in server mode before network access", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		const transport = vi.fn<typeof fetch>();
		const result = await streamAntigravity(model, normalizeContext(context), { apiKey, fetch: transport }).result();
		expect(result.errorMessage).toContain("must use pi-server");
		expect(transport).not.toHaveBeenCalled();
	});

	it("honors aborts while reading an idle stream", async () => {
		const controller = new AbortController();
		const cancelled = vi.fn();
		const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: cancelled })));
		const source = streamAntigravity(model, normalizeContext(context), {
			apiKey,
			fetch: transport,
			signal: controller.signal,
		});
		for await (const event of source) {
			if (event.type === "start") controller.abort();
		}
		expect((await source.result()).stopReason).toBe("aborted");
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("honors timeouts while reading an idle stream", async () => {
		const result = await streamAntigravity(model, normalizeContext(context), {
			apiKey,
			timeoutMs: 10,
			fetch: async () => new Response(new ReadableStream()),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timeout/i);
	});
});
