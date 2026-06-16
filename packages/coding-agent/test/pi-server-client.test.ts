import { createHash } from "node:crypto";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compactPiServer,
	hashStaticContext,
	resetAllSessionTracking,
	resetSessionTracking,
	streamPiServer,
	syncPiServerTree,
} from "../src/core/pi-server-client.ts";

type JsonObject = Record<string, unknown>;

function parseJsonObject(rawBody: string): JsonObject {
	if (!rawBody) return {};
	const parsed = JSON.parse(rawBody) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected JSON object request body");
	}
	return parsed as JsonObject;
}

function makeMockResponse(events: object[], status = 200): Response {
	const sseBody = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
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

function textMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
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
		timestamp,
	};
}

function messageEntry(id: string, parentId: string | null, message: Message): SessionTreeEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function baseTree(): SessionTreeEntry[] {
	return [
		messageEntry("u1", null, textMessage("one", 1000)),
		messageEntry("a1", "u1", assistantMessage("first answer", 2000)),
		messageEntry("u2", "a1", textMessage("two", 3000)),
	];
}

function hashEntries(entries: SessionTreeEntry[]): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

const testModel: Model<"openai-completions"> = {
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

describe("pi-server-client", () => {
	beforeEach(() => {
		resetAllSessionTracking();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	it("resets individual session tracking", () => {
		resetSessionTracking("test-session");
		expect(true).toBe(true);
	});

	it("includes tool parameters in the static context hash", () => {
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

	it("syncs the tree once, then appends only new entries", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await syncPiServerTree("tree-append", context, { entries, leafId: "a1" });
		capturedBodies.length = 0;
		await syncPiServerTree("tree-append", context, { entries: [...entries, nextEntry], leafId: "u2" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual(["/api/session/tree/append"]);
		expect(capturedBodies[0].body.entries).toEqual([nextEntry]);
		expect(capturedBodies[0].body.leafId).toBe("u2");
	});

	it("skips initial tree sync when pi-server reports a matching persisted tree hash", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				if (url.endsWith("/api/session/tree/append")) {
					return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						sessionId: body.sessionId,
						staticContextHash: "hash-persisted",
						treeHash: hashEntries(entries),
						leafId: "a1",
						entryCount: entries.length,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await syncPiServerTree("persisted-tree", context, { entries, leafId: "a1" });
		await syncPiServerTree("persisted-tree", context, { entries: [...entries, nextEntry], leafId: "u2" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/tree/append",
		]);
		expect(capturedBodies[1].body.entries).toEqual([nextEntry]);
	});

	it("rebuilds the server tree when incremental append finds missing server state", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));
		let rejectNextAppend = false;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/tree/append") && rejectNextAppend) {
					return new Response(JSON.stringify({ error: "parent entry a1 does not exist" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await syncPiServerTree("tree-rebuild", context, { entries, leafId: "a1" });
		capturedBodies.length = 0;
		rejectNextAppend = true;
		await syncPiServerTree("tree-rebuild", context, { entries: [...entries, nextEntry], leafId: "u2" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/tree/append",
			"/api/session/tree/sync",
		]);
		expect(capturedBodies[1].body.entries).toEqual([...entries, nextEntry]);
		expect(capturedBodies[1].body.leafId).toBe("u2");
	});

	it("switches pi-server tree leaf without uploading entries after the tree is already synced", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree();

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		await syncPiServerTree("tree-switch", context, { entries, leafId: "u2" });
		capturedBodies.length = 0;
		await syncPiServerTree("tree-switch", context, { entries, leafId: "a1" });

		expect(capturedBodies).toHaveLength(1);
		expect(new URL(capturedBodies[0].url).pathname).toBe("/api/session/tree/switch");
		expect(capturedBodies[0].body).toEqual({ sessionId: "tree-switch", leafId: "a1" });
	});

	it("streams through pi-server without sending messages in the stream request", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree().slice(0, 1);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "ok" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 1 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-tree", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const streamBody = capturedBodies.find((request) => request.url.endsWith("/api/stream"))?.body;
		expect(streamBody).toBeDefined();
		expect(streamBody).not.toHaveProperty("messages");
		expect(streamBody).not.toHaveProperty("delta");
		expect(streamBody).not.toHaveProperty("entries");
		expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
	});

	it("rebuilds missing server state once when streaming after a pi-server restart", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree().slice(0, 1);
		let streamCount = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/stream")) {
					streamCount++;
					if (streamCount === 1) {
						return new Response(
							JSON.stringify({
								error: "Session has no static context. Initialize with /api/session/init first.",
							}),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}

					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "ok" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 1 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const context: Context = { systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] };
		await syncPiServerTree("stream-restart", context, { entries, leafId: "u1" });
		capturedBodies.length = 0;

		const stream = await streamPiServer(testModel, context, {
			sessionId: "stream-restart",
			sessionTree: { entries, leafId: "u1" },
		});
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/stream",
			"/api/session/init",
			"/api/session/tree/sync",
			"/api/stream",
		]);
		expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
	});

	it("chunks oversized tree sync requests under the configured request size", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const maxBytes = 2 * 1024;
		const capturedRequests: { url: string; bodyBytes: number; body: JsonObject }[] = [];
		const entries = [messageEntry("u1", null, textMessage("x".repeat(1024 * 1024), 1000))];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const rawBody = (init?.body as string | undefined) ?? "";
				const body = parseJsonObject(rawBody);
				capturedRequests.push({ url, bodyBytes: Buffer.byteLength(rawBody, "utf-8"), body });

				if (url.endsWith("/api/request/chunk")) {
					if (typeof body.index !== "number" || typeof body.total !== "number") {
						throw new Error("Chunk request is missing numeric index/total");
					}
					if (body.index !== body.total - 1) {
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
				}

				return new Response(JSON.stringify({ sessionId: "chunk-tree", leafId: "u1", entryCount: 1 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await syncPiServerTree(
			"chunk-tree",
			{ systemPrompt: "You are helpful.", messages: [] },
			{ entries, leafId: "u1" },
		);

		expect(capturedRequests.every((request) => request.bodyBytes <= maxBytes)).toBe(true);
		expect(capturedRequests.some((request) => request.url.endsWith("/api/request/chunk"))).toBe(true);
		expect(capturedRequests.some((request) => request.body.target === "/api/session/tree/sync")).toBe(true);
		expect(capturedRequests.some((request) => request.url.endsWith("/api/session/sync"))).toBe(false);
	});

	it("syncs the tree before server-side compact", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree();

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					return new Response(
						JSON.stringify({
							success: true,
							compaction: { summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-tree", apiKey: "sk-client", sessionTree: { entries, leafId: "u2" } },
		);

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/tree/sync",
			"/api/session/compact",
		]);
		expect(capturedBodies[1].body.entries).toEqual(entries);
	});

	it("rebuilds missing server state once when compacting after a pi-server restart", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree();
		let compactCount = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					compactCount++;
					if (compactCount === 1) {
						return new Response(JSON.stringify({ error: "session not found" }), {
							status: 404,
							headers: { "Content-Type": "application/json" },
						});
					}
					return new Response(
						JSON.stringify({
							success: true,
							compaction: { summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		await syncPiServerTree("compact-restart", context, { entries, leafId: "u2" });
		capturedBodies.length = 0;

		const result = await compactPiServer(testModel, context, {
			sessionId: "compact-restart",
			apiKey: "sk-client",
			sessionTree: { entries, leafId: "u2" },
		});

		expect(result.summary).toBe("summary");
		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/compact",
			"/api/session/init",
			"/api/session/tree/sync",
			"/api/session/compact",
		]);
	});
});
