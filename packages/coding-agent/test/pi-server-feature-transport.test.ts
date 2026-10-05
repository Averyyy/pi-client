import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AnyModel,
	type AssistantImages,
	type AssistantMessage,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type DeferredHandle,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageModel,
	type ImagesContext,
	isModelType,
	type Message,
	type Model,
	type MutableModels,
	normalizeContext,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { getAllBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllRequestChunks } from "../../pi-server/src/request-chunks.ts";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions, getSession } from "../../pi-server/src/session-store.ts";
import {
	cancelDeferredPiServer,
	classifyPiServer,
	fetchDeferredPiServer,
	fetchPiServerModels,
	generateImagesPiServer,
	hashStaticContext,
	resetAllSessionTracking,
	streamPiServer,
	streamRawPiServer,
	syncPiServerTree,
} from "../src/core/pi-server-client.ts";
import { ChunkRequest } from "../src/core/pi-server-request.ts";

const MAX_REQUEST_BYTES = 65_536;
const providerId = "transport-feature-provider";
const baseModel = {
	id: "shared",
	name: "Shared",
	provider: providerId,
	baseUrl: "https://fixture.invalid",
	input: ["text"] as ("text" | "image")[],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};
const chatModel: Model<"transport-feature-chat"> = {
	...baseModel,
	api: "transport-feature-chat",
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 4096,
};
const imageModel: ImageModel<"transport-feature-image"> = {
	...baseModel,
	type: "image",
	api: "transport-feature-image",
	output: ["image"],
};
const classifierModel: ClassifierModel<"transport-feature-classifier"> = {
	...baseModel,
	type: "classifier",
	api: "transport-feature-classifier",
	contextWindow: 200_000,
};
const usage = {
	input: 17,
	output: 4,
	cacheRead: 64,
	cacheWrite: 8,
	totalTokens: 93,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

function resultFor(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		thinkingLevel: "high",
		providerThinkingLevel: "provider-high",
		rawStopReason: "native-stop",
		usage,
		timestamp: 1234,
	};
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP listener address");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("upstream features over 64 KiB pi-server HTTP requests", () => {
	let server: Server;
	let guard: Server;
	let baseUrl: string;
	let sessionDir: string;
	let requests: { path: string; bytes: number; target?: string }[];
	let providerCalls: { model: Model<string>; context: TranscriptContext; options?: SimpleStreamOptions }[];
	let imageCalls: { model: ImageModel<string>; context: ImagesContext; apiKey?: string }[];
	let classifierCalls: {
		model: ClassifierModel<string>;
		context: ClassifierContext;
		apiKey?: string;
		temperature?: number;
	}[];
	let nextAssistant: AssistantMessage | undefined;
	let models: MutableModels;
	let imageGate: Promise<void> | undefined;
	let imageStarted: (() => void) | undefined;
	let imageAborted: (() => void) | undefined;
	let disconnectOperationResult: boolean;
	let disconnectErrorResult: boolean;
	let lifecyclePayloads: unknown[];
	let lifecycleStages: string[];
	let chatGate: Promise<void> | undefined;
	let chatAborted: (() => void) | undefined;
	let callbackRejected: (() => void) | undefined;
	let callbackCleanupGate: Promise<void> | undefined;
	let deferredCalls: { operation: string; handle: DeferredHandle; apiKey?: string; wait?: number }[];

	beforeEach(async () => {
		clearAllSessions();
		clearAllRequestChunks();
		resetAllSessionTracking();
		requests = [];
		providerCalls = [];
		imageCalls = [];
		classifierCalls = [];
		nextAssistant = undefined;
		imageGate = undefined;
		imageStarted = undefined;
		imageAborted = undefined;
		disconnectOperationResult = false;
		disconnectErrorResult = false;
		lifecyclePayloads = [];
		lifecycleStages = [];
		chatGate = undefined;
		chatAborted = undefined;
		callbackRejected = undefined;
		callbackCleanupGate = undefined;
		deferredCalls = [];
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		vi.stubEnv("FEATURE_SERVER_KEY", "server-owned-fixture-key");
		models = createModels();
		models.setProvider(
			createProvider({
				id: providerId,
				models: [chatModel, { ...imageModel, headers: { Authorization: "private-model-header" } }, classifierModel],
				auth: {
					apiKey: {
						name: "Server fixture key",
						resolve: async ({ ctx }) => {
							const key = await ctx.env("FEATURE_SERVER_KEY");
							return key ? { auth: { apiKey: key } } : undefined;
						},
					},
				},
				api: {
					stream: fixtureStream,
					streamSimple: fixtureStream,
					fetchDeferred: (model, handle, options) => {
						deferredCalls.push({ operation: "fetch", handle, apiKey: options?.apiKey, wait: options?.wait });
						return fixtureStream(model, normalizeContext({ messages: [] }), options);
					},
					cancelDeferred: async (model, handle, options) => {
						deferredCalls.push({ operation: "cancel", handle, apiKey: options?.apiKey });
						await fixtureCallbacks(model, handle, options);
					},
				},
				images: {
					[imageModel.api]: {
						generateImages: async (model, context, options): Promise<AssistantImages> => {
							imageCalls.push({ model, context, apiKey: options?.apiKey });
							await fixtureCallbacks(model, context, options);
							options?.signal?.addEventListener("abort", () => imageAborted?.(), { once: true });
							imageStarted?.();
							await imageGate;
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								output: [{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" }],
								responseId: "image-result",
								usage,
								stopReason: "stop",
								timestamp: 1234,
							};
						},
					},
				},
				classifiers: {
					[classifierModel.api]: {
						classify: async (model, context, options): Promise<ClassifierResult> => {
							classifierCalls.push({
								model,
								context,
								apiKey: options?.apiKey,
								temperature: options?.temperature,
							});
							await fixtureCallbacks(model, context, options);
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: { approved: { type: "bool", probability: 0.95 } },
								usage,
								stopReason: "stop",
								timestamp: 1234,
							};
						},
					},
				},
			}),
		);
		registerApiProvider({ api: chatModel.api, stream: fixtureStream, streamSimple: fixtureStream });
		function fixtureStream(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) {
			providerCalls.push({ model, context, options });
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					options?.signal?.addEventListener("abort", () => chatAborted?.(), { once: true });
					await fixtureCallbacks(model, context, options);
					await options?.onProviderStreamEvent?.(
						{ type: "native-event", privateField: "provider-only" },
						{ ...model, headers: { Authorization: "private-provider-header" } },
					);
					await chatGate;
					const message = nextAssistant ?? resultFor(model);
					stream.push({ type: "start", partial: message });
					const call = message.content.find((block) => block.type === "toolCall");
					if (call) {
						const contentIndex = message.content.indexOf(call);
						stream.push({ type: "toolcall_start", contentIndex, partial: message });
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(call.arguments),
							partial: message,
						});
						stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
					}
					if (message.stopReason === "error" || message.stopReason === "aborted")
						stream.push({ type: "error", reason: message.stopReason, error: message });
					else stream.push({ type: "done", reason: "stop", message });
					stream.end();
				} catch (error) {
					lifecycleStages.push("provider_failed");
					const message = {
						...resultFor(model),
						stopReason: "error" as const,
						errorMessage: error instanceof Error ? error.message : String(error),
					};
					stream.push({ type: "error", reason: "error", error: message });
					stream.end();
				}
			})();
			return stream;
		}
		async function fixtureCallbacks<TModel extends AnyModel>(
			model: TModel,
			payload: unknown,
			options?: ProviderRequestOptions<TModel>,
		): Promise<void> {
			try {
				lifecycleStages.push("payload_before");
				lifecyclePayloads.push((await options?.onPayload?.(payload, model)) ?? payload);
				lifecycleStages.push("payload_after");
				await options?.onResponse?.({ status: 201, headers: { "x-fixture-response": "ready" } }, model);
				lifecycleStages.push("response_after");
			} catch (error) {
				callbackRejected?.();
				await callbackCleanupGate;
				throw error;
			}
		}
		sessionDir = mkdtempSync(join(tmpdir(), "pi-server-features-"));
		server = createPiServer({ authToken: "transport-token", sessionStoreDir: sessionDir }, models);
		const upstream = await listen(server);
		guard = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks);
			requests.push({
				path: req.url ?? "/",
				bytes: raw.length,
				target:
					req.url === "/api/request/chunk" ? (JSON.parse(raw.toString()) as { target: string }).target : undefined,
			});
			if (raw.length > MAX_REQUEST_BYTES) {
				res.writeHead(413);
				res.end("64 KiB request limit");
				return;
			}
			const controller = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) controller.abort();
			});
			try {
				const reply = await fetch(`${upstream}${req.url}`, {
					method: req.method,
					headers: { Authorization: req.headers.authorization ?? "", "Content-Type": "application/json" },
					body: req.method === "POST" ? raw : undefined,
					signal: controller.signal,
				});
				res.writeHead(reply.status, { "Content-Type": reply.headers.get("Content-Type") ?? "application/json" });
				res.flushHeaders();
				if (reply.body)
					for await (const chunk of reply.body) {
						if (disconnectErrorResult && Buffer.from(chunk).toString().includes('"type":"error"')) {
							disconnectErrorResult = false;
							res.destroy();
							return;
						}
						if (disconnectOperationResult && Buffer.from(chunk).toString().includes("event: result")) {
							disconnectOperationResult = false;
							res.destroy();
							return;
						}
						res.write(chunk);
					}
				res.end();
			} catch {
				if (!res.destroyed) {
					if (res.headersSent) res.destroy();
					else {
						res.writeHead(502);
						res.end();
					}
				}
			}
		});
		baseUrl = await listen(guard);
		vi.stubEnv("PI_SERVER_URL", baseUrl);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "transport-token");
	});

	afterEach(async () => {
		await close(guard);
		await close(server);
		rmSync(sessionDir, { recursive: true, force: true });
		resetAllSessionTracking();
		resetApiProviders();
		clearAllSessions();
		clearAllRequestChunks();
		vi.unstubAllEnvs();
	});

	it("enforces the actual UTF-8 boundary and accepts exact-sized direct bodies", async () => {
		const request = new ChunkRequest({ serverUrl: baseUrl, authToken: "transport-token" });
		const body = { sessionId: "boundary", staticContext: { systemPrompt: "" } };
		body.staticContext.systemPrompt = "x".repeat(MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(body)));
		expect((await request.postJson("/api/session/init", body)).status).toBe(200);
		expect(requests[0]).toMatchObject({ path: "/api/session/init", bytes: MAX_REQUEST_BYTES });
		body.staticContext.systemPrompt += "你";
		expect((await request.postJson("/api/session/update", body)).status).toBe(200);
		expect(
			requests
				.slice(1)
				.every((request) => request.path === "/api/request/chunk" && request.bytes <= MAX_REQUEST_BYTES),
		).toBe(true);
		expect(
			(await fetch(`${baseUrl}/api/session/init`, { method: "POST", body: "x".repeat(MAX_REQUEST_BYTES + 1) }))
				.status,
		).toBe(413);
	});

	it("preserves large grammar tools, projected system updates, images, structured tool results, and final metadata", async () => {
		const grammarTool = {
			name: "codemode",
			description: "d".repeat(80_000),
			parameters: Type.Object({ code: Type.String() }),
			constrainedSampling: { type: "grammar" as const, variants: { openai_lark: "start: /[\\s\\S]*/" } },
		};
		const messages: Message[] = [
			{ role: "user", content: [{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" }], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "codemode",
				content: [{ type: "text", text: "你".repeat(30_000) }],
				details: { nestedCalls: [{ name: "bash", structuredContent: { output: "z".repeat(100_000) } }] },
				usage,
				isError: false,
				timestamp: 2,
			},
		];
		nextAssistant = {
			...resultFor(chatModel),
			content: [
				{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "signed-thinking" },
				{
					type: "toolCall",
					id: "ctc_call",
					name: "codemode",
					namespace: "functions",
					arguments: { code: "text(1)" },
				},
			],
		};
		const observed: unknown[] = [];
		const stream = await streamPiServer(
			chatModel,
			{ systemPrompt: "original", tools: [grammarTool], messages },
			{
				sessionId: "projection",
				samplingParams: { top_p: 0.7 },
				toolChoice: "none",
				env: { PROVIDER_OPTION: "value" },
				deferred: { window: "1h" },
				reasoning: "high",
				onProviderStreamEvent: (event, model) => {
					observed.push(event);
					expect(model.headers).toBeUndefined();
				},
			},
		);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(await stream.result()).toEqual(nextAssistant);
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			toolCall: { namespace: "functions", id: "ctc_call" },
		});
		expect(observed).toEqual([{ type: "native-event", privateField: "provider-only" }]);
		expect(providerCalls[0].context.messages.filter((message) => message.role !== "system")).toEqual(messages);
		expect(getCurrentTools(providerCalls[0].context.messages)).toEqual([grammarTool]);
		expect(providerCalls[0].options).toMatchObject({
			samplingParams: { top_p: 0.7 },
			toolChoice: "none",
			env: { PROVIDER_OPTION: "value" },
			deferred: { window: "1h" },
			reasoning: "high",
		});
		expect(getSession("projection")?.entries).toEqual([]);
		expect(
			requests.filter((request) => request.path === "/api/request/chunk").map((request) => request.target),
		).toContain("/api/stream");
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		const strict = {
			...grammarTool,
			constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
		};
		expect(hashStaticContext({ tools: [strict], messages: [] })).not.toBe(
			hashStaticContext({ tools: [grammarTool], messages: [] }),
		);
		const second = await streamPiServer(
			chatModel,
			{ systemPrompt: "original", tools: [strict], messages: [] },
			{ sessionId: "projection" },
		);
		await second.result();
		expect(getCurrentSystemPrompt(providerCalls[1].context.messages)).toBe("original");
		expect(getCurrentTools(providerCalls[1].context.messages)).toEqual([strict]);
		const third = await streamPiServer(
			chatModel,
			{ systemPrompt: "updated", tools: [strict], messages: [] },
			{ sessionId: "projection" },
		);
		await third.result();
		expect(getCurrentSystemPrompt(providerCalls[2].context.messages)).toBe("updated");
	});

	it("preserves terminal provider errors and API-specific stream options", async () => {
		nextAssistant = {
			...resultFor(chatModel),
			stopReason: "error",
			errorMessage: "native failure",
			diagnostics: [{ type: "native_error", timestamp: 10 }],
			thinkingLevel: "high",
		};
		const stream = await streamRawPiServer(
			chatModel,
			{ messages: [] },
			{ sessionId: "raw", reasoning: "high", custom_option: { budget: 10 } },
		);
		expect(await stream.result()).toEqual(nextAssistant);
		expect(providerCalls[0].options).toMatchObject({ custom_option: { budget: 10 } });
	});

	it("preserves mid-conversation system sections and tool additions in their exact transcript positions", async () => {
		const tool = { name: "mcp__server__read", description: "read", parameters: Type.Object({ path: Type.String() }) };
		const messages: Message[] = [
			{ role: "user", content: "before", timestamp: 1 },
			{
				role: "system",
				content: "",
				sections: { mcp_servers: "你".repeat(30_000) },
				toolsAdded: [tool],
				timestamp: 2,
			},
			{ role: "user", content: "after", timestamp: 3 },
		];
		const stream = await streamPiServer(
			chatModel,
			{ systemPrompt: "initial", messages },
			{ sessionId: "transcript" },
		);
		await stream.result();
		expect(providerCalls[0].context.messages.slice(1)).toEqual(messages);
		expect(getCurrentTools(providerCalls[0].context.messages)).toEqual([tool]);
		expect(getCurrentSystemPrompt(providerCalls[0].context.messages)).toContain("你".repeat(30_000));
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
	});

	it("reports provider observer failures without recovering them as successful model replies", async () => {
		const stream = await streamPiServer(
			chatModel,
			{ messages: [] },
			{
				sessionId: "observer-error",
				onProviderStreamEvent: () => {
					throw new Error("observer failed");
				},
			},
		);
		expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: "observer failed" });
		expect(requests.some((request) => request.path.includes("/runs/") && !request.path.endsWith("/abort"))).toBe(
			false,
		);
	});

	it("keeps chat, image, and classifier catalog identities distinct and protects auth headers", async () => {
		models.setProvider(
			createProvider({
				id: "operations-only",
				models: [],
				auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: {} }) } },
				images: {
					[imageModel.api]: {
						generateImages: async () => {
							throw new Error("Unused catalog fixture");
						},
					},
				},
			}),
		);
		const catalog = await fetchPiServerModels();
		expect(catalog.models.map((model) => model.type ?? "chat")).toEqual(["chat", "image", "classifier"]);
		expect(catalog.available).toHaveLength(3);
		expect(catalog.providers).toEqual([
			{ id: providerId, fetchDeferred: true, cancelDeferred: true },
			{ id: "operations-only", fetchDeferred: false, cancelDeferred: false },
		]);
		expect(JSON.stringify(catalog)).not.toContain("private-model-header");
		vi.stubEnv("FEATURE_SERVER_KEY", "");
		expect((await fetchPiServerModels()).available).toEqual([]);
		expect((await fetch(`${baseUrl}/api/models`)).status).toBe(401);
	});

	async function runLifecycleOperation(
		kind: "simple" | "api" | "image" | "classifier",
		options: ProviderRequestOptions<AnyModel>,
	) {
		const text = "你".repeat(30_000);
		if (kind === "image") return generateImagesPiServer(imageModel, { input: [{ type: "text", text }] }, options);
		if (kind === "classifier") return classifyPiServer(classifierModel, { state: { text }, questions: {} }, options);
		const stream = await (kind === "api" ? streamRawPiServer : streamPiServer)(
			chatModel,
			{
				messages: [{ role: "user", content: text, timestamp: 1 }],
			},
			{ ...options },
		);
		return stream.result();
	}

	it.each(["simple", "api", "image", "classifier"] as const)(
		"awaits large payload replacements and response observers for %s",
		async (kind) => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let observed: (() => void) | undefined;
			const responseObserved = new Promise<void>((resolve) => {
				observed = resolve;
			});
			const replacement = { replaced: "你".repeat(40_000) };
			let settled = false;
			const result = runLifecycleOperation(kind, {
				onPayload: async (payload, model) => {
					expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(MAX_REQUEST_BYTES);
					expect(model.provider).toBe(providerId);
					expect(model.headers).toBeUndefined();
					return replacement;
				},
				onResponse: async (response, model) => {
					expect(response).toEqual({ status: 201, headers: { "x-fixture-response": "ready" } });
					expect(model.id).toBe("shared");
					observed?.();
					await gate;
				},
			}).then((value) => {
				settled = true;
				return value;
			});
			await responseObserved;
			expect(settled).toBe(false);
			expect(lifecyclePayloads).toEqual([replacement]);
			expect(lifecycleStages).toEqual(["payload_before", "payload_after"]);
			release?.();
			expect((await result).stopReason).toBe("stop");
			expect(lifecycleStages).toEqual(["payload_before", "payload_after", "response_after"]);
			expect(requests.some((request) => request.target === "/api/provider-callback")).toBe(true);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		},
	);

	it.each(["simple", "api", "image", "classifier"] as const)(
		"propagates local callback exceptions for %s",
		async (kind) => {
			const result = runLifecycleOperation(kind, {
				onPayload: () => {
					throw new Error("local payload rejected");
				},
			});
			if (kind === "image" || kind === "classifier") await expect(result).rejects.toThrow("local payload rejected");
			else expect(await result).toMatchObject({ stopReason: "error", errorMessage: "local payload rejected" });
			expect(lifecycleStages).not.toContain("payload_after");
			expect(requests.some((request) => request.path === "/api/provider-callback")).toBe(true);
			expect(requests.some((request) => request.path.endsWith("/abort"))).toBe(true);
		},
	);

	it("rejects response observer errors after applying an in-place payload mutation", async () => {
		const result = await runLifecycleOperation("simple", {
			onPayload: (payload) => {
				Object.assign(payload as object, { extension: true });
			},
			onResponse: () => {
				throw new Error("response observer rejected");
			},
		});
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "response observer rejected" });
		expect(lifecyclePayloads[0]).toMatchObject({ extension: true });
		expect(lifecycleStages).not.toContain("response_after");
	});

	it("aborts an unanswered local callback and rejects stale callback replies", async () => {
		let started: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const result = runLifecycleOperation("simple", {
			signal: controller.signal,
			onPayload: () => {
				started?.();
				return new Promise(() => {});
			},
		});
		await pending;
		controller.abort();
		expect(await result).toMatchObject({ stopReason: "aborted" });
		expect(lifecycleStages).toContain("provider_failed");
		expect(lifecycleStages).not.toContain("payload_after");
		expect(
			(
				await fetch(`${baseUrl}/api/provider-callback`, {
					method: "POST",
					headers: { Authorization: "Bearer transport-token", "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: "missing", runId: "missing", callbackId: "stale" }),
				})
			).status,
		).toBe(409);
		expect((await fetch(`${baseUrl}/api/provider-callback`, { method: "POST", body: "{}" })).status).toBe(401);
	});

	it("awaits remote provider cleanup after a native observer fails", async () => {
		let release: (() => void) | undefined;
		chatGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			chatAborted = resolve;
		});
		let settled = false;
		const stream = await streamPiServer(
			chatModel,
			{ messages: [] },
			{
				onProviderStreamEvent: () => {
					throw new Error("observer failed during provider run");
				},
			},
		);
		const result = stream.result().then((value) => {
			settled = true;
			return value;
		});
		await aborted;
		expect(settled).toBe(false);
		release?.();
		expect(await result).toMatchObject({ stopReason: "error", errorMessage: "observer failed during provider run" });
	});

	it("recovers authoritative failed assistant metadata after error delivery disconnects", async () => {
		nextAssistant = {
			...resultFor(chatModel),
			stopReason: "error",
			errorMessage: "native final error",
			content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "error-signature" }],
		};
		disconnectErrorResult = true;
		const stream = await streamPiServer(chatModel, { messages: [] });
		expect(await stream.result()).toEqual(nextAssistant);
		expect(providerCalls).toHaveLength(1);
	});

	it("rejects pending callback state when its event stream disconnects", async () => {
		const rejected = new Promise<void>((resolve) => {
			callbackRejected = resolve;
		});
		const response = await fetch(`${baseUrl}/api/generate-images`, {
			method: "POST",
			headers: { Authorization: "Bearer transport-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "disconnected-callback",
				runId: "pending",
				model: imageModel,
				context: { input: [] },
				callbacks: { onPayload: true },
			}),
		});
		const reader = response.body!.getReader();
		let data = "";
		while (!data.includes("event: provider_callback") || !data.includes("data:") || !data.endsWith("\n\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Missing provider callback request");
			data += new TextDecoder().decode(chunk.value);
		}
		const callbackLine = data
			.split("\n\n")
			.find((event) => event.includes("event: provider_callback"))
			?.split("\n")
			.find((line) => line.startsWith("data:"));
		if (!callbackLine) throw new Error("Missing provider callback data");
		const callback = JSON.parse(callbackLine.slice(5).trim()) as { callbackId: string };
		await reader.cancel();
		await rejected;
		const reply = await fetch(`${baseUrl}/api/provider-callback`, {
			method: "POST",
			headers: { Authorization: "Bearer transport-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "disconnected-callback",
				runId: "pending",
				callbackId: callback.callbackId,
				result: {},
			}),
		});
		expect(reply.status).toBe(409);
	});

	it.each(["stream", "generate-images", "classify", "cancel-deferred"] as const)(
		"waits for pending %s callback cleanup before acknowledging session deletion and cancellation",
		async (operation) => {
			const sessionId = `delete-${operation}`;
			const runId = "pending";
			const request = new ChunkRequest({ serverUrl: baseUrl, authToken: "transport-token" });
			expect(
				(await request.postJson("/api/session/init", { sessionId, staticContext: { systemPrompt: "fixture" } }))
					.status,
			).toBe(200);
			let release: (() => void) | undefined;
			callbackCleanupGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const rejected = new Promise<void>((resolve) => {
				callbackRejected = resolve;
			});
			const handle: DeferredHandle = { provider: providerId, modelId: chatModel.id, api: chatModel.api, id: "job" };
			const response = await request.postJson(`/api/${operation}`, {
				sessionId,
				runId,
				callbacks: { onPayload: true },
				...(operation === "stream"
					? { model: chatModel, contextOverlay: [] }
					: operation === "generate-images"
						? { model: imageModel, context: { input: [] } }
						: operation === "classify"
							? { model: classifierModel, context: { state: {}, questions: {} } }
							: { model: chatModel, handle }),
			});
			const reader = response.body!.getReader();
			let data = "";
			while (!data.includes("event: provider_callback") || !data.includes("data:") || !data.endsWith("\n\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Missing provider callback request");
				data += new TextDecoder().decode(chunk.value);
			}
			const callbackLine = data
				.split("\n\n")
				.find((event) => event.includes("event: provider_callback"))
				?.split("\n")
				.find((line) => line.startsWith("data:"));
			if (!callbackLine) throw new Error("Missing provider callback data");
			const callback = JSON.parse(callbackLine.slice(5).trim()) as { callbackId: string };
			let deletionSettled = false;
			const deletion = fetch(`${baseUrl}/api/session/${sessionId}`, {
				method: "DELETE",
				headers: { Authorization: "Bearer transport-token" },
			}).then((reply) => {
				deletionSettled = true;
				return reply;
			});
			await rejected;
			expect(deletionSettled).toBe(false);
			let abortSettled = false;
			const abort = request
				.postJson(`/api/session/${sessionId}/runs/${runId}/abort`, { sessionId, runId })
				.then((reply) => {
					abortSettled = true;
					return reply;
				});
			expect(
				(
					await request.postJson("/api/provider-callback", {
						sessionId,
						runId,
						callbackId: callback.callbackId,
						result: {},
					})
				).status,
			).toBe(409);
			expect(abortSettled).toBe(false);
			expect(deletionSettled).toBe(false);
			release?.();
			expect((await deletion).status).toBe(200);
			expect(await (await abort).json()).toMatchObject({ status: "aborted", sessionId, runId });
			let terminalData = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				terminalData += new TextDecoder().decode(chunk.value);
			}
			expect(terminalData).not.toContain('"type":"done"');
			expect(terminalData).not.toContain('"stopReason":"stop"');
			expect((await request.getJson(`/api/session/${sessionId}/runs/${runId}`)).status).toBe(404);
			expect(getSession(sessionId)).toBeUndefined();
			expect(requests.every((entry) => entry.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		},
	);

	it("fetches and cancels oversized deferred handles remotely with server auth and awaited callbacks", async () => {
		const handle: DeferredHandle = {
			provider: providerId,
			modelId: chatModel.id,
			api: chatModel.api,
			id: "deferred-job",
			data: { original: "你".repeat(30_000) },
		};
		const stream = await fetchDeferredPiServer(chatModel, handle, {
			wait: 1500,
			onResponse: (response) => {
				expect(response.status).toBe(201);
			},
		});
		expect(await stream.result()).toMatchObject({ stopReason: "stop" });
		let responseObserved = false;
		await cancelDeferredPiServer(chatModel, handle, {
			onPayload: (payload) => {
				expect(payload).toEqual(handle);
				return { replacement: "你".repeat(40_000) };
			},
			onResponse: async () => {
				responseObserved = true;
			},
		});
		expect(responseObserved).toBe(true);
		expect(deferredCalls).toEqual([
			{ operation: "fetch", handle, wait: 1500, apiKey: "server-owned-fixture-key" },
			{ operation: "cancel", handle, apiKey: "server-owned-fixture-key" },
		]);
		expect(requests.some((request) => request.target === "/api/cancel-deferred")).toBe(true);
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
	});

	it.each(["simple", "api", "image", "classifier"] as const)(
		"rejects custom fetch rather than executing inference locally for %s",
		async (kind) => {
			await expect(runLifecycleOperation(kind, { fetch })).rejects.toThrow(
				"Custom fetch functions cannot execute on pi-server",
			);
			expect(requests).toEqual([]);
		},
	);

	it("generates images from oversized inputs with server-only auth and preserves unrestricted response size", async () => {
		const context: ImagesContext = {
			input: [
				{ type: "text", text: "你".repeat(30_000) },
				{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" },
			],
		};
		const result = await generateImagesPiServer(imageModel, context, { metadata: { source: "codemode" } });
		expect(result).toMatchObject({ responseId: "image-result", usage, stopReason: "stop" });
		expect(result.output[0]).toMatchObject({ data: "A".repeat(100_000) });
		expect(imageCalls[0]).toMatchObject({ context, apiKey: "server-owned-fixture-key" });
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		expect(requests.some((request) => request.target === "/api/generate-images")).toBe(true);
	});

	it("classifies oversized states with server-only auth and preserves token usage", async () => {
		const context: ClassifierContext = {
			state: { text: "你".repeat(40_000) },
			questions: { approved: { type: "bool", instructions: "Approve?", criteria: { true: "yes", false: "no" } } },
		};
		const result = await classifyPiServer(classifierModel, context, { temperature: 0.25 });
		expect(result).toMatchObject({ answers: { approved: { type: "bool", probability: 0.95 } }, usage });
		expect(classifierCalls[0]).toMatchObject({ context, apiKey: "server-owned-fixture-key", temperature: 0.25 });
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		expect(requests.some((request) => request.target === "/api/classify")).toBe(true);
	});

	it("waits for acknowledged server image cancellation until provider cleanup finishes", async () => {
		let release: (() => void) | undefined;
		imageGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			imageStarted = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			imageAborted = resolve;
		});
		const controller = new AbortController();
		let settled = false;
		const call = generateImagesPiServer(
			imageModel,
			{ input: [{ type: "text", text: "draw" }] },
			{ signal: controller.signal },
		);
		const rejected = expect(call).rejects.toThrow();
		void call.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await started;
		controller.abort();
		await aborted;
		expect(settled).toBe(false);
		release?.();
		await rejected;
		expect(requests.some((request) => request.path.endsWith("/abort"))).toBe(true);
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
	});

	it("recovers the same image run when final result delivery is interrupted", async () => {
		disconnectOperationResult = true;
		const result = await generateImagesPiServer(imageModel, { input: [{ type: "text", text: "draw" }] });
		expect(result).toMatchObject({ responseId: "image-result", stopReason: "stop", usage });
		expect(imageCalls).toHaveLength(1);
		expect(requests.some((request) => request.path.includes("/runs/"))).toBe(true);
	});

	it("flushes image heartbeat before a pending provider operation settles", async () => {
		let release: (() => void) | undefined;
		imageGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const response = await fetch(`${baseUrl}/api/generate-images`, {
			method: "POST",
			headers: { Authorization: "Bearer transport-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "heartbeat",
				runId: "image",
				model: imageModel,
				context: { input: [{ type: "text", text: "draw" }] },
			}),
		});
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing image event stream body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(": keep-alive\n\n");
		release?.();
		const remaining: Uint8Array[] = [];
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			remaining.push(chunk.value);
		}
		expect(Buffer.concat(remaining).toString()).toContain("event: result");
	});

	it("rejects unsupported operation APIs explicitly after oversized chunk upload", async () => {
		await expect(
			classifyPiServer(
				{ ...classifierModel, provider: "unregistered-provider", api: "unsupported-classifier-api" },
				{ state: { text: "你".repeat(40_000) }, questions: {} },
			),
		).rejects.toThrow("No classifier API registered on pi-server: unsupported-classifier-api");
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
	});

	it("syncs full large trees without pruning sibling branches", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "root",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: { role: "user" as const, content: "你".repeat(40_000), timestamp: 1 },
			},
			{
				type: "message" as const,
				id: "sibling",
				parentId: "root",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user" as const, content: "sibling", timestamp: 2 },
			},
			{
				type: "message" as const,
				id: "active",
				parentId: "root",
				timestamp: "2026-01-01T00:00:02Z",
				message: { role: "user" as const, content: "active", timestamp: 3 },
			},
		];
		await syncPiServerTree("tree", { systemPrompt: "system", messages: [] }, { entries, leafId: "active" });
		expect(getSession("tree")?.entries).toEqual(entries);
		expect(getSession("tree")?.leafId).toBe("active");
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
	});

	it.each([
		["github-copilot", "claude-opus-5.5"],
		["github-copilot", "gpt-6-sol"],
		["github-copilot", "gpt-6-luna"],
		["openai", "gpt-6-sol"],
		["openai", "gpt-6-luna"],
		["openai-codex", "gpt-6-sol"],
		["openai-codex", "gpt-6-luna"],
		["anthropic", "claude-opus-5-5"],
		["anthropic", "claude-sonnet-5-5"],
		["xai", "grok-4.7"],
		["openai", "gpt-6.1-sol"],
		["azure", "gpt-6.1-sol"],
		["openai-codex", "gpt-6.1-sol"],
	] as const)("routes catalog feature %s/%s with complete model capabilities", async (provider, id) => {
		const model = getAllBuiltinModels(provider).find(
			(candidate) => isModelType(candidate, "chat") && candidate.provider === provider && candidate.id === id,
		);
		if (!model || !isModelType(model, "chat")) throw new Error(`Missing exact chat catalog model ${provider}/${id}`);
		registerApiProvider({ api: model.api, stream: fixture, streamSimple: fixture });
		models.setProvider(
			createProvider({
				id: model.provider,
				models: [model],
				auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: {} }) } },
				api: { stream: fixture, streamSimple: fixture },
			}),
		);
		function fixture(requestModel: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) {
			providerCalls.push({ model: requestModel, context, options });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: resultFor(requestModel) });
			stream.end();
			return stream;
		}
		const stream = await streamPiServer(
			model,
			{ messages: [{ role: "user", content: "你".repeat(30_000), timestamp: 1 }] },
			{ sessionId: `${provider}-${id}`, reasoning: "high", samplingParams: { top_p: 0.85 } },
		);
		expect((await stream.result()).model).toBe(id);
		expect(providerCalls[0].model).toEqual(model);
		expect(providerCalls[0].options).toMatchObject({ reasoning: "high", samplingParams: { top_p: 0.85 } });
		expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
		expect(requests.some((request) => request.target === "/api/stream")).toBe(true);
	});
});
