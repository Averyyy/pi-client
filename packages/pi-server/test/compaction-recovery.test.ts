import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import {
	buildLegacySessionContext,
	compactLegacy,
	convertToLlm,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type Message,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compactWithRequest } from "../../agent/src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import {
	compactPiServer,
	hashStaticContext,
	resetAllSessionTracking,
	syncPiServerTree,
} from "../../coding-agent/src/core/pi-server-client.ts";
import { hashPiServerProviderMessages as hashClientProviderMessages } from "../../coding-agent/src/core/pi-server-protocol.ts";
import { hashPiServerProviderMessages as hashServerProviderMessages } from "../src/pi-server-protocol.ts";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
	...(await importOriginal<typeof AgentCore>()),
	compactLegacy: vi.fn(async () => ({
		ok: true,
		value: {
			summary: "summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			retainedTail: [],
		},
	})),
}));

const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const context = { systemPrompt: "test", messages: [] };
const compactSettings = { enabled: true, reserveTokens: 100, keepRecentTokens: 1 };
const entries: SessionTreeEntry[] = ["u1", "u2"].map((id, index) => ({
	type: "message",
	id,
	parentId: index ? "u1" : null,
	timestamp: new Date(index).toISOString(),
	message: { role: "user", content: "test", timestamp: index },
}));
let server: Server;
let url: string;
let storeDir: string;
const realFetch = globalThis.fetch;

it("hashes provider messages as canonical JSON with a fixed SHA-256 size", () => {
	const first: Message = {
		role: "user",
		content: [{ type: "text", text: "request" }],
		timestamp: 1,
	};
	const sameWithDifferentKeyOrder: Message = {
		timestamp: 1,
		content: [{ text: "request", type: "text" }],
		role: "user",
	};
	const clientHash = hashClientProviderMessages([first]);
	expect(clientHash).toHaveLength(64);
	expect(clientHash).toBe(hashServerProviderMessages([sameWithDifferentKeyOrder]));
});

beforeEach(async () => {
	clearAllSessions();
	resetAllSessionTracking();
	vi.clearAllMocks();
	storeDir = mkdtempSync(join(tmpdir(), "pi-compact-recovery-"));
	server = createPiServer({ authToken: "", sessionStoreDir: storeDir });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	url = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("PI_SERVER_URL", url);
	vi.stubEnv("PI_SERVER_AUTH_TOKEN", "");
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	clearAllSessions();
	resetAllSessionTracking();
	rmSync(storeDir, { recursive: true, force: true });
});

it("recovers the exact committed compact result after a truncated response without another summary", async () => {
	const paths: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		paths.push(new URL(input).pathname);
		const response = await realFetch(input, init);
		if (input.endsWith("/api/session/compact")) {
			await response.text(); // Commit completed, but its result never reaches the client.
			return new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } });
		}
		return response;
	});
	const result = await compactPiServer(model, context, {
		sessionId: "lost",
		settings: compactSettings,
		sessionTree: { entries, leafId: "u2" },
	});
	expect(result.entries).toEqual(getSession("lost")?.entries);
	expect(result.leafId).toBe(getSession("lost")?.leafId);
	expect(paths.filter((path) => path === "/api/session/compact")).toHaveLength(1);
	expect(paths.filter((path) => path.includes("/runs/"))).toHaveLength(1);
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});

it("reconciles a lost checkpoint after tracking reset and returns it without Nothing to compact", async () => {
	const options = { sessionId: "checkpoint", settings: compactSettings, sessionTree: { entries, leafId: "u2" } };
	const first = await compactPiServer(model, context, options);
	// Reload the persisted checkpoint independently of the in-memory run journal.
	await new Promise<void>((resolve) => server.close(() => resolve()));
	clearAllSessions();
	server = createPiServer({ authToken: "", sessionStoreDir: storeDir });
	await new Promise<void>((resolve) => server.listen(Number(new URL(url).port), "127.0.0.1", resolve));
	resetAllSessionTracking();
	const reconciled = vi.fn();
	const second = await compactPiServer(model, context, { ...options, onHistoryReconciled: reconciled });
	expect(second.entries).toEqual(first.entries);
	expect(second.compactionEntry).toEqual(first.compactionEntry);
	expect(reconciled).toHaveBeenCalledTimes(1);
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});

it("validates known prefix contents instead of accepting modified entries with cached IDs", async () => {
	const sessionId = "modified-prefix";
	await syncPiServerTree(sessionId, context, { entries, leafId: "u2" });
	const changed = structuredClone(entries);
	const first = changed[0];
	if (first.type !== "message") throw new Error("Expected message");
	first.message = { role: "user", content: "changed by projection", timestamp: 0 };
	changed.push({
		type: "custom",
		id: "metadata",
		parentId: "u2",
		timestamp: new Date().toISOString(),
		customType: "test",
		data: {},
	});
	const reconciled = vi.fn();
	const result = await compactPiServer(model, context, {
		sessionId,
		settings: compactSettings,
		sessionTree: { entries: changed, leafId: "metadata" },
		onHistoryReconciled: reconciled,
	});
	expect(reconciled).toHaveBeenCalledTimes(1);
	expect(result.entries.slice(0, 2)).toEqual(entries);
	expect(result.entries.some((entry) => entry.id === "metadata")).toBe(false);
});

it("syncs context edits as raw entries and compacts their projected messages", async () => {
	const omitted: SessionTreeEntry = {
		type: "message",
		id: "u0",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "omit from context", timestamp: 0 },
	};
	const replaced: SessionTreeEntry = {
		type: "message",
		id: "u1",
		parentId: omitted.id,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "raw replacement", timestamp: 1 },
	};
	const omitEdit: SessionTreeEntry = {
		type: "context_edit",
		id: "omit-edit",
		parentId: replaced.id,
		timestamp: new Date(2).toISOString(),
		targetId: omitted.id,
		replacement: null,
	};
	const replaceEdit: SessionTreeEntry = {
		type: "context_edit",
		id: "replace-edit",
		parentId: omitEdit.id,
		timestamp: new Date(3).toISOString(),
		targetId: replaced.id,
		replacement: { content: "projected replacement" },
	};
	const kept: SessionTreeEntry = {
		type: "message",
		id: "u2",
		parentId: replaceEdit.id,
		timestamp: new Date(4).toISOString(),
		message: { role: "user", content: "keep after compact", timestamp: 4 },
	};
	const sessionId = "context-edit-compact";
	const tree = { entries: [omitted, replaced, omitEdit, replaceEdit, kept], leafId: kept.id };
	await syncPiServerTree(sessionId, context, tree);

	const result = await compactPiServer(model, context, {
		sessionId,
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		preparation: { firstKeptEntryId: kept.id },
		sessionTree: tree,
	});

	const compactCall = vi.mocked(compactLegacy).mock.calls[0];
	const preparation = compactCall?.[0];
	expect(preparation?.messagesToSummarize).toMatchObject([{ role: "user", content: "projected replacement" }]);
	expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("omit from context");
	expect(result.entries.map((entry) => entry.id)).toEqual([
		"u0",
		"u1",
		"omit-edit",
		"replace-edit",
		"u2",
		result.compactionEntry.id,
	]);
	const active = getSession(sessionId);
	expect(active?.messages[0]).toMatchObject({
		role: "user",
		content: [{ type: "text", text: expect.stringContaining("summary") }],
	});
	expect(active?.messages[1]?.content).toBe("keep after compact");
	expect(JSON.stringify(active?.messages)).not.toContain("omit from context");
	expect(JSON.stringify(active?.messages)).not.toContain("projected replacement");
});

it("uses exact compact prefixes with server static context and rejects divergent overlays", async () => {
	const compactBodies: Array<Record<string, unknown>> = [];
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0] | URL, init?: RequestInit) => {
		const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
		if (new URL(requestUrl).pathname === "/api/session/compact" && typeof init?.body === "string") {
			const parsed: unknown = JSON.parse(init.body);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				compactBodies.push(parsed as Record<string, unknown>);
			}
		}
		return realFetch(input, init);
	});
	const usage: Usage = {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const firstUser: SessionTreeEntry = {
		type: "message",
		id: "cache-first-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "old work", timestamp: 1 },
	};
	const previousAssistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "old response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 2,
	};
	const assistantEntry: SessionTreeEntry = {
		type: "message",
		id: "cache-assistant",
		parentId: firstUser.id,
		timestamp: new Date(2).toISOString(),
		message: previousAssistant,
	};
	const retainedUser: SessionTreeEntry = {
		type: "message",
		id: "cache-retained-user",
		parentId: assistantEntry.id,
		timestamp: new Date(3).toISOString(),
		message: { role: "user", content: "retained tail", timestamp: 3 },
	};
	const sessionTree = { entries: [firstUser, assistantEntry, retainedUser], leafId: retainedUser.id };
	const sessionId = "cache-prefix-compact";
	const staticTool = { name: "read", description: "Read files", parameters: {} };
	const staticContext = { systemPrompt: "Server session instructions", tools: [staticTool] };
	const compactContext = { ...staticContext, messages: [] };
	const cacheMessages = convertToLlm(buildLegacySessionContext(sessionTree.entries).messages);
	const cacheContextHash = hashClientProviderMessages(cacheMessages);
	const cacheStaticContextHash = hashStaticContext({ ...staticContext, messages: [] });
	const summaryRequests: Array<{ context: { messages: Message[] }; options: Record<string, unknown> }> = [];

	vi.mocked(compactLegacy).mockImplementationOnce(
		async (
			preparation,
			_models,
			requestModel,
			customInstructions,
			_signal,
			thinkingLevel,
			_retry,
			_callbacks,
			cacheContext,
			cacheOptions,
			cacheFallbackReason,
		) => {
			if (!cacheContext || !cacheOptions) throw new Error("Expected validated cache context");
			const result = await compactWithRequest(
				preparation,
				{
					model: requestModel,
					customInstructions,
					thinkingLevel,
					cacheContext,
					cacheOptions,
					cacheFallbackReason,
				},
				async (summaryContext, options) => {
					summaryRequests.push({ context: summaryContext, options: options as Record<string, unknown> });
					return fauxAssistantMessage("## Goal\nUpdated summary");
				},
				BACKGROUND_CONTEXT,
			);
			if (!result.ok) return result;
			return { ok: true, value: { ...result.value, firstKeptEntryId: preparation.firstKeptEntryId } };
		},
	);

	const result = await compactPiServer(model, compactContext, {
		sessionId,
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		cacheRetention: "long",
		sessionTree,
		cacheContextHash,
		cacheStaticContextHash,
	});

	const call = vi.mocked(compactLegacy).mock.calls[0];
	const preparation = call?.[0];
	expect(summaryRequests).toHaveLength(1);
	expect(summaryRequests[0]?.options).toMatchObject({ sessionId, cacheRetention: "long" });
	expect(summaryRequests[0]?.context.messages.filter((message) => message.role === "system")).toHaveLength(1);
	expect(summaryRequests[0]?.context.messages[0]).toMatchObject({
		role: "system",
		content: "Server session instructions",
		toolsAdded: [{ name: "read", description: "Read files" }],
	});
	expect(summaryRequests[0]?.context.messages.at(-1)?.role).toBe("user");
	expect(result.compaction.details).toMatchObject({ cachePath: { mode: "exact_prefix" } });
	expect(compactBodies[0]).not.toHaveProperty("cacheContext");
	expect(compactBodies[0]?.cacheContextHash).toMatch(/^[a-f0-9]{64}$/);
	expect(compactBodies[0]?.cacheStaticContextHash).toMatch(/^[a-f0-9]{64}$/);
	expect(JSON.stringify(compactBodies[0])).not.toContain("old work");
	expect(preparation?.cachePrefixMessages?.map((message) => JSON.stringify(message)).join("\n")).toContain("old work");
	expect(JSON.stringify(preparation?.cachePrefixMessages)).not.toContain("retained tail");

	const divergentSessionId = "cache-prefix-divergence";
	vi.mocked(compactLegacy).mockImplementationOnce(
		async (
			preparation,
			_models,
			_requestModel,
			_custom,
			_signal,
			_thinking,
			_retry,
			_callbacks,
			cacheContext,
			cacheOptions,
			cacheFallbackReason,
		) => {
			expect(cacheContext).toBeUndefined();
			expect(cacheOptions?.sessionId).toBe(divergentSessionId);
			expect(cacheFallbackReason).toBe("request_context_digest_mismatch");
			return {
				ok: true,
				value: {
					summary: "chunked summary",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					retainedTail: preparation.retainedTail,
					details: { cachePath: { mode: "chunked", reason: cacheFallbackReason ?? "unknown" } },
				},
			};
		},
	);
	const divergentMessages = structuredClone(cacheMessages);
	const first = divergentMessages[0];
	if (!first || first.role !== "user") throw new Error("Expected provider user message");
	first.content = "changed prompt";
	const divergent = await compactPiServer(model, compactContext, {
		sessionId: divergentSessionId,
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		sessionTree: { entries: sessionTree.entries, leafId: sessionTree.leafId },
		cacheContextHash: hashClientProviderMessages(divergentMessages),
		cacheStaticContextHash,
	});
	const mismatchCall = vi.mocked(compactLegacy).mock.calls[1];
	expect(mismatchCall?.[8]).toBeUndefined();
	expect(mismatchCall?.[10]).toBe("request_context_digest_mismatch");
	expect(divergent.compaction.details).toMatchObject({
		cachePath: { mode: "chunked", reason: "request_context_digest_mismatch" },
	});
	expect(compactBodies[1]).not.toHaveProperty("cacheContext");
});

it("stores the effective system prompt and tools on a remote compaction checkpoint", async () => {
	const system: SessionTreeEntry = {
		type: "message",
		id: "system-entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "system",
			content: "tree prompt",
			toolsAdded: [{ name: "read", description: "read", parameters: {} }],
			timestamp: 0,
		},
	};
	const user: SessionTreeEntry = {
		type: "message",
		id: "system-user",
		parentId: "system-old",
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "request", timestamp: 1 },
	};
	const oldUser: SessionTreeEntry = {
		type: "message",
		id: "system-old",
		parentId: system.id,
		timestamp: new Date(0, 0, 1).toISOString(),
		message: { role: "user", content: "old request", timestamp: 0 },
	};
	const sessionId = "system-checkpoint-compact";
	const tree = { entries: [system, oldUser, user], leafId: user.id };
	await syncPiServerTree(sessionId, context, tree);
	await compactPiServer(model, context, {
		sessionId,
		settings: compactSettings,
		preparation: { firstKeptEntryId: user.id },
		sessionTree: tree,
	});

	const checkpoint = getSession(sessionId)?.entries.at(-1);
	expect(checkpoint).toMatchObject({
		type: "compaction",
		systemMessage: {
			role: "system",
			content: "tree prompt",
			toolsAdded: [{ name: "read" }],
		},
	});
	expect(getSession(sessionId)?.messages[0]).toMatchObject({
		role: "system",
		content: "tree prompt",
		toolsAdded: [{ name: "read" }],
	});
});

it("replays a completed run without compacting messages appended afterward", async () => {
	const sessionId = "replay";
	await syncPiServerTree(sessionId, context, { entries, leafId: "u2" });
	const body = { sessionId, runId: "same-run", model, settings: compactSettings };
	const firstResponse = await fetch(`${url}/api/session/compact`, { method: "POST", body: JSON.stringify(body) });
	const first: unknown = await firstResponse.json();
	const session = getSession(sessionId);
	if (!session) throw new Error("Missing session");
	resetAllSessionTracking();
	await syncPiServerTree(sessionId, context, {
		entries: [
			...session.entries,
			{
				type: "message",
				id: "later",
				parentId: session.leafId,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "later", timestamp: 3 },
			},
		],
		leafId: "later",
	});
	const replay = await fetch(`${url}/api/session/compact`, { method: "POST", body: JSON.stringify(body) });
	expect(await replay.json()).toEqual(first);
	expect(getSession(sessionId)?.leafId).toBe("later");
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});

it("preserves summarizer failures instead of treating them as recovered compactions", async () => {
	vi.mocked(compactLegacy).mockRejectedValueOnce(new Error("summarizer failed"));
	await expect(
		compactPiServer(model, context, {
			sessionId: "failed",
			settings: compactSettings,
			sessionTree: { entries, leafId: "u2" },
		}),
	).rejects.toThrow("summarizer failed");
	expect(getSession("failed")?.leafId).toBe("u2");
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});
