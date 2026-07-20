import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { compact as compactAgentCore } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { registerFauxProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer, resolveStreamOptions, type ServerConfig } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof AgentCore>();
	return {
		...actual,
		compact: vi.fn(async () => ({
			ok: true,
			value: {
				summary: "summary",
				firstKeptEntryId: "u2",
				tokensBefore: 10,
			},
		})),
	};
});

interface ServerResponse {
	status?: string;
	version?: string;
	sessionId?: string;
	staticContextHash?: string;
	treeHash?: string;
	messageCount?: number;
	entryCount?: number;
	leafId?: string | null;
	revision?: number;
	sessions?: {
		sessionId: string;
		treeHash?: string;
		messageCount: number;
		entryCount: number;
		leafId: string | null;
		revision: number;
		createdAt: number;
		updatedAt: number;
	}[];
	error?: string;
	deleted?: string;
	dropped?: boolean;
	staticContext?: { systemPrompt?: string };
	messages?: Message[];
	entries?: unknown[];
	baseMessageCount?: number;
	compactionEntry?: unknown;
	treePatch?: {
		baseTreeHash?: string;
		entriesFrom: number;
		baseRevision?: number;
		entries: unknown[];
		leafId: string | null;
		revision: number;
	};
}

interface RunResponse {
	status?: "running" | "completed" | "failed";
	message?: Message;
	error?: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("pi-server HTTP", () => {
	let server: Server;
	let baseUrl: string;
	let sessionStoreDir: string;
	let uploadDir: string;

	beforeEach(() => {
		clearAllSessions();
		sessionStoreDir = mkdtempSync(join(tmpdir(), "pi-server-http-sessions-"));
		uploadDir = join(sessionStoreDir, "uploads");
		server = createPiServer({ authToken: "test-token", sessionStoreDir, uploadDir } as Partial<ServerConfig>);
		server.listen(0);
		const addr = server.address();
		if (typeof addr === "object" && addr !== null) {
			baseUrl = `http://127.0.0.1:${addr.port}`;
		} else {
			throw new Error("Failed to get server address");
		}
	});

	afterEach(() => {
		return new Promise<void>((resolve) => {
			server.close(() => {
				rmSync(sessionStoreDir, { recursive: true, force: true });
				resetApiProviders();
				resolve();
			});
		});
	});

	async function restartServer(): Promise<void> {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		clearAllSessions();
		server = createPiServer({ authToken: "test-token", sessionStoreDir, uploadDir } as Partial<ServerConfig>);
		server.listen(0);
		const addr = server.address();
		if (typeof addr !== "object" || addr === null) {
			throw new Error("Failed to get restarted server address");
		}
		baseUrl = `http://127.0.0.1:${addr.port}`;
	}

	it("responds to health check", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.status).toBe("ok");
	});

	it("includes the package version with an unauthorized root response", async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(401);
		const body = (await res.json()) as ServerResponse;
		expect(body.error).toBe("Unauthorized");
		expect(body.version).toMatch(/^\d+\.\d+\.\d+-piclient\.\d+$/);
	});

	it("rejects requests without auth token when configured", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "test" }),
		});
		expect(res.status).toBe(401);
	});

	it("accepts requests with correct auth token", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "test-auth" }),
		});
		expect(res.status).toBe(200);
	});

	it("initializes session with static context", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "test-init",
				staticContext: {
					systemPrompt: "You are helpful.",
					tools: [],
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.sessionId).toBe("test-init");
		expect(body.staticContextHash).toBeTruthy();
		expect(body.messageCount).toBe(0);
	});

	it("reassembles chunked requests and dispatches them to the target endpoint", async () => {
		const originalBody = {
			name: "chunked-upload",
			entries: [
				{ path: "", type: "directory" },
				{ path: "nested", type: "directory" },
				{ path: "nested/file.txt", type: "file", data: Buffer.from("hello").toString("base64") },
			],
		};
		const encoded = Buffer.from(JSON.stringify(originalBody), "utf-8").toString("base64");
		const midpoint = Math.ceil(encoded.length / 2);
		const requestId = "request-1";
		const firstChunk = encoded.slice(0, midpoint);
		const secondChunk = encoded.slice(midpoint);

		const first = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				requestId,
				target: "/api/receive",
				chunkIndex: 0,
				totalChunks: 2,
				sha256: sha256(firstChunk),
				chunk: firstChunk,
			}),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ received: true, requestId, chunkIndex: 0, totalChunks: 2 });

		const second = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				requestId,
				target: "/api/receive",
				chunkIndex: 1,
				totalChunks: 2,
				sha256: sha256(secondChunk),
				chunk: secondChunk,
			}),
		});
		expect(second.status).toBe(200);

		const responseBody = (await second.json()) as { path: string; files: number };
		expect(responseBody.path).toBe(join(uploadDir, "chunked-upload"));
		expect(responseBody.files).toBe(1);
		expect(readFileSync(join(uploadDir, "chunked-upload", "nested", "file.txt"), "utf-8")).toBe("hello");
	});

	it("rejects receive paths that could escape the upload directory", async () => {
		const res = await fetch(`${baseUrl}/api/receive`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({
				name: "unsafe",
				entries: [
					{ path: "", type: "directory" },
					{ path: "../outside", type: "file", data: "" },
				],
			}),
		});
		expect(res.status).toBe(400);
		expect(existsSync(join(sessionStoreDir, "outside"))).toBe(false);
	});

	it("receives a single file", async () => {
		const res = await fetch(`${baseUrl}/api/receive`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({
				name: "file.txt",
				entries: [{ path: "", type: "file", data: Buffer.from("hello").toString("base64") }],
			}),
		});
		expect(res.status).toBe(200);
		expect(readFileSync(join(uploadDir, "file.txt"), "utf-8")).toBe("hello");
	});

	it("syncs a replaced local message history", async () => {
		const messages = [
			{ role: "user" as const, content: "new branch", timestamp: 1000 },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "branch answer" }],
				api: "openai-completions" as const,
				provider: "opencode-go" as const,
				model: "glm-5.1",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 2000,
			},
		];

		const res = await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "sync-history",
				messages,
				staticContext: { systemPrompt: "Synced system prompt" },
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.messageCount).toBe(2);
		expect(getSession("sync-history")?.messages).toEqual(messages);
		expect(getSession("sync-history")?.staticContext?.systemPrompt).toBe("Synced system prompt");
	});

	it("returns full session history without a request body", async () => {
		const messages: Message[] = [
			{ role: "user", content: "large local history", timestamp: 1000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "stored on server" }],
				api: "openai-completions",
				provider: "opencode-go",
				model: "glm-5.1",
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
		];

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "full-history",
				messages,
				staticContext: { systemPrompt: "History system prompt" },
			}),
		});

		const res = await fetch(`${baseUrl}/api/session/full-history/history`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.sessionId).toBe("full-history");
		expect(body.messageCount).toBe(2);
		expect(body.staticContext?.systemPrompt).toBe("History system prompt");
		expect(body.messages).toEqual(messages);
	});

	it("returns session history after the requested message offset", async () => {
		const messages: Message[] = [
			{ role: "user", content: "one", timestamp: 1000 },
			{ role: "user", content: "two", timestamp: 2000 },
			{ role: "user", content: "three", timestamp: 3000 },
		];

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "delta-history", messages }),
		});

		const res = await fetch(`${baseUrl}/api/session/delta-history/history?from=1`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.messageCount).toBe(3);
		expect(body.baseMessageCount).toBe(1);
		expect(body.messages).toEqual(messages.slice(1));
	});

	it("returns session history tree patch after the requested entry offset and revision", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "two", timestamp: 2000 },
			},
		];
		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "entry-delta-history", entries, leafId: "u2" }),
		});
		const syncBody = (await sync.json()) as ServerResponse;

		const res = await fetch(
			`${baseUrl}/api/session/entry-delta-history/history?entriesFrom=1&revision=${syncBody.revision}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.entries).toBeUndefined();
		expect(body.treePatch?.entriesFrom).toBe(1);
		expect(body.treePatch?.baseRevision).toBe(1);
		expect(body.treePatch?.entries).toEqual([entries[1]]);
		expect(body.treePatch?.revision).toBe(body.revision);
	});

	it("returns compact tree patch when the client base tree hash matches", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "old", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "keep", timestamp: 2000 },
			},
		];
		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-delta", entries, leafId: "u2" }),
		});
		const syncBody = (await sync.json()) as ServerResponse;

		const res = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "compact-delta",
				baseTreeHash: syncBody.treeHash,
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.entries).toBeUndefined();
		expect(body.messages).toBeUndefined();
		expect(body.treePatch?.baseTreeHash).toBe(syncBody.treeHash);
		expect(body.treePatch?.entriesFrom).toBe(2);
		expect(body.treePatch?.entries).toHaveLength(1);
		expect(body.treePatch?.leafId).toBe(body.leafId);
		expect(body.entryCount).toBe(3);
	});

	it("streams compact heartbeat before upstream compaction finishes", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "old", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-stream", entries, leafId: "u2" }),
		});

		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCompact = resolve;
				}),
		);

		const res = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "compact-stream",
				streamResponse: true,
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.body).toBeTruthy();

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for compact heartbeat")), 1000),
			),
		]);
		if (firstChunk.done) {
			throw new Error("Compact heartbeat stream ended before sending data");
		}
		const chunks = [decoder.decode(firstChunk.value)];
		expect(chunks[0]).toContain(": keep-alive");

		if (!resolveCompact) {
			throw new Error("Compact mock did not start");
		}
		resolveCompact({
			ok: true,
			value: {
				summary: "summary",
				firstKeptEntryId: "u2",
				tokensBefore: 10,
			},
		});

		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			chunks.push(decoder.decode(chunk.value));
		}

		const body = chunks.join("");
		expect(body).toContain("event: result");
		expect(body).toContain('"success":true');
		expect(body).toContain('"summary":"summary"');
	});

	it("keeps JSON compact clients alive with whitespace heartbeat bytes", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "old", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "keep", timestamp: 2000 },
			},
		];
		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-json-stream", entries, leafId: "u2" }),
		});
		const syncBody = (await sync.json()) as ServerResponse;

		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCompact = resolve;
				}),
		);

		const res = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "compact-json-stream",
				baseTreeHash: syncBody.treeHash,
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.body).toBeTruthy();

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for JSON compact heartbeat")), 1000),
			),
		]);
		if (firstChunk.done) {
			throw new Error("JSON compact stream ended before sending data");
		}
		const chunks = [decoder.decode(firstChunk.value)];
		expect(chunks[0].trim()).toBe("");

		if (!resolveCompact) {
			throw new Error("Compact mock did not start");
		}
		resolveCompact({
			ok: true,
			value: {
				summary: "summary",
				firstKeptEntryId: "u2",
				tokensBefore: 10,
			},
		});

		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			chunks.push(decoder.decode(chunk.value));
		}

		const body = JSON.parse(chunks.join("")) as ServerResponse;
		expect(body.treePatch?.baseTreeHash).toBe(syncBody.treeHash);
		expect(body.treePatch?.entries).toHaveLength(1);
		expect(body.entryCount).toBe(3);
	});

	it("lists active sessions with summary counts", async () => {
		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "listed-a",
				messages: [{ role: "user", content: "one", timestamp: 1000 }],
			}),
		});
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "listed-b", staticContext: { systemPrompt: "B" } }),
		});

		const res = await fetch(`${baseUrl}/api/sessions`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.sessions?.map((session) => session.sessionId).sort()).toEqual(["listed-a", "listed-b"]);
		expect(body.sessions?.find((session) => session.sessionId === "listed-a")).toMatchObject({
			messageCount: 1,
			entryCount: 1,
			revision: 1,
		});
		expect(body.sessions?.every((session) => typeof session.updatedAt === "number")).toBe(true);
	});

	it("appends client-only messages without replacing server history", async () => {
		const first: Message = { role: "user", content: "server base", timestamp: 1000 };
		const second: Message = { role: "user", content: "client delta", timestamp: 2000 };

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "append-history", messages: [first] }),
		});

		const res = await fetch(`${baseUrl}/api/session/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "append-history", messages: [second] }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.messageCount).toBe(2);
		expect(getSession("append-history")?.messages).toEqual([first, second]);
	});

	it("persists appended session history across server restarts", async () => {
		const first: Message = { role: "user", content: "before restart", timestamp: 1000 };
		const second: Message = { role: "user", content: "after append", timestamp: 2000 };

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "append-restart", messages: [first] }),
		});
		await fetch(`${baseUrl}/api/session/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "append-restart", messages: [second] }),
		});

		await restartServer();

		const history = await fetch(`${baseUrl}/api/session/append-restart/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(history.status).toBe(200);
		const historyBody = (await history.json()) as ServerResponse;
		expect(historyBody.messages).toEqual([first, second]);
	});

	it("switches active history by tree leaf without replacing the stored tree", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
					api: "openai-completions",
					provider: "opencode-go",
					model: "glm-5.1",
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
			},
			{
				type: "message",
				id: "u2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user", content: "two", timestamp: 3000 },
			},
		];

		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "tree-http", entries, leafId: "u2" }),
		});

		const res = await fetch(`${baseUrl}/api/session/tree/switch`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "tree-http", leafId: "a1" }),
		});

		expect(res.status).toBe(200);
		const switchBody = (await res.json()) as ServerResponse;
		expect(switchBody.leafId).toBe("a1");
		expect(switchBody.entryCount).toBe(3);
		expect(switchBody.messageCount).toBe(2);

		const history = await fetch(`${baseUrl}/api/session/tree-http/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const historyBody = (await history.json()) as ServerResponse;
		expect(historyBody.entries).toEqual(entries);
		expect(historyBody.messages?.map((message) => message.content)).toEqual([
			"one",
			[{ type: "text", text: "first answer" }],
		]);
	});

	it("persists a synced session tree by session id across server restarts", async () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "persist me", timestamp: 1000 },
			},
		];

		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "persisted-tree",
				entries,
				leafId: "u1",
				staticContext: { systemPrompt: "Persisted" },
			}),
		});
		expect(sync.status).toBe(200);
		const syncBody = (await sync.json()) as ServerResponse;
		expect(syncBody.treeHash).toBeTruthy();

		await restartServer();

		const history = await fetch(`${baseUrl}/api/session/persisted-tree/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(history.status).toBe(200);
		const historyBody = (await history.json()) as ServerResponse;
		expect(historyBody.staticContext?.systemPrompt).toBe("Persisted");
		expect(historyBody.treeHash).toBe(syncBody.treeHash);
		expect(historyBody.entries).toEqual(entries);
		expect(historyBody.messages?.map((message) => message.content)).toEqual(["persist me"]);
	});

	it("returns 404 when full session history is missing", async () => {
		const res = await fetch(`${baseUrl}/api/session/missing-history/history`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as ServerResponse;
		expect(body.error).toContain("session not found");
		expect(getSession("missing-history")).toBeUndefined();
	});

	it("drops only the last assistant error message", async () => {
		const errorMessage = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider: "opencode-go" as const,
			model: "glm-5.1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "retryable",
			timestamp: 2000,
		};

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "drop-error",
				messages: [{ role: "user", content: "hello", timestamp: 1000 }, errorMessage],
			}),
		});

		const res = await fetch(`${baseUrl}/api/session/drop-last-assistant-error`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "drop-error" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.dropped).toBe(true);
		expect(body.messageCount).toBe(1);
		expect(getSession("drop-error")?.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("does not create a session when dropping a missing assistant error", async () => {
		const res = await fetch(`${baseUrl}/api/session/drop-last-assistant-error`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "missing-drop-error" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.dropped).toBe(false);
		expect(body.messageCount).toBe(0);
		expect(getSession("missing-drop-error")).toBeUndefined();
	});

	it("rejects stream without static context", async () => {
		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "test-no-ctx",
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				delta: [],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ServerResponse;
		expect(body.error).toContain("static context");
	});

	it("sends a stream heartbeat before upstream provider events", async () => {
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-heartbeat",
				staticContext: { systemPrompt: "Heartbeat test" },
			}),
		});

		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-heartbeat",
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "http://127.0.0.1:1" },
			}),
		});

		expect(res.status).toBe(200);
		expect(res.body).toBeTruthy();

		const reader = res.body!.getReader();
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for heartbeat")), 1000),
			),
		]);
		await reader.cancel();

		expect(firstChunk.done).toBe(false);
		expect(new TextDecoder().decode(firstChunk.value)).toContain(": keep-alive");
	});

	it("journals a completed stream run for recovery by run id", async () => {
		const faux = registerFauxProvider();
		const journaledMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "journaled" }],
			api: faux.models[0].api,
			provider: faux.models[0].provider,
			model: faux.models[0].id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1000,
		};
		faux.setResponses([journaledMessage]);
		const runId = "run-journal-1";

		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-run-journal",
				staticContext: { systemPrompt: "Journal test" },
			}),
		});

		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-run-journal",
				runId,
				model: faux.models[0],
			}),
		});
		expect(res.status).toBe(200);
		await res.text();

		const runRes = await fetch(`${baseUrl}/api/session/stream-run-journal/runs/${runId}`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(runRes.status).toBe(200);
		const runBody = (await runRes.json()) as RunResponse;
		expect(runBody.status).toBe("completed");
		expect(runBody.message?.role).toBe("assistant");
		expect(runBody.message?.content).toEqual([{ type: "text", text: "journaled" }]);
	});

	it("returns 404 for unknown routes with auth", async () => {
		const res = await fetch(`${baseUrl}/unknown`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	it("deletes only the requested session, not all sessions", async () => {
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "session-a",
				staticContext: { systemPrompt: "A" },
			}),
		});
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "session-b",
				staticContext: { systemPrompt: "B" },
			}),
		});

		expect(getSession("session-a")).toBeDefined();
		expect(getSession("session-b")).toBeDefined();

		const res = await fetch(`${baseUrl}/api/session/session-a`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.deleted).toBe("session-a");

		expect(getSession("session-a")).toBeUndefined();
		expect(getSession("session-b")).toBeDefined();
	});
});

describe("resolveStreamOptions", () => {
	const baseModel: Model<"openai-completions"> = {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://original.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};

	it("returns original model when no provider overrides are set", () => {
		const config: ServerConfig = {
			host: "127.0.0.1",
			port: 4217,
			authToken: undefined,
			sessionStoreDir: "unused",
			uploadDir: "unused",
		};
		const { model, options } = resolveStreamOptions(config, baseModel, {
			sessionId: "s1",
			model: baseModel,
		});
		expect(model.baseUrl).toBe("https://original.example.com");
		expect(options.apiKey).toBeUndefined();
	});

	it("ignores server-side provider request config", () => {
		const config = {
			host: "127.0.0.1",
			port: 4217,
			authToken: undefined,
			sessionStoreDir: "unused",
			uploadDir: "unused",
			providerApiKey: "sk-server",
			providerBaseUrl: "https://server-proxy.example.com/v1",
			providerHeaders: { "X-Server": "yes" },
		} as ServerConfig;
		const { model, options } = resolveStreamOptions(config, baseModel, {
			sessionId: "s1",
			model: baseModel,
			options: { headers: { "X-Client": "yes" } },
		});
		expect(model.baseUrl).toBe("https://original.example.com");
		expect(options.apiKey).toBeUndefined();
		expect(options.headers).toEqual({ "X-Client": "yes" });
	});
});
