import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityRuntime } from "../src/core/antigravity-runtime.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { closePiServerObserver } from "../src/core/pi-server-observer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const providerId = "google-antigravity";
let cwd: string;

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

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(cwd, { recursive: true, force: true });
});

describe("Antigravity ACP", () => {
	it("keeps login and model discovery in agy, and never uses the old Pi credential", async () => {
		const old = { type: "oauth" as const, access: "old", refresh: "old", expires: 0 };
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(providerId, async () => old);
		const network = vi.fn(() => {
			throw new Error("Unexpected Pi HTTP request");
		});
		vi.stubGlobal("fetch", network);
		const runtime = await createRuntime(credentials);
		expect(runtime.getProvider(providerId)?.auth.oauth?.loginLabel).toBe("Sign in with Google Antigravity");
		expect(runtime.getModels(providerId)).toEqual([]);
		expect(await runtime.listCredentials()).toEqual([]);

		const notify = vi.fn();
		const prompt = vi.fn(async () => "mock-code");
		expect(await runtime.login(providerId, "oauth", { notify, prompt })).toEqual({ type: "local", providerId });
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "auth_url", url: "https://accounts.google.com/mock-antigravity" }),
		);
		expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "manual_code" }));
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

	it("executes a custom Pi tool through MCP and sends subsequent turns to the same ACP session in PiServer mode", async () => {
		signedIn();
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.invalid");
		const network = vi.fn(async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path === "/api/accounts") return Response.json({ accounts: [] });
			if (path === "/api/observer") return Response.json({ accepted: true });
			throw new Error(`Unexpected PiServer request ${path}`);
		});
		vi.stubGlobal("fetch", network);
		const modelsPath = join(cwd, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { [providerId]: { modelOverrides: { "gemini-test": { contextWindow: 50_000 } } } },
			}),
		);
		const runtime = await createRuntime(undefined, modelsPath);
		const model = runtime.getModel(providerId, "gemini-test")!;
		expect(model.contextWindow).toBe(50_000);
		const execute = vi.fn(async (_id: string, params: { key: string }) => ({
			content: [{ type: "text" as const, text: `Found ${params.key}` }],
			details: {},
		}));
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName === "lookup") return { content: [{ type: "text", text: "Reviewed 答案" }] };
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
			sessionManager: SessionManager.inMemory(cwd),
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
		session.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event.type);
		});
		try {
			await session.bindExtensions({});
			await session.prompt("custom");
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
				{ type: "text", text: "gemini-test: follow-up" },
			]);
			const requests = trace();
			expect(requests.filter((entry) => entry.method === "session/new")).toHaveLength(2);
			expect(requests.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params)).toEqual([
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "custom" }] },
				{ sessionId: "mock-agy-session", prompt: [{ type: "text", text: "follow-up" }] },
			]);
			expect(requests.find((entry) => entry.method === "mock/tools/list")?.result).toMatchObject({
				tools: [
					{
						name: "lookup",
						inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
					},
				],
			});
			expect(requests.find((entry) => entry.method === "mock/tools/call")?.result).toEqual({
				content: [{ type: "text", text: "Reviewed 答案" }],
				isError: false,
			});
			const compacted = await session.compact();
			expect(compacted.summary).toContain("Reviewed 答案");
			expect(trace().at(-1)).toMatchObject({ method: "session/prompt" });
			expect(
				network.mock.calls.every(([input]) =>
					["/api/accounts", "/api/observer"].includes(new URL(String(input)).pathname),
				),
			).toBe(true);
		} finally {
			const closes = close.mock.calls.length;
			session.dispose();
			await Promise.all([closePiServerObserver(session), ...close.mock.results.map(({ value }) => value)]);
			expect(close).toHaveBeenCalledTimes(closes + 1);
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
