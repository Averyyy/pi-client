import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextStore } from "../../pi-server/src/context-store.ts";
import { createPiServer } from "../../pi-server/src/server.ts";
import type { AntigravityToolDisplay } from "../src/core/antigravity-native-tools.ts";
import { type AntigravityClient, AntigravityRuntime } from "../src/core/antigravity-runtime.ts";
import { AntigravityWorkspace } from "../src/core/antigravity-workspace.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { streamPiServerAntigravity } from "../src/core/pi-server-client.ts";
import { closePiServerObserver } from "../src/core/pi-server-observer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestUiContext } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const providerId = "google-antigravity";
let cwd: string;
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

function trace(): { method: string; params?: unknown; result?: unknown }[] {
	return readFileSync(join(cwd, "trace.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

/** A PiServer session store whose agy workspace can start the fixture CLI, like the test directory. */
function serverStore(name: string): string {
	const store = join(cwd, name);
	mkdirSync(join(store, "antigravity-workspace"), { recursive: true });
	copyFileSync(join(cwd, "acp"), join(store, "antigravity-workspace", "acp"));
	return store;
}

function signedIn(): void {
	writeFileSync(join(cwd, "signed-in"), "");
}

function createRuntime(credentials = new InMemoryCredentialStore(), modelsPath: string | null = null) {
	return ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore() });
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-antigravity-acp-"));
	copyFileSync(new URL("./fixtures/antigravity-acp.cjs", import.meta.url), join(cwd, "acp"));
	vi.spyOn(process, "cwd").mockReturnValue(cwd);
	vi.stubEnv("PI_ANTIGRAVITY_CLI", process.execPath);
	vi.stubEnv("PI_ACP_FIXTURE_DIR", cwd);
	vi.stubEnv("PI_SERVER_MODE", "false");
});

afterEach(async () => {
	for (const server of servers.splice(0).reverse()) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(cwd, { recursive: true, force: true });
});

describe("Antigravity ACP", () => {
	it("loads models from an existing agy sign-in without touching Pi credentials", async () => {
		const old = { type: "oauth" as const, access: "old", refresh: "old", expires: 0 };
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(providerId, async () => old);
		const network = vi.fn(() => {
			throw new Error("Unexpected Pi HTTP request");
		});
		vi.stubGlobal("fetch", network);
		const runtime = await createRuntime(credentials);
		expect(runtime.getModels(providerId)).toEqual([]);
		expect(await runtime.listCredentials()).toEqual([]);

		const notify = vi.fn();
		const prompt = vi.fn();
		await expect(runtime.login(providerId, "oauth", { notify, prompt })).rejects.toThrow(
			"Sign in to agy on the machine running Pi, then retry /login google-antigravity.",
		);
		signedIn();
		expect(await runtime.login(providerId, "oauth", { notify, prompt })).toEqual({ type: "local", providerId });
		expect(notify).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(runtime.getModels(providerId).map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: "gemini-test", name: "Gemini Test" },
			{ id: "orchestrator-test", name: "Orchestrator (Argon)" },
		]);
		expect(await runtime.checkAuth(providerId)).toEqual({ type: "oauth", source: "local Antigravity CLI" });
		expect(await runtime.getAuth(providerId)).toBeUndefined();
		expect(await credentials.read(providerId)).toEqual(old);
		await runtime.logout(providerId);
		expect(runtime.getModels(providerId)).toEqual([]);
		expect(await runtime.listCredentials()).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	});

	it("sends agy only the user's turn and selects the advertised Orchestrator", async () => {
		signedIn();
		const runtime = await createRuntime();
		const model = runtime.getModel(providerId, "orchestrator-test")!;
		const prompt = [
			{ type: "text" as const, text: "你好" },
			{ type: "image" as const, mimeType: "image/png", data: "cG5n" },
		];
		const context = normalizeContext({
			systemPrompt: "Pi prompt",
			messages: [
				{ role: "user", content: "earlier question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "another model's answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: prompt, timestamp: 3 },
			],
		});
		// Pi's own requests never reach agy: no session, no process.
		const traced = existsSync(join(cwd, "trace.jsonl")) ? trace().length : 0;
		expect(await runtime.streamSimple(model, context).result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("only as the agent of an interactive Pi session"),
		});
		expect(trace()).toHaveLength(traced);
		const adapter = new AntigravityRuntime(cwd);
		try {
			const stream = adapter.stream(model, context, {}, {});
			const events = [];
			for await (const event of stream) events.push(event.type);
			expect(events).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_delta",
				"text_end",
				"done",
			]);
			expect(await stream.result()).toMatchObject({
				content: [
					{ type: "thinking", thinking: "Planning" },
					{ type: "text", text: "orchestrator-test: 你好" },
				],
				stopReason: "stop",
			});
			// agy keeps its own instructions and context: no Pi system prompt, no earlier turns.
			expect(
				trace()
					.slice(-4)
					.map(({ method, params }) => ({ method, params })),
			).toEqual([
				{
					method: "initialize",
					params: {
						protocolVersion: 1,
						clientInfo: { name: "pi", title: "Pi" },
						clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					},
				},
				{ method: "session/new", params: { cwd, mcpServers: [] } },
				{
					method: "session/set_config_option",
					params: { sessionId: "mock-agy-session", configId: "model", value: "orchestrator-test" },
				},
				{ method: "session/prompt", params: { sessionId: "mock-agy-session", prompt } },
			]);
		} finally {
			await adapter.close();
		}
	});

	it("discovers server agy models and sends incremental turns and tools through a 64 KiB proxy", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const backendUrl = await listen(
			createPiServer({
				sessionStoreDir: serverStore("server"),
				accountStoreDir: join(cwd, "accounts"),
				authToken: "fixture",
			}),
		);
		const requests: {
			path: string;
			body?: { target?: string; providerId?: string; contextOverlay?: unknown[] };
			bytes: number;
		}[] = [];
		let released = false;
		const proxy = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks);
				const path = request.url!;
				requests.push({
					path,
					bytes: body.byteLength,
					body: body.byteLength ? JSON.parse(body.toString("utf8")) : undefined,
				});
				if (body.byteLength > 65_536) {
					response.writeHead(413).end();
					return;
				}
				const upstream = await fetch(`${backendUrl}${path}`, {
					method: request.method,
					headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
					...(body.byteLength ? { body } : {}),
				});
				response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "" });
				response.flushHeaders();
				if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
				response.end();
				if (path === "/api/antigravity/release") released = upstream.ok;
			} catch (error) {
				if (response.headersSent) response.destroy(error as Error);
				else response.writeHead(500).end(String(error));
			}
		});
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		const modelsPath = join(cwd, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { [providerId]: { modelOverrides: { "gemini-test": { contextWindow: 50_000 } } } },
			}),
		);
		const runtime = await createRuntime(undefined, modelsPath);
		const interaction = { notify: vi.fn(), prompt: vi.fn() };
		await expect(runtime.login(providerId, "oauth", interaction)).rejects.toThrow(
			"Sign in to agy on the machine running PiServer, then retry /login google-antigravity.",
		);
		signedIn();
		await runtime.login(providerId, "oauth", interaction);
		expect(interaction.notify).not.toHaveBeenCalled();
		expect(interaction.prompt).not.toHaveBeenCalled();
		// Startup reads PiServer's cached catalog with the accounts; each login asks it to rediscover.
		expect(
			requests
				.filter(({ path }) => path.startsWith("/api/accounts"))
				.map(({ path, body }) => [path, body?.providerId]),
		).toEqual([
			["/api/accounts", undefined],
			["/api/accounts/refresh", "google-antigravity"],
			["/api/accounts/refresh", "google-antigravity"],
		]);
		const discoveryRequests = trace().length;
		const model = runtime.getModel(providerId, "gemini-test")!;
		expect(model.contextWindow).toBe(50_000);
		const largeToolValue = "工具😀".repeat(7_000);
		const execute = vi.fn(async (_id: string, params: { key: string }) => ({
			content: [{ type: "text" as const, text: `Found ${params.key}` }],
			details: { found: params.key },
			structuredContent: { value: largeToolValue },
		}));
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName === "lookup") {
							return {
								content: [{ type: "text", text: "Reviewed 答案" }],
								structuredContent: event.structuredContent,
							};
						}
					});
				},
			],
			cwd,
		);
		const sessionManager = SessionManager.create(cwd, cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime: runtime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			noTools: "builtin",
			autoSessionName: false,
			customTools: [
				{
					name: "lookup",
					label: "Lookup",
					description: "Find an answer",
					parameters: Type.Object({ key: Type.String() }),
					execute,
				},
			],
		});
		const toolEvents: string[] = [];
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		const resolve = vi.spyOn(ContextStore.prototype, "resolve");
		const select = vi.fn(async () => "Allow once");
		session.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event.type);
		});
		try {
			await session.bindExtensions({ uiContext: createTestUiContext({ select }) });
			await session.prompt("custom");
			expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
				stopReason: "stop",
			});
			const largePrompt = "漢字😀".repeat(7_000);
			await session.prompt(largePrompt);
			await session.prompt("follow-up");
			expect(execute).toHaveBeenCalledExactlyOnceWith(
				expect.any(String),
				{ key: "答案" },
				expect.any(AbortSignal),
				expect.any(Function),
				expect.any(Object),
			);
			expect(toolEvents).toEqual(["tool_execution_start", "tool_execution_end"]);
			const messages = session.messages.filter((message) => message.role === "assistant");
			expect(messages.map((message) => message.content.at(-1))).toEqual([
				{ type: "text", text: "Reviewed 答案" },
				{ type: "text", text: `gemini-test: ${largePrompt}` },
				{ type: "text", text: "gemini-test: follow-up" },
			]);
			expect(
				requests.some(({ path, body }) => path === "/api/request/chunk" && body?.target === "/api/stream"),
			).toBe(true);
			expect(
				requests.some(
					({ path, body }) => path === "/api/request/chunk" && body?.target === "/api/provider-callback",
				),
			).toBe(true);
			expect(requests.every(({ bytes }) => bytes <= 65_536)).toBe(true);
			// Each turn uploads only the new prompt; PiServer already holds the reply and the relayed tool result.
			const deltas = resolve.mock.calls.slice(0, 3).map(([, delta]) => ({
				base: delta.base !== undefined,
				messages: delta.messages.map((message) => (typeof message === "string" ? "hash" : message.role)),
			}));
			expect(deltas).toEqual([
				{ base: false, messages: ["system", "user"] },
				{ base: true, messages: ["hash", "hash", "user"] },
				{ base: true, messages: ["hash", "user"] },
			]);
			const acpRequests = trace().slice(discoveryRequests);
			expect(acpRequests.filter((entry) => entry.method === "session/new")).toHaveLength(1);
			expect(acpRequests.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params)).toEqual([
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "custom" }] },
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: largePrompt }] },
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "follow-up" }] },
			]);
			expect(acpRequests.find((entry) => entry.method === "mock/tools/list")?.result).toMatchObject({
				tools: [
					{
						name: "lookup",
						inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
					},
				],
			});
			expect(acpRequests.find((entry) => entry.method === "mock/tools/call")?.result).toEqual({
				content: [{ type: "text", text: "Reviewed 答案" }],
				structuredContent: { value: largeToolValue },
				isError: false,
			});
			const reopen = () => SessionManager.open(sessionManager.getSessionFile()!, cwd).getBranch();
			const results = reopen().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
			);
			expect(results).toMatchObject([
				{
					toolName: "lookup",
					toolCallId: execute.mock.calls[0][0],
					content: [{ type: "text", text: "Reviewed 答案" }],
					details: { found: "答案" },
					structuredContent: { value: largeToolValue },
					isError: false,
				},
			]);
			// The tool call sits where agy ran it, between the thinking before it and the reply after it.
			expect(messages[0].content).toMatchObject([
				{ type: "thinking", thinking: "Planning" },
				{ type: "toolCall", id: results[0].toolCallId },
				{ type: "text", text: "Reviewed 答案" },
			]);
			await session.prompt("permission");
			expect(select).toHaveBeenCalledWith("Run native tool", ["Allow once"], { signal: expect.any(AbortSignal) });
			// Pi's summaries never run on agy; compaction.model chooses another model for them.
			const tracedBeforeCompaction = trace().length;
			await expect(session.compact()).rejects.toThrow("compaction.model");
			expect(trace()).toHaveLength(tracedBeforeCompaction);
			expect(reopen()).toContainEqual(expect.objectContaining({ type: "message", message: results[0] }));
			expect(requests.some(({ path }) => path.startsWith("/api/session/tree/"))).toBe(false);
			const callsBeforeAbort = trace().filter(({ method }) => method === "mock/tools/call").length;
			const prompt = session.prompt("custom-cancel");
			try {
				await vi.waitFor(
					() =>
						expect(trace().filter(({ method }) => method === "mock/tools/call")).toHaveLength(
							callsBeforeAbort + 1,
						),
					{ timeout: 5_000 },
				);
			} finally {
				await session.abort();
				await prompt;
			}
			expect(trace().at(-1)).toMatchObject({ method: "session/cancel" });
			expect(
				reopen().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult"),
			).toMatchObject({ message: { toolCallId: execute.mock.calls.at(-1)?.[0] } });
			await session.prompt("after cancellation");
		} finally {
			session.dispose();
			await Promise.all([closePiServerObserver(session), ...close.mock.results.map(({ value }) => value)]);
		}
		await vi.waitFor(() => expect(released).toBe(true));
	});

	it("resumes the agy session after a PiServer restart and uploads the context whole only when the store is gone", async () => {
		signedIn();
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
		let backend: Server | undefined;
		let backendUrl = "";
		// A restart stops the previous process before the next one opens the same store.
		const restartServer = async (store: string) => {
			if (backend) {
				const stopped = backend;
				servers.splice(servers.indexOf(stopped), 1);
				stopped.closeAllConnections();
				await new Promise<void>((resolve, reject) => stopped.close((error) => (error ? reject(error) : resolve())));
			}
			backend = createPiServer({
				sessionStoreDir: serverStore(store),
				accountStoreDir: join(cwd, "accounts"),
				authToken: "fixture",
			});
			backendUrl = await listen(backend);
		};
		await restartServer("store");
		const streams: { context?: { base?: string; messages: unknown[] }; contextOverlay?: unknown[] }[] = [];
		const statuses: number[] = [];
		let released = false;
		const proxy = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks);
				const upstream = await fetch(`${backendUrl}${request.url}`, {
					method: request.method,
					headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
					...(body.byteLength ? { body } : {}),
				});
				if (request.url === "/api/stream") {
					streams.push(JSON.parse(body.toString("utf8")));
					statuses.push(upstream.status);
				}
				response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "" });
				response.flushHeaders();
				if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
				response.end();
				if (request.url === "/api/antigravity/release") released = upstream.ok;
			} catch (error) {
				if (response.headersSent) response.destroy(error as Error);
				else response.writeHead(500).end(String(error));
			}
		});
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		const runtime = await createRuntime();
		const discovery = trace().length;
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model: runtime.getModel(providerId, "gemini-test")!,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			autoSessionName: false,
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		try {
			await session.bindExtensions({});
			await session.prompt("first");
			await restartServer("store");
			await session.prompt("second");
			await restartServer("lost");
			await session.prompt("third");
			expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
				stopReason: "stop",
				content: [{ type: "thinking" }, { type: "text", text: "gemini-test: third" }],
			});
			const sent = streams.map(({ context, contextOverlay }) => ({
				base: context?.base !== undefined,
				roles: context?.messages.map((message) => (typeof message === "string" ? "hash" : message)),
				contextOverlay,
			}));
			const user = (text: string) => expect.objectContaining({ role: "user", content: [{ type: "text", text }] });
			const assistant = (text: string) =>
				expect.objectContaining({ role: "assistant", content: [expect.anything(), { type: "text", text }] });
			const system = expect.objectContaining({ role: "system" });
			expect(sent).toEqual([
				{ base: false, roles: [system, user("first")], contextOverlay: undefined },
				{ base: true, roles: ["hash", user("second")], contextOverlay: undefined },
				{ base: true, roles: ["hash", user("third")], contextOverlay: undefined },
				{
					base: false,
					roles: [
						system,
						user("first"),
						assistant("gemini-test: first"),
						user("second"),
						assistant("gemini-test: second"),
						user("third"),
					],
					contextOverlay: undefined,
				},
			]);
			expect(statuses).toEqual([200, 200, 409, 200]);
			const acp = trace().slice(discovery);
			// The restarted process loads the saved agy session and receives only the new prompt.
			expect(acp.filter((entry) => entry.method === "session/load").map((entry) => entry.params)).toEqual([
				expect.objectContaining({ sessionId: "mock-agy-session", cwd }),
			]);
			const prompts = acp.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params);
			expect(prompts.slice(0, 2)).toEqual([
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "first" }] },
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "second" }] },
			]);
			// The lost store also lost the saved session; agy starts a new one with this turn's input only.
			expect(prompts[2]).toEqual({ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "third" }] });
		} finally {
			session.dispose();
			await Promise.all([closePiServerObserver(session), ...close.mock.results.map(({ value }) => value)]);
		}
		await vi.waitFor(() => expect(released).toBe(true));
	});

	it("keeps automatic session naming out of the live agy conversation", async () => {
		signedIn();
		const runtime = await createRuntime();
		const discovery = trace().length;
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model: runtime.getModel(providerId, "gemini-test")!,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		try {
			await session.bindExtensions({});
			await session.prompt("first");
			await session.prompt("second");
			const requests = trace().slice(discovery);
			expect(requests.filter((entry) => entry.method === "session/new")).toHaveLength(1);
			expect(requests.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params)).toEqual([
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "first" }] },
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "second" }] },
			]);
		} finally {
			session.dispose();
			await Promise.all(close.mock.results.map(({ value }) => value));
		}
	});

	it.each([
		{ label: "an unknown context window", contextWindow: 0, automatic: false },
		{ label: "a configured context window", contextWindow: 50_000, automatic: true },
	])("keeps Pi's compaction summaries off agy with $label", async ({ contextWindow, automatic }) => {
		signedIn();
		let modelsPath: string | null = null;
		if (contextWindow > 0) {
			modelsPath = join(cwd, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({ providers: { [providerId]: { modelOverrides: { "gemini-test": { contextWindow } } } } }),
			);
		}
		const runtime = await createRuntime(undefined, modelsPath);
		const model = runtime.getModel(providerId, "gemini-test")!;
		expect(model.contextWindow).toBe(contextWindow);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime: runtime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 49_000, keepRecentTokens: 1 },
			}),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			autoSessionName: false,
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		const reasons: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") reasons.push(event.reason);
		});
		const large = "Retained fixture context. ".repeat(256);
		try {
			await session.bindExtensions({});
			await session.prompt("Remember the initial requirement");
			await session.prompt(large);
			expect(reasons).toEqual(automatic ? ["threshold"] : []);
			await expect(session.compact("Keep the initial requirement")).rejects.toThrow("compaction.model");
			expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			// agy received the two user turns and nothing Pi generated.
			expect(
				trace()
					.filter((entry) => entry.method === "session/prompt")
					.map((entry) => (entry.params as { prompt: unknown }).prompt),
			).toEqual([[{ type: "text", text: "Remember the initial requirement" }], [{ type: "text", text: large }]]);
		} finally {
			session.dispose();
			await Promise.all(close.mock.results.map(({ value }) => value));
		}
	});

	it.each([
		{ label: "no compaction model", piCompaction: false },
		{ label: "a compaction model", piCompaction: true },
	])("shows agy's own compaction and compacts Pi's transcript with $label", async ({ piCompaction }) => {
		signedIn();
		const runtime = await createRuntime();
		const faux = fauxProvider({ models: [{ id: "summarizer", contextWindow: 1_000_000 }] });
		runtime.registerNativeProvider({
			...faux.provider,
			auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		});
		await runtime.refresh({ providers: [faux.provider.id], allowNetwork: false });
		// The cut splits the last turn, so Pi summarizes the history and that turn's prefix.
		faux.setResponses([fauxAssistantMessage("Pi history summary"), fauxAssistantMessage("Pi turn prefix summary")]);
		const discovery = trace().length;
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model: runtime.getModel(providerId, "gemini-test")!,
			modelRuntime: runtime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: {
					enabled: true,
					keepRecentTokens: 1,
					...(piCompaction ? { model: `${faux.provider.id}/summarizer` } : {}),
				},
			}),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			autoSessionName: false,
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") events.push(`start:${event.reason}`);
			if (event.type === "compaction_end")
				events.push(`end:${event.result ? "summary" : (event.errorMessage ?? "agy")}`);
		});
		try {
			await session.bindExtensions({});
			await session.prompt("first");
			await session.prompt("compact");
			// agy's compaction shows as Pi events; Pi then summarizes its own copy with the compaction model.
			expect(events).toEqual(
				piCompaction
					? ["start:threshold", "end:agy", "start:threshold", "end:summary"]
					: ["start:threshold", "end:agy"],
			);
			expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
				piCompaction ? 1 : 0,
			);
			// The agy session continues, and Pi's summary never reaches it.
			await session.prompt("after");
			const acp = trace().slice(discovery);
			expect(acp.filter((entry) => entry.method === "session/new")).toHaveLength(1);
			expect(acp.filter((entry) => entry.method === "session/prompt").at(-1)?.params).toEqual({
				sessionId: "mock-agy-session",
				prompt: [{ type: "text", text: "after" }],
			});
		} finally {
			session.dispose();
			await Promise.all(close.mock.results.map(({ value }) => value));
		}
	});

	it("continues agy's session after another model with every user message since agy's last reply", async () => {
		signedIn();
		const runtime = await createRuntime();
		const faux = fauxProvider({ models: [{ id: "other", contextWindow: 1_000_000 }] });
		runtime.registerNativeProvider({
			...faux.provider,
			auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		});
		await runtime.refresh({ providers: [faux.provider.id], allowNetwork: false });
		faux.setResponses([fauxAssistantMessage("another model's answer")]);
		const agy = runtime.getModel(providerId, "gemini-test")!;
		const discovery = trace().length;
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model: agy,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			autoSessionName: false,
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		try {
			await session.bindExtensions({});
			await session.prompt("first");
			await session.setModel(runtime.getModel(faux.provider.id, "other")!);
			await session.prompt("asked meanwhile");
			await session.setModel(agy);
			await session.prompt("back");
			const acp = trace().slice(discovery);
			expect(acp.filter((entry) => entry.method === "session/new")).toHaveLength(1);
			// agy hears what the user asked meanwhile, never the other model's reply.
			expect(acp.filter((entry) => entry.method === "session/prompt").at(-1)?.params).toEqual({
				sessionId: "mock-agy-session",
				prompt: [
					{ type: "text", text: "asked meanwhile" },
					{ type: "text", text: "back" },
				],
			});
		} finally {
			session.dispose();
			await Promise.all(close.mock.results.map(({ value }) => value));
		}
	});

	it("stores native ACP results, maps the native plan and form to Pi extension records, and preserves cancelled Pi tool results", async () => {
		signedIn();
		const runtime = await createRuntime();
		const model = runtime.getModel(providerId, "gemini-test")!;
		const manager = SessionManager.create(cwd, cwd);
		const events = createEventBus();
		const asked = vi.fn();
		const blocked = vi.fn();
		events.on("rpiv:ask-user:prompt", asked);
		events.on("rpiv:ask-user:blocked", blocked);
		const todoReplay = vi.fn();
		const piTool = vi.fn(async () => ({ content: [], details: {} }));
		const tool = (name: string) => ({
			name,
			label: name,
			description: name,
			promptSnippet: `Use Pi's ${name}`,
			promptGuidelines: [`Prefer Pi's ${name}`],
			parameters: Type.Object({}),
			execute: piTool,
		});
		const lookup = vi.fn(async (_id: string, { key }: { key: string }) => {
			if (key === "fail") throw new Error("Lookup failed");
			return { content: [{ type: "text" as const, text: key }], details: { key } };
		});
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.registerTool(tool("todo"));
					pi.registerTool(tool("ask_user_question"));
					pi.on("session_tree", (_event, ctx) => {
						todoReplay(ctx.sessionManager.getBranch().at(-1));
					});
				},
			],
			cwd,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime: runtime,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			autoSessionName: false,
			noTools: "builtin",
			resourceLoader: { ...createTestResourceLoader({ extensionsResult }), getEventBus: () => events },
			customTools: [
				{
					...tool("lookup"),
					parameters: Type.Object({ key: Type.String() }),
					execute: lookup,
				},
			],
		});
		const close = vi.spyOn(AntigravityRuntime.prototype, "close");
		const nativeRows: [string, string][] = [];
		session.subscribe((event) => {
			if (
				(event.type === "tool_execution_start" ||
					event.type === "tool_execution_update" ||
					event.type === "tool_execution_end") &&
				(event.toolName === "read" || event.toolName.startsWith("agy_"))
			) {
				nativeRows.push([event.type, event.toolName]);
			}
		});
		const select = vi
			.fn<ReturnType<typeof createTestUiContext>["select"]>()
			.mockImplementationOnce(async (_title, options) => options[0])
			.mockImplementationOnce(async (_title, options) => options[0])
			.mockImplementationOnce(async (_title, options) => options[1])
			.mockResolvedValueOnce("Done selecting")
			.mockResolvedValueOnce("Submit answers");
		const results = () =>
			SessionManager.open(manager.getSessionFile()!, cwd)
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
				);
		try {
			await session.bindExtensions({ uiContext: createTestUiContext({ select, input: async () => "Keep both" }) });
			await session.prompt("follow-up");
			await session.prompt("interactions");
			// Only the SDK tool reaches agy, through MCP, and no Pi instructions come with it.
			expect(trace()).toContainEqual(
				expect.objectContaining({
					method: "session/new",
					params: { cwd, mcpServers: [expect.objectContaining({ name: "pi" })] },
				}),
			);
			expect(trace().find((entry) => entry.method === "mock/tools/list")?.result).toMatchObject({
				tools: [{ name: "lookup" }],
			});
			expect(trace()).toContainEqual(
				expect.objectContaining({
					id: "elicitation",
					result: {
						action: "accept",
						content: { choice: "balanced", features: ["Audit", "Metrics"], note: "Keep both" },
					},
				}),
			);
			expect(piTool).not.toHaveBeenCalled();
			expect(asked).toHaveBeenCalledWith(
				expect.objectContaining({
					questions: expect.arrayContaining([expect.objectContaining({ header: "features", multiSelect: true })]),
				}),
			);
			expect(blocked.mock.calls).toEqual([[{ active: true }], [{ active: false }]]);
			expect(todoReplay).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					message: expect.objectContaining({ role: "toolResult", toolName: "todo" }),
				}),
			);
			expect(results()).toMatchObject([
				{ toolName: "lookup", details: { key: "答案" }, isError: false },
				{
					toolName: "read",
					content: [{ type: "text", text: "first chunk" }],
					details: { rawOutput: { lines: 2 } },
					isError: false,
				},
				{
					toolName: "ask_user_question",
					details: {
						cancelled: false,
						answers: [
							{ kind: "option", answer: "Balanced" },
							{ kind: "multi", selected: ["Audit", "Metrics"] },
							{ kind: "custom", answer: "Keep both" },
						],
					},
				},
				{
					toolName: "todo",
					details: { tasks: [{ id: 1, subject: "Review choices", status: "completed" }], nextId: 2 },
				},
			]);
			// agy's own tool calls showed as live Pi tool rows before their results reached the transcript.
			expect(nativeRows).toEqual([
				["tool_execution_start", "read"],
				["tool_execution_update", "read"],
				["tool_execution_end", "read"],
				["tool_execution_start", "agy_search"],
				["tool_execution_end", "agy_search"],
			]);
			// The transcript records agy's read as Pi's read, and its search, which no Pi tool describes, as a note.
			const replyContent = SessionManager.open(manager.getSessionFile()!, cwd)
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
				);
			expect(replyContent).toContainEqual(
				expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "notes.txt", offset: 1 } }),
			);
			expect(replyContent).toContainEqual({ type: "text", text: '[Antigravity ran: Search for TODO]\n{"hits":1}' });
			expect(replyContent).not.toContainEqual(expect.objectContaining({ name: "agy_search" }));
			select.mockImplementationOnce(async (_title, options) => options[1]).mockResolvedValueOnce("Submit answers");
			await session.prompt("native-choice");
			expect(trace()).toContainEqual(
				expect.objectContaining({
					id: "permission",
					result: { outcome: { outcome: "selected", optionId: "file" } },
				}),
			);
			expect(results().at(-1)).toMatchObject({
				toolName: "ask_user_question",
				details: { cancelled: false, answers: [{ kind: "option", answer: "File" }] },
			});
			await session.prompt("custom-error");
			expect(results().at(-1)).toMatchObject({
				toolName: "lookup",
				content: [{ type: "text", text: "Lookup failed" }],
				isError: true,
			});
			const prompt = session.prompt("custom-cancel");
			await vi.waitFor(() =>
				expect(trace().at(-1)).toMatchObject({ method: "mock/tools/call", result: { isError: false } }),
			);
			await session.abort();
			await prompt;
			expect(results().at(-1)).toMatchObject({ toolName: "lookup", details: { key: "答案" }, isError: false });
			expect(lookup).toHaveBeenCalledTimes(3);
		} finally {
			session.dispose();
			await Promise.all(close.mock.results.map(({ value }) => value));
		}
	});

	it.each(["Pi", "PiServer"])("serves agy file and terminal requests in the %s client workspace", async (host) => {
		signedIn();
		writeFileSync(join(cwd, "notes.txt"), "one\ntwo\nthree");
		const workspace = new AntigravityWorkspace(cwd);
		const displays: AntigravityToolDisplay[] = [];
		const client: AntigravityClient = {
			workspace: (request, signal) => workspace.handle(request, signal),
			showToolCall: (display) => displays.push(display),
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "workspace", timestamp: 1 }] });
		let runtime: AntigravityRuntime | undefined;
		try {
			let reply: AssistantMessage;
			if (host === "Pi") {
				const models = await createRuntime();
				runtime = new AntigravityRuntime(cwd);
				reply = await runtime.stream(models.getModel(providerId, "gemini-test")!, context, {}, client).result();
			} else {
				vi.stubEnv("PI_SERVER_MODE", "true");
				vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
				vi.stubEnv(
					"PI_SERVER_URL",
					await listen(
						createPiServer({
							sessionStoreDir: serverStore("server"),
							accountStoreDir: join(cwd, "accounts"),
							authToken: "fixture",
						}),
					),
				);
				const models = await createRuntime();
				const stream = await streamPiServerAntigravity(
					models.getModel(providerId, "gemini-test")!,
					context,
					{ sessionId: "workspace-session", antigravityCwd: cwd },
					client,
				);
				reply = await stream.result();
			}
			expect(trace()).toContainEqual(
				expect.objectContaining({
					method: "initialize",
					params: expect.objectContaining({
						clientCapabilities: expect.objectContaining({
							fs: { readTextFile: true, writeTextFile: true },
							terminal: true,
						}),
					}),
				}),
			);
			const text = reply.content.find((block) => block.type === "text");
			expect(JSON.parse(text?.type === "text" ? text.text : "")).toEqual({
				read: "two",
				exit: { exitCode: 0, signal: null },
				output: { output: "minal ok", truncated: true, exitStatus: { exitCode: 0, signal: null } },
			});
			expect(readFileSync(join(cwd, "out", "result.txt"), "utf8")).toBe("written");
			// The command agy ran in Pi's terminal is recorded and shown as Pi's bash, with the output agy read.
			const bash = { name: "bash", arguments: { command: expect.stringContaining(" -e 'process.stdout.write(") } };
			expect(reply.content).toContainEqual(expect.objectContaining(bash));
			expect(displays.map((display) => [display.type, display.toolCall.name])).toEqual([
				["start", "agy_execute"],
				["update", "bash"],
				["end", "bash"],
			]);
			expect(displays.at(-1)).toMatchObject({ result: { content: [{ type: "text", text: "minal ok" }] } });
		} finally {
			workspace.close();
			await runtime?.close();
		}
	});

	it("answers agy's parallel tool calls concurrently through PiServer", { timeout: 10_000 }, async () => {
		signedIn();
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
		vi.stubEnv(
			"PI_SERVER_URL",
			await listen(
				createPiServer({
					sessionStoreDir: serverStore("server"),
					accountStoreDir: join(cwd, "accounts"),
					authToken: "fixture",
				}),
			),
		);
		const models = await createRuntime();
		let secondStarted!: () => void;
		const second = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const client: AntigravityClient = {
			toolNames: ["lookup"],
			// The first call waits for the second, so answering callbacks one at a time would deadlock.
			executeTool: async (call) => {
				if (call.arguments.key === "first") await second;
				else secondStarted();
				return {
					toolCall: call,
					result: { content: [{ type: "text", text: String(call.arguments.key) }], details: {} },
					isError: false,
				};
			},
		};
		const stream = await streamPiServerAntigravity(
			models.getModel(providerId, "gemini-test")!,
			normalizeContext({
				tools: [{ name: "lookup", description: "Find an answer", parameters: Type.Object({ key: Type.String() }) }],
				messages: [{ role: "user", content: "parallel", timestamp: 1 }],
			}),
			{ sessionId: "parallel-session", antigravityCwd: cwd },
			client,
		);
		expect((await stream.result()).content.at(-1)).toEqual({ type: "text", text: "first+second" });
		expect(stream.executedToolResults?.map((result) => result.content)).toEqual(
			expect.arrayContaining([[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]),
		);
	});

	it("forwards native permission outcomes and waits for ACP cancellation", async () => {
		signedIn();
		const runtime = await createRuntime();
		const model = runtime.getModel(providerId, "gemini-test")!;
		const adapter = new AntigravityRuntime(cwd);
		const context = (content: string) => normalizeContext({ messages: [{ role: "user", content, timestamp: 1 }] });
		const permission = vi.fn(async () => "Allow once");
		try {
			const stream = adapter.stream(
				model,
				context("permission"),
				{ reasoning: "high" },
				{ requestPermission: permission },
			);
			expect(await stream.result()).toMatchObject({
				content: [{ type: "thinking" }, { type: "text", text: "selected" }],
			});
			expect(permission).toHaveBeenCalledWith("Run native tool", ["Allow once"], expect.any(AbortSignal));
			expect(trace()).toContainEqual(
				expect.objectContaining({
					method: "session/set_config_option",
					params: { sessionId: "mock-agy-session", configId: "effort", value: "high" },
				}),
			);
			// Pi sends no level for "off"; agy must still leave "high".
			await adapter.stream(model, context("off"), {}, { requestPermission: permission }).result();
			expect(trace()).toContainEqual(
				expect.objectContaining({
					method: "session/set_config_option",
					params: { sessionId: "mock-agy-session", configId: "effort", value: "off" },
				}),
			);
			const controller = new AbortController();
			const cancelled = adapter.stream(model, context("cancel"), { signal: controller.signal }, {});
			await vi.waitFor(() =>
				expect(trace().at(-1)).toMatchObject({
					method: "session/prompt",
					params: { prompt: [{ type: "text", text: "cancel" }] },
				}),
			);
			controller.abort();
			expect(await cancelled.result()).toMatchObject({ stopReason: "aborted" });
			expect(trace().at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "mock-agy-session" } });
		} finally {
			await adapter.close();
		}
	});
});
