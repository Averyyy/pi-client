import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type CacheRetention,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	lazyStream,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinProviderForModel, registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions } from "../../pi-server/src/session-store.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking, streamPiServer, streamRawPiServer } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const largeText = "汉字😀".repeat(20000);
const serverSecret = "private-server-retention-key";
const model: Model<"anthropic-messages"> = {
	id: "retention",
	name: "Retention fixture",
	provider: "retention-fixture",
	api: "anthropic-messages",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 1000,
	promptCache: { short: 300, long: 3600 },
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture listener");
	return `http://127.0.0.1:${address.port}`;
}

function scheduled(session: AgentSession) {
	return (
		session as unknown as {
			_cacheWarmer: {
				run?: { timer?: ReturnType<typeof setTimeout>; ttlMs: number; options: SimpleStreamOptions };
				refresh(run: object): Promise<void>;
			};
		}
	)._cacheWarmer;
}

async function warmNow(session: AgentSession): Promise<void> {
	const warmer = scheduled(session);
	if (!warmer.run) throw new Error("Missing scheduled cache warm");
	clearTimeout(warmer.run.timer);
	await warmer.refresh(warmer.run);
}

describe("server-authoritative cache retention over bounded HTTP", () => {
	const servers: Server[] = [];
	const sessions: AgentSession[] = [];
	const children: ChildProcess[] = [];
	let directory: string;
	afterEach(async () => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
		for (const server of servers.splice(0).reverse()) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		if (directory) rmSync(directory, { recursive: true, force: true });
		clearAllSessions();
		resetAllSessionTracking();
		resetApiProviders();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function fixture(options: {
		serverEnv: "short" | "long";
		serverProcess?: "short" | "long";
		clientProcess?: "short" | "long";
		callerEnv?: "short" | "long";
		explicit?: CacheRetention;
		disconnect?: boolean;
		defaultCompat?: boolean;
	}) {
		vi.stubEnv("PI_CACHE_RETENTION", options.clientProcess ?? "short");
		directory = mkdtempSync(join(tmpdir(), "pi-client-retention-"));
		const calls: { context: TranscriptContext; options: SimpleStreamOptions }[] = [];
		const resolveAuth = vi.fn(async () => ({
			auth: { apiKey: serverSecret },
			env: { PI_CACHE_RETENTION: options.serverEnv, PRIVATE_SERVER_ENV: "private-env-value" },
		}));
		let finishTool!: () => void;
		let enterTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			finishTool = resolve;
		});
		const toolEntered = new Promise<void>((resolve) => {
			enterTool = resolve;
		});
		let realCalls = 0;
		const stream = (requestModel: Model<string>, context: TranscriptContext, requestOptions?: SimpleStreamOptions) =>
			lazyStream(requestModel, async () => {
				calls.push({ context: structuredClone(context), options: { ...requestOptions } });
				const warm = requestOptions?.maxTokens === 1;
				const message = {
					...fauxAssistantMessage(warm ? "warm" : realCalls++ === 0 ? fauxToolCall("wait_tool", {}) : "answer", {
						stopReason: warm ? "length" : realCalls === 1 ? "toolUse" : "stop",
					}),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: {
						input: 0,
						cacheRead: 6000,
						cacheWrite: 0,
						output: 1,
						totalTokens: 6001,
						cost: { input: 0, cacheRead: 0.003, cacheWrite: 0, output: 0.000025, total: 0.003025 },
					},
				};
				const result = createAssistantMessageEventStream();
				result.push({
					type: "done",
					reason: message.stopReason === "toolUse" ? "toolUse" : warm ? "length" : "stop",
					message,
				});
				result.end(message);
				return result;
			});
		const models = createModels();
		models.setProvider(
			createProvider({
				id: model.provider,
				models: [model],
				auth: { apiKey: { name: "Server", resolve: resolveAuth } },
				api: { stream, streamSimple: stream },
			}),
		);
		const backend = createPiServer(
			{ sessionStoreDir: join(directory, "server"), authToken: "fixture-token" },
			options.defaultCompat ? undefined : models,
		);
		servers.push(backend);
		let backendUrl = await listen(backend);
		if (options.serverProcess) {
			const root = fileURLToPath(new URL("../../../", import.meta.url));
			const script = join(directory, "isolated-retention-server.mts");
			const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
			writeFileSync(
				script,
				`
import { once } from "node:events";
import { createPiServer } from ${moduleUrl("packages/pi-server/src/server.ts")};
import { createModels, createProvider } from ${moduleUrl("packages/ai/src/models.ts")};
import { lazyStream } from ${moduleUrl("packages/ai/src/api/lazy.ts")};
import { AssistantMessageEventStream } from ${moduleUrl("packages/ai/src/utils/event-stream.ts")};
import { fauxAssistantMessage, fauxToolCall } from ${moduleUrl("packages/ai/src/providers/faux.ts")};
const model = ${JSON.stringify(model)};
let realCalls = 0;
let reportId = 0;
const reports = new Map();
process.on("message", (message) => { if (message.kind === "ack") { reports.get(message.id)?.(); reports.delete(message.id); } });
const report = (event) => new Promise((resolve) => { const id = ++reportId; reports.set(id, resolve); process.send({...event, id}); });
const stream = (m, context, options) => lazyStream(m, async () => {
  await report({kind:"call", context, options:{cacheRetention:options.cacheRetention,maxTokens:options.maxTokens,maxRetries:options.maxRetries}});
  const warm = options.maxTokens === 1;
  const message = {...fauxAssistantMessage(warm ? "warm" : realCalls++ === 0 ? fauxToolCall("wait_tool", {}) : "answer", {stopReason:warm ? "length" : realCalls === 1 ? "toolUse" : "stop"}),
    api:m.api,provider:m.provider,model:m.id,usage:{input:0,cacheRead:6000,cacheWrite:0,output:1,totalTokens:6001,cost:{input:0,cacheRead:0.003,cacheWrite:0,output:0.000025,total:0.003025}}};
  const result = new AssistantMessageEventStream();
  result.push({type:"done",reason:message.stopReason,message});result.end(message);return result;
});
const models = createModels();
models.setProvider(createProvider({id:model.provider,models:[model],auth:{apiKey:{name:"Server",resolve:async()=>{await report({kind:"auth"});return {auth:{apiKey:"isolated-server-key"}};}}},api:{stream,streamSimple:stream}}));
const server = createPiServer({sessionStoreDir:${JSON.stringify(join(directory, "isolated-server"))},authToken:"fixture-token"},models);
server.listen(0,"127.0.0.1");await once(server,"listening");process.send({kind:"ready",url:"http://127.0.0.1:"+server.address().port});
`,
				"utf8",
			);
			const child = spawn(
				process.execPath,
				[
					"--import",
					pathToFileURL(join(root, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
					script,
				],
				{
					cwd: root,
					env: { ...process.env, PI_CACHE_RETENTION: options.serverProcess },
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				},
			);
			children.push(child);
			let errors = "";
			child.stderr?.on("data", (data: Buffer) => {
				errors += data.toString();
			});
			backendUrl = await new Promise<string>((resolve, reject) => {
				child.on("error", reject);
				child.on("exit", () => reject(new Error(`Isolated server exited: ${errors}`)));
				child.on("message", (message: unknown) => {
					const event = message as {
						kind: string;
						id?: number;
						url?: string;
						context?: TranscriptContext;
						options?: SimpleStreamOptions;
					};
					if (event.kind === "ready" && event.url) resolve(event.url);
					else if (event.kind === "auth") void resolveAuth();
					else if (event.kind === "call" && event.context && event.options)
						calls.push({ context: event.context, options: event.options });
					if (event.id !== undefined) child.send({ kind: "ack", id: event.id });
				});
			});
		}
		const requests: { path: string; bytes: number }[] = [];
		const replies: { path: string; text: string }[] = [];
		let rejected = 0;
		let disconnected = false;
		const proxy = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const path = request.url ?? "/";
			requests.push({ path, bytes: body.length });
			if (body.length > 65536) {
				rejected++;
				response.writeHead(413).end("Body exceeds 65536 UTF-8 bytes");
				return;
			}
			try {
				const upstream = await fetch(`${backendUrl}${path}`, {
					method: request.method,
					headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
					...(body.length ? { body } : {}),
				});
				const contentType = upstream.headers.get("content-type") ?? "";
				response.writeHead(upstream.status, { "content-type": contentType });
				response.flushHeaders();
				const reply: Buffer[] = [];
				const interrupt = options.disconnect && !disconnected && contentType.includes("text/event-stream");
				if (interrupt) disconnected = true;
				if (upstream.body)
					for await (const chunk of upstream.body) {
						reply.push(Buffer.from(chunk));
						if (interrupt) response.destroy();
						else response.write(chunk);
					}
				replies.push({ path, text: Buffer.concat(reply).toString("utf8") });
				response.end();
			} catch (error) {
				if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)));
			}
		});
		servers.push(proxy);
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-token");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const extensionsResult = await createTestExtensionsResult([]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			sessionManager: SessionManager.inMemory(directory),
			autoSessionName: false,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: ["wait_tool"],
			customTools: [
				{
					name: "wait_tool",
					label: "Wait",
					description: largeText,
					parameters: Type.Object({}),
					execute: async () => {
						enterTool();
						await toolGate;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});
		sessions.push(session);
		const original = session.agent.streamFunction;
		session.agent.streamFunction = (m, context, streamOptions) =>
			original(m, context, {
				...streamOptions,
				...(options.explicit ? { cacheRetention: options.explicit } : {}),
				...(options.callerEnv ? { env: { PI_CACHE_RETENTION: options.callerEnv } } : {}),
			});
		resolveAuth.mockClear();
		return {
			session,
			runtime,
			calls,
			requests,
			replies,
			resolveAuth,
			toolEntered,
			finishTool,
			rejected: () => rejected,
			disconnected: () => disconnected,
		};
	}

	it.each([
		{ serverEnv: "long", expected: "long" },
		{ serverEnv: "short", clientProcess: "long", expected: "short" },
		{ serverEnv: "long", callerEnv: "short", expected: "short" },
		{ serverEnv: "short", callerEnv: "long", expected: "long" },
		{ serverEnv: "short", callerEnv: "short", explicit: "long", expected: "long" },
		{ serverEnv: "long", callerEnv: "long", explicit: "short", expected: "short" },
		{ serverEnv: "long", callerEnv: "long", explicit: "none", expected: "none" },
	] as const)(
		"uses authoritative $expected for server $serverEnv, process $clientProcess, caller $callerEnv, explicit $explicit",
		async (options) => {
			const f = await fixture(options);
			expect(await f.runtime.getAuth(model)).toBeUndefined();
			const run = f.session.prompt(largeText);
			try {
				await f.toolEntered;
				expect(f.resolveAuth).toHaveBeenCalledTimes(1);
				expect(f.calls[0].options).toMatchObject({ apiKey: serverSecret, cacheRetention: options.expected });
				if (options.expected === "none") {
					expect(scheduled(f.session).run).toBeUndefined();
					expect(f.session.cacheWarmingStatus).toEqual({
						state: "inactive",
						reason: "request disabled prompt caching",
					});
				} else {
					expect(scheduled(f.session).run?.ttlMs).toBe(options.expected === "long" ? 3600000 : 300000);
					expect(scheduled(f.session).run?.options.cacheRetention).toBe(options.expected);
					expect(scheduled(f.session).run?.options.env ?? {}).not.toHaveProperty("PRIVATE_SERVER_ENV");
					expect(f.session.cacheWarmingStatus?.decision).toMatchObject({
						phase: "streaming",
						action: options.expected === "long" ? "warm" : "stop",
					});
					await warmNow(f.session);
					if (options.expected === "long") {
						expect(f.calls).toHaveLength(2);
						expect(f.resolveAuth).toHaveBeenCalledTimes(2);
						expect(f.calls[1].context).toEqual(f.calls[0].context);
						expect(f.calls[1].options).toMatchObject({ cacheRetention: "long", maxTokens: 1, maxRetries: 0 });
					} else {
						expect(f.calls).toHaveLength(1);
						expect(f.resolveAuth).toHaveBeenCalledTimes(1);
						expect(f.session.cacheWarmingStatus).toMatchObject({
							state: "inactive",
							reason: "expected savings below threshold",
						});
					}
				}
			} finally {
				f.finishTool();
				await run;
			}
			expect(f.resolveAuth).toHaveBeenCalledTimes(f.calls.length);
			expect(f.requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
			expect(f.rejected()).toBe(0);
			const wire = f.replies.map((reply) => reply.text).join("\n");
			expect(wire).toContain(`event: cache_policy`);
			expect(wire).toContain(`"cacheRetention":"${options.expected}"`);
			for (const secret of [serverSecret, "PRIVATE_SERVER_ENV", "private-env-value", "PI_CACHE_RETENTION"])
				expect(wire).not.toContain(secret);
		},
	);

	it("recovers an interrupted stream's authoritative enum from the same completed run without another provider call", async () => {
		const f = await fixture({ serverEnv: "long", disconnect: true });
		const run = f.session.prompt(largeText);
		try {
			await f.toolEntered;
			expect(f.disconnected()).toBe(true);
			expect(f.calls).toHaveLength(1);
			expect(f.resolveAuth).toHaveBeenCalledTimes(1);
			expect(scheduled(f.session).run).toMatchObject({ ttlMs: 3600000, options: { cacheRetention: "long" } });
			const recovery = f.replies.filter((reply) => reply.path.includes("/runs/"));
			expect(recovery.length).toBeGreaterThan(0);
			expect(JSON.parse(recovery.at(-1)!.text)).toMatchObject({ status: "completed", cacheRetention: "long" });
			await warmNow(f.session);
			expect(f.calls).toHaveLength(2);
			expect(f.resolveAuth).toHaveBeenCalledTimes(2);
		} finally {
			f.finishTool();
			await run;
		}
		expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
		expect(f.rejected()).toBe(0);
		for (const reply of f.replies) expect(reply.text).not.toContain(serverSecret);
	});

	it.each([
		{ serverProcess: "long", clientProcess: "short" },
		{ serverProcess: "short", clientProcess: "long" },
	] as const)(
		"uses isolated server process default $serverProcess while client process is $clientProcess",
		async (options) => {
			const f = await fixture({ ...options, serverEnv: "short" });
			const run = f.session.prompt(largeText);
			try {
				await f.toolEntered;
				expect(process.env.PI_CACHE_RETENTION).toBe(options.clientProcess);
				expect(f.calls[0].options.cacheRetention).toBe(options.serverProcess);
				expect(scheduled(f.session).run).toMatchObject({
					ttlMs: options.serverProcess === "long" ? 3600000 : 300000,
					options: { cacheRetention: options.serverProcess },
				});
				expect(f.session.cacheWarmingStatus?.decision?.action).toBe(
					options.serverProcess === "long" ? "warm" : "stop",
				);
				await warmNow(f.session);
				expect(f.calls).toHaveLength(options.serverProcess === "long" ? 2 : 1);
				expect(f.resolveAuth).toHaveBeenCalledTimes(f.calls.length);
				if (options.serverProcess === "long")
					expect(f.calls[1].options).toMatchObject({ maxTokens: 1, cacheRetention: "long" });
			} finally {
				f.finishTool();
				await run;
			}
			expect(f.requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
			expect(f.rejected()).toBe(0);
			expect(f.replies.some((reply) => reply.text.includes(`"cacheRetention":"${options.serverProcess}"`))).toBe(
				true,
			);
			for (const reply of f.replies) expect(reply.text).not.toContain("isolated-server-key");
		},
	);

	it.each(["raw", "simple", "deferred"] as const)(
		"rejects client prepared option transforms on remote %s before auth or inference",
		async (kind) => {
			const f = await fixture({ serverEnv: "long" });
			const transformPreparedStreamOptions = vi.fn(<TOptions extends StreamOptions>(options: TOptions) => options);
			const options = { transformPreparedStreamOptions };
			const result =
				kind === "raw"
					? await f.runtime.complete(model, { messages: [] }, options)
					: kind === "simple"
						? await f.runtime.completeSimple(model, { messages: [] }, options)
						: await f.runtime.fetchDeferred(
								model,
								{ id: "handle", api: model.api, provider: model.provider, modelId: model.id },
								options,
							);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not support client prepared stream option transforms");
			expect(transformPreparedStreamOptions).not.toHaveBeenCalled();
			expect(f.resolveAuth).not.toHaveBeenCalled();
			expect(f.calls).toEqual([]);
		},
	);

	it.each([
		{ kind: "raw", auth: "explicit" },
		{ kind: "simple", auth: "explicit" },
		{ kind: "raw", auth: "server-key" },
		{ kind: "simple", auth: "server-key" },
		{ kind: "raw", auth: "server-bearer" },
		{ kind: "simple", auth: "server-bearer" },
		{ kind: "raw", auth: "server-federation" },
		{ kind: "simple", auth: "server-federation" },
		{ kind: "raw", auth: "unknown-provider" },
		{ kind: "simple", auth: "unknown-provider" },
		{ kind: "raw", auth: "cloudflare" },
		{ kind: "simple", auth: "cloudflare" },
		{ kind: "raw", auth: "caller-bearer" },
		{ kind: "simple", auth: "caller-bearer" },
	] as const)(
		"preserves native Anthropic $kind mapping with $auth through the default compatibility adapter",
		async ({ kind, auth }) => {
			vi.stubEnv("ANTHROPIC_API_KEY", auth === "server-key" ? "native-fixture-key" : "");
			vi.stubEnv("ANTHROPIC_AUTH_TOKEN", auth === "server-bearer" ? "native-fixture-bearer" : "");
			vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
			if (auth === "cloudflare") {
				vi.stubEnv("CLOUDFLARE_API_KEY", "native-cloudflare-key");
				vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "server-account");
				vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "server-gateway");
			}
			const payloads: Record<string, unknown>[] = [];
			const exchanges: Record<string, unknown>[] = [];
			const headers: { key?: string; authorization?: string; gateway?: string }[] = [];
			const paths: string[] = [];
			const provider = createServer(async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				if (request.url === "/v1/oauth/token") {
					exchanges.push(JSON.parse(Buffer.concat(chunks).toString()));
					response.writeHead(200, { "content-type": "application/json" }).end(
						JSON.stringify({
							access_token: "native-federated-access",
							token_type: "Bearer",
							expires_in: 3600,
						}),
					);
					return;
				}
				payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
				paths.push(request.url ?? "");
				headers.push({
					key: request.headers["x-api-key"] as string | undefined,
					authorization: request.headers.authorization,
					...(request.headers["cf-aig-authorization"]
						? { gateway: String(request.headers["cf-aig-authorization"]) }
						: {}),
				});
				response.writeHead(200, { "content-type": "text/event-stream" }).end(
					[
						{
							type: "message_start",
							message: { id: "msg_native", usage: { input_tokens: 6000, output_tokens: 0 } },
						},
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					]
						.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
						.join(""),
				);
			});
			servers.push(provider);
			const providerUrl = await listen(provider);
			const f = await fixture({ serverEnv: "short", defaultCompat: true });
			if (auth === "server-federation") {
				const identityFile = join(directory, "identity.jwt");
				writeFileSync(identityFile, "fixture-identity-assertion", { mode: 0o600 });
				vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fixture-rule");
				vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "fixture-organization");
				vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "fixture-service-account");
				vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "fixture-workspace");
				vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", identityFile);
			}
			const nativeModel: Model<"anthropic-messages"> = {
				...model,
				provider:
					auth === "unknown-provider"
						? "custom-native-provider"
						: auth === "cloudflare"
							? "cloudflare-ai-gateway"
							: "anthropic",
				id: "native-fixture",
				baseUrl:
					auth === "cloudflare"
						? `${providerUrl}/gateway/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}`
						: providerUrl,
				reasoning: true,
				maxTokens: 16384,
				compat: { forceAdaptiveThinking: false, supportsLongCacheRetention: true },
			};
			const nativeResolve =
				auth === "cloudflare"
					? vi.spyOn(getBuiltinProviderForModel(nativeModel)!.auth.apiKey!, "resolve")
					: undefined;
			const context = {
				systemPrompt: "Native fixture",
				tools: [{ name: "native", description: largeText, parameters: Type.Object({}) }],
				messages: [{ role: "user" as const, content: largeText, timestamp: Date.now() }],
			};
			const options = {
				...(auth === "explicit" || auth === "unknown-provider" ? { apiKey: "native-fixture-key" } : {}),
				...(auth === "caller-bearer" ? { headers: { Authorization: "Bearer native-caller-bearer" } } : {}),
				env: {
					PI_CACHE_RETENTION: "long",
					...(auth === "cloudflare" ? { CLOUDFLARE_ACCOUNT_ID: "scoped-account" } : {}),
				},
				maxTokens: 8192,
				maxRetries: 0,
			};
			const stream =
				kind === "raw"
					? await streamRawPiServer(nativeModel, context, {
							...options,
							toolChoice: { type: "tool", name: "native" },
							thinkingEnabled: true,
							thinkingBudgetTokens: 4096,
						})
					: await streamPiServer(nativeModel, context, { ...options, reasoning: "low" });
			expect((await stream.result()).stopReason).toBe("stop");
			expect(payloads).toHaveLength(1);
			expect(headers).toEqual(
				auth === "server-bearer"
					? [{ key: undefined, authorization: "Bearer native-fixture-bearer" }]
					: auth === "server-federation"
						? [{ key: undefined, authorization: "Bearer native-federated-access" }]
						: auth === "caller-bearer"
							? [{ key: undefined, authorization: "Bearer native-caller-bearer" }]
							: auth === "cloudflare"
								? [{ key: undefined, authorization: undefined, gateway: "Bearer native-cloudflare-key" }]
								: [{ key: "native-fixture-key", authorization: undefined }],
			);
			if (auth === "server-federation")
				expect(exchanges).toEqual([
					{
						grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
						assertion: "fixture-identity-assertion",
						federation_rule_id: "fixture-rule",
						organization_id: "fixture-organization",
						service_account_id: "fixture-service-account",
						workspace_id: "fixture-workspace",
					},
				]);
			else expect(exchanges).toEqual([]);
			if (auth === "cloudflare") {
				expect(nativeResolve).toHaveBeenCalledTimes(1);
				expect(paths.map((path) => new URL(path, providerUrl).pathname)).toEqual([
					"/gateway/scoped-account/server-gateway/v1/messages",
				]);
			}
			expect(payloads[0].thinking).toMatchObject({ type: "enabled", budget_tokens: kind === "raw" ? 4096 : 2048 });
			if (kind === "raw") expect(payloads[0].tool_choice).toEqual({ type: "tool", name: "native" });
			const wirePayload = JSON.stringify(payloads[0]);
			expect(wirePayload).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}');
			expect(f.requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
			expect(f.rejected()).toBe(0);
			expect(f.replies.some((reply) => reply.text.includes('"cacheRetention":"long"'))).toBe(true);
			for (const reply of f.replies) {
				expect(reply.text).not.toContain("native-fixture-key");
				expect(reply.text).not.toContain("native-fixture-bearer");
				expect(reply.text).not.toContain("native-federated-access");
				expect(reply.text).not.toContain("fixture-identity-assertion");
				expect(reply.text).not.toContain("ANTHROPIC_IDENTITY_TOKEN_FILE");
				expect(reply.text).not.toContain("native-cloudflare-key");
				expect(reply.text).not.toContain("native-caller-bearer");
			}
		},
	);

	it.each([
		{ kind: "raw", provider: "anthropic" },
		{ kind: "simple", provider: "anthropic" },
		{ kind: "raw", provider: "registry-custom" },
		{ kind: "simple", provider: "registry-custom" },
	] as const)(
		"honors a keyless registered API override for $provider $kind through default compatibility",
		async ({ kind, provider }) => {
			vi.stubEnv("ANTHROPIC_API_KEY", "");
			vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
			vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
			const f = await fixture({ serverEnv: "short", defaultCompat: true });
			const calls: { kind: string; options?: SimpleStreamOptions }[] = [];
			const respond = (m: Model<string>, branch: string, options?: SimpleStreamOptions) => {
				calls.push({ kind: branch, options });
				const message = { ...fauxAssistantMessage("registry"), api: m.api, provider: m.provider, model: m.id };
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			registerApiProvider(
				{
					api: "anthropic-messages",
					stream: (m, _c, o) => respond(m, "raw", o as SimpleStreamOptions),
					streamSimple: (m, _c, o) => respond(m, "simple", o),
				},
				"retention-registry-override",
			);
			const requestModel = { ...model, provider };
			const context = { messages: [{ role: "user" as const, content: largeText, timestamp: Date.now() }] };
			const options = { env: { PI_CACHE_RETENTION: "long" } };
			const stream =
				kind === "raw"
					? await streamRawPiServer(requestModel, context, {
							...options,
							thinkingEnabled: true,
							thinkingBudgetTokens: 4096,
						})
					: await streamPiServer(requestModel, context, { ...options, reasoning: "high" });
			expect((await stream.result()).stopReason).toBe("stop");
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ kind, options: { cacheRetention: "long" } });
			expect(calls[0].options?.apiKey).toBeUndefined();
			if (kind === "raw") expect(calls[0].options).toHaveProperty("thinkingBudgetTokens", 4096);
			else expect(calls[0].options).toHaveProperty("reasoning", "high");
			expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
			expect(f.rejected()).toBe(0);
		},
	);

	it.each([
		{ kind: "raw", auth: "throws" },
		{ kind: "simple", auth: "throws" },
		{ kind: "raw", auth: "unconfigured" },
		{ kind: "simple", auth: "unconfigured" },
	] as const)("surfaces native $kind $auth auth before provider dispatch", async ({ kind, auth }) => {
		const f = await fixture({ serverEnv: "short", defaultCompat: true });
		let providerCalls = 0;
		const provider = createServer((_request, response) => {
			providerCalls++;
			response.writeHead(500).end("Provider must not run");
		});
		servers.push(provider);
		const providerUrl = await listen(provider);
		const requestModel: Model<"anthropic-messages"> = { ...model, provider: "anthropic", baseUrl: providerUrl };
		const resolver = vi.spyOn(getBuiltinProviderForModel(requestModel)!.auth.apiKey!, "resolve");
		if (auth === "throws")
			resolver.mockImplementationOnce(async () => {
				throw new Error("Fixture auth resolver failed");
			});
		else resolver.mockResolvedValueOnce(undefined);
		const options = {
			maxRetries: 0,
			...(auth === "throws" ? { headers: { Authorization: "Bearer declared-caller-key" } } : {}),
		};
		const stream =
			kind === "raw"
				? await streamRawPiServer(requestModel, { messages: [] }, options)
				: await streamPiServer(requestModel, { messages: [] }, options);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			auth === "throws" ? "Fixture auth resolver failed" : "Provider is not configured",
		);
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(providerCalls).toBe(0);
		expect(f.requests.every((request) => request.bytes <= 65536)).toBe(true);
		expect(f.rejected()).toBe(0);
	});
});
