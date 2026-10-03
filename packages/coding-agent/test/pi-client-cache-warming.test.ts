import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type CacheRetention,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	getCurrentTools,
	lazyStream,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions, getOrCreateSession } from "../../pi-server/src/session-store.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CacheWarmer } from "../src/core/cache-warmer.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type CacheWarmingMode, SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const largeText = "汉字😀".repeat(20000);
const model: Model<"cache-fixture"> = {
	id: "cached",
	name: "Cached fixture",
	provider: "cache-fixture",
	api: "cache-fixture",
	baseUrl: "https://unused.invalid",
	headers: { "X-Cache-Fixture": "original-model-header" },
	reasoning: false,
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 1000,
	promptCache: { short: 60, long: 300 },
	cost: { input: 10, output: 10, cacheRead: 0.01, cacheWrite: 12.5 },
};

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture listener");
	return `http://127.0.0.1:${address.port}`;
}

// Drive the actual scheduled operation directly, keeping HTTP and abort timers real.
async function warmNow(session: AgentSession): Promise<void> {
	const warmer = (session as unknown as { _cacheWarmer: CacheWarmer })._cacheWarmer;
	const internal = warmer as unknown as {
		run?: { timer?: ReturnType<typeof setTimeout> };
		refresh(run: object): Promise<void>;
	};
	if (!internal.run) throw new Error("Expected a scheduled cache warm");
	clearTimeout(internal.run.timer);
	await internal.refresh(internal.run);
}

describe("pi-client cache warming through a 65536-byte HTTP proxy", () => {
	const servers: Server[] = [];
	const sessions: AgentSession[] = [];
	let directory: string;

	afterEach(async () => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const server of servers.splice(0).reverse()) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		if (directory) rmSync(directory, { recursive: true, force: true });
		clearAllSessions();
		resetAllSessionTracking();
		vi.unstubAllEnvs();
	});

	async function fixture(
		options: {
			mode?: CacheWarmingMode;
			tool?: boolean;
			hooks?: boolean;
			clientAuth?: boolean;
			clientAuthEnv?: boolean;
			callerRetentionEnv?: "short" | "long";
			retention?: CacheRetention;
			autoCompact?: boolean;
			failAbort?: boolean;
		} = {},
	) {
		directory = mkdtempSync(join(tmpdir(), "pi-client-cache-warming-"));
		const calls: { model: Model<string>; context: TranscriptContext; options: SimpleStreamOptions; warm: boolean }[] =
			[];
		const hookEvents: string[] = [];
		const compactFailures: unknown[] = [];
		const headerInputs: ProviderHeaders[] = [];
		let realCalls = 0;
		let holdWarm = false;
		let failAbort = options.failAbort === true;
		let releaseHeldWarm: (() => void) | undefined;
		let releaseTool: (() => void) | undefined;
		let startTool: () => void;
		let summaryEntered = false;
		let abortEntered = false;
		let releaseSummary: () => void;
		let releaseAbort: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		const summaryGate = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			startTool = resolve;
		});
		const stream = (requestModel: Model<string>, context: TranscriptContext, requestOptions?: SimpleStreamOptions) =>
			lazyStream(requestModel, async () => {
				const warm = requestOptions?.maxTokens === 1;
				calls.push({
					model: structuredClone(requestModel),
					context: structuredClone(context),
					options: { ...requestOptions },
					warm,
				});
				await requestOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				await requestOptions?.onPayload?.({ original: largeText }, requestModel);
				await requestOptions?.onProviderStreamEvent?.({ type: "cache-fixture-event" }, requestModel);
				if (options.autoCompact && !warm && realCalls === 1) {
					summaryEntered = true;
					await summaryGate;
				}
				if (warm && holdWarm && !requestOptions?.signal?.aborted) {
					await new Promise<void>((resolve) => {
						releaseHeldWarm = resolve;
						requestOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
				}
				let message: AssistantMessage;
				if (requestOptions?.signal?.aborted) message = fauxAssistantMessage("", { stopReason: "aborted" });
				else if (warm)
					message = fauxAssistantMessage("warm response excluded from transcript", { stopReason: "length" });
				else if (options.tool && realCalls++ === 0)
					message = fauxAssistantMessage(fauxToolCall("wait_tool", {}), { stopReason: "toolUse" });
				else message = fauxAssistantMessage("real answer");
				message = {
					...message,
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					...(warm ? { responseModel: "physical-cache-model" } : {}),
					usage: {
						input: 0,
						output: 1,
						cacheRead: 400000,
						cacheWrite: 0,
						totalTokens: 400001,
						cost: { input: 0, output: 0.00001, cacheRead: 0.004, cacheWrite: 0, total: 0.00401 },
					},
				};
				const result = createAssistantMessageEventStream();
				if (message.stopReason === "aborted") result.push({ type: "error", reason: "aborted", error: message });
				else
					result.push({
						type: "done",
						reason:
							message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop",
						message,
					});
				result.end(message);
				return result;
			});
		const models = createModels();
		models.setProvider(
			createProvider({
				id: model.provider,
				models: [model, { ...model, id: "other" }],
				auth: { apiKey: { name: "Server key", resolve: async () => ({ auth: { apiKey: "server-cache-key" } }) } },
				api: { stream, streamSimple: stream },
			}),
		);
		const backend = createPiServer(
			{ sessionStoreDir: join(directory, "server"), authToken: "fixture-token" },
			models,
		);
		servers.push(backend);
		const backendUrl = await listen(backend);
		const requests: { path: string; bytes: number }[] = [];
		let rejected = 0;
		const proxy = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			requests.push({ path: request.url ?? "/", bytes: body.length });
			if (body.length > 65536) {
				rejected++;
				response.writeHead(413).end("Body exceeds 65536 UTF-8 bytes");
				return;
			}
			if (options.autoCompact && request.url?.endsWith("/abort")) {
				abortEntered = true;
				await abortGate;
				if (failAbort) {
					response
						.writeHead(503, { "content-type": "application/json" })
						.end(JSON.stringify({ error: "fixture cancellation not confirmed" }));
					return;
				}
			}
			const controller = new AbortController();
			response.on("close", () => {
				if (!response.writableEnded) controller.abort();
			});
			try {
				const upstream = await fetch(`${backendUrl}${request.url}`, {
					method: request.method,
					headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
					...(body.length ? { body } : {}),
					signal: controller.signal,
				});
				response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "" });
				if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
				response.end();
			} catch (error) {
				if (!response.destroyed) {
					if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
					else response.writeHead(500).end(String(error));
				}
			}
		});
		servers.push(proxy);
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-token");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		if (options.clientAuth) {
			runtime.registerNativeProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: {
						apiKey: {
							name: "Client key",
							resolve: async () => ({
								...(options.clientAuthEnv ? { env: { PI_CACHE_RETENTION: "long" } } : {}),
								auth: {
									apiKey: "client-cache-key",
									baseUrl: "https://configured-client.invalid/v1",
									headers: { "X-Auth": "client-auth-header", "X-Override": "auth" },
								},
							}),
						},
					},
					api: {
						stream: () => {
							throw new Error("Local inference forbidden");
						},
						streamSimple: () => {
							throw new Error("Local inference forbidden");
						},
					},
				}),
			);
			await runtime.refresh({ allowNetwork: false });
		}
		const extensionsResult = await createTestExtensionsResult(
			options.hooks || options.clientAuth || options.autoCompact
				? [
						(pi) => {
							if (options.autoCompact)
								pi.on("session_compact_failed", (event) => {
									compactFailures.push(event);
								});
							if (options.clientAuth)
								pi.on("before_provider_headers", (event) => {
									headerInputs.push({ ...event.headers });
									event.headers["X-Hook"] = "header-transform";
								});
							if (!options.hooks) return;
							pi.on("before_provider_request", () => {
								hookEvents.push("payload");
							});
							pi.on("after_provider_response", () => {
								hookEvents.push("response");
							});
							pi.on("provider_stream_event", () => {
								hookEvents.push("event");
							});
						},
					]
				: [],
		);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model,
			settingsManager: SettingsManager.inMemory({
				...(options.mode ? { cacheWarming: options.mode } : {}),
				compaction: options.autoCompact
					? { enabled: true, reserveTokens: 620000, keepRecentTokens: 1000 }
					: { enabled: false },
				retry: { enabled: false },
			}),
			sessionManager: SessionManager.inMemory(directory),
			autoSessionName: false,
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSystemPrompt: () => "Exact cache system prompt",
			},
			tools: options.tool ? ["wait_tool"] : [],
			customTools: options.tool
				? [
						{
							name: "wait_tool",
							label: "Wait",
							description: largeText,
							parameters: Type.Object({}),
							execute: async () => {
								startTool();
								await toolGate;
								return { content: [{ type: "text", text: "tool completed" }], details: {} };
							},
						},
					]
				: [],
		});
		sessions.push(session);
		const originalStream = session.agent.streamFunction;
		session.agent.streamFunction = (m, context, streamOptions) =>
			originalStream(m, context, {
				...streamOptions,
				cacheRetention: options.clientAuthEnv ? options.retention : "long",
				...(options.callerRetentionEnv ? { env: { PI_CACHE_RETENTION: options.callerRetentionEnv } } : {}),
				...(options.clientAuth ? { headers: { "X-Caller": "caller-header", "X-Override": "caller" } } : {}),
			});
		return {
			session,
			runtime,
			calls,
			requests,
			hookEvents,
			compactFailures,
			headerInputs,
			toolStarted,
			summaryEntered: () => summaryEntered,
			abortEntered: () => abortEntered,
			releaseAbort: () => releaseAbort(),
			allowAborts: () => {
				failAbort = false;
			},
			releaseSummary: () => releaseSummary(),
			releaseHeldWarm: () => releaseHeldWarm?.(),
			releaseTool: () => releaseTool?.(),
			holdWarm: () => {
				holdWarm = true;
			},
			rejected: () => rejected,
		};
	}

	it("warms the exact provider prefix during a long tool in default streaming mode, then stops on settlement", async () => {
		const { session, runtime, calls, requests, toolStarted, releaseTool, rejected } = await fixture({ tool: true });
		expect(await runtime.getAuth(model)).toBeUndefined();
		const run = session.prompt(largeText);
		try {
			await toolStarted;
			expect(session.isStreaming).toBe(true);
			expect(session.cacheWarmingStatus).toMatchObject({
				state: "scheduled",
				decision: { phase: "streaming", action: "warm" },
			});
			const original = calls[0];
			expect(getCurrentTools(original.context.messages)[0]?.description).toBe(largeText);
			expect(JSON.stringify(original.context.messages)).toContain("Exact cache system prompt");
			await warmNow(session);
			expect(calls[1].context).toEqual(original.context);
			expect(calls[1].options).toMatchObject({
				apiKey: "server-cache-key",
				sessionId: session.sessionId,
				cacheRetention: "long",
				maxTokens: 1,
				maxRetries: 0,
			});
			expect(calls[1].options.headers).toEqual(original.options.headers);
			for (const call of calls) {
				expect(call.options.onPayload).toBeUndefined();
				expect(call.options.onResponse).toBeUndefined();
				expect(call.options.onProviderStreamEvent).toBeUndefined();
			}
			const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "usage");
			expect(entries).toMatchObject([
				{
					kind: "cache_warm",
					provider: model.provider,
					model: "physical-cache-model",
					usage: { cacheRead: 400000 },
				},
			]);
			expect(JSON.stringify(session.messages)).not.toContain("warm response excluded");
			expect(getOrCreateSession(session.sessionId).entries).toEqual([]);
			expect(requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
			expect(requests.some((request) => request.path.includes("callback"))).toBe(false);
			expect(rejected()).toBe(0);
		} finally {
			releaseTool();
			await run;
		}
		expect(session.cacheWarmingStatus).toMatchObject({ state: "inactive", reason: "agent run settled" });
		expect(session.getLastAssistantText()).toBe("real answer");
	});

	it("awaits a warm cancellation acknowledgement before threshold auto-compaction", async () => {
		const {
			session,
			calls,
			requests,
			toolStarted,
			releaseTool,
			summaryEntered,
			releaseSummary,
			abortEntered,
			releaseAbort,
			holdWarm,
		} = await fixture({
			tool: true,
			autoCompact: true,
		});
		const compactEvents: unknown[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") compactEvents.push(event);
		});
		const run = session.prompt(largeText);
		let warming: Promise<void> | undefined;
		try {
			await toolStarted;
			holdWarm();
			warming = warmNow(session);
			await vi.waitFor(() => expect(calls.some((call) => call.warm)).toBe(true));
			releaseTool();
			await vi.waitFor(() => expect(abortEntered()).toBe(true));
			expect(summaryEntered()).toBe(false);
			expect(requests.some((request) => request.path === "/api/session/update")).toBe(false);
			releaseAbort();
			await warming;
			await vi.waitFor(() => expect(summaryEntered()).toBe(true));
			expect(session.isStreaming).toBe(true);
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "usage")).toBe(false);
		} finally {
			releaseTool();
			releaseAbort();
			releaseSummary();
			await warming;
			await run;
		}
		expect(compactEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "threshold", aborted: false, result: expect.any(Object) }),
			]),
		);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
	});

	it.each(["followUp", "steer", "clearSteer"] as const)(
		"preserves %s intent through unconfirmed warm cancellation and explicit retry",
		async (behavior) => {
			const {
				session,
				calls,
				requests,
				toolStarted,
				releaseTool,
				abortEntered,
				releaseAbort,
				summaryEntered,
				releaseSummary,
				holdWarm,
				releaseHeldWarm,
				compactFailures,
				allowAborts,
			} = await fixture({ tool: true, autoCompact: true, failAbort: true });
			session.setAutoRetryEnabled(true);
			const events: string[] = [];
			session.subscribe((event) => {
				events.push(event.type);
			});
			const run = session.prompt(largeText);
			let warming: Promise<void> | undefined;
			try {
				await toolStarted;
				holdWarm();
				warming = warmNow(session);
				await vi.waitFor(() => expect(calls.some((call) => call.warm)).toBe(true));
				if (behavior !== "followUp") await session.steer("queued during cancellation acknowledgement");
				releaseTool();
				await vi.waitFor(() => expect(abortEntered()).toBe(true));
				if (behavior === "followUp") await session.followUp("queued during cancellation acknowledgement");
				expect(behavior !== "followUp" ? session.getSteeringMessages() : session.getFollowUpMessages()).toEqual([
					"queued during cancellation acknowledgement",
				]);
				if (behavior === "clearSteer") {
					expect(session.clearQueue()).toEqual({
						steering: ["queued during cancellation acknowledgement"],
						followUp: [],
					});
				}
				releaseAbort();
				await run;
				await warming;
				expect(session.isAborting).toBe(true);
				expect(session.abortError).toContain("Session run cancellation failed");
				expect(summaryEntered()).toBe(false);
				expect(requests.some((request) => request.path === "/api/session/compact")).toBe(false);
				expect(calls.filter((call) => !call.warm)).toHaveLength(1);
				expect(events).not.toContain("auto_retry_start");
				expect(compactFailures).toEqual([
					expect.objectContaining({
						reason: "threshold",
						aborted: false,
						willRetry: false,
						errorMessage: expect.stringContaining("fixture cancellation not confirmed"),
					}),
				]);
				expect(
					session.sessionManager
						.getEntries()
						.some((entry) => entry.type === "usage" || entry.type === "compaction"),
				).toBe(false);
				expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
				expect(behavior !== "followUp" ? session.getSteeringMessages() : session.getFollowUpMessages()).toEqual(
					behavior === "clearSteer" ? [] : ["queued during cancellation acknowledgement"],
				);
				expect(calls.filter((call) => !call.warm)).toHaveLength(1);
				allowAborts();
				releaseSummary();
				await session.abort();
				await session.waitForIdle();
				expect(session.isAborting).toBe(false);
				expect(session.abortError).toBeUndefined();
				expect(session.getFollowUpMessages()).toEqual([]);
				expect(session.getSteeringMessages()).toEqual([]);
				expect(
					session.messages.filter(
						(message) =>
							message.role === "user" &&
							JSON.stringify(message.content).includes("queued during cancellation acknowledgement"),
					),
				).toHaveLength(behavior === "clearSteer" ? 0 : 1);
				if (behavior === "clearSteer") expect(calls.filter((call) => !call.warm)).toHaveLength(1);
				else expect(session.getLastAssistantText()).toBe("real answer");
				for (const message of session.messages) expect(Object.getOwnPropertySymbols(message)).toEqual([]);
				for (const entry of session.sessionManager.getEntries()) {
					if (entry.type === "message") expect(Object.getOwnPropertySymbols(entry.message)).toEqual([]);
				}
			} finally {
				releaseTool();
				releaseAbort();
				releaseSummary();
				releaseHeldWarm();
				await warming;
				await run.catch(() => {});
			}
		},
	);

	it("replays the exact effective client-auth model and headers with one header transform per request", async () => {
		const { session, calls, headerInputs, requests } = await fixture({ mode: "idle", clientAuth: true });
		await session.prompt(largeText);
		await warmNow(session);
		expect(calls).toHaveLength(2);
		expect(calls[0].model.baseUrl).toBe("https://configured-client.invalid/v1");
		expect(calls[1].model).toEqual(calls[0].model);
		expect(calls[1].context).toEqual(calls[0].context);
		const headers = {
			"X-Cache-Fixture": "original-model-header",
			"X-Auth": "client-auth-header",
			"X-Override": "caller",
			"X-Caller": "caller-header",
		};
		expect(headerInputs).toEqual([headers, headers]);
		for (const call of calls) {
			expect(call.options.apiKey).toBe("client-cache-key");
			expect(call.options.headers).toEqual({ ...headers, "X-Hook": "header-transform" });
			expect(call.options.sessionId).toBe(session.sessionId);
			expect(call.options.cacheRetention).toBe("long");
		}
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
		expect(getOrCreateSession(session.sessionId).entries).toEqual([]);
	});

	it.each([
		{ callerEnv: undefined, retention: undefined, expected: "long" },
		{ callerEnv: "short", retention: undefined, expected: "short" },
		{ callerEnv: "short", retention: "long", expected: "long" },
		{ callerEnv: undefined, retention: "short", expected: "short" },
	] as const)(
		"schedules the effective client-auth retention with caller env $callerEnv and explicit $retention",
		async ({ callerEnv, retention, expected }) => {
			const { session, calls, requests } = await fixture({
				mode: "idle",
				clientAuth: true,
				clientAuthEnv: true,
				callerRetentionEnv: callerEnv,
				retention,
			});
			await session.prompt(largeText);
			const warmer = (
				session as unknown as { _cacheWarmer: { run?: { ttlMs: number; options: SimpleStreamOptions } } }
			)._cacheWarmer;
			expect(warmer.run?.ttlMs).toBe(expected === "long" ? 300000 : 60000);
			expect(warmer.run?.options.env).toEqual({ PI_CACHE_RETENTION: callerEnv ?? "long" });
			await warmNow(session);
			expect(calls).toHaveLength(2);
			expect(calls[1].context).toEqual(calls[0].context);
			for (const call of calls) {
				expect(call.options.env).toEqual({ PI_CACHE_RETENTION: callerEnv ?? "long" });
				expect(call.options.cacheRetention).toBe(retention);
			}
			expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
		},
	);

	it("continues idle warming and records only local usage entries", async () => {
		const { session, calls, requests } = await fixture({ mode: "idle" });
		await session.prompt(largeText);
		const before = session.sessionManager.buildSessionContext().messages;
		expect(session.cacheWarmingStatus?.decision?.phase).toBe("idle");
		await warmNow(session);
		await warmNow(session);
		expect(calls.filter((call) => call.warm)).toHaveLength(2);
		expect(calls[1].context).toEqual(calls[0].context);
		expect(calls[2].context).toEqual(calls[0].context);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(2);
		expect(session.sessionManager.buildSessionContext().messages).toEqual(before);
		expect(getOrCreateSession(session.sessionId).entries).toEqual([]);
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
	});

	it("keeps off mode inactive and cancels an idle schedule immediately when disabled", async () => {
		const { session, calls } = await fixture({ mode: "off" });
		await session.prompt(largeText);
		expect(session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "cache warming disabled" });
		expect(calls).toHaveLength(1);
		session.setCacheWarmingMode("idle");
		await session.prompt("next");
		expect(session.cacheWarmingStatus?.state).toBe("scheduled");
		session.setCacheWarmingMode("off");
		expect(session.cacheWarmingStatus?.state).toBe("inactive");
		expect(calls.filter((call) => call.warm)).toEqual([]);
	});

	it.each(["abort", "dispose"])("cancels an in-flight warm on %s without recording its response", async (action) => {
		const { session, calls, requests, holdWarm } = await fixture({ mode: "idle" });
		await session.prompt(largeText);
		holdWarm();
		const warming = warmNow(session);
		await vi.waitFor(() => expect(calls.some((call) => call.warm)).toBe(true));
		if (action === "abort") await session.abort();
		else session.dispose();
		await warming;
		expect(session.cacheWarmingStatus?.state).toBe("inactive");
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toEqual([]);
		expect(requests.some((request) => request.path.endsWith("/abort"))).toBe(true);
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
	});

	it.each(["model", "context"])("stops a scheduled warm after %s replacement", async (change) => {
		const { session, calls } = await fixture({ mode: "idle" });
		await session.prompt(largeText);
		if (change === "model") await session.setModel({ ...model, id: "other" });
		else session.agent.state.messages = session.agent.state.messages.slice(1);
		expect(session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		await warmNow(session);
		expect(calls).toHaveLength(1);
		expect(session.cacheWarmingStatus?.state).toBe("inactive");
	});

	it("preserves registered provider lifecycle hooks on both the real and warm request", async () => {
		const { session, hookEvents, requests } = await fixture({ mode: "idle", hooks: true });
		await session.prompt(largeText);
		await warmNow(session);
		expect(hookEvents).toEqual(["response", "payload", "event", "response", "payload", "event"]);
		expect(requests.some((request) => request.path.includes("callback"))).toBe(true);
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
	});

	it("preserves explicit caller callbacks on the original request and its warm replay", async () => {
		const { session, calls, requests } = await fixture({ mode: "idle" });
		await session.prompt(largeText);
		const onPayload = vi.fn(async (payload: unknown) => payload);
		const onResponse = vi.fn(async () => {});
		const onProviderStreamEvent = vi.fn(async () => {});
		const original = await session.agent.streamFunction(model, calls[0].context, {
			sessionId: session.sessionId,
			onPayload,
			onResponse,
			onProviderStreamEvent,
		});
		expect((await original.result()).stopReason).toBe("stop");
		await warmNow(session);
		expect(calls[2].context).toEqual(calls[1].context);
		expect(onPayload).toHaveBeenCalledTimes(2);
		expect(onResponse).toHaveBeenCalledTimes(2);
		expect(onProviderStreamEvent).toHaveBeenCalledTimes(2);
		expect(requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
		expect(requests.every((request) => request.bytes <= 65536)).toBe(true);
	});
});
