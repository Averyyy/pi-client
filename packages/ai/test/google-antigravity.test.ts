import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAntigravity, streamSimple as streamSimpleAntigravity } from "../src/api/google-antigravity.ts";
import { ANTIGRAVITY_SESSION_ID } from "../src/api/google-antigravity-client.ts";
import type { AntigravityRoutes, GoogleAntigravityModel } from "../src/api/google-antigravity-model.ts";
import { stream, streamSimple } from "../src/compat.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { getCurrentSystemPrompt, normalizeContext } from "../src/utils/transcript.ts";

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
		expect(payload.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
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
		expect(headers.get("user-agent")).toMatch(/^antigravity\/cli\/1\.5\.9 \(aidev_client; os_type=/);
		expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		expect(headers.get("x-model")).toBe("model");
		expect(headers.get("x-caller")).toBe("caller");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			project: "test-project",
			model: model.id,
			userAgent: "antigravity",
			requestType: "agent",
			requestId: expect.stringMatching(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/0$/),
			request: {
				sessionId: ANTIGRAVITY_SESSION_ID,
				systemInstruction: {
					role: "user",
					parts: [{ text: "Initial instructions\n\nCurrent instructions" }],
				},
				contents: [{ role: "user", parts: [{ text: "Hello" }] }],
				tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "object", required: ["path"] } }] }],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			},
		});
		expect(JSON.parse(String(init?.body)).request.labels).toBeUndefined();
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

	it.each([
		{ terminalUsage: { promptTokenCount: 100 }, cacheRead: 80 },
		{ terminalUsage: {}, cacheRead: 80 },
		{ terminalUsage: { cachedContentTokenCount: 0 }, cacheRead: 0 },
	])("keeps reported prompt usage across sparse frames ($terminalUsage)", async ({ terminalUsage, cacheRead }) => {
		const result = await stream(model, context, {
			apiKey,
			fetch: async () =>
				sse([
					{ response: { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80 } } },
					{ response: { ...stopped.response, usageMetadata: { ...terminalUsage, candidatesTokenCount: 10 } } },
				]),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({ input: 100 - cacheRead, cacheRead, output: 10, totalTokens: 110 });
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
		// The CLI omits the thinking config when the request asks for no effort.
		expect(String(transport.mock.calls[0][1]?.body)).not.toContain("thinkingConfig");
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

	it.each(["http", "stream"])("preserves safe Google RPC details on a %s error", async (transport) => {
		const error = {
			code: 429,
			status: "RESOURCE_EXHAUSTED",
			message: "Provider text with private request data",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.ErrorInfo",
					reason: "QUOTA_EXHAUSTED",
					metadata: { project: "private-project" },
				},
				{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2.125s" },
				{
					"@type": "type.googleapis.com/google.rpc.QuotaFailure",
					violations: [{ subject: "private-account" }],
				},
			],
		};
		const result = await stream(model, context, {
			apiKey,
			maxRetries: 0,
			fetch: async () => (transport === "http" ? Response.json({ error }, { status: 429 }) : sse([{ error }])),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(error.message);
		expect(result.diagnostics).toEqual([
			{
				type: "google_antigravity_response_failure",
				timestamp: expect.any(Number),
				details: {
					status: 429,
					rpcStatus: "RESOURCE_EXHAUSTED",
					reason: "QUOTA_EXHAUSTED",
					retryDelay: "2.125s",
					quotaViolations: 1,
				},
			},
		]);
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

	it("releases the reader when fetch errors the body on timeout", async () => {
		const transport = vi.fn<typeof fetch>(async (_url, init) => {
			const signal = init?.signal;
			if (!signal) throw new Error("Expected a request timeout signal");
			const body = new ReadableStream({
				start(controller) {
					signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				},
			});
			return new Response(body);
		});
		const result = await streamAntigravity(model, normalizeContext(context), {
			apiKey,
			timeoutMs: 10,
			fetch: transport,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timeout/i);
		const response = await transport.mock.results[0].value;
		expect(response.body?.locked).toBe(false);
	});
});

describe("Antigravity catalog routes and prompt adaptation", () => {
	const piOpening =
		"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
	const routes: AntigravityRoutes = {
		default: { runtimeId: "gemini-4-neon-low", modelEnum: "MODEL_PLACEHOLDER_M534" },
		levels: {
			low: { runtimeId: "gemini-4-neon-low", modelEnum: "MODEL_PLACEHOLDER_M534" },
			medium: { runtimeId: "gemini-4-neon-medium", modelEnum: "MODEL_PLACEHOLDER_M533" },
			high: { runtimeId: "gemini-4-neon-high", modelEnum: "MODEL_PLACEHOLDER_M532" },
			xhigh: { runtimeId: "gemini-4-neon-xhigh", modelEnum: "MODEL_PLACEHOLDER_M535" },
		},
	};
	const groupedModel: GoogleAntigravityModel = {
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		api: "google-antigravity",
		provider: "google-antigravity",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 262144,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
		antigravityRoutes: routes,
	};

	it("sends the runtime id and labels for the requested effort", async () => {
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));
		await streamSimple(groupedModel, context, {
			apiKey,
			reasoning: "xhigh",
			sessionId: "01a1f7ea-6a7f-7138-a821-739ad8983fa6",
			fetch: transport,
		}).result();

		const payload = JSON.parse(String(transport.mock.calls[0][1]?.body));
		expect(payload.model).toBe("gemini-4-neon-xhigh");
		expect(payload.request.generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "XHIGH",
		});
		expect(payload.request.sessionId).toBe(ANTIGRAVITY_SESSION_ID);
		expect(payload.request.labels).toMatchObject({
			cascade_id: "01a1f7ea-6a7f-7138-a821-739ad8983fa6",
			root_cascade_id: "01a1f7ea-6a7f-7138-a821-739ad8983fa6",
			model_enum: "MODEL_PLACEHOLDER_M535",
			used_claude: "false",
			used_claude_conservative: "false",
			used_non_gemini_model: "false",
		});
		expect(payload.requestId).toMatch(/^agent\/01a1f7ea-6a7f-7138-a821-739ad8983fa6\/\d+\/[0-9a-f-]{36}\/0$/);
	});

	it("switches the wire runtime id with the pi effort", async () => {
		const low = vi.fn<typeof fetch>(async () => sse([stopped]));
		const medium = vi.fn<typeof fetch>(async () => sse([stopped]));
		await streamSimple(groupedModel, context, { apiKey, reasoning: "low", fetch: low }).result();
		await streamSimple(groupedModel, context, { apiKey, reasoning: "medium", fetch: medium }).result();

		expect(JSON.parse(String(low.mock.calls[0][1]?.body)).model).toBe("gemini-4-neon-low");
		expect(JSON.parse(String(medium.mock.calls[0][1]?.body)).model).toBe("gemini-4-neon-medium");
	});

	it("adapts the prompt on the wire only, so another model still gets the original pi request", async () => {
		const systemMessage = {
			role: "system" as const,
			content: "",
			sections: {
				preamble: piOpening,
				tools: "- read: Read file contents\n\nAdditional tools may be available.",
				rules: "- Be concise in your responses",
			},
			timestamp: 0,
		};
		const transcript = normalizeContext({ messages: [systemMessage, context.messages[0]!] });
		const originalPrompt = getCurrentSystemPrompt(transcript.messages);
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));

		await streamAntigravity(model, transcript, { apiKey, fetch: transport }).result();

		const text = JSON.parse(String(transport.mock.calls[0][1]?.body)).request.systemInstruction.parts[0].text;
		expect(text.startsWith("You are Antigravity, a powerful agentic AI coding assistant")).toBe(true);
		expect(text).toContain("- read: View the contents of a file");
		expect(text).toContain("- Keep responses concise");
		expect(text).not.toContain("inside pi");
		expect(getCurrentSystemPrompt(transcript.messages)).toBe(originalPrompt);
		expect(originalPrompt).toContain(piOpening);
	});
});

describe("Antigravity tool envelope", () => {
	it("sends one declaration wrapper per tool and an empty array without tools", async () => {
		const withTools = vi.fn<typeof fetch>(async () => sse([stopped]));
		const parameters = Type.Object({ path: Type.String() });
		await streamAntigravity(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ apiKey, fetch: withTools },
		).result();
		expect(JSON.parse(String(withTools.mock.calls[0][1]?.body)).request.tools).toEqual([]);

		const twoTools = vi.fn<typeof fetch>(async () => sse([stopped]));
		const contextWithTools = normalizeContext({
			messages: [
				{
					role: "system",
					content: "",
					toolsAdded: [
						{ name: "read", description: "Read", parameters },
						{ name: "bash", description: "Bash", parameters },
					],
					timestamp: 0,
				},
				{ role: "user", content: "Hello", timestamp: 1 },
			],
		});
		await streamAntigravity(model, contextWithTools, { apiKey, fetch: twoTools }).result();
		const tools = JSON.parse(String(twoTools.mock.calls[0][1]?.body)).request.tools;
		expect(
			tools.map((wrapper: { functionDeclarations: { name: string }[] }) => wrapper.functionDeclarations.length),
		).toEqual([1, 1]);
		expect(
			tools.map((wrapper: { functionDeclarations: { name: string }[] }) => wrapper.functionDeclarations[0]?.name),
		).toEqual(["read", "bash"]);
	});
});

describe("Antigravity rendered prompt adaptation", () => {
	it("rewrites a rendered prompt that carries no structured sections", async () => {
		const piOpening =
			"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
		const rendered = [
			piOpening,
			"",
			"<tools>",
			"- read: Read file contents",
			"",
			"Additional tools may be available.",
			"</tools>",
			"<rules>",
			"- Be concise in your responses",
			"</rules>",
		].join("\n");
		const transport = vi.fn<typeof fetch>(async () => sse([stopped]));

		await streamAntigravity(
			model,
			normalizeContext({
				systemPrompt: rendered,
				messages: [{ role: "user", content: "Name this session", timestamp: 1 }],
			}),
			{ apiKey, fetch: transport },
		).result();

		const text = JSON.parse(String(transport.mock.calls[0][1]?.body)).request.systemInstruction.parts[0].text;
		expect(text.startsWith("You are Antigravity, a powerful agentic AI coding assistant")).toBe(true);
		expect(text).toContain("- read: View the contents of a file");
		expect(text).toContain("- Keep responses concise");
		expect(text).not.toContain("Read file contents");
		expect(text).not.toContain("Be concise in your responses");
	});
});
