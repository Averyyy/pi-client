import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function parseJsonObject(rawBody: string): Record<string, unknown> {
	if (!rawBody) return {};
	const parsed = JSON.parse(rawBody) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected JSON object request body");
	}
	return parsed as Record<string, unknown>;
}

describe("AgentSession pi-server sync", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_SERVER_MODE;
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	it("syncs the session tree to pi-server after explicit tree navigation without uploading flat messages", async () => {
		const harness = createHarness({ responses: ["answer one", "answer two"] });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];

		try {
			await harness.session.prompt("question one");
			await harness.agent.waitForIdle();
			await harness.session.prompt("question two");
			await harness.agent.waitForIdle();

			const userTwoEntry = harness.sessionManager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						Array.isArray(entry.message.content) &&
						entry.message.content.some((content) => content.type === "text" && content.text === "question two"),
				);
			expect(userTwoEntry).toBeDefined();

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedRequests.push({ url, body });

				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-tree",
							messageCount: 4,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/session/tree/sync")) {
					const entries = body.entries as unknown[];
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-tree",
							entryCount: entries.length,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("Unexpected request", { status: 500 });
			});

			vi.stubGlobal("fetch", mockFetch);
			process.env.PI_SERVER_MODE = "true";

			const result = await harness.session.navigateTree(userTwoEntry!.id, { summarize: false });
			expect(result.editorText).toBe("question two");

			const syncRequest = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/sync"));
			expect(syncRequest).toBeDefined();
			expect(syncRequest!.body.leafId).toBe(harness.sessionManager.getLeafId());
			expect(syncRequest!.body).not.toHaveProperty("messages");
			expect(syncRequest!.body.entries).toEqual(harness.sessionManager.getEntries());
		} finally {
			harness.cleanup();
		}
	});

	it("bootstraps an existing non-pi-client session tree before streaming", async () => {
		const tempDir = join(tmpdir(), `pi-existing-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model!.provider, "test-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const sessionManager = SessionManager.inMemory(cwd);
		const legacyUserId = sessionManager.appendMessage({ role: "user", content: "legacy question", timestamp: 1000 });
		const legacyAssistantId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "legacy answer" }],
			api: model!.api,
			provider: model!.provider,
			model: model!.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2000,
		});
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								'data: {"type":"done","reason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}}\n\n',
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-existing",
							entryCount: Array.isArray(body.entries) ? body.entries.length : 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				authStorage,
				modelRegistry,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.prompt("fresh question");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			const treeSync = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/sync"));
			expect(treeSync).toBeDefined();
			expect(treeSync!.body).not.toHaveProperty("messages");
			const entries = treeSync!.body.entries as Array<{
				id: string;
				type: string;
				message?: { role: string; content: unknown };
			}>;
			expect(entries.some((entry) => entry.id === legacyUserId)).toBe(true);
			expect(entries.some((entry) => entry.id === legacyAssistantId)).toBe(true);
			expect(
				entries.some(
					(entry) =>
						entry.type === "message" &&
						Array.isArray(entry.message?.content) &&
						entry.message.content.some((content) => content.type === "text" && content.text === "fresh question"),
				),
			).toBe(true);
			const streamRequest = capturedRequests.find((request) => request.url.endsWith("/api/stream"));
			expect(streamRequest?.body).not.toHaveProperty("messages");
			expect(streamRequest?.body).not.toHaveProperty("delta");
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});
});
