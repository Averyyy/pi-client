import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

vi.mock("../src/core/pi-server-observer.ts", () => ({ PiServerObserver: class {} }));

it("measures accepted input preparation and tool continuation separately from tool execution", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-sdk-timing-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	vi.stubEnv("PI_SERVER_MODE", "true");
	vi.stubEnv("PI_SERVER_URL", "http://fixture.invalid");
	vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture");
	vi.stubEnv("PI_TIMING", "1");
	let clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
	const model: Model<"openai-completions"> = {
		id: "timing",
		name: "Timing",
		provider: "timing",
		api: "openai-completions",
		baseUrl: "http://fixture.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const auth = AuthStorage.inMemory({ timing: { type: "api_key", key: "fixture" } });
	const registry = await createModelRegistry(auth, join(agentDir, "models.json"));
	registry.registerProvider("timing", {
		api: model.api,
		streamSimple: () => {
			throw new Error("Local inference is forbidden");
		},
	});
	const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => {
					clock += 70;
				});
				pi.on("tool_execution_end", () => {
					clock += 60;
				});
			},
		],
	});
	await loader.reload();
	let requests = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith("/api/stream")) return Response.json({ sessionId: "fixture", messageCount: 0 });
			const body = JSON.parse(String(init?.body)) as { observeTiming?: boolean };
			expect(body.observeTiming).toBe(true);
			requests++;
			const message: AssistantMessage = {
				...fauxAssistantMessage("done"),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			if (requests === 1) {
				message.content = [{ type: "toolCall", id: "fixture_call", name: "timed_tool", arguments: {} }];
				message.stopReason = "toolUse";
			}
			clock += 5;
			return new Response(
				`: keep-alive\n\nevent: cache_policy\ndata: {"cacheRetention":"short"}\n\nevent: timing\ndata: ${JSON.stringify({ bodyReadyMs: 1, providerDispatchMs: 2, firstContentMs: 3 })}\n\nevent: done\ndata: ${JSON.stringify({ type: "done", reason: message.stopReason, message })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}),
	);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: getModelRuntime(registry),
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
		autoSessionName: false,
		tools: [],
		customTools: [
			{
				name: "timed_tool",
				label: "Timed tool",
				description: "Fixture",
				parameters: Type.Object({}),
				execute: async () => {
					clock += 1_000;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		],
	});
	session.subscribe((event) => {
		if (event.type === "run_state_changed" && event.running) clock += 30;
		if (event.type === "tool_execution_end" && !event.parentToolCallId) clock += 40;
	});
	try {
		await session.prompt("fixture");
		expect(requests).toBe(2);
		const logs = diagnostic.mock.calls
			.filter(([value]) => String(value).startsWith("[pi-server timing] "))
			.map(
				([value]) =>
					JSON.parse(String(value).slice("[pi-server timing] ".length)) as {
						clientPrepareFrom: string;
						clientPrepareMs: number;
					},
			);
		expect(logs.map((log) => log.clientPrepareFrom)).toEqual(["run_accepted", "tool_end"]);
		expect(logs[0].clientPrepareMs).toBe(100);
		expect(logs[1].clientPrepareMs).toBe(100);
	} finally {
		session.dispose();
		registry.unregisterProvider("timing");
		resetAllSessionTracking();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(directory, { recursive: true, force: true });
	}
});
