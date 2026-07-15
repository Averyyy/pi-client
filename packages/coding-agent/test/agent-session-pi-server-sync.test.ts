import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession as createSdkAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

async function createAgentSession(options: Parameters<typeof createSdkAgentSession>[0] = {}) {
	return createSdkAgentSession({ autoSessionName: false, ...options });
}

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

	it("retries a retryable pi-server stream error after resyncing the active tree", async () => {
		const tempDir = join(tmpdir(), `pi-stream-error-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						streamCount++;
						if (streamCount === 2) {
							return new Response(
								[
									'data: {"type":"start"}\n\n',
									'data: {"type":"text_start","contentIndex":0}\n\n',
									'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
									'data: {"type":"text_end","contentIndex":0}\n\n',
									'data: {"type":"done","reason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}}\n\n',
								].join(""),
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response(
							'data: {"type":"error","reason":"error","errorMessage":"connection lost","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}}\n\n',
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-error",
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
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const events: string[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
				if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
			});
			try {
				await session.prompt("will fail");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			const treeRequests = capturedRequests.filter((request) => request.url.includes("/api/session/tree/"));
			expect(treeRequests.map((request) => new URL(request.url).pathname)).toEqual([
				"/api/session/tree/sync",
				"/api/session/tree/append",
				"/api/session/tree/append",
			]);
			expect(streamCount).toBe(2);
			expect(events).toEqual(["start:1", "end:success=true"]);
			expect(session.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("does not retry a pi-server provider balance error", async () => {
		const tempDir = join(tmpdir(), `pi-stream-balance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		let streamCount = 0;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");

					if (url.endsWith("/api/stream")) {
						streamCount++;
						return new Response(
							'data: {"type":"error","reason":"error","errorMessage":"401 Insufficient balance","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}}\n\n',
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-balance",
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
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const events: string[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			});
			try {
				await session.prompt("will fail for balance");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(streamCount).toBe(1);
			expect(events).toEqual([]);
			expect(session.state.messages.map((message) => message.role)).toEqual(["user"]);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("retries from the last valid pi-server leaf after an HTTP 524 stream failure", async () => {
		const tempDir = join(tmpdir(), `pi-stream-524-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						streamCount++;
						if (streamCount === 1) {
							return new Response("Cloudflare timeout", { status: 524, statusText: "A timeout occurred" });
						}
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
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
							staticContextHash: "hash-524",
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
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const events: string[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
				if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
			});
			try {
				await session.prompt("will 524");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(streamCount).toBe(2);
			expect(events).toEqual(["start:1", "end:success=true"]);
			const activeMessages = sessionManager.buildSessionContext().messages;
			expect(activeMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(
				activeMessages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason === "error" &&
						message.errorMessage?.includes("524"),
				),
			).toBe(false);
			const errorEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error" &&
						entry.message.errorMessage?.includes("524"),
				);
			expect(errorEntries).toHaveLength(1);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("continues from the last valid leaf when an existing session ends on an assistant failure", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-existing-failure-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
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
		sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1000 });
		const oldErrorId = sessionManager.appendMessage({
			role: "assistant",
			content: [],
			api: model!.api,
			provider: model!.provider,
			model: model!.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "previous 524",
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
							staticContextHash: "hash-existing-failure",
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
				await session.prompt("continue from old failure");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			const treeSync = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/sync"));
			expect(treeSync).toBeDefined();
			const syncedEntries = treeSync!.body.entries as Array<{ id: string }>;
			expect(syncedEntries.some((entry) => entry.id === oldErrorId)).toBe(true);
			const activeMessages = sessionManager.buildSessionContext().messages;
			expect(activeMessages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
			expect(
				activeMessages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason === "error" &&
						message.errorMessage === "previous 524",
				),
			).toBe(false);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("chunks the first tree bootstrap for a long session created outside pi-client", async () => {
		const tempDir = join(tmpdir(), `pi-long-legacy-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		for (let index = 0; index < 30; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: `legacy question ${index} ${"x".repeat(1200)}`,
				timestamp: 1000 + index * 2,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `legacy answer ${index} ${"y".repeat(1200)}` }],
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
				timestamp: 1001 + index * 2,
			});
		}

		const maxBytes = 2 * 1024;
		const capturedRequests: { url: string; bodyBytes: number; body: Record<string, unknown> }[] = [];

		try {
			process.env.PI_SERVER_MODE = "true";
			process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const rawBody = (init?.body as string | undefined) ?? "";
					const body = parseJsonObject(rawBody);
					capturedRequests.push({ url, bodyBytes: Buffer.byteLength(rawBody, "utf-8"), body });

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

					if (url.endsWith("/api/request/chunk")) {
						const target = body.target;
						if (typeof target !== "string") {
							throw new Error("Expected chunk target");
						}
						const index = body.chunkIndex;
						const total = body.totalChunks;
						if (typeof index !== "number" || typeof total !== "number") {
							throw new Error("Expected numeric chunk index and total");
						}
						if (index !== total - 1) {
							return new Response(
								JSON.stringify({
									received: true,
									requestId: body.requestId,
									chunkIndex: index,
									totalChunks: total,
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							);
						}
						return new Response(
							JSON.stringify({
								sessionId: body.sessionId,
								leafId: body.leafId,
								staticContextHash: "hash-long-legacy",
								entryCount: 61,
								target,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-long-legacy",
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

			expect(capturedRequests.every((request) => request.bodyBytes <= maxBytes)).toBe(true);
			const chunkTargets = capturedRequests
				.filter((request) => request.url.endsWith("/api/request/chunk"))
				.map((request) => request.body.target);
			expect(chunkTargets).toContain("/api/session/tree/sync");
			const streamRequest = capturedRequests.find((request) => request.url.endsWith("/api/stream"));
			expect(streamRequest?.body).not.toHaveProperty("messages");
			expect(streamRequest?.body).not.toHaveProperty("entries");
			expect(streamRequest?.body).not.toHaveProperty("delta");
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("does not retry or resync after aborting a pi-server stream", async () => {
		const tempDir = join(tmpdir(), `pi-stream-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamRequestStarted = () => {};
		const streamRequestPromise = new Promise<void>((resolve) => {
			streamRequestStarted = resolve;
		});

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						streamRequestStarted();
						const signal = init?.signal;
						return await new Promise<Response>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(new Error("Request aborted by test"));
								return;
							}
							signal?.addEventListener("abort", () => reject(new Error("Request aborted by test")), {
								once: true,
							});
						});
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-abort",
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
			const events: Array<{ type: string; willRetry?: boolean }> = [];
			session.subscribe((event) => {
				if (event.type === "agent_end") {
					events.push({ type: event.type, willRetry: event.willRetry });
				} else if (event.type === "auto_retry_start") {
					events.push({ type: event.type });
				}
			});
			try {
				const promptPromise = session.prompt("abort me");
				await streamRequestPromise;
				await session.abort();
				await promptPromise;
			} finally {
				session.dispose();
			}

			const treeRequests = capturedRequests.filter((request) => request.url.includes("/api/session/tree/"));
			expect(treeRequests.map((request) => new URL(request.url).pathname)).toEqual(["/api/session/tree/sync"]);
			expect(events).toEqual([{ type: "agent_end", willRetry: false }]);
			const leaf = sessionManager.getLeafEntry();
			expect(leaf?.type).toBe("message");
			expect(leaf?.type === "message" ? leaf.message.role : undefined).toBe("user");
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("passes the active abort signal to post-stream pi-server tree sync", async () => {
		const tempDir = join(tmpdir(), `pi-post-stream-sync-signal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const treeSignals: Array<AbortSignal | null> = [];

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (url.includes("/api/session/tree/")) {
						treeSignals.push(init?.signal ?? null);
					}

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
							staticContextHash: "hash-post-stream",
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
				await session.prompt("hello");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(treeSignals.length).toBeGreaterThanOrEqual(2);
			expect(treeSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("does not retry the LLM after post-stream pi-server tree append fails", async () => {
		const tempDir = join(tmpdir(), `pi-post-stream-append-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						streamCount++;
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

					if (url.endsWith("/api/session/tree/append")) {
						return new Response(JSON.stringify({ error: "CONNECT timeout" }), {
							status: 502,
							statusText: "Bad Gateway",
							headers: { "Content-Type": "application/json" },
						});
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-post-stream-append-fail",
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
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const events: Array<{ type: string; willRetry?: boolean }> = [];
			session.subscribe((event) => {
				if (event.type === "agent_end") {
					events.push({ type: event.type, willRetry: event.willRetry });
				} else if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
					events.push({ type: event.type });
				}
			});
			try {
				await session.prompt("post stream sync fails");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(streamCount).toBe(1);
			expect(events).toEqual([{ type: "agent_end", willRetry: false }]);
			expect(session.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			const syncErrorEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.errorMessage?.includes("Session tree append failed"),
				);
			expect(syncErrorEntries).toHaveLength(1);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("compacts pi-server length overflow without keeping the length assistant on the active branch", async () => {
		const tempDir = join(tmpdir(), `pi-length-overflow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const baseModel = getModel("anthropic", "claude-sonnet-4-5");
		expect(baseModel).toBeDefined();
		const model = { ...baseModel!, contextWindow: 100, maxTokens: 20 };
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 } });
		let streamCount = 0;
		let serverEntries: Array<Record<string, unknown>> = [];
		let serverLeafId: string | null = null;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");

					if (url.endsWith("/api/stream")) {
						streamCount++;
						if (streamCount === 1) {
							return new Response(
								[
									'data: {"type":"start"}\n\n',
									'data: {"type":"text_start","contentIndex":0}\n\n',
									'data: {"type":"text_delta","contentIndex":0,"delta":"first ok"}\n\n',
									'data: {"type":"text_end","contentIndex":0}\n\n',
									'data: {"type":"done","reason":"stop","usage":{"input":10,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":11}}\n\n',
								].join(""),
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						if (streamCount === 2) {
							return new Response(
								'data: {"type":"done","reason":"length","usage":{"input":100,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":100}}\n\n',
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								'data: {"type":"done","reason":"stop","usage":{"input":20,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":21}}\n\n',
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					if (url.endsWith("/api/session/tree/sync")) {
						serverEntries = [...((body.entries as Array<Record<string, unknown>> | undefined) ?? [])];
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/append")) {
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as Array<Record<string, unknown>> | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/switch")) {
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/compact")) {
						const compactionEntry = {
							type: "compaction",
							id: "server-compact-1",
							parentId: serverLeafId,
							timestamp: "2026-01-01T00:00:00.000Z",
							summary: "server summary",
							firstKeptEntryId: serverLeafId,
							tokensBefore: 100,
						};
						serverEntries = [...serverEntries, compactionEntry];
						serverLeafId = compactionEntry.id;
						return new Response(
							JSON.stringify({
								success: true,
								compaction: {
									summary: compactionEntry.summary,
									firstKeptEntryId: compactionEntry.firstKeptEntryId,
									tokensBefore: compactionEntry.tokensBefore,
								},
								compactionEntry,
								entries: serverEntries,
								leafId: serverLeafId,
								messages: [],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							leafId: body.leafId,
							staticContextHash: "hash-length",
							entryCount: serverEntries.length,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				thinkingLevel: "off",
				authStorage,
				modelRegistry,
				sessionManager,
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.prompt("first");
				await session.agent.waitForIdle();
				await session.prompt("overflow");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(streamCount).toBe(3);
			const allLengthEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "length",
				);
			expect(allLengthEntries).toHaveLength(1);
			const activeLengthEntries = sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "length",
				);
			expect(activeLengthEntries).toHaveLength(0);
			expect(
				sessionManager
					.buildSessionContext()
					.messages.some((message) => message.role === "assistant" && message.stopReason === "length"),
			).toBe(false);
			const lastMessage = session.messages.at(-1);
			expect(lastMessage?.role).toBe("assistant");
			expect(lastMessage?.role === "assistant" ? lastMessage.content : undefined).toEqual([
				{ type: "text", text: "recovered" },
			]);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});
});
