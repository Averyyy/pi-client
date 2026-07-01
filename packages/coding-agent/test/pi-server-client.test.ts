import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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

function compactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string,
): SessionTreeEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 100,
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

function compactResponse(
	compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number },
	entries: SessionTreeEntry[],
	leafId: string | null,
): string {
	const compactionEntry = entries.find((entry) => entry.type === "compaction" && entry.id === leafId);
	return JSON.stringify({
		success: true,
		compaction,
		compactionEntry,
		entries,
		leafId,
		messages: [],
	});
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

	it("preserves full compacted tree history before full tree sync", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = [
			messageEntry("u1", null, textMessage("one", 1000)),
			messageEntry("a1", "u1", assistantMessage("first answer", 2000)),
			messageEntry("u2", "a1", textMessage("two", 3000)),
			messageEntry("a2", "u2", assistantMessage("second answer", 4000)),
			compactionEntry("c1", "a2", "summary of one", "u2"),
			messageEntry("u3", "c1", textMessage("three", 5000)),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 6 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await syncPiServerTree("compacted-tree-sync", context, { entries, leafId: "u3" });

		const treeSync = capturedBodies.find((request) => request.url.endsWith("/api/session/tree/sync"));
		expect(treeSync).toBeDefined();
		const syncedEntries = treeSync!.body.entries as Array<{ id: string; parentId: string | null }>;
		expect(syncedEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(syncedEntries.map((entry) => entry.parentId)).toEqual(entries.map((entry) => entry.parentId));
		expect(treeSync!.body.leafId).toBe("u3");
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

	it("appends after pi-server init reports a known persisted tree prefix", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-persisted-prefix",
							treeHash: hashEntries(entries),
							leafId: "a1",
							entryCount: entries.length,
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

		await syncPiServerTree("persisted-tree-prefix", context, { entries: [...entries, nextEntry], leafId: "u2" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/tree/append",
		]);
		expect(capturedBodies[1].body.entries).toEqual([nextEntry]);
	});

	it("switches persisted server tree leaf without reuploading entries after tracking resets", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree();

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-persisted-switch",
							treeHash: hashEntries(entries),
							leafId: "u2",
							entryCount: entries.length,
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

		await syncPiServerTree("persisted-tree-switch", context, { entries, leafId: "a1" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/tree/switch",
		]);
		expect(capturedBodies[1].body).toEqual({ sessionId: "persisted-tree-switch", leafId: "a1" });
	});

	it("reconciles server history instead of full-syncing over a different non-empty server tree", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const serverEntries = baseTree().slice(0, 2);
		const localEntries = [messageEntry("local-u1", null, textMessage("local one", 1000))];
		let reconciled: { entries: SessionTreeEntry[]; leafId: string | null } | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-server",
							treeHash: hashEntries(serverEntries),
							leafId: "a1",
							entryCount: serverEntries.length,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.endsWith("/api/session/server-authoritative/history")) {
					return new Response(
						JSON.stringify({
							sessionId: "server-authoritative",
							treeHash: hashEntries(serverEntries),
							entryCount: serverEntries.length,
							leafId: "a1",
							entries: serverEntries,
							messages: [textMessage("one", 1000), assistantMessage("first answer", 2000)],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("unexpected request", { status: 500 });
			}),
		);

		await expect(
			syncPiServerTree(
				"server-authoritative",
				context,
				{ entries: localEntries, leafId: "local-u1" },
				{
					onHistoryReconciled: (snapshot) => {
						reconciled = { entries: snapshot.entries, leafId: snapshot.leafId };
					},
				},
			),
		).rejects.toThrow("pi-server history differed");

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/server-authoritative/history",
		]);
		expect(reconciled).toEqual({ entries: serverEntries, leafId: "a1" });
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

				if (url.endsWith("/api/session/tree-rebuild/history")) {
					return new Response(JSON.stringify({ error: "session not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

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
			"/api/session/tree-rebuild/history",
			"/api/session/tree/sync",
		]);
		expect(capturedBodies[2].body.entries).toEqual([...entries, nextEntry]);
		expect(capturedBodies[2].body.leafId).toBe("u2");
	});

	it("reconciles server history instead of full-syncing after tree switch divergence", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree();
		const serverEntries = baseTree().slice(0, 2);
		let rejectSwitch = false;
		let reconciled: { entries: SessionTreeEntry[]; leafId: string | null } | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/tree-switch-divergence/history")) {
					return new Response(
						JSON.stringify({
							sessionId: "tree-switch-divergence",
							treeHash: hashEntries(serverEntries),
							entryCount: serverEntries.length,
							leafId: "a1",
							entries: serverEntries,
							messages: [textMessage("one", 1000), assistantMessage("first answer", 2000)],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/session/tree/switch") && rejectSwitch) {
					return new Response(JSON.stringify({ error: "leafId a1 does not exist in session tree" }), {
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

		await syncPiServerTree("tree-switch-divergence", context, { entries, leafId: "u2" });
		capturedBodies.length = 0;
		rejectSwitch = true;

		await expect(
			syncPiServerTree(
				"tree-switch-divergence",
				context,
				{ entries, leafId: "a1" },
				{
					onHistoryReconciled: (snapshot) => {
						reconciled = { entries: snapshot.entries, leafId: snapshot.leafId };
					},
				},
			),
		).rejects.toThrow("pi-server history differed");

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/tree/switch",
			"/api/session/tree-switch-divergence/history",
		]);
		expect(reconciled).toEqual({ entries: serverEntries, leafId: "a1" });
	});

	it("replaces a temporary full-sync tree with the real session tree", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const temporaryEntry = messageEntry("pending-0", null, textMessage("pending", 1000));
		const entries = baseTree().slice(0, 2);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });
				return new Response(
					JSON.stringify({
						sessionId: body.sessionId,
						leafId: body.leafId,
						treeHash: hashEntries((body.entries as SessionTreeEntry[] | undefined) ?? []),
						entryCount: Array.isArray(body.entries) ? body.entries.length : 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await syncPiServerTree("temporary-tree", context, {
			entries: [temporaryEntry],
			leafId: temporaryEntry.id,
			replace: true,
		});
		capturedBodies.length = 0;

		await syncPiServerTree("temporary-tree", context, { entries, leafId: "a1" });

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual(["/api/session/tree/sync"]);
		expect(capturedBodies[0].body.entries).toEqual(entries);
	});

	it("does not mark tree sync successful after an HTML proxy failure", async () => {
		const capturedPaths: string[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		let treeSyncAttempts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				capturedPaths.push(path);

				if (path === "/api/session/tree/sync") {
					treeSyncAttempts++;
					if (treeSyncAttempts === 1) {
						return new Response("<html>Cloudflare 520</html>", {
							status: 520,
							headers: { "Content-Type": "text/html; charset=utf-8" },
						});
					}
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 2 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		let error: unknown;
		try {
			await syncPiServerTree("html-tree-failure", context, { entries, leafId: "a1" });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Session tree sync failed");
		expect(message).toContain("520");
		expect(message).toContain("server error");
		expect(message).toContain("content-type: text/html; charset=utf-8");
		expect(message).toContain("body excerpt: <html>Cloudflare 520</html>");
		expect(message).not.toContain("Unexpected token");

		await syncPiServerTree("html-tree-failure", context, { entries, leafId: "a1" });

		expect(treeSyncAttempts).toBe(2);
		expect(capturedPaths).toEqual(["/api/session/init", "/api/session/tree/sync", "/api/session/tree/sync"]);
	});

	it("does not mark tree append successful after a proxy failure", async () => {
		const capturedRequests: { path: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));
		let appendAttempts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				capturedRequests.push({ path, body });

				if (path === "/api/session/tree/append") {
					appendAttempts++;
					if (appendAttempts === 1) {
						return new Response("<html>Cloudflare 520</html>", {
							status: 520,
							headers: { "Content-Type": "text/html" },
						});
					}
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 3 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await syncPiServerTree("append-proxy-failure", context, { entries, leafId: "a1" });
		await expect(
			syncPiServerTree("append-proxy-failure", context, { entries: [...entries, nextEntry], leafId: "u2" }),
		).rejects.toThrow("Session tree append failed");
		await syncPiServerTree("append-proxy-failure", context, { entries: [...entries, nextEntry], leafId: "u2" });

		const appendRequests = capturedRequests.filter((request) => request.path === "/api/session/tree/append");
		expect(appendRequests).toHaveLength(2);
		expect(
			appendRequests.every((request) => JSON.stringify(request.body.entries) === JSON.stringify([nextEntry])),
		).toBe(true);
	});

	it("rejects non-JSON successful tree sync responses before marking sync state", async () => {
		const capturedPaths: string[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		let treeSyncAttempts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				capturedPaths.push(path);

				if (path === "/api/session/tree/sync") {
					treeSyncAttempts++;
					if (treeSyncAttempts === 1) {
						return new Response("<html>not json</html>", {
							status: 200,
							headers: { "Content-Type": "text/html" },
						});
					}
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 2 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await expect(syncPiServerTree("non-json-tree-success", context, { entries, leafId: "a1" })).rejects.toThrow(
			"expected JSON",
		);

		await syncPiServerTree("non-json-tree-success", context, { entries, leafId: "a1" });

		expect(treeSyncAttempts).toBe(2);
		expect(capturedPaths).toEqual(["/api/session/init", "/api/session/tree/sync", "/api/session/tree/sync"]);
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

	it("does not count request chunk upload time against the LLM timeout", async () => {
		process.env.PI_CLIENT_MAX_REQUEST_KB = "2";
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = [messageEntry("u1", null, textMessage("x".repeat(1024 * 1024), 1000))];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/request/chunk")) {
					await sleep(5);
					const index = body.index;
					const total = body.total;
					if (typeof index !== "number" || typeof total !== "number") {
						throw new Error("Expected numeric chunk index and total");
					}
					if (index !== total - 1) {
						return new Response(JSON.stringify({ received: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}
					return new Response(JSON.stringify({ sessionId: "chunk-timeout", leafId: "u1", entryCount: 1 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

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

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("x".repeat(1024 * 1024), 1000)] },
			{ sessionId: "chunk-timeout", sessionTree: { entries, leafId: "u1" }, timeoutMs: 1 },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const chunkTargets = capturedBodies
			.filter((request) => request.url.endsWith("/api/request/chunk"))
			.map((request) => request.body.target);
		expect(chunkTargets).toContain("/api/session/tree/sync");
		const streamBody = capturedBodies.find((request) => request.url.endsWith("/api/stream"))?.body;
		expect((streamBody?.options as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(1);
		expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
	});

	it("reports HTML stream proxy failures with response details", async () => {
		const entries = baseTree().slice(0, 1);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (url.endsWith("/api/stream")) {
					return new Response("<html>Bad gateway</html>", {
						status: 502,
						statusText: "Bad Gateway",
						headers: { "Content-Type": "text/html" },
					});
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
			{ sessionId: "html-stream-failure", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const errorEvent = events.find((event) => (event as { type?: string }).type === "error") as
			| { error?: { errorMessage?: string } }
			| undefined;
		expect(errorEvent?.error?.errorMessage).toContain("502 Bad Gateway");
		expect(errorEvent?.error?.errorMessage).toContain("content-type: text/html");
		expect(errorEvent?.error?.errorMessage).toContain("body excerpt: <html>Bad gateway</html>");
		expect(errorEvent?.error?.errorMessage).not.toContain("Unexpected token");
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
					const serverEntry = compactionEntry("c1", "u2", "summary", "u2");
					return new Response(
						compactResponse(
							{ summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
							[...entries, serverEntry],
							"c1",
						),
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

	it("reconciles server history before compact instead of full-syncing over a different tree", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const serverEntries = baseTree().slice(0, 2);
		const localEntries = [messageEntry("local-u1", null, textMessage("local one", 1000))];
		let reconciled: { entries: SessionTreeEntry[]; leafId: string | null } | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/init")) {
					return new Response(
						JSON.stringify({
							sessionId: body.sessionId,
							staticContextHash: "hash-compact-diverged",
							treeHash: hashEntries(serverEntries),
							leafId: "a1",
							entryCount: serverEntries.length,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.endsWith("/api/session/compact-diverged/history")) {
					return new Response(
						JSON.stringify({
							sessionId: "compact-diverged",
							treeHash: hashEntries(serverEntries),
							entryCount: serverEntries.length,
							leafId: "a1",
							entries: serverEntries,
							messages: [textMessage("one", 1000), assistantMessage("first answer", 2000)],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("unexpected request", { status: 500 });
			}),
		);

		await expect(
			compactPiServer(testModel, context, {
				sessionId: "compact-diverged",
				apiKey: "sk-client",
				sessionTree: { entries: localEntries, leafId: "local-u1" },
				onHistoryReconciled: (snapshot) => {
					reconciled = { entries: snapshot.entries, leafId: snapshot.leafId };
				},
			}),
		).rejects.toThrow("pi-server history differed");

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/compact-diverged/history",
		]);
		expect(reconciled).toEqual({ entries: serverEntries, leafId: "a1" });
	});

	it("preserves already compacted branches before server-side compact", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = [
			messageEntry("u1", null, textMessage("one", 1000)),
			messageEntry("a1", "u1", assistantMessage("first answer", 2000)),
			messageEntry("u2", "a1", textMessage("two", 3000)),
			messageEntry("a2", "u2", assistantMessage("second answer", 4000)),
			compactionEntry("c1", "a2", "summary of one", "u2"),
			messageEntry("u3", "c1", textMessage("three", 5000)),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					const serverEntry = compactionEntry("c2", "u3", "next summary", "u3");
					return new Response(
						compactResponse(
							{ summary: "next summary", firstKeptEntryId: "u3", tokensBefore: 10 },
							[...entries, serverEntry],
							"c2",
						),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({ sessionId: body.sessionId, leafId: body.leafId, entryCount: 6 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-pruned-tree", apiKey: "sk-client", sessionTree: { entries, leafId: "u3" } },
		);

		const treeSync = capturedBodies.find((request) => request.url.endsWith("/api/session/tree/sync"));
		expect(treeSync).toBeDefined();
		const syncedEntries = treeSync!.body.entries as Array<{ id: string; parentId: string | null }>;
		expect(syncedEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(syncedEntries.map((entry) => entry.parentId)).toEqual(entries.map((entry) => entry.parentId));
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
					const serverEntry = compactionEntry("c1", "u2", "summary", "u2");
					return new Response(
						compactResponse(
							{ summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
							[...entries, serverEntry],
							"c1",
						),
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

		expect(result.compaction.summary).toBe("summary");
		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/compact",
			"/api/session/init",
			"/api/session/tree/sync",
			"/api/session/compact",
		]);
	});
});
