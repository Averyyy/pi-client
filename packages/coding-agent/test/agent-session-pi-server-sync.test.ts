import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	acquirePiServerSessionLease,
	hashPiServerCompactRequest,
	releasePiServerSessionLease,
} from "../src/core/pi-server-client.ts";
import {
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	PI_SERVER_EMPTY_TREE_HASH,
} from "../src/core/pi-server-protocol.ts";
import { getPiServerRunStatePath, readPiServerPendingRun } from "../src/core/pi-server-run-state.ts";
import { createAgentSession as createSdkAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

async function createAgentSession(options: Parameters<typeof createSdkAgentSession>[0] = {}) {
	return createSdkAgentSession({ autoSessionName: false, ...options });
}

async function createTestModelRuntime(provider: string) {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	return getModelRuntime(modelRegistry);
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
	if (!rawBody) return {};
	const parsed = JSON.parse(rawBody) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected JSON object request body");
	}
	return parsed as Record<string, unknown>;
}

function getStreamRequestMac(body: Record<string, unknown>): string {
	const { runId: _runId, eventCursor: _eventCursor, ...identity } = body;
	const serialized = canonicalJsonStringify(identity);
	if (serialized === undefined) {
		throw new Error("Expected serializable stream request identity");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

interface TestTerminalRun {
	requestMac: string;
	status: "completed" | "failed";
}

function registerTestTerminalRun(
	body: Record<string, unknown>,
	terminalRuns: Map<string, TestTerminalRun>,
	status: TestTerminalRun["status"],
): Array<Record<string, unknown>> {
	if (typeof body.runId !== "string") throw new Error("Expected a stream run id");
	const requestMac = getStreamRequestMac(body);
	terminalRuns.set(body.runId, { requestMac, status });
	return [
		{
			type: "pi_server_run",
			timestamp: 1,
			details: {
				sessionId: body.sessionId,
				runId: body.runId,
				requestMac,
				restartUnknown: false,
			},
		},
	];
}

function makeTestRunAcknowledgement(
	body: Record<string, unknown>,
	terminalRuns: Map<string, TestTerminalRun>,
): Response {
	if (typeof body.runId !== "string") throw new Error("Expected an acknowledged run id");
	const terminal = terminalRuns.get(body.runId);
	if (!terminal) throw new Error("Expected a terminal run before acknowledgement");
	return new Response(
		JSON.stringify({
			acknowledged: true,
			sessionId: body.sessionId,
			runId: body.runId,
			requestMac: terminal.requestMac,
			status: terminal.status,
			acknowledgedAt: 1,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function makeSessionResponse(body: Record<string, unknown>, overrides: Record<string, unknown> = {}): Response {
	const requestedHash = typeof body.staticContextHash === "string" ? body.staticContextHash : undefined;
	const entries = Array.isArray(body.entries) ? body.entries : [];
	const responseBody =
		requestedHash === undefined
			? {
					protocolVersion: 2,
					sessionId: body.sessionId,
					staticContextHash: "",
					treeHash: hashPiServerSessionEntries(entries),
					messageCount: entries.filter(
						(entry) =>
							typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message",
					).length,
					entryCount: entries.length,
					leafId: (body.leafId as string | null | undefined) ?? null,
					revision: entries.length === 0 ? 0 : 1,
					...overrides,
				}
			: {
					protocolVersion: 2,
					sessionId: body.sessionId,
					staticContextRequired: false,
					staticContextHash: requestedHash,
					treeHash: PI_SERVER_EMPTY_TREE_HASH,
					messageCount: 0,
					entryCount: 0,
					leafId: null,
					revision: 0,
					...overrides,
				};
	return new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("AgentSession pi-server sync", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_SERVER_MODE;
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
		delete process.env.PI_SERVER_STREAM_RECOVERY_WINDOW_MS;
	});

	it("syncs the session tree to pi-server after explicit tree navigation without uploading flat messages", async () => {
		const harness = await createHarness({ responses: ["answer one", "answer two"] });
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

				if (url.endsWith("/api/session/init") || url.endsWith("/api/session/tree/append")) {
					return makeSessionResponse(body);
				}

				return new Response("Unexpected request", { status: 500 });
			});

			vi.stubGlobal("fetch", mockFetch);
			process.env.PI_SERVER_MODE = "true";

			const result = await harness.session.navigateTree(userTwoEntry!.id, { summarize: false });
			expect(result.editorText).toBe("question two");

			const syncRequest = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/append"));
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
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
		const terminalRuns = new Map<string, TestTerminalRun>();

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.prompt("fresh question");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			const treeSync = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/append"));
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;
		const terminalRuns = new Map<string, TestTerminalRun>();

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
							const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
							return new Response(
								[
									'data: {"type":"start"}\n\n',
									'data: {"type":"text_start","contentIndex":0}\n\n',
									'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
									'data: {"type":"text_end","contentIndex":0}\n\n',
									`data: ${JSON.stringify({
										type: "done",
										reason: "stop",
										usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
										diagnostics,
									})}\n\n`,
								].join(""),
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						const diagnostics = [
							...registerTestTerminalRun(body, terminalRuns, "failed"),
							{
								type: "pi_server_failure",
								timestamp: 1,
								details: { phase: "provider_stream", retryable: true, source: "pi-server" },
							},
						];
						return new Response(
							`data: ${JSON.stringify({
								type: "error",
								reason: "error",
								errorMessage: "connection lost",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
								diagnostics,
							})}\n\n`,
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}
					if (new URL(url).pathname.includes("/runs/")) {
						return new Response(JSON.stringify({ error: "Run not found" }), {
							status: 404,
							headers: { "Content-Type": "application/json" },
						});
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
				"/api/session/tree/append",
				"/api/session/tree/append",
				"/api/session/tree/switch",
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
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

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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

	it("does not retry a pi-server restart-unknown terminal", async () => {
		const tempDir = join(tmpdir(), `pi-stream-restart-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
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
							`data: ${JSON.stringify({
								type: "error",
								reason: "error",
								errorMessage: "restart-unknown",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
								diagnostics: [
									{
										type: "pi_server_run",
										timestamp: 1,
										details: {
											sessionId: body.sessionId,
											runId: body.runId,
											requestMac: "a".repeat(64),
											restartUnknown: true,
										},
									},
								],
							})}\n\n`,
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const retries: string[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") retries.push(`start:${event.attempt}`);
			});
			try {
				await session.prompt("restart uncertainty");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(streamCount).toBe(1);
			expect(retries).toEqual([]);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("flushes the persisted terminal assistant before acknowledging its pi-server run", async () => {
		const tempDir = join(tmpdir(), `pi-run-ack-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const events: string[] = [];
		const originalFlushSessionFile = sessionManager.flushSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "flushSessionFile").mockImplementation(() => {
			events.push("flush");
			originalFlushSessionFile();
		});
		const serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (url.endsWith("/api/stream")) {
						const sessionFile = sessionManager.getSessionFile();
						if (!sessionFile) throw new Error("Expected a persisted session file");
						const pending = readPiServerPendingRun(getPiServerRunStatePath(sessionFile));
						if (!pending) throw new Error("Expected a durable pending pi-server run");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"durable"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics: [
										{
											type: "pi_server_run",
											timestamp: 1,
											details: {
												sessionId: body.sessionId,
												runId: pending.runId,
												requestMac: pending.requestHash,
												restartUnknown: false,
											},
										},
									],
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					if (url.endsWith("/api/session/run/ack")) {
						events.push("ack");
						const sessionFile = sessionManager.getSessionFile();
						if (!sessionFile) throw new Error("Expected a persisted session file");
						const pending = readPiServerPendingRun(getPiServerRunStatePath(sessionFile));
						if (!pending) throw new Error("Expected a durable pending pi-server run");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: body.sessionId,
								runId: body.runId,
								requestMac: pending.requestHash,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					if (url.endsWith("/api/session/tree/append")) {
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					}

					return makeSessionResponse(body, {
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.prompt("durable terminal");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(events).toEqual(["flush", "ack"]);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("holds the persistent session lease across terminal acknowledgement and tool execution", async () => {
		const tempDir = join(tmpdir(), `pi-session-tool-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		let streamCount = 0;
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					const sessionFile = sessionManager.getSessionFile();
					if (!sessionFile) throw new Error("Expected a persisted session file");
					const runStatePath = getPiServerRunStatePath(sessionFile);
					if (url.endsWith("/api/stream")) {
						streamCount++;
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected a durable pending pi-server run");
						const diagnostics = [
							{
								type: "pi_server_run",
								timestamp: 1,
								details: {
									sessionId: body.sessionId,
									runId: pending.runId,
									requestMac: pending.requestHash,
									restartUnknown: false,
								},
							},
						];
						const events =
							streamCount === 1
								? [
										{ type: "start" },
										{ type: "toolcall_start", contentIndex: 0, id: "wait-1", toolName: "wait" },
										{ type: "toolcall_delta", contentIndex: 0, delta: "{}" },
										{ type: "toolcall_end", contentIndex: 0 },
										{
											type: "done",
											reason: "toolUse",
											usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
											diagnostics,
										},
									]
								: [
										{ type: "start" },
										{ type: "text_start", contentIndex: 0 },
										{ type: "text_delta", contentIndex: 0, delta: "done" },
										{ type: "text_end", contentIndex: 0 },
										{
											type: "done",
											reason: "stop",
											usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
											diagnostics,
										},
									];
						return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
							status: 200,
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					if (url.endsWith("/api/session/run/ack")) {
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected pending run during acknowledgement");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: pending.sessionId,
								runId: pending.runId,
								requestMac: pending.requestHash,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url.endsWith("/api/session/tree/sync")) {
						serverEntries.splice(
							0,
							serverEntries.length,
							...((body.entries as SessionTreeEntry[] | undefined) ?? []),
						);
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/append")) {
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					}
					return makeSessionResponse(body, {
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
				tools: ["wait"],
				customTools: [
					{
						name: "wait",
						label: "Wait",
						description: "Wait for test release",
						parameters: Type.Object({}),
						execute: async () => {
							await toolRelease;
							return { content: [{ type: "text", text: "released" }], details: {} };
						},
					},
				],
			});
			const sawToolStart = new Promise<void>((resolveStart) => {
				const unsubscribe = session.subscribe((event) => {
					if (event.type !== "tool_execution_start") return;
					unsubscribe();
					resolveStart();
				});
			});
			try {
				const promptPromise = session.prompt("run the wait tool");
				await sawToolStart;
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a persisted session file");
				const runStatePath = getPiServerRunStatePath(sessionFile);
				expect(() => acquirePiServerSessionLease("competing-session", runStatePath)).toThrow(
					"this process already owns the session lease",
				);

				releaseToolExecution?.();
				await promptPromise;

				acquirePiServerSessionLease("competing-session", runStatePath);
				releasePiServerSessionLease("competing-session", runStatePath);
			} finally {
				releaseToolExecution?.();
				session.dispose();
			}

			expect(streamCount).toBe(2);
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("waits for the settling run to release its lease before manual compact acquires it", async () => {
		const tempDir = join(tmpdir(), `pi-session-compact-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		const terminalRuns = new Map<string, string>();
		let compactRequests = 0;
		let compactPromise: Promise<unknown> | undefined;
		let armSettledCompact = false;
		let competingLeaseRejected = false;
		let notifyCompactStarted: (() => void) | undefined;
		const compactStarted = new Promise<void>((resolve) => {
			notifyCompactStarted = resolve;
		});

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					const path = new URL(url).pathname;
					if (path === "/api/stream") {
						if (typeof body.runId !== "string") throw new Error("Expected a stream run id");
						const requestMac = getStreamRequestMac(body);
						terminalRuns.set(body.runId, requestMac);
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"done"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics: [
										{
											type: "pi_server_run",
											timestamp: 1,
											details: {
												sessionId: body.sessionId,
												runId: body.runId,
												requestMac,
												restartUnknown: false,
											},
										},
									],
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (path === "/api/session/run/ack") {
						if (typeof body.runId !== "string") throw new Error("Expected an acknowledged run id");
						const requestMac = terminalRuns.get(body.runId);
						if (!requestMac) throw new Error("Expected a terminal run before acknowledgement");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: body.sessionId,
								runId: body.runId,
								requestMac,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (path === "/api/session/compact") {
						compactRequests++;
						const requestHash = hashPiServerCompactRequest(
							body as unknown as Parameters<typeof hashPiServerCompactRequest>[0],
						);
						return new Response(
							JSON.stringify({
								protocolVersion: 2,
								sessionId: body.sessionId,
								operationId: body.operationId,
								requestHash,
								status: "rejected",
								httpStatus: 409,
								operationDisposition: "not_started",
								error: "test compact reached after run lease release",
							}),
							{ status: 409, headers: { "Content-Type": "application/json" } },
						);
					}
					if (path === "/api/session/tree/append") {
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (path === "/api/session/tree/switch") {
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					}
					return makeSessionResponse(body, {
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			const runStatePath = getPiServerRunStatePath(sessionFile);
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "agent_settled" || !armSettledCompact) return;
				armSettledCompact = false;
				try {
					acquirePiServerSessionLease("competing-session", runStatePath);
					releasePiServerSessionLease("competing-session", runStatePath);
				} catch {
					competingLeaseRejected = true;
				}
				compactPromise = session.compact();
				void compactPromise.catch(() => undefined);
				notifyCompactStarted?.();
			});
			try {
				await session.prompt("first prompt");
				await session.agent.waitForIdle();
				armSettledCompact = true;
				const secondPrompt = session.prompt("second prompt");
				await compactStarted;
				await secondPrompt;
				if (!compactPromise) throw new Error("Expected compact to start from agent_settled");
				await expect(compactPromise).rejects.toThrow("test compact reached after run lease release");
				expect(competingLeaseRejected).toBe(true);
				expect(compactRequests).toBe(1);

				acquirePiServerSessionLease("competing-session", runStatePath);
				releasePiServerSessionLease("competing-session", runStatePath);
			} finally {
				unsubscribe();
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("acknowledges an in-memory terminal run after syncing the assistant tree entry", async () => {
		const tempDir = join(tmpdir(), `pi-in-memory-run-ack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const events: string[] = [];
		const serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		let terminalRequestMac: string | undefined;

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (url.endsWith("/api/stream")) {
						terminalRequestMac = getStreamRequestMac(body);
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics: [
										{
											type: "pi_server_run",
											timestamp: 1,
											details: {
												sessionId: body.sessionId,
												runId: body.runId,
												requestMac: terminalRequestMac,
												restartUnknown: false,
											},
										},
									],
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}

					if (url.endsWith("/api/session/run/ack")) {
						events.push("ack");
						if (!terminalRequestMac) throw new Error("Expected a terminal request MAC");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: body.sessionId,
								runId: body.runId,
								requestMac: terminalRequestMac,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					if (url.endsWith("/api/session/tree/sync")) {
						events.push("tree");
						serverEntries.splice(
							0,
							serverEntries.length,
							...((body.entries as SessionTreeEntry[] | undefined) ?? []),
						);
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/append")) {
						events.push("tree");
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/switch")) {
						events.push("tree");
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					}

					return makeSessionResponse(body, {
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			expect(sessionManager.getSessionFile()).toBeUndefined();
			try {
				await session.prompt("in-memory terminal");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			expect(events).toEqual(["tree", "tree", "ack"]);
			const lastServerEntry = serverEntries.at(-1);
			expect(lastServerEntry?.type).toBe("message");
			expect(lastServerEntry?.type === "message" ? lastServerEntry.message.role : undefined).toBe("assistant");
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it.each([true, false])(
		"keeps a pi-server control-plane failure with runUnresolved=%s local without syncing or acknowledging it",
		async (runUnresolved) => {
			const tempDir = join(
				tmpdir(),
				`pi-control-plane-local-${String(runUnresolved)}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			const sessionsDir = join(tempDir, "sessions");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const model = getModel("anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			const modelRuntime = await createTestModelRuntime(model!.provider);
			const sessionManager = SessionManager.create(cwd, sessionsDir);
			const flushSessionFile = vi.spyOn(sessionManager, "flushSessionFile");
			const serverEntries: SessionTreeEntry[] = [];
			let serverLeafId: string | null = null;
			let treeMutationCount = 0;
			let acknowledgementCount = 0;

			try {
				process.env.PI_SERVER_MODE = "true";
				vi.stubGlobal(
					"fetch",
					vi.fn(async (url: string, init?: RequestInit) => {
						const body = parseJsonObject((init?.body as string | undefined) ?? "");
						if (url.endsWith("/api/stream")) {
							return new Response(
								[
									'data: {"type":"start"}\n\n',
									`data: ${JSON.stringify({
										type: "error",
										reason: "error",
										errorMessage: "local pi-server control-plane failure",
										usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
										diagnostics: [
											{
												type: "pi_server_failure",
												timestamp: 1,
												error: { name: "Error", message: "local pi-server control-plane failure" },
												details: {
													phase: runUnresolved ? "provider_stream" : "session_init",
													source: "pi-server",
													retryable: false,
													runUnresolved,
												},
											},
										],
									})}\n\n`,
								].join(""),
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}

						if (url.endsWith("/api/session/run/ack")) {
							acknowledgementCount++;
							return new Response("Unexpected acknowledgement", { status: 500 });
						}

						if (url.endsWith("/api/session/tree/sync")) {
							treeMutationCount++;
							serverEntries.splice(
								0,
								serverEntries.length,
								...((body.entries as SessionTreeEntry[] | undefined) ?? []),
							);
							serverLeafId = (body.leafId as string | null | undefined) ?? null;
						} else if (url.endsWith("/api/session/tree/append")) {
							treeMutationCount++;
							const existingIds = new Set(serverEntries.map((entry) => entry.id));
							for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
								if (!existingIds.has(entry.id)) {
									serverEntries.push(entry);
									existingIds.add(entry.id);
								}
							}
							serverLeafId = (body.leafId as string | null | undefined) ?? null;
						} else if (url.endsWith("/api/session/tree/switch")) {
							treeMutationCount++;
							serverLeafId = (body.leafId as string | null | undefined) ?? null;
						}

						return makeSessionResponse(body, {
							treeHash: hashPiServerSessionEntries(serverEntries),
							messageCount: serverEntries.filter((entry) => entry.type === "message").length,
							entryCount: serverEntries.length,
							leafId: serverLeafId,
							revision: serverEntries.length,
						});
					}),
				);

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					model: model!,
					thinkingLevel: "off",
					modelRuntime,
					sessionManager,
					resourceLoader: createTestResourceLoader(),
				});
				try {
					await session.prompt("keep this control-plane failure local");
					await session.agent.waitForIdle();
				} finally {
					session.dispose();
				}

				const unresolvedEntries = sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.diagnostics?.some(
								(diagnostic) =>
									diagnostic.type === "pi_server_failure" &&
									diagnostic.details?.runUnresolved === runUnresolved,
							),
					);
				expect(unresolvedEntries).toHaveLength(1);
				expect(sessionManager.getBranch().map((entry) => entry.id)).not.toContain(unresolvedEntries[0]?.id);
				const leafEntry = sessionManager.getLeafEntry();
				expect(leafEntry?.type).toBe("message");
				expect(leafEntry?.type === "message" ? leafEntry.message.role : undefined).toBe("user");
				expect(treeMutationCount).toBe(1);
				expect(serverEntries.map((entry) => entry.id)).not.toContain(unresolvedEntries[0]?.id);
				expect(acknowledgementCount).toBe(0);
				expect(flushSessionFile).not.toHaveBeenCalled();
			} finally {
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			}
		},
	);

	it("reconciles and replaces a 524 run missing from the authoritative server journal", async () => {
		const tempDir = join(tmpdir(), `pi-stream-524-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;
		const serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		let serverSessionId = "";
		let serverStaticContextHash = "";
		const terminalRuns = new Map<string, TestTerminalRun>();

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
						const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (new URL(url).pathname.includes("/runs/")) {
						return new Response(JSON.stringify({ error: "Run not found" }), {
							status: 404,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}
					if (url.includes("/history")) {
						return new Response(
							JSON.stringify({
								protocolVersion: 2,
								sessionId: serverSessionId,
								staticContextHash: serverStaticContextHash,
								treeHash: hashPiServerSessionEntries(serverEntries),
								messageCount: serverEntries.filter((entry) => entry.type === "message").length,
								entryCount: serverEntries.length,
								leafId: serverLeafId,
								revision: serverEntries.length,
								entries: serverEntries,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url.endsWith("/api/session/init")) {
						serverSessionId = body.sessionId as string;
						serverStaticContextHash = body.staticContextHash as string;
					}
					if (url.endsWith("/api/session/tree/append") || url.endsWith("/api/session/tree/sync")) {
						const incoming = body.entries as SessionTreeEntry[];
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of incoming) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					}
					return makeSessionResponse(body, {
						staticContextHash: serverStaticContextHash,
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
			expect(events).toEqual([]);
			const streamBodies = capturedRequests
				.filter((request) => request.url.endsWith("/api/stream"))
				.map((request) => request.body);
			expect(streamBodies).toHaveLength(2);
			expect(streamBodies[1]?.runId).not.toBe(streamBodies[0]?.runId);
			const activeMessages = sessionManager.buildSessionContext().messages;
			expect(activeMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
			const lastActiveMessage = activeMessages.at(-1);
			expect(lastActiveMessage?.role === "assistant" ? lastActiveMessage.content : undefined).toEqual([
				{ type: "text", text: "recovered" },
			]);
			const errorEntries = sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error" &&
						entry.message.errorMessage?.includes("524"),
				);
			expect(errorEntries).toHaveLength(0);
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
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
		const terminalRuns = new Map<string, TestTerminalRun>();

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.prompt("continue from old failure");
				await session.agent.waitForIdle();
			} finally {
				session.dispose();
			}

			const treeSync = capturedRequests.find((request) => request.url.endsWith("/api/session/tree/append"));
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
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
								protocolVersion: 2,
								sessionId: capturedRequests.find((request) => request.url.endsWith("/api/session/init"))?.body
									.sessionId,
								staticContextHash: "",
								treeHash: "0".repeat(64),
								messageCount: 61,
								entryCount: 61,
								leafId: null,
								revision: 1,
								target,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
			expect(chunkTargets).toContain("/api/session/tree/append");
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
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

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
			expect(treeRequests.map((request) => new URL(request.url).pathname)).toEqual(["/api/session/tree/append"]);
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const treeSignals: Array<AbortSignal | null> = [];
		const terminalRuns = new Map<string, TestTerminalRun>();

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
						const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
		const modelRuntime = await createTestModelRuntime(model!.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const capturedRequests: { url: string; body: Record<string, unknown> }[] = [];
		let streamCount = 0;
		let appendCount = 0;
		const terminalRuns = new Map<string, TestTerminalRun>();

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					capturedRequests.push({ url, body });

					if (url.endsWith("/api/stream")) {
						streamCount++;
						const diagnostics = registerTestTerminalRun(body, terminalRuns, "completed");
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						return makeTestRunAcknowledgement(body, terminalRuns);
					}

					if (url.endsWith("/api/session/tree/append")) {
						appendCount++;
						if (appendCount > 1) {
							return new Response(JSON.stringify({ error: "CONNECT timeout" }), {
								status: 502,
								statusText: "Bad Gateway",
								headers: { "Content-Type": "application/json" },
							});
						}
					}

					return makeSessionResponse(body);
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: model!,
				thinkingLevel: "off",
				modelRuntime,
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
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const baseModel = getModel("anthropic", "claude-sonnet-4-5");
		expect(baseModel).toBeDefined();
		const model = { ...baseModel!, contextWindow: 100, maxTokens: 20 };
		const modelRuntime = await createTestModelRuntime(model.provider);
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({
			auth: { apiKey: "test-key" },
			env: { TEST_REGION: "test-region" },
		});
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 },
			retry: { enabled: true, maxRetries: 4, baseDelayMs: 7 },
		});
		let streamCount = 0;
		let serverEntries: SessionTreeEntry[] = [];
		let serverLeafId: string | null = null;
		let compactRequestBody: Record<string, unknown> | undefined;
		const terminalRuns = new Map<string, string>();

		try {
			process.env.PI_SERVER_MODE = "true";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");

					if (url.endsWith("/api/stream")) {
						streamCount++;
						if (typeof body.runId !== "string") throw new Error("Expected a stream run id");
						const requestMac = getStreamRequestMac(body);
						terminalRuns.set(body.runId, requestMac);
						const diagnostics = [
							{
								type: "pi_server_run",
								timestamp: 1,
								details: {
									sessionId: body.sessionId,
									runId: body.runId,
									requestMac,
									restartUnknown: false,
								},
							},
						];
						if (streamCount === 1) {
							return new Response(
								[
									'data: {"type":"start"}\n\n',
									'data: {"type":"text_start","contentIndex":0}\n\n',
									'data: {"type":"text_delta","contentIndex":0,"delta":"first ok"}\n\n',
									'data: {"type":"text_end","contentIndex":0}\n\n',
									`data: ${JSON.stringify({
										type: "done",
										reason: "stop",
										usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
										diagnostics,
									})}\n\n`,
								].join(""),
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						if (streamCount === 2) {
							return new Response(
								`data: ${JSON.stringify({
									type: "done",
									reason: "length",
									usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
									diagnostics,
								})}\n\n`,
								{ status: 200, headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response(
							[
								'data: {"type":"start"}\n\n',
								'data: {"type":"text_start","contentIndex":0}\n\n',
								'data: {"type":"text_delta","contentIndex":0,"delta":"recovered"}\n\n',
								'data: {"type":"text_end","contentIndex":0}\n\n',
								`data: ${JSON.stringify({
									type: "done",
									reason: "stop",
									usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21 },
									diagnostics,
								})}\n\n`,
							].join(""),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (url.endsWith("/api/session/run/ack")) {
						if (typeof body.runId !== "string") throw new Error("Expected an acknowledged run id");
						const requestMac = terminalRuns.get(body.runId);
						if (!requestMac) throw new Error("Expected a terminal run before acknowledgement");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: body.sessionId,
								runId: body.runId,
								requestMac,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					if (url.endsWith("/api/session/tree/sync")) {
						serverEntries = [...((body.entries as SessionTreeEntry[] | undefined) ?? [])];
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/append")) {
						const existingIds = new Set(serverEntries.map((entry) => entry.id));
						for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
							if (!existingIds.has(entry.id)) {
								serverEntries.push(entry);
								existingIds.add(entry.id);
							}
						}
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/tree/switch")) {
						serverLeafId = (body.leafId as string | null | undefined) ?? null;
					} else if (url.endsWith("/api/session/compact")) {
						compactRequestBody = body;
						if (serverLeafId === null) throw new Error("Expected a server leaf before compaction");
						const requestHash = hashPiServerCompactRequest(
							body as unknown as Parameters<typeof hashPiServerCompactRequest>[0],
						);
						const compactionEntry: Extract<SessionTreeEntry, { type: "compaction" }> = {
							type: "compaction" as const,
							id: "server-compact-1",
							parentId: serverLeafId,
							timestamp: "2026-01-01T00:00:00.000Z",
							summary: "server summary",
							firstKeptEntryId: serverLeafId,
							tokensBefore: 100,
						};
						Object.assign(compactionEntry, {
							piServerCompactOperation: {
								version: 1,
								operationId: body.operationId,
								requestHash,
								baseStaticContextHash: body.baseStaticContextHash,
								baseTreeHash: body.baseTreeHash,
								baseEntryCount: body.baseEntryCount,
								baseLeafId: body.baseLeafId,
								baseRevision: body.baseRevision,
							},
						});
						serverEntries = [...serverEntries, compactionEntry];
						serverLeafId = compactionEntry.id;
						return new Response(
							JSON.stringify({
								protocolVersion: 2,
								sessionId: body.sessionId,
								operationId: body.operationId,
								requestHash,
								treePatch: {
									baseStaticContextHash: body.baseStaticContextHash,
									baseTreeHash: body.baseTreeHash,
									baseEntryCount: body.baseEntryCount,
									baseLeafId: body.baseLeafId,
									baseRevision: body.baseRevision,
									entriesFrom: body.baseEntryCount,
									entries: [compactionEntry],
									leafId: serverLeafId,
									revision: (body.baseRevision as number) + 1,
									treeHash: hashPiServerSessionEntries(serverEntries),
								},
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url.endsWith("/api/session/compact/ack")) {
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: body.sessionId,
								operationId: body.operationId,
								requestHash: body.requestHash,
								status: "completed",
								acknowledgedAt: 1,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					return makeSessionResponse(body, {
						treeHash: hashPiServerSessionEntries(serverEntries),
						messageCount: serverEntries.filter((entry) => entry.type === "message").length,
						entryCount: serverEntries.length,
						leafId: serverLeafId,
						revision: serverEntries.length,
					});
				}),
			);

			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				thinkingLevel: "off",
				modelRuntime,
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
			expect(compactRequestBody?.retry).toEqual({ enabled: true, maxRetries: 4, baseDelayMs: 7 });
			expect(compactRequestBody?.options).toMatchObject({ env: { TEST_REGION: "test-region" } });
		} finally {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});
});
