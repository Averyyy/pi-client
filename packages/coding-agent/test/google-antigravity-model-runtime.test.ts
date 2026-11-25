import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { AntigravityRuntime } from "../src/core/antigravity-runtime.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
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

	it("selects the advertised Orchestrator using the ACP model config and preserves multimodal input", async () => {
		signedIn();
		const runtime = await createRuntime();
		const model = runtime.getModel(providerId, "orchestrator-test")!;
		const prompt = [
			{ type: "text" as const, text: "你好" },
			{ type: "image" as const, mimeType: "image/png", data: "cG5n" },
		];
		const stream = runtime.streamSimple(model, {
			systemPrompt: "Pi prompt",
			messages: [{ role: "user", content: prompt, timestamp: 1 }],
		});
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
		expect(
			trace()
				.slice(-4)
				.map(({ method, params }) => ({ method, params })),
		).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: 2,
					clientInfo: { name: "pi", title: "Pi" },
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				},
			},
			{
				method: "session/new",
				params: { cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append: "Pi prompt" } } } },
			},
			{
				method: "session/set_config_option",
				params: { sessionId: "mock-agy-session", configId: "model", value: "orchestrator-test" },
			},
			{ method: "session/prompt", params: { sessionId: "mock-agy-session", prompt } },
		]);
	});

	it("discovers server agy models and sends incremental turns and tools through a 64 KiB proxy", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const backendUrl = await listen(
			createPiServer({
				sessionStoreDir: join(cwd, "server"),
				accountStoreDir: join(cwd, "accounts"),
				authToken: "fixture",
			}),
		);
		const requests: {
			path: string;
			body?: { target?: string; antigravity?: { baseRunId?: string }; contextOverlay?: unknown[] };
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
		expect(requests.filter(({ path }) => path === "/api/antigravity/models")).toHaveLength(3);
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
			expect(requests.filter(({ path }) => path === "/api/stream").at(-1)?.body).toMatchObject({
				antigravity: { baseRunId: expect.any(String) },
				contextOverlay: [expect.objectContaining({ role: "user", content: [{ type: "text", text: "follow-up" }] })],
			});
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
			expect(messages[0].content[0]).toMatchObject({ type: "toolCall", id: results[0].toolCallId });
			await session.prompt("permission");
			expect(select).toHaveBeenCalledWith("Run native tool", ["Allow once"], { signal: expect.any(AbortSignal) });
			const compacted = await session.compact();
			expect(compacted.summary).toContain("Reviewed 答案");
			expect(reopen()).toContainEqual(expect.objectContaining({ type: "message", message: results[0] }));
			expect(trace().at(-1)).toMatchObject({ method: "session/prompt" });
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

	it.each([
		{ label: "an unknown context window", contextWindow: 0, automatic: false },
		{ label: "a configured context window", contextWindow: 50_000, automatic: true },
	])("uses the correct compaction trigger with $label", async ({ contextWindow, automatic }) => {
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
		try {
			await session.bindExtensions({});
			await session.prompt("Remember the initial requirement");
			expect(reasons).toEqual([]);
			await session.prompt("Retained fixture context. ".repeat(256));
			expect(reasons).toEqual(automatic ? ["threshold"] : []);
			if (!automatic) {
				const requests = trace();
				expect(requests.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
				expect(requests.filter((entry) => entry.method === "session/new")).toHaveLength(2);
				const result = await session.compact("Keep the initial requirement");
				expect(result.summary).toContain("initial requirement");
				expect(reasons).toEqual(["manual"]);
			}
			expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
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
			expect(trace()).toContainEqual(
				expect.objectContaining({
					method: "session/new",
					params: expect.objectContaining({
						mcpServers: [expect.objectContaining({ name: "pi" })],
						_meta: {
							antigravity: {
								systemPrompt: { append: expect.not.stringMatching(/Pi's (todo|ask_user_question)/) },
							},
						},
					}),
				}),
			);
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
			expect(SessionManager.open(manager.getSessionFile()!, cwd).getBranch()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "custom",
						customType: "antigravity_acp_update",
						data: {
							acpSessionId: "mock-agy-session",
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: "native-1",
								status: "completed",
								rawOutput: { lines: 2 },
							},
						},
					}),
				]),
			);
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
			const controller = new AbortController();
			const cancelled = adapter.stream(model, context("cancel"), { signal: controller.signal });
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
