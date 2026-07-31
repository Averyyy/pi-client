import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgePiServerCompaction,
	acknowledgePiServerRunMessage,
	compactPiServer as compactPiServerRaw,
	hashStaticContext,
	recordPiServerCompactionApplied,
	resetAllSessionTracking,
	resetSessionTracking,
	streamPiServer,
	syncPiServerTree,
} from "../src/core/pi-server-client.ts";
import { readPiServerPendingCompact } from "../src/core/pi-server-compact-state.ts";
import {
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	PI_SERVER_EMPTY_TREE_HASH,
} from "../src/core/pi-server-protocol.ts";
import { readPiServerPendingRun } from "../src/core/pi-server-run-state.ts";

type JsonObject = Record<string, unknown>;

let compactStateDirectory: string | undefined;
let compactStatePaths = new Map<string, string>();

function compactPiServer(...args: Parameters<typeof compactPiServerRaw>): ReturnType<typeof compactPiServerRaw> {
	const options = args[2] ?? {};
	const sessionId = options.sessionId ?? "default";
	if (!compactStateDirectory) throw new Error("Compact state test directory is not initialized");
	let compactStatePath = compactStatePaths.get(sessionId);
	if (!compactStatePath) {
		compactStatePath = join(compactStateDirectory, `${compactStatePaths.size}.jsonl`);
		compactStatePaths.set(sessionId, compactStatePath);
	}
	return compactPiServerRaw(args[0], args[1], { ...options, piServerCompactStatePath: compactStatePath });
}

function getCompactStatePathForTest(sessionId: string): string {
	const path = compactStatePaths.get(sessionId);
	if (!path) throw new Error(`Compact state path was not created for ${sessionId}`);
	return path;
}

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

function getStreamRequestMac(body: JsonObject): string {
	const { runId: _runId, eventCursor: _eventCursor, ...identity } = body;
	const serialized = canonicalJsonStringify(identity);
	if (serialized === undefined) {
		throw new Error("Expected serializable stream request identity");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

function makeRunStatusResponse(
	sessionId: string,
	runId: string,
	requestMac: string,
	status: "running" | "completed" | "failed",
	nextSeq: number,
): Response {
	return new Response(JSON.stringify({ sessionId, runId, requestMac, status, nextSeq }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function makeCompactEventStreamResponse(body: object): Response {
	return new Response(`: keep-alive\n\nevent: result\ndata: ${JSON.stringify(body)}\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function makeFragmentedCompactEventStreamResponse(body: object, chunkBytes: number): Response {
	const encoded = new TextEncoder().encode(`: keep-alive\n\nevent: result\ndata: ${JSON.stringify(body)}\n\n`);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
					controller.enqueue(encoded.subarray(offset, Math.min(offset + chunkBytes, encoded.byteLength)));
				}
				controller.close();
			},
		}),
		{
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		},
	);
}

function textMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp: number): AssistantMessage {
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
): Extract<SessionTreeEntry, { type: "compaction" }> {
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
	return hashPiServerSessionEntries(entries);
}

function makeSessionResponse(body: JsonObject, overrides: JsonObject = {}): Response {
	const requestedHash = typeof body.staticContextHash === "string" ? body.staticContextHash : undefined;
	const hasPersistedTree = typeof overrides.treeHash === "string";
	const responseBody =
		requestedHash === undefined
			? {
					protocolVersion: 2,
					sessionId: body.sessionId,
					staticContextHash: "",
					treeHash: PI_SERVER_EMPTY_TREE_HASH,
					messageCount: 0,
					entryCount: 0,
					leafId: null,
					revision: 0,
					...overrides,
				}
			: {
					protocolVersion: 2,
					sessionId: body.sessionId,
					staticContextRequired: false,
					staticContextHash: requestedHash,
					treeHash: hasPersistedTree ? overrides.treeHash : PI_SERVER_EMPTY_TREE_HASH,
					messageCount: hasPersistedTree ? (overrides.messageCount ?? 0) : 0,
					entryCount: hasPersistedTree ? (overrides.entryCount ?? 0) : 0,
					leafId: hasPersistedTree ? (overrides.leafId ?? null) : null,
					revision: hasPersistedTree ? (overrides.revision ?? 0) : 0,
				};
	return new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function compactV2ResponseBody(
	requestBody: JsonObject,
	baseEntries: SessionTreeEntry[],
	entry: SessionTreeEntry,
): JsonObject {
	const requestHash = compactRequestHash(requestBody);
	Object.assign(entry, {
		piServerCompactOperation: {
			version: 1,
			operationId: requestBody.operationId,
			requestHash,
			baseStaticContextHash: requestBody.baseStaticContextHash,
			baseTreeHash: requestBody.baseTreeHash,
			baseEntryCount: requestBody.baseEntryCount,
			baseLeafId: requestBody.baseLeafId,
			baseRevision: requestBody.baseRevision,
		},
	});
	const entries = [...baseEntries, entry];
	return {
		protocolVersion: 2,
		sessionId: requestBody.sessionId,
		operationId: requestBody.operationId,
		requestHash,
		treePatch: {
			baseStaticContextHash: requestBody.baseStaticContextHash,
			baseTreeHash: requestBody.baseTreeHash,
			baseEntryCount: requestBody.baseEntryCount,
			baseLeafId: requestBody.baseLeafId,
			baseRevision: requestBody.baseRevision,
			entriesFrom: baseEntries.length,
			entries: [entry],
			leafId: entry.id,
			revision: (requestBody.baseRevision as number) + 1,
			treeHash: hashEntries(entries),
		},
	};
}

function compactRequestHash(body: JsonObject): string {
	const serialized = canonicalJsonStringify({
		protocolVersion: body.protocolVersion,
		sessionId: body.sessionId,
		model: body.model,
		options: body.options,
		settings: body.settings,
		preparation: body.preparation,
		extensionCompaction: body.extensionCompaction,
		customInstructions: body.customInstructions,
		baseStaticContextHash: body.baseStaticContextHash,
		baseTreeHash: body.baseTreeHash,
		baseEntryCount: body.baseEntryCount,
		baseLeafId: body.baseLeafId,
		baseRevision: body.baseRevision,
		streamResponse: body.streamResponse,
		retry: body.retry,
	});
	if (serialized === undefined) throw new Error("Expected serializable compact request identity");
	return createHash("sha256").update(serialized).digest("hex");
}

function compactResponse(requestBody: JsonObject, baseEntries: SessionTreeEntry[], entry: SessionTreeEntry): string {
	return JSON.stringify(compactV2ResponseBody(requestBody, baseEntries, entry));
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
		compactStateDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-compact-state-"));
		compactStatePaths = new Map();
		delete process.env.PI_CLIENT_MAX_REQUEST_KB;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (compactStateDirectory) rmSync(compactStateDirectory, { recursive: true, force: true });
		compactStateDirectory = undefined;
		compactStatePaths.clear();
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
		expect(hashStaticContext(ctx1)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashStaticContext(ctx1)).not.toContain("You are helpful");
	});

	it.each([
		["accepted", false, ["/api/session/init", "/api/session/tree/append"]],
		["required", true, ["/api/session/init", "/api/session/update", "/api/session/tree/append"]],
	] as const)(
		"uses a hash-only init probe when a large static context is %s",
		async (_label, contextRequired, paths) => {
			const captured: Array<{ path: string; body: JsonObject; bodyBytes: number }> = [];
			const context: Context = {
				systemPrompt: `large-static-context-${"x".repeat(256 * 1024)}`,
				messages: [],
				tools: [
					{
						name: "large-tool",
						description: "tool",
						parameters: { type: "object", description: "y".repeat(32 * 1024) },
					},
				],
			};
			const expectedHash = hashStaticContext(context);
			const entries = [messageEntry("u1", null, textMessage("one", 1000))];

			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const rawBody = (init?.body as string | undefined) ?? "";
					const body = parseJsonObject(rawBody);
					const path = new URL(url).pathname;
					captured.push({ path, body, bodyBytes: Buffer.byteLength(rawBody) });
					if (path === "/api/session/init") {
						return new Response(
							JSON.stringify({
								protocolVersion: 2,
								sessionId: "large-static-context",
								staticContextRequired: contextRequired,
								staticContextHash: contextRequired ? "" : expectedHash,
								treeHash: PI_SERVER_EMPTY_TREE_HASH,
								messageCount: 0,
								entryCount: 0,
								leafId: null,
								revision: 0,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (path === "/api/session/update") {
						return makeSessionResponse(body, { staticContextHash: expectedHash });
					}
					return makeSessionResponse(body, {
						staticContextHash: expectedHash,
						treeHash: hashEntries(entries),
						messageCount: 1,
						entryCount: 1,
						leafId: "u1",
						revision: 1,
					});
				}),
			);

			await syncPiServerTree("large-static-context", context, { entries, leafId: "u1" });

			expect(captured.map((request) => request.path)).toEqual(paths);
			expect(captured[0].body).toEqual({
				sessionId: "large-static-context",
				staticContextHash: expectedHash,
			});
			expect(captured[0].bodyBytes).toBeLessThan(160);
			const update = captured.find((request) => request.path === "/api/session/update");
			if (contextRequired) {
				expect(update?.body.staticContext).toEqual({
					systemPrompt: context.systemPrompt,
					tools: context.tools,
				});
				expect(update?.bodyBytes).toBeGreaterThan(256 * 1024);
			} else {
				expect(update).toBeUndefined();
			}
			const append = captured.find((request) => request.path === "/api/session/tree/append");
			expect(append?.body).not.toHaveProperty("staticContext");
		},
	);

	it.each([
		[
			"missing protocol version",
			{
				sessionId: "init-compatibility",
				staticContextRequired: false,
				staticContextHash: "0".repeat(64),
				treeHash: PI_SERVER_EMPTY_TREE_HASH,
				messageCount: 0,
				entryCount: 0,
				leafId: null,
				revision: 0,
			},
			"unsupported pi-server protocol version: missing",
		],
		[
			"unsupported protocol version",
			{
				protocolVersion: 3,
				sessionId: "init-compatibility",
				staticContextRequired: false,
				staticContextHash: "0".repeat(64),
				treeHash: PI_SERVER_EMPTY_TREE_HASH,
				messageCount: 0,
				entryCount: 0,
				leafId: null,
				revision: 0,
			},
			"unsupported pi-server protocol version: 3",
		],
		[
			"missing negotiation flag",
			{
				protocolVersion: 2,
				sessionId: "init-compatibility",
				staticContextHash: "0".repeat(64),
				treeHash: PI_SERVER_EMPTY_TREE_HASH,
				messageCount: 0,
				entryCount: 0,
				leafId: null,
				revision: 0,
			},
			"did not include staticContextRequired",
		],
	] as const)("fails explicitly for an init response with %s", async (_label, responseBody, expectedError) => {
		const requests: JsonObject[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				requests.push(parseJsonObject((init?.body as string | undefined) ?? ""));
				return new Response(JSON.stringify(responseBody), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await expect(
			syncPiServerTree(
				"init-compatibility",
				{ systemPrompt: "compatibility", messages: [] },
				{ entries: [], leafId: null },
			),
		).rejects.toThrow(expectedError);
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("staticContext");
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
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 6 });
			}),
		);

		await syncPiServerTree("compacted-tree-sync", context, { entries, leafId: "u3", replace: true });

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
					return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
				}
				return makeSessionResponse(body, {
					treeHash: hashEntries(entries),
					leafId: "a1",
					entryCount: entries.length,
					messageCount: 2,
					revision: 1,
				});
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
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "a1",
						entryCount: entries.length,
						messageCount: 2,
						revision: 1,
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u2",
						entryCount: entries.length,
						messageCount: 3,
						revision: 1,
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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
					return makeSessionResponse(body, {
						treeHash: hashEntries(serverEntries),
						leafId: "a1",
						entryCount: serverEntries.length,
						messageCount: 2,
						revision: 1,
					});
				}
				if (new URL(url).pathname === "/api/session/server-authoritative/history") {
					return new Response(
						JSON.stringify({
							protocolVersion: 2,
							sessionId: "server-authoritative",
							staticContextHash: hashStaticContext(context),
							treeHash: hashEntries(serverEntries),
							messageCount: 2,
							entryCount: serverEntries.length,
							leafId: "a1",
							revision: 1,
							entries: serverEntries,
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

	it("reconciles a protocol v2 history tree patch without repeated messages or static context", async () => {
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const initialEntries = baseTree().slice(0, 2);
		const localEntry = messageEntry("u2", "a1", textMessage("two", 3000));
		const localEntries = [...initialEntries, localEntry];
		const serverEntry = messageEntry("a2", "u2", assistantMessage("authoritative", 4000));
		const serverEntries = [...localEntries, serverEntry];
		const capturedUrls: string[] = [];
		let appendRequests = 0;
		let reconciled: { entries: SessionTreeEntry[]; leafId: string | null } | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedUrls.push(url);
				if (path === "/api/session/init") {
					return makeSessionResponse(body);
				}
				if (path === "/api/session/tree/append") {
					appendRequests++;
					if (appendRequests === 2) {
						return new Response(JSON.stringify({ error: "entry u2 already exists" }), {
							status: 400,
							headers: { "Content-Type": "application/json" },
						});
					}
					return makeSessionResponse(body, {
						staticContextHash: hashStaticContext(context),
						treeHash: hashEntries(initialEntries),
						messageCount: initialEntries.length,
						entryCount: initialEntries.length,
						leafId: "a1",
						revision: 1,
					});
				}
				if (path === "/api/session/history-tree-patch/history") {
					return new Response(
						JSON.stringify({
							protocolVersion: 2,
							sessionId: "history-tree-patch",
							staticContextHash: hashStaticContext(context),
							treeHash: hashEntries(serverEntries),
							messageCount: serverEntries.length,
							entryCount: serverEntries.length,
							leafId: "a2",
							revision: 2,
							treePatch: {
								entriesFrom: localEntries.length,
								baseRevision: 1,
								entries: [serverEntry],
								leafId: "a2",
								revision: 2,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("unexpected request", { status: 500 });
			}),
		);

		await syncPiServerTree("history-tree-patch", context, { entries: initialEntries, leafId: "a1" });
		await expect(
			syncPiServerTree(
				"history-tree-patch",
				context,
				{ entries: localEntries, leafId: "u2" },
				{
					onHistoryReconciled: (snapshot) => {
						reconciled = { entries: snapshot.entries, leafId: snapshot.leafId };
					},
				},
			),
		).rejects.toThrow("pi-server history differed");

		const historyUrl = new URL(capturedUrls.find((url) => new URL(url).pathname.endsWith("/history"))!);
		expect(historyUrl.searchParams.get("protocolVersion")).toBe("2");
		expect(historyUrl.searchParams.get("entriesFrom")).toBe(String(localEntries.length));
		expect(historyUrl.searchParams.get("baseTreeHash")).toBe(hashEntries(localEntries));
		expect(historyUrl.searchParams.get("revision")).toBe("1");
		expect(reconciled).toEqual({ entries: serverEntries, leafId: "a2" });
		expect(capturedUrls.some((url) => new URL(url).pathname === "/api/session/tree/sync")).toBe(false);
	});

	it("rejects legacy history responses instead of falling back to repeated messages and static context", async () => {
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const serverEntries = baseTree().slice(0, 2);
		const localEntries = [messageEntry("local-u1", null, textMessage("local", 1000))];
		const capturedBodies: JsonObject[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push(body);
				if (url.endsWith("/api/session/init")) {
					return makeSessionResponse(body, {
						treeHash: hashEntries(serverEntries),
						messageCount: serverEntries.length,
						entryCount: serverEntries.length,
						leafId: "a1",
						revision: 1,
					});
				}
				return new Response(
					JSON.stringify({
						sessionId: "legacy-history",
						staticContext: { systemPrompt: context.systemPrompt, tools: [] },
						messages: serverEntries.map((entry) => (entry as { message: Message }).message),
						entries: serverEntries,
						leafId: "a1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(
			syncPiServerTree("legacy-history", context, { entries: localEntries, leafId: "local-u1" }),
		).rejects.toThrow("unsupported pi-server protocol version: missing");
		expect(capturedBodies).toHaveLength(2);
		expect(capturedBodies[0]).not.toHaveProperty("staticContext");
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

				if (new URL(url).pathname === "/api/session/tree-rebuild/history") {
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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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

				if (new URL(url).pathname === "/api/session/tree-switch-divergence/history") {
					return new Response(
						JSON.stringify({
							protocolVersion: 2,
							sessionId: "tree-switch-divergence",
							staticContextHash: hashStaticContext(context),
							treeHash: hashEntries(serverEntries),
							messageCount: 2,
							entryCount: serverEntries.length,
							leafId: "a1",
							revision: 2,
							entries: serverEntries,
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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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
				const requestEntries = (body.entries as SessionTreeEntry[] | undefined) ?? [];
				return makeSessionResponse(body, {
					leafId: body.leafId,
					treeHash: hashEntries(requestEntries),
					entryCount: requestEntries.length,
					messageCount: requestEntries.filter((entry) => entry.type === "message").length,
					revision: requestEntries.length === 0 ? 0 : 1,
				});
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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 2 });
			}),
		);

		let error: unknown;
		try {
			await syncPiServerTree("html-tree-failure", context, { entries, leafId: "a1", replace: true });
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

		await syncPiServerTree("html-tree-failure", context, { entries, leafId: "a1", replace: true });

		expect(treeSyncAttempts).toBe(2);
		expect(capturedPaths).toEqual(["/api/session/init", "/api/session/tree/sync", "/api/session/tree/sync"]);
	});

	it("does not mark tree append successful after a proxy failure", async () => {
		const capturedRequests: { path: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));
		let appendAttempts = 0;
		let failAppends = false;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				capturedRequests.push({ path, body });

				if (path === "/api/session/tree/append" && failAppends) {
					appendAttempts++;
					if (appendAttempts === 1) {
						return new Response("<html>Cloudflare 520</html>", {
							status: 520,
							headers: { "Content-Type": "text/html" },
						});
					}
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		await syncPiServerTree("append-proxy-failure", context, { entries, leafId: "a1" });
		capturedRequests.length = 0;
		failAppends = true;
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

	it("retries transient Cloudflare tree append failures", async () => {
		const capturedRequests: { path: string; body: JsonObject }[] = [];
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const entries = baseTree().slice(0, 2);
		const nextEntry = messageEntry("u2", "a1", textMessage("two", 3000));
		let appendAttempts = 0;
		let failAppends = false;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				capturedRequests.push({ path, body });

				if (path === "/api/session/tree/append" && failAppends) {
					appendAttempts++;
					if (appendAttempts === 1) {
						return new Response(JSON.stringify({ error: "CONNECT timeout" }), {
							status: 502,
							statusText: "Bad Gateway",
							headers: { "Content-Type": "application/json" },
						});
					}
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		await syncPiServerTree("append-cloudflare-timeout", context, { entries, leafId: "a1" });
		capturedRequests.length = 0;
		failAppends = true;
		await syncPiServerTree("append-cloudflare-timeout", context, { entries: [...entries, nextEntry], leafId: "u2" });

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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 2 });
			}),
		);

		await expect(
			syncPiServerTree("non-json-tree-success", context, { entries, leafId: "a1", replace: true }),
		).rejects.toThrow("expected JSON");

		await syncPiServerTree("non-json-tree-success", context, { entries, leafId: "a1", replace: true });

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
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
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
		const signal = new AbortController().signal;

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
							responseModel: "resolved-model",
							responseId: "response-1",
							diagnostics: [
								{
									type: "provider_transport_failure",
									timestamp: 123,
									error: { name: "Error", message: "websocket failed" },
									details: { transport: "websocket", fallback: "sse" },
								},
							],
						},
					]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "stream-tree",
				sessionTree: { entries, leafId: "u1" },
				temperature: 0.25,
				maxTokens: 1234,
				reasoning: "high",
				cacheRetention: "long",
				apiKey: "test-api-key",
				headers: { "x-test": "header" },
				metadata: { user_id: "test-user" },
				transport: "websocket",
				thinkingBudgets: { high: 8192 },
				timeoutMs: 12_345,
				websocketConnectTimeoutMs: 2345,
				maxRetries: 2,
				maxRetryDelayMs: 3456,
				env: { TEST_REGION: "test-region" },
				signal,
				onPayload: () => undefined,
				onResponse: () => {},
			},
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
		expect(streamBody?.options).toEqual({
			temperature: 0.25,
			maxTokens: 1234,
			reasoning: "high",
			cacheRetention: "long",
			sessionId: "stream-tree",
			apiKey: "test-api-key",
			headers: { "x-test": "header" },
			metadata: { user_id: "test-user" },
			transport: "websocket",
			thinkingBudgets: { high: 8192 },
			timeoutMs: 12_345,
			websocketConnectTimeoutMs: 2345,
			maxRetries: 2,
			maxRetryDelayMs: 3456,
			env: { TEST_REGION: "test-region" },
		});
		expect(streamBody?.options).not.toHaveProperty("signal");
		expect(streamBody?.options).not.toHaveProperty("onPayload");
		expect(streamBody?.options).not.toHaveProperty("onResponse");
		const doneEvent = events.find((event) => (event as { type?: string }).type === "done") as
			| {
					message?: {
						responseModel?: string;
						responseId?: string;
						diagnostics?: Array<{ type?: string }>;
					};
			  }
			| undefined;
		expect(doneEvent?.message).toMatchObject({
			responseModel: "resolved-model",
			responseId: "response-1",
			diagnostics: [{ type: "provider_transport_failure" }],
		});
	});

	it("preserves redacted thinking and tool-call thought signatures from pi-server", async () => {
		const entries = baseTree().slice(0, 1);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{ type: "thinking_start", contentIndex: 0 },
						{ type: "thinking_delta", contentIndex: 0, delta: "[Reasoning redacted]" },
						{
							type: "thinking_end",
							contentIndex: 0,
							contentSignature: "opaque-thinking",
							redacted: true,
						},
						{ type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "lookup" },
						{ type: "toolcall_delta", contentIndex: 1, delta: '{"query":"pi"}' },
						{ type: "toolcall_end", contentIndex: 1, thoughtSignature: "opaque-tool-thought" },
						{
							type: "done",
							reason: "toolUse",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-provider-signatures", sessionTree: { entries, leafId: "u1" } },
		);
		const result = await stream.result();

		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "opaque-thinking",
				redacted: true,
			},
			{
				type: "toolCall",
				id: "call-1",
				name: "lookup",
				arguments: { query: "pi" },
				thoughtSignature: "opaque-tool-thought",
			},
		]);
	});

	it("uses authoritative end content and terminal assistant metadata without delta events", async () => {
		const entries = baseTree().slice(0, 1);
		const usage = {
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/stream")) {
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{
							type: "text_end",
							contentIndex: 0,
							content: "authoritative text",
							contentSignature: "text-signature",
						},
						{ type: "thinking_start", contentIndex: 1 },
						{
							type: "thinking_end",
							contentIndex: 1,
							content: "authoritative thinking",
							contentSignature: "thinking-signature",
							redacted: true,
						},
						{ type: "toolcall_start", contentIndex: 2, id: "partial-id", toolName: "partial-tool" },
						{
							type: "toolcall_end",
							contentIndex: 2,
							toolCall: {
								type: "toolCall",
								id: "server-call",
								name: "server-tool",
								arguments: { query: "pi" },
								thoughtSignature: "tool-signature",
							},
						},
						{
							type: "done",
							reason: "toolUse",
							usage,
							api: "anthropic-messages",
							provider: "server-provider",
							model: "server-model",
							timestamp: 987654321,
							responseModel: "server-response-model",
							responseId: "server-response-id",
							diagnostics: [],
						},
					]);
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-authoritative-end", sessionTree: { entries, leafId: "u1" } },
		);
		const result = await stream.result();

		expect(result).toStrictEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "authoritative text", textSignature: "text-signature" },
				{
					type: "thinking",
					thinking: "authoritative thinking",
					thinkingSignature: "thinking-signature",
					redacted: true,
				},
				{
					type: "toolCall",
					id: "server-call",
					name: "server-tool",
					arguments: { query: "pi" },
					thoughtSignature: "tool-signature",
				},
			],
			api: "anthropic-messages",
			provider: "server-provider",
			model: "server-model",
			usage,
			stopReason: "toolUse",
			timestamp: 987654321,
			responseModel: "server-response-model",
			responseId: "server-response-id",
			diagnostics: [],
		});
	});

	it.each([
		["fetch failure", "fetch"],
		["HTTP 503", "http"],
	] as const)("reattaches to the same run after an initial %s", async (_label, failureKind) => {
		const entries = baseTree().slice(0, 1);
		const streamBodies: JsonObject[] = [];
		const runStatusUrls: URL[] = [];
		const runEventUrls: URL[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					runEventUrls.push(parsedUrl);
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "recovered" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}

				if (path.startsWith("/api/session/initial-stream-recovery/runs/")) {
					runStatusUrls.push(parsedUrl);
					const runId = path.split("/").pop();
					if (!runId || !streamBodies[0]) {
						throw new Error("Expected the original stream request before run recovery");
					}
					return makeRunStatusResponse(
						"initial-stream-recovery",
						runId,
						getStreamRequestMac(streamBodies[0]),
						"running",
						5,
					);
				}

				if (path === "/api/stream") {
					streamBodies.push(body);
					switch (failureKind) {
						case "fetch":
							throw new Error("fetch failed");
						case "http":
							return new Response("upstream unavailable", {
								status: 503,
								statusText: "Service Unavailable",
								headers: { "Content-Type": "text/plain" },
							});
					}
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "initial-stream-recovery", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(streamBodies).toHaveLength(1);
		expect(streamBodies[0].runId).toBeDefined();
		expect(runStatusUrls).toHaveLength(1);
		expect(runEventUrls).toHaveLength(1);
		expect(runEventUrls[0].searchParams.get("from")).toBe("0");
		expect(events.map((event) => (event as { type?: string }).type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(
			events
				.filter((event) => (event as { type?: string }).type === "text_delta")
				.map((event) => (event as { delta?: string }).delta)
				.join(""),
		).toBe("recovered");
	});

	it("fails an invalid non-SSE stream response immediately without run status or replay requests", async () => {
		const entries = baseTree().slice(0, 1);
		let streamPosts = 0;
		let runRequests = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (path.includes("/runs/")) {
					runRequests++;
					throw new Error("Run recovery must not execute for a protocol-invalid response");
				}
				if (path === "/api/stream") {
					streamPosts++;
					return new Response("<html>proxy response</html>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "invalid-non-sse", sessionTree: { entries, leafId: "u1" } },
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("expected text/event-stream");
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
		expect(streamPosts).toBe(1);
		expect(runRequests).toBe(0);
	});

	it.each([401, 403])("fails stream authentication HTTP %s without entering recovery", async (status) => {
		const entries = baseTree().slice(0, 1);
		let streamPosts = 0;
		let runRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (path.includes("/runs/")) {
					runRequests++;
					throw new Error("Run recovery must not execute for an authentication failure");
				}
				if (path === "/api/stream") {
					streamPosts++;
					return new Response(JSON.stringify({ error: "authentication failed" }), {
						status,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: `stream-auth-${status}`,
				sessionTree: { entries, leafId: "u1" },
				piServerRecoveryWindowMs: 1,
			},
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(String(status));
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
		expect(streamPosts).toBe(1);
		expect(runRequests).toBe(0);
	});

	it("bounds a failed stream response body and does not attempt run recovery", async () => {
		const entries = baseTree().slice(0, 1);
		let runRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (path.includes("/runs/")) {
					runRequests++;
					throw new Error("Run recovery must not execute for an oversized authentication response");
				}
				if (path === "/api/stream") {
					return new Response("x".repeat(64 * 1024 + 1), {
						status: 401,
						headers: { "Content-Type": "text/plain" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-auth-body-limit", sessionTree: { entries, leafId: "u1" } },
		);
		const result = await stream.result();

		expect(result.errorMessage).toContain("response body exceeded 65536 bytes");
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
		expect(runRequests).toBe(0);
	});

	it.each([
		["invalid requestMac", { requestMac: "not-a-digest", status: "running" }, "requestMac"],
		["invalid status", { requestMac: "0".repeat(64), status: "future" }, "unsupported run status"],
	] as const)("fails recovered run state with %s without reconnecting", async (_label, invalidRun, expectedError) => {
		const entries = baseTree().slice(0, 1);
		let streamBody: JsonObject | undefined;
		let runRequests = 0;
		let replayRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (path.endsWith("/events")) {
					replayRequests++;
					throw new Error("Replay must not execute for invalid recovered run state");
				}
				if (path.startsWith("/api/session/invalid-run-state/runs/")) {
					runRequests++;
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected original stream request");
					return new Response(
						JSON.stringify({
							sessionId: "invalid-run-state",
							runId,
							nextSeq: 0,
							...invalidRun,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (path === "/api/stream") {
					streamBody = body;
					throw new Error("fetch failed");
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "invalid-run-state",
				sessionTree: { entries, leafId: "u1" },
				piServerRecoveryWindowMs: 100_000,
			},
		);
		const result = await stream.result();

		expect(result.errorMessage).toContain(expectedError);
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
		expect(runRequests).toBe(1);
		expect(replayRequests).toBe(0);
	});

	it("does not resubmit an ambiguously missing run after the first provider request may have arrived", async () => {
		const entries = baseTree().slice(0, 1);
		const streamBodies: JsonObject[] = [];
		let statusRequests = 0;
		let eventRequests = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (path.endsWith("/events")) {
					eventRequests++;
					expect(parsedUrl.searchParams.get("from")).toBe("1");
					return makeMockResponse([
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "replayed" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}
				if (path.startsWith("/api/session/ambiguous-not-found/runs/")) {
					statusRequests++;
					return new Response(JSON.stringify({ error: "Run not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (path === "/api/stream") {
					streamBodies.push(body);
					throw new Error("socket closed after the provider request may have arrived");
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "ambiguous-not-found",
				sessionTree: { entries, leafId: "u1" },
				piServerRecoveryWindowMs: 5000,
			},
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider outcome is unknown");
		expect(result.errorMessage).toContain("pending marker was retained");
		expect(result.errorMessage).toContain("automatic provider resubmission is disabled");
		expect(result.diagnostics?.[0]?.details?.runUnresolved).toBe(true);
		expect(statusRequests).toBe(1);
		expect(streamBodies).toHaveLength(1);
		expect(eventRequests).toBe(0);
	});

	it("recovers a completed run when the stream disconnects before final delivery", async () => {
		const capturedUrls: URL[] = [];
		const entries = baseTree().slice(0, 1);
		const recoveredMessage = assistantMessage("recovered", 3000);
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				capturedUrls.push(parsedUrl);
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					return makeMockResponse([
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "recovered" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: recoveredMessage.stopReason,
							usage: recoveredMessage.usage,
							api: recoveredMessage.api,
							provider: recoveredMessage.provider,
							model: recoveredMessage.model,
							timestamp: recoveredMessage.timestamp,
						},
					]);
				}

				if (path.startsWith("/api/session/stream-run-recovery/runs/")) {
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"stream-run-recovery",
						runId,
						getStreamRequestMac(streamBody),
						"completed",
						5,
					);
				}

				if (url.endsWith("/api/stream")) {
					streamPosts++;
					streamBody = body;
					const encoder = new TextEncoder();
					let readCount = 0;
					const bodyStream = new ReadableStream<Uint8Array>({
						pull(controller) {
							readCount++;
							if (readCount === 1) {
								controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
								return;
							}
							throw new Error("socket lost");
						},
					});
					return new Response(bodyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-run-recovery", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const doneEvent = events.find((event) => (event as { type?: string }).type === "done") as
			| { message?: Message }
			| undefined;
		expect(doneEvent?.message).toEqual(recoveredMessage);
		expect(streamPosts).toBe(1);
		const eventsUrl = capturedUrls.find((value) => value.pathname.endsWith("/events"));
		expect(eventsUrl?.searchParams.get("from")).toBe("1");
	});

	it("recovers a completed run when the stream closes cleanly without a terminal event", async () => {
		const entries = baseTree().slice(0, 1);
		const recoveredMessage = assistantMessage("recovered after clean eof", 3000);
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;
		let eventsUrl: URL | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventsUrl = parsedUrl;
					return makeMockResponse([
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "recovered after clean eof" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: recoveredMessage.stopReason,
							usage: recoveredMessage.usage,
							api: recoveredMessage.api,
							provider: recoveredMessage.provider,
							model: recoveredMessage.model,
							timestamp: recoveredMessage.timestamp,
						},
					]);
				}

				if (path.startsWith("/api/session/stream-clean-eof/runs/")) {
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse("stream-clean-eof", runId, getStreamRequestMac(streamBody), "completed", 5);
				}

				if (path === "/api/stream") {
					streamPosts++;
					streamBody = body;
					return makeMockResponse([{ type: "start" }]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-clean-eof", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const doneEvent = events.find((event) => (event as { type?: string }).type === "done") as
			| { message?: Message }
			| undefined;
		expect(doneEvent?.message).toEqual(recoveredMessage);
		expect(streamPosts).toBe(1);
		expect(eventsUrl?.searchParams.get("from")).toBe("1");
	});

	it("reattaches to a running interrupted run without duplicating replayed events", async () => {
		const entries = baseTree().slice(0, 1);
		let runRequests = 0;
		const streamBodies: JsonObject[] = [];
		const eventUrls: URL[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventUrls.push(parsedUrl);
					return makeMockResponse([
						{ type: "text_delta", contentIndex: 0, delta: "covered" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}

				if (path.startsWith("/api/session/stream-running-recovery/runs/")) {
					runRequests++;
					const runId = path.split("/").pop();
					if (!runId || !streamBodies[0]) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"stream-running-recovery",
						runId,
						getStreamRequestMac(streamBodies[0]),
						"running",
						6,
					);
				}

				if (path === "/api/stream") {
					streamBodies.push(body);
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "re" },
					]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-running-recovery", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const doneEvent = events.find((event) => (event as { type?: string }).type === "done") as
			| { message?: { content?: Array<{ type: string; text?: string }> } }
			| undefined;
		expect(doneEvent?.message?.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(
			events
				.filter((event) => (event as { type?: string }).type === "text_delta")
				.map((event) => (event as { delta?: string }).delta)
				.join(""),
		).toBe("recovered");
		expect(runRequests).toBe(1);
		expect(streamBodies).toHaveLength(1);
		expect(streamBodies[0].eventCursor).toBe(0);
		expect(eventUrls).toHaveLength(1);
		expect(eventUrls[0].searchParams.get("from")).toBe("3");
		expect(eventUrls[0].pathname).toContain(String(streamBodies[0].runId));
	});

	it("uses the server run error when an interrupted run failed", async () => {
		const entries = baseTree().slice(0, 1);
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;
		let eventsUrl: URL | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventsUrl = parsedUrl;
					return makeMockResponse([
						{
							type: "error",
							reason: "error",
							errorMessage: "provider rejected the recovered run",
							usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
							diagnostics: [
								{
									type: "pi_server_failure",
									timestamp: 123,
									error: { name: "Error", message: "provider rejected the recovered run" },
									details: { phase: "provider_stream", source: "pi-server", retryable: true },
								},
							],
						},
					]);
				}

				if (path.startsWith("/api/session/stream-failed-recovery/runs/")) {
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"stream-failed-recovery",
						runId,
						getStreamRequestMac(streamBody),
						"failed",
						2,
					);
				}

				if (path === "/api/stream") {
					streamPosts++;
					streamBody = body;
					return makeMockResponse([{ type: "start" }]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-failed-recovery", sessionTree: { entries, leafId: "u1" } },
		);
		const events: object[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const errorEvent = events.find((event) => (event as { type?: string }).type === "error") as
			| {
					error?: {
						errorMessage?: string;
						diagnostics?: Array<{ details?: { phase?: unknown; retryable?: unknown } }>;
					};
			  }
			| undefined;
		expect(errorEvent?.error?.errorMessage).toBe("provider rejected the recovered run");
		expect(errorEvent?.error?.diagnostics?.[0]?.details?.phase).toBe("provider_stream");
		expect(streamPosts).toBe(1);
		expect(eventsUrl?.searchParams.get("from")).toBe("1");
	});

	it("reports an explicit provider stream error when an interrupted run cannot be recovered", async () => {
		vi.useFakeTimers();
		const entries = baseTree().slice(0, 1);
		let runRequests = 0;
		const streamBodies: JsonObject[] = [];
		const eventCursors: string[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventCursors.push(parsedUrl.searchParams.get("from") ?? "");
					return makeMockResponse([]);
				}

				if (path.startsWith("/api/session/stream-unavailable-recovery/runs/")) {
					runRequests++;
					const runId = path.split("/").pop();
					if (!runId || !streamBodies[0]) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"stream-unavailable-recovery",
						runId,
						getStreamRequestMac(streamBodies[0]),
						"running",
						1,
					);
				}

				if (path === "/api/stream") {
					streamBodies.push(body);
					return makeMockResponse([{ type: "start" }]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "stream-unavailable-recovery",
				sessionTree: { entries, leafId: "u1" },
				piServerRecoveryWindowMs: 10 * 60_000 + 30_000,
			},
		);
		const resultPromise = stream.result();
		let settled = false;
		void resultPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(settled).toBe(false);
		expect(runRequests).toBeGreaterThan(5);
		expect(eventCursors.length).toBeGreaterThan(5);
		expect(new Set(eventCursors)).toEqual(new Set(["1"]));
		expect(streamBodies).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(31_000);
		const result = await resultPromise;
		expect(result.errorMessage).toContain("pi-server stream ended before a terminal event");
		expect(result.errorMessage).toContain("pi-server stream recovery exhausted after 630000ms");
		expect(result.diagnostics?.[0]?.details?.phase).toBe("provider_stream");
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
	});

	it("reattaches the same run after run recovery is temporarily unavailable", async () => {
		vi.useFakeTimers();
		const entries = baseTree().slice(0, 1);
		let runRequests = 0;
		const streamBodies: JsonObject[] = [];
		const eventUrls: URL[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventUrls.push(parsedUrl);
					return makeMockResponse([
						{ type: "start" },
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "recovered" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						},
					]);
				}

				if (path.startsWith("/api/session/stream-unknown-recovery/runs/")) {
					runRequests++;
					if (runRequests <= 5) {
						throw new Error("fetch failed while checking run");
					}
					const runId = path.split("/").pop();
					if (!runId || !streamBodies[0]) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"stream-unknown-recovery",
						runId,
						getStreamRequestMac(streamBodies[0]),
						"running",
						5,
					);
				}
				if (path === "/api/stream") {
					streamBodies.push(body);
					throw new Error("fetch failed while starting stream");
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "stream-unknown-recovery", sessionTree: { entries, leafId: "u1" } },
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(31_001);
		const result = await resultPromise;

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(runRequests).toBe(6);
		expect(streamBodies).toHaveLength(1);
		expect(eventUrls).toHaveLength(1);
		expect(eventUrls[0].searchParams.get("from")).toBe("0");
		expect(eventUrls[0].pathname).toContain(String(streamBodies[0].runId));
	});

	it("turns an invalid recovered stop reason into a terminal non-retryable error", async () => {
		const entries = baseTree().slice(0, 1);
		const recoveredMessage = { ...assistantMessage("invalid terminal", 3000), stopReason: "future_reason" };
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;
		let statusRequests = 0;
		let eventRequests = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const path = new URL(url).pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					eventRequests++;
					return makeMockResponse([
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "invalid terminal" },
						{ type: "text_end", contentIndex: 0 },
						{
							type: "done",
							reason: recoveredMessage.stopReason,
							usage: recoveredMessage.usage,
							api: recoveredMessage.api,
							provider: recoveredMessage.provider,
							model: recoveredMessage.model,
							timestamp: recoveredMessage.timestamp,
						},
					]);
				}

				if (path.startsWith("/api/session/invalid-recovered-stop/runs/")) {
					statusRequests++;
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"invalid-recovered-stop",
						runId,
						getStreamRequestMac(streamBody),
						"completed",
						5,
					);
				}
				if (path === "/api/stream") {
					streamPosts++;
					streamBody = body;
					return makeMockResponse([{ type: "start" }]);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{ sessionId: "invalid-recovered-stop", sessionTree: { entries, leafId: "u1" } },
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Received invalid terminal done reason: future_reason");
		expect(result.diagnostics?.[0]?.details?.retryable).toBe(false);
		expect(streamPosts).toBe(1);
		expect(statusRequests).toBe(1);
		expect(eventRequests).toBe(1);
	});

	it("durably writes the pi-server run marker before submitting the provider stream", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-state-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		let streamBody: JsonObject | undefined;
		let markerObservedBeforePost = false;

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path === "/api/stream") {
						streamBody = body;
						const pending = readPiServerPendingRun(runStatePath);
						markerObservedBeforePost =
							pending?.sessionId === "durable-marker-before-post" &&
							pending.runId === body.runId &&
							pending.requestHash === getStreamRequestMac(body);
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
				}),
			);

			const stream = await streamPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
				{
					sessionId: "durable-marker-before-post",
					sessionTree: { entries, leafId: "u1" },
					piServerRunStatePath: runStatePath,
				},
			);
			await stream.result();

			expect(streamBody).toBeDefined();
			expect(markerObservedBeforePost).toBe(true);
			expect(readPiServerPendingRun(runStatePath)?.runId).toBe(streamBody?.runId);
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("reuses a durable run after OAuth, headers, and env refresh without resubmitting the provider", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-resume-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		const streamBodies: JsonObject[] = [];
		const eventUrls: URL[] = [];
		let statusRequests = 0;

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const parsedUrl = new URL(url);
					const path = parsedUrl.pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path.endsWith("/events")) {
						eventUrls.push(parsedUrl);
						return makeMockResponse([
							{ type: "start" },
							{ type: "text_start", contentIndex: 0 },
							{ type: "text_delta", contentIndex: 0, delta: "same durable run" },
							{ type: "text_end", contentIndex: 0 },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					if (path.startsWith("/api/session/process-style-resume/runs/")) {
						statusRequests++;
						const pending = readPiServerPendingRun(runStatePath);
						const runId = path.split("/").pop();
						if (!pending || !runId) throw new Error("Expected durable pending run");
						return makeRunStatusResponse("process-style-resume", runId, pending.requestHash, "completed", 5);
					}
					if (path === "/api/stream") {
						streamBodies.push(body);
						return makeMockResponse([
							{ type: "start" },
							{ type: "text_start", contentIndex: 0 },
							{ type: "text_delta", contentIndex: 0, delta: "same durable run" },
							{ type: "text_end", contentIndex: 0 },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [textMessage("one", 1000)],
			};
			const initialOptions = {
				sessionId: "process-style-resume",
				sessionTree: { entries, leafId: "u1" },
				piServerRunStatePath: runStatePath,
				apiKey: "oauth-before-refresh",
				headers: { authorization: "Bearer before-refresh" },
				env: { PI_OAUTH_STATE: "before-refresh" },
			};
			const firstStream = await streamPiServer(testModel, context, initialOptions);
			const firstResult = await firstStream.result();
			const pending = readPiServerPendingRun(runStatePath);
			expect(pending?.runId).toBe(streamBodies[0]?.runId);

			resetAllSessionTracking();
			const resumedStream = await streamPiServer(testModel, context, {
				...initialOptions,
				apiKey: "oauth-after-refresh",
				headers: { authorization: "Bearer after-refresh" },
				env: { PI_OAUTH_STATE: "after-refresh" },
			});
			const resumedResult = await resumedStream.result();

			expect(firstResult.content).toEqual([{ type: "text", text: "same durable run" }]);
			expect(resumedResult.content).toEqual(firstResult.content);
			expect(streamBodies).toHaveLength(1);
			expect(statusRequests).toBe(1);
			expect(eventUrls).toHaveLength(1);
			expect(eventUrls[0].pathname).toContain(String(pending?.runId));
			expect(eventUrls[0].searchParams.get("from")).toBe("0");
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("fails closed when a durable pending run is missing instead of submitting a second provider run", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-not-found-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		const streamBodies: JsonObject[] = [];
		const statusRunIds: string[] = [];

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path.startsWith("/api/session/pending-not-found/runs/")) {
						const runId = path.split("/").pop();
						if (!runId) throw new Error("Expected pending run id");
						statusRunIds.push(runId);
						return new Response(JSON.stringify({ error: "Run not found" }), {
							status: 404,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (path === "/api/stream") {
						streamBodies.push(body);
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [textMessage("one", 1000)],
			};
			const initialStream = await streamPiServer(testModel, context, {
				sessionId: "pending-not-found",
				sessionTree: { entries, leafId: "u1" },
				piServerRunStatePath: runStatePath,
				apiKey: "oauth-before-404",
				headers: { authorization: "Bearer before-404" },
				env: { PI_OAUTH_STATE: "before-404" },
			});
			await initialStream.result();
			const oldPending = readPiServerPendingRun(runStatePath);
			expect(oldPending?.runId).toBe(streamBodies[0]?.runId);

			resetAllSessionTracking();
			const replacementStream = await streamPiServer(testModel, context, {
				sessionId: "pending-not-found",
				sessionTree: { entries, leafId: "u1" },
				piServerRunStatePath: runStatePath,
				apiKey: "oauth-after-404",
				headers: { authorization: "Bearer after-404" },
				env: { PI_OAUTH_STATE: "after-404" },
			});
			const replacementResult = await replacementStream.result();
			const newPending = readPiServerPendingRun(runStatePath);

			expect(statusRunIds).toEqual([oldPending?.runId]);
			expect(streamBodies).toHaveLength(1);
			expect(replacementResult.stopReason).toBe("error");
			expect(replacementResult.errorMessage).toContain("provider outcome is unknown");
			expect(replacementResult.errorMessage).toContain("pending marker was retained");
			expect(replacementResult.errorMessage).toContain("automatic provider resubmission is disabled");
			expect(replacementResult.diagnostics?.[0]?.details?.runUnresolved).toBe(true);
			expect(newPending).toEqual(oldPending);
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("keeps durable run recovery alive beyond six hours and replays the terminal without another provider submit", async () => {
		vi.useFakeTimers();
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-ultra-long-run-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		const recoveryDelayMs = 6 * 60 * 60_000 + 1;
		const recoveryAvailableAt = Date.now() + recoveryDelayMs;
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;
		let statusRequests = 0;
		let eventRequests = 0;

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const parsedUrl = new URL(url);
					const path = parsedUrl.pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path.endsWith("/events")) {
						eventRequests++;
						expect(parsedUrl.searchParams.get("from")).toBe("1");
						return makeMockResponse([
							{ type: "text_start", contentIndex: 0 },
							{ type: "text_delta", contentIndex: 0, delta: "lossless long-run recovery" },
							{ type: "text_end", contentIndex: 0 },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					if (path.startsWith("/api/session/ultra-long-run/runs/")) {
						statusRequests++;
						if (Date.now() < recoveryAvailableAt) {
							throw new Error("temporary recovery network outage");
						}
						const pending = readPiServerPendingRun(runStatePath);
						const runId = path.split("/").pop();
						if (!pending || !runId) throw new Error("Expected durable pending run");
						return makeRunStatusResponse("ultra-long-run", runId, pending.requestHash, "completed", 5);
					}
					if (path === "/api/stream") {
						streamPosts++;
						streamBody = body;
						return makeMockResponse([{ type: "start" }]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const stream = await streamPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
				{
					sessionId: "ultra-long-run",
					sessionTree: { entries, leafId: "u1" },
					piServerRunStatePath: runStatePath,
					piServerRecoveryWindowMs: Number.POSITIVE_INFINITY,
				},
			);
			const resultPromise = stream.result();
			await vi.advanceTimersByTimeAsync(recoveryDelayMs + 31_000);
			const result = await resultPromise;

			expect(result.content).toEqual([{ type: "text", text: "lossless long-run recovery" }]);
			expect(streamPosts).toBe(1);
			expect(streamBody?.runId).toBe(readPiServerPendingRun(runStatePath)?.runId);
			expect(statusRequests).toBeGreaterThan(1);
			expect(eventRequests).toBe(1);
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("acknowledges a persisted terminal run before clearing its durable local marker", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-ack-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		let ackBody: JsonObject | undefined;

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path === "/api/session/run/ack") {
						ackBody = body;
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected the local marker to remain pending until server ack");
						return new Response(
							JSON.stringify({
								acknowledged: true,
								sessionId: pending.sessionId,
								runId: pending.runId,
								requestMac: pending.requestHash,
								status: "completed",
								acknowledgedAt: 1234,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (path === "/api/stream") {
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected durable pending run before stream submit");
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
								diagnostics: [
									{
										type: "pi_server_run",
										timestamp: 123,
										details: {
											sessionId: pending.sessionId,
											runId: pending.runId,
											requestMac: pending.requestHash,
											restartUnknown: false,
										},
									},
								],
							},
						]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const stream = await streamPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
				{
					sessionId: "durable-terminal-ack",
					sessionTree: { entries, leafId: "u1" },
					piServerRunStatePath: runStatePath,
				},
			);
			const terminal = await stream.result();
			const pending = readPiServerPendingRun(runStatePath);
			expect(pending).toBeDefined();

			await acknowledgePiServerRunMessage("durable-terminal-ack", terminal, runStatePath);

			expect(ackBody).toEqual({ sessionId: "durable-terminal-ack", runId: pending?.runId });
			expect(readPiServerPendingRun(runStatePath)).toBeUndefined();
		} finally {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("recovers a durable pending run from authoritative server history after a local tree mismatch", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-tree-mismatch-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		const changedEntries = [...entries, messageEntry("u2", "u1", textMessage("changed tree", 2000))];
		let streamPosts = 0;
		let statusRequests = 0;
		let historyRequests = 0;
		let eventRequests = 0;
		let reconciledEntries: SessionTreeEntry[] | undefined;

		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path.startsWith("/api/session/durable-tree-mismatch/runs/") && path.endsWith("/events")) {
						eventRequests++;
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected durable pending run");
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
								diagnostics: [
									{
										type: "pi_server_run",
										timestamp: 123,
										details: {
											sessionId: pending.sessionId,
											runId: pending.runId,
											requestMac: pending.requestHash,
											restartUnknown: false,
										},
									},
								],
							},
						]);
					}
					if (path.startsWith("/api/session/durable-tree-mismatch/runs/")) {
						statusRequests++;
						const pending = readPiServerPendingRun(runStatePath);
						if (!pending) throw new Error("Expected durable pending run");
						return makeRunStatusResponse(pending.sessionId, pending.runId, pending.requestHash, "completed", 2);
					}
					if (path === "/api/session/durable-tree-mismatch/history") {
						historyRequests++;
						return new Response(
							JSON.stringify({
								protocolVersion: 2,
								sessionId: "durable-tree-mismatch",
								staticContextHash: hashStaticContext({
									systemPrompt: "You are helpful.",
									messages: [textMessage("one", 1000)],
								}),
								treeHash: hashEntries(entries),
								messageCount: 1,
								entryCount: entries.length,
								leafId: "u1",
								revision: 1,
								entries,
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (path === "/api/stream") {
						streamPosts++;
						const requestMac = getStreamRequestMac(body);
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
								diagnostics: [
									{
										type: "pi_server_run",
										timestamp: 123,
										details: {
											sessionId: body.sessionId,
											runId: body.runId,
											requestMac,
											restartUnknown: false,
										},
									},
								],
							},
						]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [textMessage("one", 1000)],
			};
			const initialStream = await streamPiServer(testModel, context, {
				sessionId: "durable-tree-mismatch",
				sessionTree: { entries, leafId: "u1" },
				temperature: 0.25,
				piServerRunStatePath: runStatePath,
			});
			await initialStream.result();
			expect(streamPosts).toBe(1);

			resetAllSessionTracking();
			streamPosts = 0;
			const resumedStream = await streamPiServer(testModel, context, {
				sessionId: "durable-tree-mismatch",
				sessionTree: { entries: changedEntries, leafId: "u2" },
				temperature: 0.25,
				piServerRunStatePath: runStatePath,
				onHistoryReconciled: (snapshot) => {
					reconciledEntries = snapshot.entries;
				},
			});
			const result = await resumedStream.result();

			expect(result.stopReason).toBe("stop");
			expect(streamPosts).toBe(0);
			expect(statusRequests).toBe(1);
			expect(historyRequests).toBe(1);
			expect(eventRequests).toBe(1);
			expect(reconciledEntries).toEqual(entries);
		} finally {
			resetAllSessionTracking();
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("refuses a durable pending run when the current server has no matching journal", async () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "pi-server-client-run-server-mismatch-"));
		const runStatePath = join(tempDirectory, "session.pi-server-runs.jsonl");
		const entries = baseTree().slice(0, 1);
		let streamPosts = 0;
		let statusRequests = 0;
		const originalServerUrl = process.env.PI_SERVER_URL;

		try {
			process.env.PI_SERVER_URL = "http://127.0.0.1:4217";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (path.startsWith("/api/session/durable-mismatch/runs/")) {
						statusRequests++;
						return new Response(JSON.stringify({ error: "stream run not found" }), {
							status: 404,
							headers: { "Content-Type": "application/json" },
						});
					}
					if (path === "/api/stream") {
						streamPosts++;
						return makeMockResponse([
							{ type: "start" },
							{
								type: "done",
								reason: "stop",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							},
						]);
					}
					return makeSessionResponse(body, {
						treeHash: hashEntries(entries),
						leafId: "u1",
						entryCount: 1,
						messageCount: 1,
						revision: 1,
					});
				}),
			);

			const context: Context = {
				systemPrompt: "You are helpful.",
				messages: [textMessage("one", 1000)],
			};
			const initialStream = await streamPiServer(testModel, context, {
				sessionId: "durable-mismatch",
				sessionTree: { entries, leafId: "u1" },
				temperature: 0.25,
				piServerRunStatePath: runStatePath,
			});
			await initialStream.result();
			expect(streamPosts).toBe(1);

			resetAllSessionTracking();
			streamPosts = 0;
			process.env.PI_SERVER_URL = "http://127.0.0.1:4218";
			const resumedStream = await streamPiServer(testModel, context, {
				sessionId: "durable-mismatch",
				sessionTree: {
					entries,
					leafId: "u1",
				},
				temperature: 0.25,
				piServerRunStatePath: runStatePath,
			});
			const result = await resumedStream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("pi-server no longer has durable journal");
			expect(streamPosts).toBe(0);
			expect(statusRequests).toBe(1);
		} finally {
			resetAllSessionTracking();
			if (originalServerUrl === undefined) {
				delete process.env.PI_SERVER_URL;
			} else {
				process.env.PI_SERVER_URL = originalServerUrl;
			}
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	});

	it("cancels the server run with an independent signal when the caller aborts", async () => {
		const entries = baseTree().slice(0, 1);
		const abortController = new AbortController();
		let streamBody: JsonObject | undefined;
		let cancelBody: JsonObject | undefined;
		let cancelSignal: AbortSignal | null | undefined;
		let cancelSignalWasAborted: boolean | undefined;
		let cancelReplayUrl: URL | undefined;
		let streamPosts = 0;
		let notifyStreamStarted: (() => void) | undefined;
		const streamStarted = new Promise<void>((resolve) => {
			notifyStreamStarted = resolve;
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const parsedUrl = new URL(url);
				const path = parsedUrl.pathname;
				const body = parseJsonObject((init?.body as string | undefined) ?? "");

				if (path.endsWith("/events")) {
					cancelReplayUrl = parsedUrl;
					return makeMockResponse([
						{
							type: "error",
							reason: "aborted",
							errorMessage: "Request aborted by user",
							usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
						},
					]);
				}
				if (path === "/api/session/run/cancel") {
					cancelBody = body;
					cancelSignal = init?.signal;
					cancelSignalWasAborted = init?.signal?.aborted;
					return new Response(JSON.stringify({ canceled: true, status: "failed" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (path === "/api/stream") {
					streamPosts++;
					streamBody = body;
					notifyStreamStarted?.();
					return new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						if (!signal) {
							reject(new Error("stream request did not include an AbortSignal"));
							return;
						}
						const rejectAbort = () => {
							reject(signal.reason ?? new DOMException("Request aborted by user", "AbortError"));
						};
						if (signal.aborted) {
							rejectAbort();
						} else {
							signal.addEventListener("abort", rejectAbort, { once: true });
						}
					});
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "stream-abort-cancel",
				sessionTree: { entries, leafId: "u1" },
				signal: abortController.signal,
			},
		);
		await streamStarted;
		abortController.abort();
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(cancelBody).toEqual({
			sessionId: "stream-abort-cancel",
			runId: streamBody?.runId,
		});
		expect(cancelSignal).not.toBe(abortController.signal);
		expect(cancelSignalWasAborted).toBe(false);
		expect(cancelSignal?.aborted).toBe(false);
		expect(cancelReplayUrl?.searchParams.get("from")).toBe("0");
		expect(cancelReplayUrl?.pathname).toContain(String(streamBody?.runId));
		expect(streamPosts).toBe(1);
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
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					return new Response(
						JSON.stringify({
							protocolVersion: 2,
							sessionId: "chunk-timeout",
							staticContextHash: "0".repeat(64),
							treeHash: hashEntries(entries),
							messageCount: 1,
							entryCount: 1,
							leafId: "u1",
							revision: 1,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 0 });
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
		expect(chunkTargets).toContain("/api/session/tree/append");
		const streamBody = capturedBodies.find((request) => request.url.endsWith("/api/stream"))?.body;
		expect((streamBody?.options as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(1);
		expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
	});

	it("reports HTML stream proxy failures with response details", async () => {
		vi.useFakeTimers();
		const entries = baseTree().slice(0, 1);
		let streamBody: JsonObject | undefined;
		let streamPosts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;

				if (path === "/api/stream") {
					streamPosts++;
					streamBody = body;
					return new Response("<html>Bad gateway</html>", {
						status: 502,
						statusText: "Bad Gateway",
						headers: { "Content-Type": "text/html" },
					});
				}
				if (path.endsWith("/events")) {
					return new Response("<html>Bad gateway</html>", {
						status: 502,
						statusText: "Bad Gateway",
						headers: { "Content-Type": "text/html" },
					});
				}
				if (path.includes("/runs/")) {
					const runId = path.split("/").pop();
					if (!runId || !streamBody) throw new Error("Expected stream body before recovery");
					return makeRunStatusResponse(
						"html-stream-failure",
						runId,
						getStreamRequestMac(streamBody),
						"running",
						0,
					);
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
			}),
		);

		const stream = await streamPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [textMessage("one", 1000)] },
			{
				sessionId: "html-stream-failure",
				sessionTree: { entries, leafId: "u1" },
				piServerRecoveryWindowMs: 1000,
			},
		);
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(1001);
		const result = await resultPromise;
		expect(result.errorMessage).toContain("502 Bad Gateway");
		expect(result.errorMessage).toContain("content-type: text/html");
		expect(result.errorMessage).toContain("body excerpt: <html>Bad gateway</html>");
		expect(result.errorMessage).not.toContain("Unexpected token");
		expect(result.diagnostics?.[0]?.details?.phase).toBe("provider_stream");
		expect(streamPosts).toBe(1);
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

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 1 });
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
			"/api/session/tree/append",
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

				if (url.endsWith("/api/session/init")) {
					return makeSessionResponse(body);
				}

				if (url.endsWith("/api/request/chunk")) {
					if (typeof body.chunkIndex !== "number" || typeof body.totalChunks !== "number") {
						throw new Error("Chunk request is missing numeric index/total");
					}
					if (body.chunkIndex !== body.totalChunks - 1) {
						return new Response(
							JSON.stringify({
								received: true,
								requestId: body.requestId,
								chunkIndex: body.chunkIndex,
								totalChunks: body.totalChunks,
							}),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}

				return new Response(
					JSON.stringify({
						protocolVersion: 2,
						sessionId: "chunk-tree",
						staticContextHash: "0".repeat(64),
						treeHash: hashEntries(entries),
						messageCount: 1,
						entryCount: 1,
						leafId: "u1",
						revision: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await syncPiServerTree(
			"chunk-tree",
			{ systemPrompt: "You are helpful.", messages: [] },
			{ entries, leafId: "u1", replace: true },
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
					return new Response(compactResponse(body, entries, serverEntry), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{
				sessionId: "compact-tree",
				apiKey: "sk-client",
				env: { TEST_REGION: "test-region" },
				retry: { enabled: true, maxRetries: 4, baseDelayMs: 25 },
				sessionTree: { entries, leafId: "u2" },
			},
		);

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/session/init",
			"/api/session/tree/append",
			"/api/session/compact",
		]);
		expect(capturedBodies[1].body.entries).toEqual(entries);
		expect(capturedBodies[2].body.protocolVersion).toBe(2);
		expect(capturedBodies[2].body.operationId).toEqual(expect.any(String));
		expect(capturedBodies[2].body.retry).toEqual({ enabled: true, maxRetries: 4, baseDelayMs: 25 });
		expect(capturedBodies[2].body.options).toMatchObject({ env: { TEST_REGION: "test-region" } });
	});

	it("uses compact tree patches when the server returns a delta response", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree();
		const serverEntry = compactionEntry("c1", "u2", "summary", "u2");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					return new Response(JSON.stringify(compactV2ResponseBody(body, entries, serverEntry)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-tree-delta", apiKey: "sk-client", sessionTree: { entries, leafId: "u2" } },
		);

		const compactBody = capturedBodies.find((request) => request.url.endsWith("/api/session/compact"))?.body;
		expect(compactBody?.baseTreeHash).toBe(hashEntries(entries));
		expect(result.entries).toEqual([...entries, serverEntry]);
		expect(result.leafId).toBe("c1");
	});

	it("derives compact results from the authoritative protocol v2 entry and preserves retained metadata", async () => {
		const entries = baseTree();
		const retainedTail = [textMessage("retained split-turn tail", 5000)];
		const usage = {
			input: 4,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0.4, output: 0.2, cacheRead: 0.1, cacheWrite: 0, total: 0.7 },
		};
		const serverEntry: SessionTreeEntry = {
			...compactionEntry("c1", "u2", "authoritative summary", "u2"),
			retainedTail,
			details: { source: "server" },
			usage,
		};
		let compactBody: JsonObject | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					compactBody = body;
					return new Response(JSON.stringify(compactV2ResponseBody(body, entries, serverEntry)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-v2-authoritative", sessionTree: { entries, leafId: "u2" } },
		);

		expect(compactBody?.protocolVersion).toBe(2);
		expect(result.compaction).toMatchObject({
			summary: "authoritative summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			retainedTail,
			details: { source: "server" },
			usage,
		});
		expect(result.compactionEntry).toEqual(serverEntry);
		expect(result.entries).toEqual([...entries, serverEntry]);
		expect(result.leafId).toBe("c1");
		expect(result.messages.at(-1)).toEqual(retainedTail[0]);
	});

	it.each([
		[
			"legacy response",
			(body: JsonObject) => {
				const legacy = { ...body };
				delete legacy.protocolVersion;
				return legacy;
			},
			"unsupported pi-server protocol version: missing",
		],
		[
			"wrong baseTreeHash",
			(body: JsonObject) => ({
				...body,
				treePatch: { ...(body.treePatch as JsonObject), baseTreeHash: "0".repeat(64) },
			}),
			"baseTreeHash did not match",
		],
		[
			"wrong entriesFrom",
			(body: JsonObject) => ({
				...body,
				treePatch: { ...(body.treePatch as JsonObject), entriesFrom: 0 },
			}),
			"entriesFrom did not match",
		],
		[
			"multiple entries",
			(body: JsonObject) => {
				const patch = body.treePatch as JsonObject;
				const entries = patch.entries as SessionTreeEntry[];
				return { ...body, treePatch: { ...patch, entries: [...entries, ...entries] } };
			},
			"exactly one compaction entry",
		],
		[
			"wrong parentId",
			(body: JsonObject) => {
				const patch = body.treePatch as JsonObject;
				const [entry] = patch.entries as SessionTreeEntry[];
				return { ...body, treePatch: { ...patch, entries: [{ ...entry, parentId: "wrong-parent" }] } };
			},
			"parentId did not match",
		],
		[
			"wrong leafId",
			(body: JsonObject) => ({
				...body,
				treePatch: { ...(body.treePatch as JsonObject), leafId: "wrong-leaf" },
			}),
			"leafId did not match",
		],
		[
			"wrong treeHash",
			(body: JsonObject) => ({
				...body,
				treePatch: { ...(body.treePatch as JsonObject), treeHash: "0".repeat(64) },
			}),
			"treeHash did not match",
		],
	] as const)("rejects a compact v2 response with %s without retrying", async (_label, mutate, expectedError) => {
		const entries = baseTree();
		const serverEntry = compactionEntry("c1", "u2", "summary", "u2");
		let compactRequests = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					compactRequests++;
					const responseBody = mutate(compactV2ResponseBody(body, entries, serverEntry));
					return new Response(JSON.stringify(responseBody), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		await expect(
			compactPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [] },
				{ sessionId: `compact-invalid-${_label}`, sessionTree: { entries, leafId: "u2" } },
			),
		).rejects.toThrow(expectedError);
		expect(compactRequests).toBe(1);
	});

	it("requests streaming compaction and reads the result event", async () => {
		const capturedBodies: { url: string; body: JsonObject }[] = [];
		const entries = baseTree();
		const serverEntry = compactionEntry("c1", "u2", "summary", "u2");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				capturedBodies.push({ url, body });

				if (url.endsWith("/api/session/compact")) {
					return makeCompactEventStreamResponse(compactV2ResponseBody(body, entries, serverEntry));
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-tree-stream", apiKey: "sk-client", sessionTree: { entries, leafId: "u2" } },
		);

		const compactBody = capturedBodies.find((request) => request.url.endsWith("/api/session/compact"))?.body;
		expect(compactBody?.streamResponse).toBe(true);
		expect(result.entries).toEqual([...entries, serverEntry]);
		expect(result.leafId).toBe("c1");
	});

	it("parses one large compact result line from bounded fragments without repeated line copying", async () => {
		const entries = baseTree();
		const largeSummary = "压缩状态".repeat(128 * 1024);
		const serverEntry = compactionEntry("c1", "u2", largeSummary, "u2");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					return makeFragmentedCompactEventStreamResponse(compactV2ResponseBody(body, entries, serverEntry), 257);
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-fragmented-line", sessionTree: { entries, leafId: "u2" } },
		);

		expect(result.compaction.summary).toBe(largeSummary);
		expect(result.entries.at(-1)).toMatchObject({ id: "c1", summary: largeSummary });
	});

	it.each([
		["malformed event JSON", 'event: result\ndata: {"broken"\n\n', "text/event-stream", "invalid event-stream JSON"],
		["unexpected response type", "<html>proxy response</html>", "text/html", "expected JSON"],
	] as const)(
		"fails a compact protocol error for %s without entering recovery",
		async (_label, responseBody, contentType, expectedError) => {
			const entries = baseTree();
			let compactRequests = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (url.endsWith("/api/session/compact")) {
						compactRequests++;
						return new Response(responseBody, { status: 200, headers: { "Content-Type": contentType } });
					}
					return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
				}),
			);

			await expect(
				compactPiServer(
					testModel,
					{ systemPrompt: "You are helpful.", messages: [] },
					{
						sessionId: `compact-protocol-${_label}`,
						sessionTree: { entries, leafId: "u2" },
						piServerRecoveryWindowMs: 1,
					},
				),
			).rejects.toThrow(expectedError);
			expect(compactRequests).toBe(1);
		},
	);

	it.each([401, 403])("fails compact authentication HTTP %s without entering recovery", async (status) => {
		const entries = baseTree();
		let compactRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					compactRequests++;
					return new Response(JSON.stringify({ error: "authentication failed" }), {
						status,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		await expect(
			compactPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [] },
				{
					sessionId: `compact-auth-${status}`,
					sessionTree: { entries, leafId: "u2" },
					piServerRecoveryWindowMs: 1,
				},
			),
		).rejects.toThrow(String(status));
		expect(compactRequests).toBe(1);
	});

	it.each([
		["fetch failure", "fetch"],
		["event-stream EOF", "eof"],
	] as const)("reattaches to the same compact operation after an initial %s", async (_label, failureKind) => {
		const compactBodies: JsonObject[] = [];
		const entries = baseTree();
		const serverEntry = compactionEntry("c1", "u2", "summary", "u2");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					compactBodies.push(body);
					if (compactBodies.length === 1) {
						switch (failureKind) {
							case "fetch":
								throw new Error("fetch failed");
							case "eof":
								return new Response(": keep-alive\n\n", {
									status: 200,
									headers: { "Content-Type": "text/event-stream" },
								});
						}
					}
					return makeCompactEventStreamResponse(compactV2ResponseBody(body, entries, serverEntry));
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: `compact-recovery-${failureKind}`, sessionTree: { entries, leafId: "u2" } },
		);

		expect(result.compaction.summary).toBe("summary");
		expect(compactBodies).toHaveLength(2);
		expect(compactBodies[0].operationId).toEqual(expect.any(String));
		expect(compactBodies[1]).toEqual(compactBodies[0]);
	});

	it("keeps retrying the same compact operation through the server orphan grace window", async () => {
		vi.useFakeTimers();
		const operationIds: unknown[] = [];
		const entries = baseTree();

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					operationIds.push(body.operationId);
					throw new Error("socket lost");
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const compactPromise = compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-long-recovery", sessionTree: { entries, leafId: "u2" } },
		);
		let settled = false;
		void compactPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
		expect(settled).toBe(false);
		expect(operationIds.length).toBeGreaterThan(1);
		expect(new Set(operationIds).size).toBe(1);

		const rejection = expect(compactPromise).rejects.toThrow("Server compaction recovery exhausted");
		await vi.advanceTimersByTimeAsync(2);
		await rejection;
	});

	it("cancels the submitted compact operation with an independent signal", async () => {
		const controller = new AbortController();
		const entries = baseTree();
		let compactBody: JsonObject | undefined;
		let cancelBody: JsonObject | undefined;
		let cancelSignal: AbortSignal | null | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact/cancel")) {
					cancelBody = body;
					cancelSignal = init?.signal;
					const terminal = {
						protocolVersion: 2,
						sessionId: body.sessionId,
						operationId: body.operationId,
						requestHash: body.requestHash,
						status: "failed",
						httpStatus: 499,
						operationDisposition: "terminal",
						error: "Compaction cancelled",
					};
					return new Response(
						JSON.stringify({
							canceled: true,
							sessionId: body.sessionId,
							operationId: body.operationId,
							requestHash: body.requestHash,
							status: "failed",
							resultStatus: 499,
							terminal,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (url.endsWith("/api/session/compact/ack")) {
					return new Response(
						JSON.stringify({
							acknowledged: true,
							sessionId: body.sessionId,
							operationId: body.operationId,
							requestHash: body.requestHash,
							status: "failed",
							acknowledgedAt: Date.now(),
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (url.endsWith("/api/session/compact")) {
					compactBody = body;
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => {
								const error = new Error("aborted");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true },
						);
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const compactPromise = compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{
				sessionId: "compact-cancel",
				sessionTree: { entries, leafId: "u2" },
				signal: controller.signal,
			},
		);
		await vi.waitFor(() => expect(compactBody).toBeDefined());
		controller.abort();

		await expect(compactPromise).rejects.toMatchObject({ name: "AbortError", message: "Compaction cancelled" });
		expect(cancelBody).toEqual({
			sessionId: "compact-cancel",
			operationId: compactBody?.operationId,
			requestHash: compactRequestHash(compactBody ?? {}),
		});
		expect(cancelSignal).not.toBe(controller.signal);
		expect(cancelSignal?.aborted).toBe(false);
		expect(readPiServerPendingCompact(getCompactStatePathForTest("compact-cancel"))).toBeUndefined();
	});

	it("does not retry a terminal compact error and permits a new operation after durable acknowledgement", async () => {
		const entries = baseTree();
		let compactCount = 0;
		const operationIds: unknown[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				if (url.endsWith("/api/session/compact")) {
					compactCount++;
					operationIds.push(body.operationId);
					if (compactCount > 1) {
						return new Response(
							compactResponse(body, entries, compactionEntry("c-retry", "u2", "retry summary", "u2")),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					const requestHash = compactRequestHash(body);
					const terminal = {
						protocolVersion: 2,
						sessionId: body.sessionId,
						operationId: body.operationId,
						requestHash,
						status: "failed",
						httpStatus: 502,
						operationDisposition: "terminal",
						error: "summarizer failed",
					};
					return new Response(`event: error\ndata: ${JSON.stringify(terminal)}\n\n`, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				if (url.endsWith("/api/session/compact/ack")) {
					return new Response(
						JSON.stringify({
							acknowledged: true,
							sessionId: body.sessionId,
							operationId: body.operationId,
							requestHash: body.requestHash,
							status: "failed",
							acknowledgedAt: Date.now(),
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		await expect(
			compactPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [] },
				{ sessionId: "compact-terminal-error", sessionTree: { entries, leafId: "u2" } },
			),
		).rejects.toThrow("summarizer failed");
		expect(compactCount).toBe(1);
		expect(readPiServerPendingCompact(getCompactStatePathForTest("compact-terminal-error"))).toBeUndefined();

		const result = await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-terminal-error", sessionTree: { entries, leafId: "u2" } },
		);
		expect(result.compaction.summary).toBe("retry summary");
		expect(compactCount).toBe(2);
		expect(operationIds[1]).not.toBe(operationIds[0]);
	});

	it.each([400, 409])(
		"clears the durable compact marker only after an exact not-started HTTP %s proof",
		async (status) => {
			const entries = baseTree();
			const operationIds: unknown[] = [];

			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const body = parseJsonObject((init?.body as string | undefined) ?? "");
					if (url.endsWith("/api/session/compact")) {
						operationIds.push(body.operationId);
						if (operationIds.length === 1) {
							return new Response(
								JSON.stringify({
									protocolVersion: 2,
									sessionId: body.sessionId,
									operationId: body.operationId,
									requestHash: compactRequestHash(body),
									status: "rejected",
									httpStatus: status,
									operationDisposition: "not_started",
									error: "compaction rejected before operation begin",
								}),
								{
									status,
									headers: { "Content-Type": "application/json" },
								},
							);
						}
						return new Response(
							compactResponse(
								body,
								entries,
								compactionEntry(`c-not-started-${status}`, "u2", "fresh summary", "u2"),
							),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
				}),
			);

			const sessionId = `compact-not-started-${status}`;
			await expect(
				compactPiServer(
					testModel,
					{ systemPrompt: "You are helpful.", messages: [] },
					{ sessionId, sessionTree: { entries, leafId: "u2" } },
				),
			).rejects.toThrow("compaction rejected");
			expect(readPiServerPendingCompact(getCompactStatePathForTest(sessionId))).toBeUndefined();

			const result = await compactPiServer(
				testModel,
				{ systemPrompt: "You are helpful.", messages: [] },
				{ sessionId, sessionTree: { entries, leafId: "u2" } },
			);
			expect(result.compaction.summary).toBe("fresh summary");
			expect(operationIds).toHaveLength(2);
			expect(operationIds[1]).not.toBe(operationIds[0]);
		},
	);

	it("self-heals an ACK-lost compact after server journal pruning without another provider submission", async () => {
		const entries = baseTree();
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const sessionId = "compact-ack-lost-pruned";
		let compactPosts = 0;
		let recoveryGets = 0;
		let acknowledgementPosts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				if (path === "/api/session/compact") {
					compactPosts++;
					return new Response(
						compactResponse(body, entries, compactionEntry("c-ack-lost", "u2", "durable summary", "u2")),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (path.includes("/compactions/")) {
					recoveryGets++;
					return new Response(JSON.stringify({ error: "compaction operation not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (path === "/api/session/compact/ack") {
					acknowledgementPosts++;
					return new Response(JSON.stringify({ error: "compaction operation not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		const result = await compactPiServer(testModel, context, {
			sessionId,
			sessionTree: { entries, leafId: "u2" },
		});
		recordPiServerCompactionApplied(result);
		const statePath = getCompactStatePathForTest(sessionId);
		expect(readPiServerPendingCompact(statePath)?.observation?.kind).toBe("applied");

		resetAllSessionTracking();
		const recovered = await compactPiServerRaw(testModel, context, {
			sessionId,
			sessionTree: { entries: result.entries, leafId: result.leafId },
			piServerCompactStatePath: statePath,
		});
		expect(recovered.operationId).toBe(result.operationId);
		expect(recovered.compactionEntry).toEqual(result.compactionEntry);

		recordPiServerCompactionApplied(recovered);
		await acknowledgePiServerCompaction(recovered);
		expect(readPiServerPendingCompact(statePath)).toBeUndefined();
		expect(compactPosts).toBe(1);
		expect(recoveryGets).toBe(1);
		expect(acknowledgementPosts).toBe(1);
	});

	it("retains an unobserved compact marker and fails closed when the server journal is missing", async () => {
		const entries = baseTree();
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const sessionId = "compact-unobserved-missing";
		let compactPosts = 0;
		let recoveryGets = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				if (path === "/api/session/compact") {
					compactPosts++;
					return new Response(
						compactResponse(body, entries, compactionEntry("c-unobserved", "u2", "summary", "u2")),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (path.includes("/compactions/")) {
					recoveryGets++;
					return new Response(JSON.stringify({ error: "compaction operation not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		const result = await compactPiServer(testModel, context, {
			sessionId,
			sessionTree: { entries, leafId: "u2" },
		});
		const statePath = getCompactStatePathForTest(sessionId);
		expect(readPiServerPendingCompact(statePath)?.observation).toBeUndefined();

		resetAllSessionTracking();
		await expect(
			compactPiServerRaw(testModel, context, {
				sessionId,
				sessionTree: { entries, leafId: "u2" },
				piServerCompactStatePath: statePath,
			}),
		).rejects.toThrow("automatic provider resubmission is disabled");
		expect(readPiServerPendingCompact(statePath)?.operationId).toBe(result.operationId);
		expect(compactPosts).toBe(1);
		expect(recoveryGets).toBe(1);
	});

	it("rejects a tampered locally applied compact before contacting the server", async () => {
		const entries = baseTree();
		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		const sessionId = "compact-applied-tamper";
		let recoveryGets = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const body = parseJsonObject((init?.body as string | undefined) ?? "");
				const path = new URL(url).pathname;
				if (path === "/api/session/compact") {
					return new Response(compactResponse(body, entries, compactionEntry("c-tamper", "u2", "summary", "u2")), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (path.includes("/compactions/")) recoveryGets++;
				return makeSessionResponse(body, { leafId: body.leafId, entryCount: entries.length });
			}),
		);

		const result = await compactPiServer(testModel, context, {
			sessionId,
			sessionTree: { entries, leafId: "u2" },
		});
		recordPiServerCompactionApplied(result);
		const tamperedEntry = { ...result.compactionEntry, summary: "tampered summary" };

		resetAllSessionTracking();
		await expect(
			compactPiServerRaw(testModel, context, {
				sessionId,
				sessionTree: {
					entries: [...entries, tamperedEntry],
					leafId: tamperedEntry.id,
				},
				piServerCompactStatePath: getCompactStatePathForTest(sessionId),
			}),
		).rejects.toThrow("local applied tree does not match its durable observation");
		expect(recoveryGets).toBe(0);
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
					return makeSessionResponse(body, {
						treeHash: hashEntries(serverEntries),
						leafId: "a1",
						entryCount: serverEntries.length,
						messageCount: 2,
						revision: 1,
					});
				}

				if (new URL(url).pathname === "/api/session/compact-diverged/history") {
					return new Response(
						JSON.stringify({
							protocolVersion: 2,
							sessionId: "compact-diverged",
							staticContextHash: hashStaticContext(context),
							treeHash: hashEntries(serverEntries),
							messageCount: 2,
							entryCount: serverEntries.length,
							leafId: "a1",
							revision: 1,
							entries: serverEntries,
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
					return new Response(compactResponse(body, entries, serverEntry), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 6 });
			}),
		);

		await compactPiServer(
			testModel,
			{ systemPrompt: "You are helpful.", messages: [] },
			{ sessionId: "compact-pruned-tree", apiKey: "sk-client", sessionTree: { entries, leafId: "u3" } },
		);

		const treeAppend = capturedBodies.find((request) => request.url.endsWith("/api/session/tree/append"));
		expect(treeAppend).toBeDefined();
		const syncedEntries = treeAppend!.body.entries as Array<{ id: string; parentId: string | null }>;
		expect(syncedEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(syncedEntries.map((entry) => entry.parentId)).toEqual(entries.map((entry) => entry.parentId));
	});

	it("fails closed without rebuilding server state after an uncertain compact submission returns 404", async () => {
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
					return new Response(JSON.stringify({ error: "session not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				return makeSessionResponse(body, { leafId: body.leafId, entryCount: 3 });
			}),
		);

		const context: Context = { systemPrompt: "You are helpful.", messages: [] };
		await syncPiServerTree("compact-restart", context, { entries, leafId: "u2" });
		capturedBodies.length = 0;

		await expect(
			compactPiServer(testModel, context, {
				sessionId: "compact-restart",
				apiKey: "sk-client",
				sessionTree: { entries, leafId: "u2" },
			}),
		).rejects.toThrow("session not found");

		expect(capturedBodies.map((request) => new URL(request.url).pathname)).toEqual(["/api/session/compact"]);
		expect(compactCount).toBe(1);
		expect(capturedBodies[0].body.operationId).toEqual(expect.any(String));
	});
});
