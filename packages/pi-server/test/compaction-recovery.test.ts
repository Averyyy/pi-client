import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { compactLegacy, type SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	compactPiServer,
	resetAllSessionTracking,
	syncPiServerTree,
} from "../../coding-agent/src/core/pi-server-client.ts";
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
	const result = await compactPiServer(model, context, { sessionId: "lost", sessionTree: { entries, leafId: "u2" } });
	expect(result.entries).toEqual(getSession("lost")?.entries);
	expect(result.leafId).toBe(getSession("lost")?.leafId);
	expect(paths.filter((path) => path === "/api/session/compact")).toHaveLength(1);
	expect(paths.filter((path) => path.includes("/runs/"))).toHaveLength(1);
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});

it("reconciles a lost checkpoint after tracking reset and returns it without Nothing to compact", async () => {
	const options = { sessionId: "checkpoint", sessionTree: { entries, leafId: "u2" } };
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
		sessionTree: { entries: changed, leafId: "metadata" },
		onHistoryReconciled: reconciled,
	});
	expect(reconciled).toHaveBeenCalledTimes(1);
	expect(result.entries.slice(0, 2)).toEqual(entries);
	expect(result.entries.some((entry) => entry.id === "metadata")).toBe(false);
});

it("replays a completed run without compacting messages appended afterward", async () => {
	const sessionId = "replay";
	await syncPiServerTree(sessionId, context, { entries, leafId: "u2" });
	const body = { sessionId, runId: "same-run", model };
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
			sessionTree: { entries, leafId: "u2" },
		}),
	).rejects.toThrow("summarizer failed");
	expect(getSession("failed")?.leafId).toBe("u2");
	expect(compactLegacy).toHaveBeenCalledTimes(1);
});
