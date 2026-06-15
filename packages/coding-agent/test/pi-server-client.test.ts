import type { Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compactPiServer,
	dropLastPiServerAssistantError,
	hashStaticContext,
	resetAllSessionTracking,
	resetSessionTracking,
	streamPiServer,
} from "../src/core/pi-server-client.ts";

function makeSSEData(event: object): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

function makeMockResponse(events: object[], status = 200): Response {
	const sseBody = events.map((e) => makeSSEData(e)).join("");
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sseBody));
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { "Content-Type": "text/event-stream" },
	});
}

interface CapturedChunkBody {
	target?: string;
	index: number;
	total: number;
}

const testModel: Model<any> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://api.test.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const testTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path" },
		},
		required: ["path"],
	},
};

describe("pi-server-client", () => {
	beforeEach(() => {
		resetAllSessionTracking();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	describe("session tracking", () => {
		it("resets individual session tracking", () => {
			resetSessionTracking("test-session");
			expect(true).toBe(true);
		});

		it("resets all session tracking", () => {
			resetAllSessionTracking();
			expect(true).toBe(true);
		});
	});

	describe("hashStaticContext", () => {
		it("includes tool parameters in the hash", () => {
			const ctx1: Context = {
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
			};
			const ctx2: Context = {
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			};
			expect(hashStaticContext(ctx1)).not.toBe(hashStaticContext(ctx2));
		});

		it("produces same hash for identical contexts", () => {
			const ctx: Context = {
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [testTool],
			};
			expect(hashStaticContext(ctx)).toBe(hashStaticContext(ctx));
		});

		it("produces different hash for different system prompts", () => {
			const ctx1: Context = { systemPrompt: "v1", messages: [] };
			const ctx2: Context = { systemPrompt: "v2", messages: [] };
			expect(hashStaticContext(ctx1)).not.toBe(hashStaticContext(ctx2));
		});

		it("produces different hash for different tool names", () => {
			const ctx1: Context = { messages: [], tools: [{ name: "read", description: "Read", parameters: {} as any }] };
			const ctx2: Context = { messages: [], tools: [{ name: "write", description: "Read", parameters: {} as any }] };
			expect(hashStaticContext(ctx1)).not.toBe(hashStaticContext(ctx2));
		});
	});

	describe("streamPiServer delta behavior", () => {
		it("chunks oversized session init and stream requests under the configured request size", async () => {
			process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
			const maxBytes = 2 * 1024;
			const capturedRequests: { url: string; bodyBytes: number; body: CapturedChunkBody }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const rawBody = init?.body as string;
				const body = JSON.parse(rawBody) as CapturedChunkBody;
				capturedRequests.push({
					url,
					bodyBytes: Buffer.byteLength(rawBody, "utf-8"),
					body,
				});

				if (url.endsWith("/api/request/chunk")) {
					if (body.index !== body.total - 1) {
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}

					if (body.target === "/api/session/init") {
						return new Response(
							JSON.stringify({
								sessionId: "chunk-test",
								staticContextHash: "hash-chunk",
								messageCount: 0,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}

					if (body.target === "/api/stream") {
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
							},
						]);
					}
				}

				return new Response("Unexpected request", { status: 500 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context: Context = {
				systemPrompt: "system ".repeat(400),
				messages: [{ role: "user", content: "hello ".repeat(400), timestamp: 1000 }],
				tools: [testTool],
			};

			const stream = await streamPiServer(testModel, context, { sessionId: "chunk-test", maxTokens: 128 });
			for await (const _event of stream) {
			}

			expect(capturedRequests.length).toBeGreaterThan(2);
			expect(capturedRequests.every((request) => request.url.endsWith("/api/request/chunk"))).toBe(true);
			expect(capturedRequests.every((request) => request.bodyBytes <= maxBytes)).toBe(true);
			expect(capturedRequests.some((request) => request.body.target === "/api/session/init")).toBe(true);
			expect(capturedRequests.some((request) => request.body.target === "/api/stream")).toBe(true);

			vi.unstubAllGlobals();
		});

		it("sends only new messages on second request for same session", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-1",
							messageCount: 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "Hi there!" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const userMsg1: Message = { role: "user", content: "Hello", timestamp: 1000 };
			const context1: Context = {
				systemPrompt: "You are helpful.",
				messages: [userMsg1],
			};

			const stream1 = await streamPiServer(testModel, context1, { sessionId: "delta-test" });
			const events1: any[] = [];
			for await (const event of stream1) {
				events1.push(event);
			}

			const initBody = capturedBodies.find((b) => b.url.endsWith("/api/session/init"));
			expect(initBody).toBeDefined();
			expect(initBody!.body.sessionId).toBe("delta-test");

			const streamBody1 = capturedBodies.find((b) => b.url.endsWith("/api/stream"));
			expect(streamBody1).toBeDefined();
			expect(streamBody1!.body.delta).toHaveLength(1);
			expect(streamBody1!.body.delta[0].content).toBe("Hello");

			capturedBodies.length = 0;

			const doneEvent = events1.find((event) => event.type === "done");
			expect(doneEvent).toBeDefined();
			const assistantMsg = doneEvent!.message as Message;
			const userMsg2: Message = { role: "user", content: "How are you?", timestamp: 3000 };
			const context2: Context = {
				systemPrompt: "You are helpful.",
				messages: [userMsg1, assistantMsg, userMsg2],
			};

			const stream2 = await streamPiServer(testModel, context2, { sessionId: "delta-test" });
			const events2: any[] = [];
			for await (const event of stream2) {
				events2.push(event);
			}

			const updateBody = capturedBodies.find((b) => b.url.endsWith("/api/session/update"));
			expect(updateBody).toBeUndefined();

			const streamBody2 = capturedBodies.find((b) => b.url.endsWith("/api/stream"));
			expect(streamBody2).toBeDefined();
			expect(streamBody2!.body.delta).toHaveLength(1);
			expect(streamBody2!.body.delta[0].content).toBe("How are you?");

			vi.unstubAllGlobals();
		});

		it("loads server history to avoid full sync uploads when local tracking is missing", async () => {
			const capturedBodies: { url: string; body: any; method: string }[] = [];
			const assistantMsg: Message = {
				role: "assistant",
				content: [{ type: "text", text: "Hi there!" }],
				api: "openai-completions",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2000,
			};

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body, method });

				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-existing",
							messageCount: 2,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/session/history-seed/history")) {
					return new Response(
						JSON.stringify({
							sessionId: "history-seed",
							staticContextHash: "hash-existing",
							messageCount: 2,
							messages: [{ role: "user", content: "Hello", timestamp: 1000 }, assistantMsg],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [
					{ role: "user", content: "Hello", timestamp: 1000 },
					assistantMsg,
					{ role: "user", content: "How are you?", timestamp: 3000 },
				],
			};

			const stream = await streamPiServer(testModel, context, { sessionId: "history-seed" });
			for await (const _event of stream) {
			}

			expect(capturedBodies.some((request) => request.url.endsWith("/api/session/history-seed/history"))).toBe(true);
			expect(capturedBodies.some((request) => request.url.endsWith("/api/session/sync"))).toBe(false);

			const streamBody = capturedBodies.find((request) => request.url.endsWith("/api/stream"));
			expect(streamBody).toBeDefined();
			expect(streamBody!.body.delta).toEqual([{ role: "user", content: "How are you?", timestamp: 3000 }]);

			vi.unstubAllGlobals();
		});

		it("sends session init on first request", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-init",
							messageCount: 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hello", timestamp: 1000 }],
			};

			const stream = await streamPiServer(testModel, context, { sessionId: "init-test" });
			const events: any[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const initBody = capturedBodies.find((b) => b.url.endsWith("/api/session/init"));
			expect(initBody).toBeDefined();
			expect(initBody!.body.sessionId).toBe("init-test");
			expect(initBody!.body.staticContext).toBeDefined();
			expect(initBody!.body.staticContext.systemPrompt).toBe("You are helpful.");

			vi.unstubAllGlobals();
		});

		it("sends session update when static context changes", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init") || url.endsWith("/api/session/update")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: `hash-${body.staticContext?.systemPrompt?.length ?? 0}`,
							messageCount: 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context1: Context = {
				systemPrompt: "v1",
				messages: [{ role: "user", content: "Hello", timestamp: 1000 }],
			};

			const stream1 = await streamPiServer(testModel, context1, { sessionId: "update-test" });
			for await (const _event of stream1) {
			}

			capturedBodies.length = 0;

			const context2: Context = {
				systemPrompt: "v2",
				messages: [{ role: "user", content: "Hello", timestamp: 1000 }],
			};

			const stream2 = await streamPiServer(testModel, context2, { sessionId: "update-test" });
			for await (const _event of stream2) {
			}

			const updateBody = capturedBodies.find((b) => b.url.endsWith("/api/session/update"));
			expect(updateBody).toBeDefined();
			expect(updateBody!.body.staticContext.systemPrompt).toBe("v2");

			vi.unstubAllGlobals();
		});

		it("syncs the full local context when history is no longer append-only", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init") || url.endsWith("/api/session/sync")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-sync",
							messageCount: body.messages?.length ?? 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context1: Context = {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "first branch", timestamp: 1000 }],
			};
			const stream1 = await streamPiServer(testModel, context1, { sessionId: "sync-test" });
			for await (const _event of stream1) {
			}

			capturedBodies.length = 0;

			const context2: Context = {
				systemPrompt: "You are helpful.",
				messages: [
					{ role: "user", content: "other branch", timestamp: 2000 },
					{
						role: "assistant",
						content: [{ type: "text", text: "other answer" }],
						api: "openai-completions",
						provider: "test-provider",
						model: "test-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 3000,
					},
					{ role: "user", content: "continue here", timestamp: 4000 },
				],
			};

			const stream2 = await streamPiServer(testModel, context2, { sessionId: "sync-test" });
			for await (const _event of stream2) {
			}

			const syncBody = capturedBodies.find((b) => b.url.endsWith("/api/session/sync"));
			expect(syncBody).toBeDefined();
			expect(syncBody!.body.messages.map((message: Message) => message.role)).toEqual(["user", "assistant", "user"]);

			const streamBody = capturedBodies.find((b) => b.url.endsWith("/api/stream"));
			expect(streamBody).toBeDefined();
			expect(streamBody!.body.delta).toEqual([]);

			vi.unstubAllGlobals();
		});

		it("marks local history synced after server-side compact", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response(
					JSON.stringify({
						sessionId: body.sessionId,
						staticContextHash: "hash-compact",
						messageCount: body.messages?.length ?? 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			vi.stubGlobal("fetch", mockFetch);

			const compactedContext: Context = {
				systemPrompt: "You are helpful.",
				messages: [
					{ role: "user", content: "old question", timestamp: 1000 },
					{
						role: "assistant",
						content: [{ type: "text", text: "old answer" }],
						api: "openai-completions",
						provider: "test-provider",
						model: "test-model",
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
					},
				],
			};

			await compactPiServer(testModel, compactedContext, { sessionId: "compact-test", apiKey: "sk-client" });
			capturedBodies.length = 0;

			const nextContext: Context = {
				...compactedContext,
				messages: [...compactedContext.messages, { role: "user", content: "new question", timestamp: 3000 }],
			};
			const stream = await streamPiServer(testModel, nextContext, {
				sessionId: "compact-test",
				apiKey: "sk-client",
			});
			for await (const _event of stream) {
			}

			const streamBody = capturedBodies.find((b) => b.url.endsWith("/api/stream"));
			expect(streamBody).toBeDefined();
			expect(streamBody!.body.delta).toHaveLength(1);
			expect(streamBody!.body.delta[0].content).toBe("new question");

			const compactBody = capturedBodies.find((b) => b.url.endsWith("/api/session/compact"));
			expect(compactBody).toBeUndefined();

			vi.unstubAllGlobals();
		});

		it("syncs diverged history before server-side compact", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init") || url.endsWith("/api/session/sync")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-compact-sync",
							messageCount: body.messages?.length ?? 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/session/compact")) {
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{
							type: "done",
							reason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
						},
					]);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			const context1: Context = {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "original branch", timestamp: 1000 }],
			};
			const stream = await streamPiServer(testModel, context1, { sessionId: "compact-sync-test" });
			for await (const _event of stream) {
			}

			capturedBodies.length = 0;

			const divergedContext: Context = {
				systemPrompt: "You are helpful.",
				messages: [
					{ role: "user", content: "other branch", timestamp: 2000 },
					{ role: "user", content: "compact this branch", timestamp: 3000 },
				],
			};
			await compactPiServer(testModel, divergedContext, { sessionId: "compact-sync-test", apiKey: "sk-client" });

			const syncBody = capturedBodies.find((b) => b.url.endsWith("/api/session/sync"));
			expect(syncBody).toBeDefined();
			expect(syncBody!.body.messages.map((message: Message) => message.content)).toEqual([
				"other branch",
				"compact this branch",
			]);
			const compactBody = capturedBodies.at(-1);
			expect(compactBody?.url.endsWith("/api/session/compact")).toBe(true);
			expect(compactBody?.body.dropLastAssistantError).toBeUndefined();

			vi.unstubAllGlobals();
		});

		it("syncs local retry history when server has no assistant error to drop", async () => {
			const capturedBodies: { url: string; body: any }[] = [];

			const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body as string) : {};
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/drop-last-assistant-error")) {
					return new Response(JSON.stringify({ success: true, dropped: false, messageCount: 1 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				if (url.endsWith("/api/session/sync")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-drop-sync",
							messageCount: body.messages?.length ?? 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("Not found", { status: 404 });
			});

			vi.stubGlobal("fetch", mockFetch);

			await dropLastPiServerAssistantError("drop-sync-test", {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "retry without error", timestamp: 1000 }],
			});

			const syncBody = capturedBodies.find((b) => b.url.endsWith("/api/session/sync"));
			expect(syncBody).toBeDefined();
			expect(syncBody!.body.messages).toEqual([{ role: "user", content: "retry without error", timestamp: 1000 }]);

			vi.unstubAllGlobals();
		});
	});
});
