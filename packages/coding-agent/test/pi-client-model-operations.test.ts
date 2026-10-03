import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
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
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type ImageModel,
	InMemoryModelsStore,
	lazyStream,
	type Model,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllRequestChunks } from "../../pi-server/src/request-chunks.ts";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions } from "../../pi-server/src/session-store.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import type { McpExposure } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createTestUiContext } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const providerId = "remote-model-fixture";
const base = {
	id: "shared",
	name: "Shared",
	provider: providerId,
	baseUrl: "https://unused.invalid",
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const chat: Model<"fixture-chat"> = {
	...base,
	api: "fixture-chat",
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 1000,
};
const image: ImageModel<"fixture-image"> = {
	...base,
	type: "image",
	api: "fixture-image",
	input: ["text", "image"],
	output: ["image"],
};
const classifier: ClassifierModel<"fixture-classifier"> = {
	...base,
	type: "classifier",
	api: "fixture-classifier",
	contextWindow: 200_000,
};
const usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
const questions: ClassifierContext["questions"] = {
	approved: { type: "bool", instructions: "Approved?", criteria: { true: "yes", false: "no" } },
};

function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type), data]);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([size, body, checksum]);
}

const imageHeader = Buffer.alloc(13);
imageHeader.writeUInt32BE(128, 0);
imageHeader.writeUInt32BE(128, 4);
imageHeader[8] = 8;
imageHeader[9] = 6;
const pixels = Buffer.concat(Array.from({ length: 128 }, () => Buffer.concat([Buffer.from([0]), randomBytes(512)])));
const largePng = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	pngChunk("IHDR", imageHeader),
	pngChunk("IDAT", deflateSync(pixels)),
	pngChunk("IEND", Buffer.alloc(0)),
]).toString("base64");

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture listener");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("pi-client model operations through HTTP with a 65536-byte request limit", () => {
	let server: Server;
	let proxy: Server;
	let dir: string;
	let models: MutableModels;
	let rejected: boolean;
	let catalogGate: Promise<void> | undefined;
	let catalogStarted: (() => void) | undefined;
	let requests: { path: string; bytes: number; target?: string }[];
	let calls: { operation: string; apiKey?: string; payload: unknown }[];
	let responses: AssistantMessage[];
	let providerContexts: TranscriptContext[];
	let providerOptions: SimpleStreamOptions[];

	beforeEach(async () => {
		clearAllSessions();
		clearAllRequestChunks();
		resetAllSessionTracking();
		dir = mkdtempSync(join(tmpdir(), "pi-client-model-operations-"));
		requests = [];
		calls = [];
		responses = [];
		providerContexts = [];
		providerOptions = [];
		rejected = false;
		catalogGate = undefined;
		catalogStarted = undefined;
		models = createModels();
		models.setProvider(
			createProvider({
				id: providerId,
				models: [chat, image, classifier, { ...chat, id: "not-granted" }],
				auth: { apiKey: { name: "Server key", resolve: async () => ({ auth: { apiKey: "server-fixture-key" } }) } },
				api: {
					stream: fixtureStream,
					streamSimple: fixtureStream,
				},
				images: {
					"fixture-image": {
						generateImages: async (model, context, options): Promise<AssistantImages> => {
							calls.push({ operation: "image", apiKey: options?.apiKey, payload: context });
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								output: [{ type: "image", data: largePng, mimeType: "image/png" }],
								usage,
								stopReason: "stop",
								timestamp: 1,
							};
						},
					},
				},
				classifiers: {
					"fixture-classifier": {
						classify: async (model, context, options): Promise<ClassifierResult> => {
							calls.push({ operation: "classifier", apiKey: options?.apiKey, payload: context });
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: { approved: { type: "bool", probability: 0.8 } },
								usage,
								stopReason: "stop",
								timestamp: 1,
							};
						},
					},
				},
			}),
		);
		function fixtureStream(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) {
			calls.push({ operation: "chat", apiKey: options?.apiKey, payload: context });
			providerContexts.push(context);
			providerOptions.push(options ?? {});
			const stream = createAssistantMessageEventStream();
			const message = {
				...(responses.shift() ?? fauxAssistantMessage("remote reply")),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			void Promise.resolve(
				options?.onProviderStreamEvent?.({ type: "native-fixture-event", nativeField: "preserved" }, model),
			).then(
				() => {
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
					stream.end();
				},
				(error: unknown) => {
					stream.push({
						type: "error",
						reason: "error",
						error: { ...message, stopReason: "error", errorMessage: String(error) },
					});
					stream.end();
				},
			);
			return stream;
		}
		const provider = models.getProvider(providerId)!;
		models.setProvider({
			...provider,
			filterAllModels: (all) => all.filter((model) => model.id !== "not-granted"),
			filterModels: (all) => all.filter((model) => model.id !== "not-granted"),
		});
		server = createPiServer({ authToken: "fixture-proxy-token", sessionStoreDir: join(dir, "sessions") }, models);
		const serverUrl = await listen(server);
		proxy = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			requests.push({
				path: req.url ?? "/",
				bytes: body.length,
				target:
					req.url === "/api/request/chunk"
						? (JSON.parse(body.toString()) as { target: string }).target
						: undefined,
			});
			if (body.length > 65_536 || rejected) {
				res.writeHead(body.length > 65_536 ? 413 : 503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "fixture rejected request" }));
				return;
			}
			if (req.url === "/api/models" && catalogGate) {
				catalogStarted?.();
				await catalogGate;
				if (res.destroyed) return;
			}
			const controller = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) controller.abort();
			});
			try {
				const reply = await fetch(`${serverUrl}${req.url}`, {
					method: req.method,
					headers: { Authorization: req.headers.authorization ?? "", "Content-Type": "application/json" },
					body: req.method === "POST" ? body : undefined,
					signal: controller.signal,
				});
				res.writeHead(reply.status, { "Content-Type": reply.headers.get("Content-Type") ?? "application/json" });
				if (reply.body) for await (const chunk of reply.body) res.write(chunk);
				res.end();
			} catch (error) {
				if (!res.destroyed) {
					res.writeHead(502);
					res.end(String(error));
				}
			}
		});
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-proxy-token");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
	});

	afterEach(async () => {
		await close(proxy);
		await close(server);
		rmSync(dir, { recursive: true, force: true });
		clearAllSessions();
		clearAllRequestChunks();
		resetAllSessionTracking();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function createRuntime(credentials = AuthStorage.inMemory()): Promise<ModelRuntime> {
		return ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
	}

	it("uses server-only credentials, preserves model types and per-model availability, and caches catalog reads", async () => {
		const runtime = await createRuntime();
		expect(await runtime.listCredentials()).toEqual([]);
		const remoteProvider = runtime.getProvider(providerId)!;
		expect(remoteProvider.auth).toEqual({});
		expect(runtime.getProviders().some((provider) => provider.id === providerId)).toBe(true);
		expect(runtime.getModels(providerId).map((model) => model.id)).toEqual(["shared", "not-granted"]);
		expect(runtime.getAllModels(providerId).map((model) => model.type ?? "chat")).toEqual([
			"chat",
			"image",
			"classifier",
			"chat",
		]);
		expect((await runtime.getAllAvailable(providerId)).map((model) => model.type ?? "chat")).toEqual([
			"chat",
			"image",
			"classifier",
		]);
		expect((await runtime.getAvailableOfType("image", providerId))[0]?.id).toBe("shared");
		expect((await runtime.getAvailableOfType("classifier", providerId))[0]?.id).toBe("shared");
		expect(requests.filter((request) => request.path === "/api/models")).toHaveLength(1);
		const largeText = "你".repeat(30_000);
		const generated = await remoteProvider.generateImages!(runtime.getModelOfType("image", providerId, "shared")!, {
			input: [
				{ type: "text", text: largeText },
				{ type: "image", data: "A".repeat(90_000), mimeType: "image/png" },
			],
		});
		const classified = await runtime.classify(runtime.getModelOfType("classifier", providerId, "shared")!, {
			state: { text: largeText },
			questions,
		});
		expect(generated.output[0]).toMatchObject({ type: "image", data: largePng });
		expect(largePng.length).toBeGreaterThan(65_536);
		expect(classified).toMatchObject({ answers: { approved: { probability: 0.8 } }, usage });
		expect(calls.map((call) => [call.operation, call.apiKey])).toEqual([
			["image", "server-fixture-key"],
			["classifier", "server-fixture-key"],
		]);
		expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
		expect(requests.some((request) => request.target === "/api/generate-images")).toBe(true);
		expect(requests.some((request) => request.target === "/api/classify")).toBe(true);
		await runtime.refresh({ allowNetwork: false });
		expect(requests.filter((request) => request.path === "/api/models")).toHaveLength(2);
	});

	it("routes virtual models and direct extension streams remotely with exact API options", async () => {
		const runtime = await createRuntime();
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			thinkingLevels: ["high"],
			route: () => ({
				model: runtime.getModel(providerId, "shared")!,
				thinkingLevel: "high",
				state: { routed: true },
			}),
		});
		await runtime.refresh({ allowNetwork: false });
		const virtual = runtime.getModel("router", "auto")!;
		expect(runtime.hasConfiguredAuth("router")).toBe(true);
		expect(
			(
				await runtime.completeSimple(
					virtual,
					{ messages: [{ role: "user", content: "你".repeat(30_000), timestamp: 1 }] },
					{ maxTokens: 5000 },
				)
			).model,
		).toBe("shared");
		expect(providerOptions[0]).toMatchObject({ reasoning: "high", maxTokens: 1000 });
		expect(
			(
				await runtime.complete(
					runtime.getModel(providerId, "shared")!,
					{ messages: [] },
					{ custom_option: { budget: 20 } },
				)
			).stopReason,
		).toBe("stop");
		expect(providerOptions[1]).toMatchObject({ custom_option: { budget: 20 } });
		expect((await runtime.complete(virtual, { messages: [] })).errorMessage).toContain("must be routed");
		expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
	});

	it("delegates Provider inference methods remotely while preserving its local auth and metadata", async () => {
		const runtime = await createRuntime();
		let localCalls = 0;
		const forbidden = (): never => {
			localCalls++;
			throw new Error("Local inference is forbidden");
		};
		const native = createProvider({
			id: providerId,
			name: "Fixture account",
			models: [chat, image, classifier],
			auth: { apiKey: { name: "Local metadata", resolve: async () => ({ auth: { apiKey: "client-facade-key" } }) } },
			api: { stream: forbidden, streamSimple: forbidden },
			images: { "fixture-image": { generateImages: forbidden } },
			classifiers: { "fixture-classifier": { classify: forbidden } },
		});
		runtime.registerNativeProvider(native);
		await runtime.refresh({ allowNetwork: false });
		const provider = runtime.getProviders().find((provider) => provider.id === providerId)!;
		expect(provider.name).toBe("Fixture account");
		expect(provider.auth).toBe(native.auth);
		expect(provider.getAllModels?.()).toEqual([chat, image, classifier]);
		expect(
			(await provider.stream(chat, normalizeContext({ messages: [] }), { custom_option: "raw" }).result())
				.stopReason,
		).toBe("stop");
		expect(
			(await provider.streamSimple(chat, normalizeContext({ messages: [] }), { reasoning: "high" }).result())
				.stopReason,
		).toBe("stop");
		expect((await provider.generateImages!(image, { input: [{ type: "text", text: "circle" }] })).stopReason).toBe(
			"stop",
		);
		expect((await provider.classify!(classifier, { state: {}, questions })).stopReason).toBe("stop");
		expect(localCalls).toBe(0);
		expect(calls.map((call) => call.operation)).toEqual(["chat", "chat", "image", "classifier"]);
	});

	it("applies merged header transforms once and explicitly rejects custom fetch without inference", async () => {
		const runtime = await createRuntime();
		runtime.registerNativeProvider(
			createProvider({
				id: providerId,
				models: [chat, image, classifier],
				api: {
					stream: () => {
						throw new Error("Local inference is forbidden");
					},
					streamSimple: () => {
						throw new Error("Local inference is forbidden");
					},
				},
				auth: {
					apiKey: {
						name: "Configured",
						resolve: async () => ({
							auth: { apiKey: "client-header-key", headers: { "X-Configured": "configured" } },
						}),
					},
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false });
		const transform = vi.fn((headers: Record<string, string | null>) => ({ ...headers, "X-Transformed": "done" }));
		expect(
			(
				await runtime.completeSimple(
					{ ...chat, headers: { "X-Model": "model" } },
					{ messages: [] },
					{ headers: { "X-Caller": "caller" }, transformHeaders: transform },
				)
			).stopReason,
		).toBe("stop");
		expect(transform).toHaveBeenCalledExactlyOnceWith({
			"X-Model": "model",
			"X-Configured": "configured",
			"X-Caller": "caller",
		});
		expect(providerOptions[0].headers).toMatchObject({
			"X-Configured": "configured",
			"X-Caller": "caller",
			"X-Transformed": "done",
			"X-Model": "model",
		});
		expect(providerOptions[0]).not.toHaveProperty("transformHeaders");
		const fetch = vi.fn(() => Promise.resolve(Response.json({})));
		const chatFailure = await runtime.completeSimple(chat, { messages: [] }, { fetch });
		const imageFailure = await runtime.generateImages(
			image,
			{ input: [{ type: "text", text: "circle" }] },
			{ fetch },
		);
		const classifierFailure = await runtime.classify(classifier, { state: {}, questions }, { fetch });
		for (const failure of [chatFailure, imageFailure, classifierFailure]) {
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toContain("does not support custom fetch");
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
	});

	it("awaits remote lifecycle callbacks and chunks their replacement payloads for every operation", async () => {
		const provider = models.getProvider(providerId)!;
		const replacements: unknown[] = [];
		async function callbacks<TModel extends AnyModel>(model: TModel, options?: ProviderRequestOptions<TModel>) {
			replacements.push(await options?.onPayload?.({ original: true }, model));
			await options?.onResponse?.({ status: 201, headers: { "x-fixture": "response" } }, model);
		}
		models.setProvider({
			...provider,
			stream: (model, context, options) =>
				lazyStream(model, async () => {
					await callbacks(model, options);
					return provider.stream(model, context, options);
				}),
			streamSimple: (model, context, options) =>
				lazyStream(model, async () => {
					await callbacks(model, options);
					return provider.streamSimple(model, context, options);
				}),
			generateImages: async (model, context, options) => {
				await callbacks(model, options);
				return provider.generateImages!(model, context, options);
			},
			classify: async (model, context, options) => {
				await callbacks(model, options);
				return provider.classify!(model, context, options);
			},
		});
		const runtime = await createRuntime();
		const payload = { unicode: "你".repeat(30_000) };
		const observed: string[] = [];
		const onPayload = vi.fn(async (original: unknown, model: AnyModel) => {
			expect(original).toEqual({ original: true });
			observed.push(model.type ?? "chat");
			return payload;
		});
		const onResponse = vi.fn(async (response: { status: number; headers: Record<string, string> }) => {
			expect(response).toEqual({ status: 201, headers: { "x-fixture": "response" } });
		});
		const options = { onPayload, onResponse };
		expect((await runtime.complete(chat, { messages: [] }, options)).stopReason).toBe("stop");
		expect((await runtime.completeSimple(chat, { messages: [] }, options)).stopReason).toBe("stop");
		expect(
			(await runtime.generateImages(image, { input: [{ type: "text", text: "circle" }] }, options)).stopReason,
		).toBe("stop");
		expect((await runtime.classify(classifier, { state: {}, questions }, options)).stopReason).toBe("stop");
		expect(observed).toEqual(["chat", "chat", "image", "classifier"]);
		expect(replacements).toEqual([payload, payload, payload, payload]);
		expect(onResponse).toHaveBeenCalledTimes(4);
		const failed = await runtime.completeSimple(
			chat,
			{ messages: [] },
			{
				onPayload: () => {
					throw new Error("client callback failed");
				},
			},
		);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("client callback failed");
		expect(requests.some((request) => request.target === "/api/provider-callback")).toBe(true);
		expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
	});

	it("fetches and cancels deferred responses remotely through runtime and Provider methods", async () => {
		const provider = models.getProvider(providerId)!;
		const fetched: DeferredHandle[] = [];
		const cancelled: DeferredHandle[] = [];
		models.setProvider({
			...provider,
			fetchDeferred: (model, handle, options) =>
				lazyStream(model, async () => {
					fetched.push(handle);
					expect(options).toMatchObject({ apiKey: "server-fixture-key", wait: 5 });
					await options?.onResponse?.({ status: 200, headers: {} }, model);
					return provider.streamSimple(model, normalizeContext({ messages: [] }));
				}),
			cancelDeferred: async (model, handle, options) => {
				cancelled.push(handle);
				expect(options?.apiKey).toBe("server-fixture-key");
				await options?.onPayload?.({ id: handle.id }, model);
			},
		});
		const runtime = await createRuntime();
		let localCalls = 0;
		const forbidden = (): never => {
			localCalls++;
			throw new Error("Local inference is forbidden");
		};
		runtime.registerNativeProvider({ ...provider, fetchDeferred: forbidden, cancelDeferred: forbidden });
		await runtime.refresh({ allowNetwork: false });
		const facade = runtime.getProvider(providerId)!;
		const handle: DeferredHandle = {
			provider: providerId,
			modelId: chat.id,
			api: chat.api,
			id: "pending",
			data: { unicode: "你".repeat(30_000) },
		};
		const onResponse = vi.fn();
		expect((await runtime.fetchDeferred(chat, handle, { wait: 5, onResponse })).stopReason).toBe("stop");
		expect((await facade.fetchDeferred!(chat, handle, { wait: 5, onResponse }).result()).stopReason).toBe("stop");
		const onPayload = vi.fn(() => ({ large: "你".repeat(30_000) }));
		await runtime.cancelDeferred(chat, handle, { onPayload });
		await facade.cancelDeferred!(chat, handle, { onPayload });
		expect(fetched).toEqual([handle, handle]);
		expect(cancelled).toEqual([handle, handle]);
		expect(localCalls).toBe(0);
		expect(onResponse).toHaveBeenCalledTimes(2);
		expect(onPayload).toHaveBeenCalledTimes(2);
		expect(requests.some((request) => request.target === "/api/cancel-deferred")).toBe(true);
		expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
	});

	it("keeps client-auth-only built-in models available and forwards their explicit credentials", async () => {
		const builtin = builtinProviderCatalog
			.getAllBuiltinModels("openrouter")
			.find((model) => model.type === "image") as ImageModel<string>;
		if (!builtin) throw new Error("Missing OpenRouter image fixture model");
		models.setProvider(
			createProvider({
				id: "openrouter",
				models: [builtin],
				auth: {
					apiKey: {
						name: "OpenRouter fixture",
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key } } : undefined,
					},
				},
				images: {
					[builtin.api]: {
						generateImages: async (model, _context, options) => {
							calls.push({ operation: "image", apiKey: options?.apiKey, payload: {} });
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								output: [],
								stopReason: "stop",
								timestamp: 1,
							};
						},
					},
				},
			}),
		);
		const credentials = AuthStorage.inMemory();
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: "client-fixture-key" }));
		const runtime = await createRuntime(credentials);
		expect((await runtime.getAvailableOfType("image", "openrouter")).some((model) => model.id === builtin.id)).toBe(
			true,
		);
		expect(
			(
				await runtime.generateImages(runtime.getModelOfType("image", "openrouter", builtin.id)!, {
					input: [{ type: "text", text: "circle" }],
				})
			).stopReason,
		).toBe("stop");
		expect(calls[0].apiKey).toBe("client-fixture-key");
	});

	it("preserves native client account model discovery without using the public catalog overlay", async () => {
		let discovered: Model<string>[] = [];
		const dynamic: Provider = {
			id: "native-client",
			name: "Native",
			auth: {
				apiKey: {
					name: "Account",
					resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
				},
			},
			getModels: () => discovered,
			stream: () => {
				throw new Error("Local inference is forbidden");
			},
			streamSimple: () => {
				throw new Error("Local inference is forbidden");
			},
			refreshModels: async (context) => {
				if (!context.allowNetwork) return;
				await context.publish({
					update: () => {
						discovered = [{ ...chat, provider: "native-client", id: "account-discovered" }];
					},
				});
			},
		};
		const builtin = builtinProviderCatalog.builtinProviders();
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockReturnValue([...builtin, dynamic]);
		const credentials = AuthStorage.inMemory();
		await credentials.modify("native-client", async () => ({ type: "api_key", key: "account-key" }));
		const runtime = await createRuntime(credentials);
		await runtime.refresh({ allowNetwork: true, providers: ["native-client"] });
		expect(runtime.getModel("native-client", "account-discovered")).toEqual(discovered[0]);
		expect((await runtime.getAvailable("native-client"))[0]?.id).toBe("account-discovered");
		expect(requests.every((request) => !request.path.startsWith("/api/models/providers/"))).toBe(true);
	});

	it.each(["local-llama-fixture", "openai", providerId])(
		"runs an explicitly registered llama.cpp classifier API for %s at the supplied remote base URL",
		async (llamaProviderId) => {
			if (llamaProviderId === "openai") {
				const openai = builtinProviderCatalog.builtinProviders().find((provider) => provider.id === "openai");
				if (!openai) throw new Error("Missing built-in OpenAI provider");
				models.setProvider(openai);
			}
			const llamaRequests: { path: string; authorization: string | undefined }[] = [];
			const llama = createServer(async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString()) as {
					content?: string;
					messages?: { role: string; content: string }[];
				};
				llamaRequests.push({ path: req.url ?? "", authorization: req.headers.authorization });
				res.writeHead(200, { "Content-Type": "application/json" });
				if (req.url === "/tokenize") {
					const tokens = (body.content ?? "")
						.split(/(\n)/u)
						.flatMap((part) =>
							part === "Yes"
								? [89]
								: part === "No"
									? [78]
									: [...part].map((character) => character.codePointAt(0)!),
						);
					res.end(JSON.stringify({ tokens }));
				} else if (req.url === "/apply-template") {
					res.end(
						JSON.stringify({
							prompt: `${body.messages?.map((message) => `<|${message.role}|>\n${message.content}`).join("\n")}\n<|assistant|>\n`,
						}),
					);
				} else if (req.url === "/completion") {
					res.end(
						JSON.stringify({
							content: "Yes",
							completion_probabilities: [
								{
									id: 89,
									token: "Yes",
									top_logprobs: [
										{ id: 89, token: "Yes", bytes: [], logprob: Math.log(0.8) },
										{ id: 78, token: "No", bytes: [], logprob: Math.log(0.2) },
									],
								},
							],
						}),
					);
				} else {
					res.end(JSON.stringify({ error: "Unknown llama fixture endpoint" }));
				}
			});
			const llamaUrl = await listen(llama);
			try {
				const runtime = await createRuntime();
				let localCalls = 0;
				const model: ClassifierModel<"llama-cpp-classify"> = {
					...classifier,
					provider: llamaProviderId,
					id: "qwen",
					api: "llama-cpp-classify",
					baseUrl: `${llamaUrl}/v1`,
				};
				runtime.registerNativeProvider(
					createProvider({
						id: model.provider,
						models: [model],
						auth: {
							apiKey: {
								name: "Llama fixture",
								resolve: async () => ({ auth: { apiKey: "llama-fixture-key" } }),
							},
						},
						classifiers: {
							"llama-cpp-classify": {
								classify: async () => {
									localCalls++;
									throw new Error("Local inference is forbidden");
								},
							},
						},
					}),
				);
				await runtime.refresh({ allowNetwork: false });
				expect((await runtime.getAvailableOfType("classifier", model.provider))[0]).toEqual(model);
				const result = await runtime.classify(model, { state: { text: "你".repeat(30_000) }, questions });
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
				expect(localCalls).toBe(0);
				expect(llamaRequests.map((request) => request.path)).toEqual(
					expect.arrayContaining(["/tokenize", "/apply-template", "/completion"]),
				);
				expect(llamaRequests.every((request) => request.authorization === "Bearer llama-fixture-key")).toBe(true);
				expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
				expect(requests.some((request) => request.target === "/api/classify")).toBe(true);
			} finally {
				await close(llama);
			}
		},
	);

	it("uses advertised server-only Provider deferred capabilities without local registration", async () => {
		const provider = models.getProvider(providerId)!;
		const fetched: DeferredHandle[] = [];
		const cancelled: DeferredHandle[] = [];
		models.setProvider({
			...provider,
			fetchDeferred: (model, handle) => {
				fetched.push(handle);
				return provider.streamSimple(model, normalizeContext({ messages: [] }));
			},
			cancelDeferred: async (_model, handle) => {
				cancelled.push(handle);
			},
		});
		const runtime = await createRuntime();
		expect(await runtime.listCredentials()).toEqual([]);
		const facade = runtime.getProvider(providerId)!;
		expect(facade.fetchDeferred).toBeTypeOf("function");
		expect(facade.cancelDeferred).toBeTypeOf("function");
		const handle: DeferredHandle = { provider: providerId, modelId: chat.id, api: chat.api, id: "server-only-job" };
		expect((await facade.fetchDeferred!(chat, handle).result()).stopReason).toBe("stop");
		await facade.cancelDeferred!(chat, handle);
		expect(fetched).toEqual([handle]);
		expect(cancelled).toEqual([handle]);
	});

	it("updates registrations and authentication locally while the server catalog is unavailable", async () => {
		const runtime = await createRuntime();
		const initialReads = requests.filter((request) => request.path === "/api/models").length;
		rejected = true;
		runtime.registerNativeProvider(
			createProvider({
				id: "registered-account",
				models: [{ ...chat, provider: "registered-account" }],
				auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "local-account-key" } }) } },
				api: {
					stream: () => {
						throw new Error("Local inference is forbidden");
					},
					streamSimple: () => {
						throw new Error("Local inference is forbidden");
					},
				},
			}),
		);
		expect((await runtime.getAllAvailable("registered-account"))[0]?.id).toBe("shared");
		runtime.unregisterProvider("registered-account");
		expect(await runtime.getAllAvailable("registered-account")).toEqual([]);
		runtime.registerVirtualModel({
			provider: "registered-router",
			id: "router",
			name: "Router",
			route: () => ({ model: chat, thinkingLevel: "off" }),
		});
		expect((await runtime.getAvailable("registered-router"))[0]?.id).toBe("router");
		runtime.unregisterVirtualModel("registered-router", "router");
		expect(await runtime.getAvailable("registered-router")).toEqual([]);
		expect(requests.filter((request) => request.path === "/api/models")).toHaveLength(initialReads);
		expect(runtime.getError()).toBeUndefined();
		const refresh = await runtime.refresh({ allowNetwork: false });
		expect(refresh.errors.get("pi-server")?.message).toContain("503");
		expect(runtime.getError()).toContain("503");
	});

	it("returns cancellation in the refresh result without changing the verified catalog", async () => {
		const runtime = await createRuntime();
		const before = runtime.getAllModels(providerId);
		const controller = new AbortController();
		let release: (() => void) | undefined;
		catalogGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			catalogStarted = resolve;
		});
		try {
			const refreshed = runtime.refresh({ allowNetwork: false, signal: controller.signal });
			await started;
			controller.abort();
			expect(await refreshed).toEqual({ aborted: true, errors: new Map() });
			expect(runtime.getAllModels(providerId)).toEqual(before);
			expect(runtime.getError()).toBeUndefined();
			expect(await runtime.refresh({ signal: controller.signal })).toEqual({ aborted: true, errors: new Map() });
		} finally {
			release?.();
		}
	});

	it("keeps server native catalog metadata when the client has no account credential", async () => {
		const fallback = { ...chat, provider: "native-metadata", contextWindow: 1000, maxTokens: 10 };
		const native: Provider = {
			id: fallback.provider,
			name: "Native metadata",
			auth: {
				apiKey: {
					name: "Account",
					resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
				},
			},
			getModels: () => [fallback],
			refreshModels: async () => {},
			stream: () => {
				throw new Error("Local inference is forbidden");
			},
			streamSimple: () => {
				throw new Error("Local inference is forbidden");
			},
		};
		const builtin = builtinProviderCatalog.builtinProviders();
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockReturnValue([...builtin, native]);
		const discovered = {
			...fallback,
			contextWindow: 200000,
			maxTokens: 12000,
			baseUrl: "https://account-server.invalid",
		};
		models.setProvider(
			createProvider({
				id: native.id,
				models: [discovered],
				auth: {
					apiKey: { name: "Server account", resolve: async () => ({ auth: { apiKey: "server-native-key" } }) },
				},
				api: { stream: native.stream, streamSimple: native.streamSimple },
			}),
		);
		const runtime = await createRuntime();
		expect(runtime.getModel(native.id, discovered.id)).toEqual(discovered);
		expect((await runtime.getAvailable(native.id))[0]).toEqual(discovered);
	});

	it("reports remote errors without falling back to a client provider implementation", async () => {
		const runtime = await createRuntime();
		let localCalls = 0;
		runtime.registerNativeProvider(
			createProvider({
				id: providerId,
				models: [image],
				auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
				images: {
					"fixture-image": {
						generateImages: async () => {
							localCalls++;
							throw new Error("Local inference is forbidden");
						},
					},
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false });
		rejected = true;
		const result = await runtime.generateImages(runtime.getModelOfType("image", providerId, "shared")!, {
			input: [{ type: "text", text: "circle" }],
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("503");
		expect(localCalls).toBe(0);
		const refreshed = await runtime.refresh({ allowNetwork: false });
		expect(refreshed.aborted).toBe(false);
		expect(refreshed.errors.get("pi-server")?.message).toContain("503");
		expect(runtime.getError()).toContain("503");
		await expect(createRuntime()).rejects.toThrow("503");
	});

	it("runs codemode image/classifier calls in a remote session and records their complete usage", async () => {
		const runtime = await createRuntime();
		const extensionsResult = await createTestExtensionsResult([createCodemodeExtension()], dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			model: runtime.getModel(providerId, "shared"),
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			session.setActiveToolsByName(["codemode"]);
			responses.push(
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: `const painter = (await models.getAvailableOfType("image", "${providerId}"))[0]; const judge = (await models.getAvailableOfType("classifier", "${providerId}"))[0]; const [generated, classified] = await Promise.all([models.generateImages(painter, { input: [{ type: "text", text: "你".repeat(30000) }] }), models.classify(judge, { state: { text: "你".repeat(30000) }, questions: ${JSON.stringify(questions)} })]); image(generated.output[0]); text(classified.answers.approved.probability);`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			);
			await session.prompt("paint and classify");
			const result = session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "codemode",
			);
			if (!result || result.role !== "toolResult") throw new Error("Missing codemode result");
			expect(
				result.isError,
				result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			).toBe(false);
			expect(result.content).toEqual(
				expect.arrayContaining([
					{ type: "image", data: largePng, mimeType: "image/png" },
					{ type: "text", text: "0.8" },
				]),
			);
			expect(result.usage).toMatchObject({ input: 20, totalTokens: 38, cost: { total: 2 } });
			expect(session.getSessionStats().cost).toBe(2);
			const sampling = getCurrentTools(providerContexts[0].messages).find(
				(tool) => tool.name === "codemode",
			)?.constrainedSampling;
			expect(typeof sampling === "object" ? sampling.type : sampling).toBe("grammar");
			expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
			expect(requests.filter((request) => request.path === "/api/models")).toHaveLength(1);
		} finally {
			session.dispose();
		}
	});

	it("delivers parsed native provider events to remote session extension handlers", async () => {
		const observed: unknown[] = [];
		const runtime = await createRuntime();
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("provider_stream_event", (event) => {
						observed.push(event);
					});
				},
			],
			dir,
		);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			model: runtime.getModel(providerId, "shared"),
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			await session.prompt("observe provider data");
			expect(observed).toEqual([
				{
					type: "provider_stream_event",
					provider: providerId,
					api: chat.api,
					model: chat.id,
					data: { type: "native-fixture-event", nativeField: "preserved" },
				},
			]);
			expect(session.messages.find((message) => message.role === "assistant")?.content).toEqual([
				{ type: "text", text: "remote reply" },
			]);
		} finally {
			session.dispose();
		}
	});

	it("keeps provider-backed MCP authentication local and reads refreshed credentials on each HTTP request", async () => {
		const authProvider = "mcp-account-fixture";
		const tokens: string[] = [];
		const mcp = createServer(async (req, res) => {
			tokens.push(req.headers.authorization ?? "");
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const request = JSON.parse(Buffer.concat(chunks).toString()) as JsonRpcRequest;
			if (!("id" in request)) {
				res.writeHead(202);
				res.end();
				return;
			}
			let result: unknown;
			if (request.method === "initialize")
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "account", version: "1.0" },
				};
			else if (request.method === "tools/list")
				result = {
					tools: [
						{
							name: "echo",
							inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
						},
					],
				};
			else if (request.method === "tools/call")
				result = {
					content: [{ type: "text", text: (request.params as { arguments: { text: string } }).arguments.text }],
				};
			else result = {};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
		});
		const mcpUrl = await listen(mcp);
		const credentials = AuthStorage.inMemory();
		await credentials.modify(authProvider, async () => ({
			type: "oauth",
			access: "account-token-one",
			refresh: "refresh-fixture",
			expires: Date.now() + 3_600_000,
		}));
		const runtime = await createRuntime(credentials);
		runtime.registerNativeProvider({
			id: authProvider,
			name: "MCP account",
			auth: {
				oauth: {
					name: "MCP account",
					login: async () => {
						throw new Error("Fixture does not sign in externally");
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("Local inference is forbidden");
			},
			streamSimple: () => {
				throw new Error("Local inference is forbidden");
			},
		});
		await runtime.refresh({ allowNetwork: false });
		const extensionsResult = await createTestExtensionsResult(
			[
				createMcpExtension({
					loadConfig: () => ({
						servers: [
							{
								name: "account",
								source: "fixture",
								scope: "extension",
								config: { url: mcpUrl, exposure: "direct", auth: { provider: authProvider } },
							},
						],
						errors: [],
					}),
				}),
			],
			dir,
		);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			model: runtime.getModel(providerId, "shared"),
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			session.setActiveToolsByName([]);
			await session.bindExtensions({ uiContext: createTestUiContext() });
			await vi.waitFor(() =>
				expect(session.getAllTools().some((tool) => tool.name === "mcp__account__echo")).toBe(true),
			);
			responses.push(
				fauxAssistantMessage([fauxToolCall("mcp__account__echo", { text: "first" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			);
			await session.prompt("first account request");
			expect(tokens.every((token) => token === "Bearer account-token-one")).toBe(true);
			tokens.length = 0;
			await credentials.modify(authProvider, async () => ({
				type: "oauth",
				access: "account-token-two",
				refresh: "refresh-fixture",
				expires: Date.now() + 3_600_000,
			}));
			responses.push(
				fauxAssistantMessage([fauxToolCall("mcp__account__echo", { text: "second" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			);
			await session.prompt("refreshed account request");
			expect(tokens).toContain("Bearer account-token-two");
			expect(tokens.every((token) => token === "Bearer account-token-two")).toBe(true);
			expect(
				calls.filter((call) => call.operation === "chat").every((call) => call.apiKey === "server-fixture-key"),
			).toBe(true);
		} finally {
			session.dispose();
			await close(mcp);
		}
	});

	it.each(["direct", "codemode", "deferred"] as const)(
		"supports %s MCP exposure across remote provider turns",
		async (exposure: McpExposure) => {
			const mcpCalls: string[] = [];
			const pair = createInMemoryTransportPair();
			pair.server.onMessage((message) => {
				if (!("id" in message) || !("method" in message)) return;
				const request = message as JsonRpcRequest;
				let result: unknown;
				if (request.method === "initialize")
					result = {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "docs", version: "1.0" },
						instructions: "Search before reading.",
					};
				else if (request.method === "tools/list")
					result = {
						tools: [
							{
								name: "search",
								description: `Search product documents.\n\n${"d".repeat(80_000)}`,
								inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
								outputSchema: {
									type: "object",
									properties: { query: { type: "string" } },
									required: ["query"],
								},
								annotations: { readOnlyHint: true },
							},
						],
					};
				else if (request.method === "tools/call") {
					const params = request.params as { name: string; arguments: { query: string } };
					mcpCalls.push(params.arguments.query);
					result = {
						content: [{ type: "text", text: `found ${params.arguments.query}` }],
						structuredContent: { query: params.arguments.query },
					};
				} else result = {};
				void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
			});
			await pair.server.start();
			const runtime = await createRuntime();
			const extensionsResult = await createTestExtensionsResult(
				[
					createCodemodeExtension(),
					createToolSearchExtension(),
					createMcpExtension({
						loadConfig: () => ({
							servers: [
								{
									name: "my-docs",
									source: "fixture",
									config: { url: "http://unused.invalid", exposure, description: "Product documents" },
								},
							],
							errors: [],
						}),
						createTransport: () => pair.client,
					}),
				],
				dir,
			);
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				model: runtime.getModel(providerId, "shared"),
				sessionManager: SessionManager.inMemory(dir),
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader({ extensionsResult }),
			});
			try {
				session.setActiveToolsByName([]);
				await session.bindExtensions({ uiContext: createTestUiContext() });
				await vi.waitFor(() =>
					expect(session.getAllTools().some((tool) => tool.name === "mcp__my_docs__search")).toBe(true),
				);
				if (exposure === "direct")
					responses.push(
						fauxAssistantMessage([fauxToolCall("mcp__my_docs__search", { query: "direct" })], {
							stopReason: "toolUse",
						}),
					);
				if (exposure === "deferred")
					responses.push(
						fauxAssistantMessage([fauxToolCall("tool_search", { query: "Search product documents", limit: 1 })], {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage([fauxToolCall("mcp__my_docs__search", { query: "deferred" })], {
							stopReason: "toolUse",
						}),
					);
				if (exposure === "codemode")
					responses.push(
						fauxAssistantMessage(
							[
								fauxToolCall("codemode", {
									code: `const namespace = await describeNamespace("my_docs"); const tool = (await searchTools("Search product documents", { namespace: namespace.name, limit: 1 }))[0]; const [a,b] = await Promise.all([tools[tool.name]({ query: "one" }), tools[tool.name]({ query: "two" })]); text([namespace.name, a.structuredContent.query, b.structuredContent.query]);`,
								}),
							],
							{ stopReason: "toolUse" },
						),
					);
				responses.push(fauxAssistantMessage("done"));
				await session.prompt("search docs");
				expect(mcpCalls).toEqual(exposure === "codemode" ? ["one", "two"] : [exposure]);
				expect(
					session.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError),
				).toBe(true);
				const initial = getCurrentTools(providerContexts[0].messages).map((tool) => tool.name);
				if (exposure === "direct") expect(initial).toContain("mcp__my_docs__search");
				if (exposure === "codemode") {
					expect(initial).toEqual(["codemode"]);
					expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
					expect(session.getAllTools().find((tool) => tool.name === "mcp__my_docs__search")?.annotations).toEqual({
						readOnlyHint: true,
					});
				}
				if (exposure === "deferred") {
					expect(initial).toEqual(["tool_search"]);
					expect(getCurrentTools(providerContexts[1].messages).map((tool) => tool.name)).toContain(
						"mcp__my_docs__search",
					);
					const branch = session.sessionManager.getBranch();
					const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
					const leaf = branch.at(-1);
					if (!user || !leaf) throw new Error("Missing MCP session entries");
					await session.navigateTree(user.id);
					expect(session.getActiveToolNames()).not.toContain("mcp__my_docs__search");
					await session.navigateTree(leaf.id);
					expect(session.getActiveToolNames()).toContain("mcp__my_docs__search");
				}
				expect(requests.every((request) => request.bytes <= 65_536)).toBe(true);
				if (exposure !== "codemode")
					expect(
						requests.some(
							(request) => request.target === "/api/stream" || request.target === "/api/session/init",
						),
					).toBe(true);
			} finally {
				session.dispose();
			}
		},
	);
});
