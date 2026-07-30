import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrepareNextTurnContext, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { hashPiServerCompactRequest } from "../src/core/pi-server-client.ts";
import {
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	PI_SERVER_EMPTY_TREE_HASH,
	PI_SERVER_PROTOCOL_VERSION,
} from "../src/core/pi-server-protocol.ts";
import { assertPiServerProviderExecution } from "../src/core/pi-server-provider-execution.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let previousPiServerMode: string | undefined;

	beforeEach(() => {
		previousPiServerMode = process.env.PI_SERVER_MODE;
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (previousPiServerMode === undefined) {
			delete process.env.PI_SERVER_MODE;
		} else {
			process.env.PI_SERVER_MODE = previousPiServerMode;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message = createDoneMessage(api);
		stream.end(message);
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionSource?: string,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		if (extensionSource) {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "headers.ts"), extensionSource);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, requestOptions);
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("uses a later main stream replacement for native auxiliary compaction", async () => {
		delete process.env.PI_SERVER_MODE;
		const model = createModel("openai-completions");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let registeredProviderCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				registeredProviderCalls++;
				return createDoneStream(model.api);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager,
		});
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const assistant = createDoneMessage(model.api, "assistant response to compact");
		assistant.timestamp = now - 500;
		assistant.usage = {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		sessionManager.appendMessage(assistant);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		let replacementCalls = 0;
		session.agent.streamFunction = (requestModel) => {
			replacementCalls++;
			const stream = createAssistantMessageEventStream();
			stream.end(createDoneMessage(requestModel.api, "summary from replacement stream"));
			return stream;
		};

		try {
			const result = await session.compact();

			expect(result?.summary).toContain("summary from replacement stream");
			expect(replacementCalls).toBe(1);
			expect(registeredProviderCalls).toBe(0);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("applies the credential-scoped baseUrl to the pi-server request model", async () => {
		const model = createModel("openai-completions");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			models: [
				{
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				},
			],
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		const expectedProviderExecutionFingerprint = assertPiServerProviderExecution(
			modelRuntime,
			model,
		).providerExecutionFingerprint;
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({
			auth: {
				apiKey: "credential-api-key",
				baseUrl: "https://credential-endpoint.invalid/v1",
			},
		});
		let requestModel: Record<string, unknown> | undefined;
		let providerExecutionFingerprint: unknown;
		let compactProviderExecutionFingerprint: unknown;
		let serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		let serverStaticContextHash = "";
		let revision = 0;
		let streamRunId = "";
		let streamRequestMac = "";

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>;
				if (url.endsWith("/api/stream")) {
					requestModel = body.model as Record<string, unknown>;
					providerExecutionFingerprint = body.providerExecutionFingerprint;
					streamRunId = body.runId as string;
					const { eventCursor: _eventCursor, runId: _runId, ...requestIdentity } = body;
					const serializedIdentity = canonicalJsonStringify(requestIdentity);
					if (serializedIdentity === undefined) throw new Error("Failed to serialize mock stream identity");
					streamRequestMac = createHash("sha256").update(serializedIdentity).digest("hex");
					return new Response(
						`data: ${JSON.stringify({
							type: "done",
							reason: "stop",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
							diagnostics: [
								{
									type: "pi_server_run",
									timestamp: Date.now(),
									details: {
										sessionId: body.sessionId,
										runId: streamRunId,
										requestMac: streamRequestMac,
									},
								},
							],
						})}\n\n`,
						{ status: 200, headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (url.endsWith("/api/session/run/ack")) {
					return new Response(
						JSON.stringify({
							acknowledged: true,
							sessionId: body.sessionId,
							runId: streamRunId,
							requestMac: streamRequestMac,
							status: "completed",
							acknowledgedAt: Date.now(),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.endsWith("/api/session/compact")) {
					compactProviderExecutionFingerprint = body.providerExecutionFingerprint;
					const requestHash = hashPiServerCompactRequest(
						body as unknown as Parameters<typeof hashPiServerCompactRequest>[0],
					);
					return new Response(
						JSON.stringify({
							protocolVersion: PI_SERVER_PROTOCOL_VERSION,
							sessionId: body.sessionId,
							operationId: body.operationId,
							requestHash,
							status: "rejected",
							httpStatus: 400,
							operationDisposition: "not_started",
							error: "stop after compact request capture",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.endsWith("/api/session/init")) {
					serverStaticContextHash = body.staticContextHash as string;
				}
				if (url.endsWith("/api/session/tree/append") || url.endsWith("/api/session/tree/sync")) {
					const entries = body.entries as SessionTreeEntry[] | undefined;
					serverEntries = url.endsWith("/append") ? [...serverEntries, ...(entries ?? [])] : (entries ?? []);
					serverLeafId = (body.leafId as string | null | undefined) ?? null;
					revision++;
				}
				return new Response(
					JSON.stringify({
						protocolVersion: PI_SERVER_PROTOCOL_VERSION,
						sessionId: body.sessionId,
						staticContextHash: serverStaticContextHash,
						staticContextRequired: false,
						treeHash:
							serverEntries.length > 0 ? hashPiServerSessionEntries(serverEntries) : PI_SERVER_EMPTY_TREE_HASH,
						messageCount: 0,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);
		process.env.PI_SERVER_MODE = "true";
		const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
		sessionManager.appendMessage({ role: "user", content: "first persisted turn", timestamp: Date.now() - 4 });
		sessionManager.appendMessage(createDoneMessage(model.api, "first persisted answer"));
		sessionManager.appendMessage({ role: "user", content: "second persisted turn", timestamp: Date.now() - 2 });
		sessionManager.appendMessage(createDoneMessage(model.api, "second persisted answer"));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			sessionManager,
		});

		try {
			await session.prompt("capture provider request");
			await session.agent.waitForIdle();
			await expect(session.compact()).rejects.toThrow("stop after compact request capture");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}

		expect(requestModel).toMatchObject({
			id: model.id,
			baseUrl: "https://credential-endpoint.invalid/v1",
		});
		expect(providerExecutionFingerprint).toBe(expectedProviderExecutionFingerprint);
		expect(compactProviderExecutionFingerprint).toBe(expectedProviderExecutionFingerprint);
		expect(model.baseUrl).toBe("https://capture.invalid/v1");
	});

	it("rejects a custom provider executor before auth or pi-server network I/O", async () => {
		const model = createModel("openai-completions");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => createDoneStream(model.api),
			models: [
				{
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		process.env.PI_SERVER_MODE = "true";
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 1000 },
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const sessionEvents: string[] = [];
		session.subscribe((event) => sessionEvents.push(event.type));
		const entryCount = session.sessionManager.getEntries().length;

		try {
			await expect(session.agent.streamFunction(model, { messages: [] })).rejects.toThrow(
				"mode=provider_config_stream_simple",
			);
			await expect(session.prompt("must not be persisted")).rejects.toThrow("mode=provider_config_stream_simple");
			await expect(session.compact()).rejects.toThrow("mode=provider_config_stream_simple");

			const assistant: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "large-tool-result",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(600_000) }],
				isError: false,
				timestamp: Date.now(),
			};
			const prepareNextTurn = session.agent.prepareNextTurnWithContext;
			if (!prepareNextTurn) throw new Error("prepareNextTurnWithContext was not installed");
			const nextTurn: PrepareNextTurnContext = {
				message: assistant,
				toolResults: [toolResult],
				context: { systemPrompt: "", messages: [assistant, toolResult], tools: [] },
				newMessages: [assistant, toolResult],
			};
			await expect(prepareNextTurn(nextTurn)).rejects.toThrow("mode=provider_config_stream_simple");

			expect(getAuth).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sessionEvents).not.toContain("compaction_start");
			expect(session.sessionManager.getEntries()).toHaveLength(entryCount);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("rejects active provider hooks before auth, hook execution, or pi-server network I/O", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "provider-hooks.ts"),
			`export default function (pi) {
				pi.on("before_provider_request", () => { throw new Error("hook executed"); });
				pi.on("before_provider_headers", () => { throw new Error("hook executed"); });
				pi.on("after_provider_response", () => { throw new Error("hook executed"); });
			}`,
		);
		const model = createModel("openai-completions");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			models: [
				{
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				},
			],
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		process.env.PI_SERVER_MODE = "true";
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
		});
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const sessionEvents: string[] = [];
		session.subscribe((event) => sessionEvents.push(event.type));

		try {
			await expect(session.agent.streamFunction(model, { messages: [] })).rejects.toThrow(
				"before_provider_request, before_provider_headers, after_provider_response",
			);
			await expect(session.compact()).rejects.toThrow(
				"before_provider_request, before_provider_headers, after_provider_response",
			);
			expect(getAuth).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sessionEvents).not.toContain("compaction_start");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			`export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			}`,
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});
