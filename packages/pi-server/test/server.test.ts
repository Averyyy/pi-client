import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { compactLegacy as compactAgentCore } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider, registerFauxProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer, type ServerConfig, startServer } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof AgentCore>();
	return {
		...actual,
		compactLegacy: vi.fn(async () => ({
			ok: true,
			value: {
				summary: "summary",
				firstKeptEntryId: "u2",
				tokensBefore: 10,
				retainedTail: [],
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
	code?: string;
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
	status?: "running" | "completed" | "failed" | "aborted";
	message?: Message;
	error?: string;
	errorMessage?: string;
}

function createCleanupGateStream(
	message: AssistantMessage,
	releaseGate: Promise<void>,
	onDoneYield: () => void,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
		onDoneYield();
		yield { type: "done", reason: "stop", message };
		await releaseGate;
	};
	return stream;
}

function registerCleanupGateProvider(message: AssistantMessage): {
	model: Model<"cleanup-gate">;
	waitForStart: () => Promise<void>;
	waitForDoneYield: () => Promise<void>;
	release: () => void;
	getAbortCount: () => number;
} {
	const api = "cleanup-gate" as const;
	const model: Model<typeof api> = {
		id: "cleanup-gate-model",
		name: "cleanup-gate-model",
		api,
		provider: "cleanup-gate-provider",
		baseUrl: "http://cleanup-gate.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
	let release: (() => void) | undefined;
	let start: (() => void) | undefined;
	let doneYield: (() => void) | undefined;
	let abortCount = 0;
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	const doneYielded = new Promise<void>((resolve) => {
		doneYield = resolve;
	});
	const stream = (_model: Model<typeof api>, _context: Context, options?: StreamOptions | SimpleStreamOptions) => {
		options?.signal?.addEventListener(
			"abort",
			() => {
				abortCount += 1;
			},
			{ once: true },
		);
		start?.();
		const releaseGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return createCleanupGateStream(message, releaseGate, () => doneYield?.());
	};
	registerApiProvider({ api, stream, streamSimple: stream });
	return {
		model,
		waitForStart: () => started,
		waitForDoneYield: () => doneYielded,
		release: () => release?.(),
		getAbortCount: () => abortCount,
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

type CompactResult = Awaited<ReturnType<typeof compactAgentCore>>;

function createCompactGate(
	summary: string,
	firstKeptEntryId: string,
): {
	started: Promise<void>;
	implementation: () => Promise<CompactResult>;
	release: () => void;
} {
	let resolveStarted: (() => void) | undefined;
	let resolveResult: ((value: CompactResult) => void) | undefined;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const result = new Promise<CompactResult>((resolve) => {
		resolveResult = resolve;
	});
	return {
		started,
		implementation: () => {
			resolveStarted?.();
			return result;
		},
		release: () =>
			resolveResult?.({
				ok: true,
				value: { summary, firstKeptEntryId, tokensBefore: 10, retainedTail: [] },
			}),
	};
}

function userTreeEntry(id: string, parentId: string | null, content: string, timestamp: number) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user" as const, content, timestamp },
	};
}

function compactModel(): Model<"openai-completions"> {
	return {
		id: "test",
		name: "test",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function branchEntries() {
	return [
		userTreeEntry("a1", null, "BRANCH A root", 1000),
		userTreeEntry("a2", "a1", "BRANCH A leaf", 2000),
		userTreeEntry("b1", null, "BRANCH B root", 3000),
		userTreeEntry("b2", "b1", "BRANCH B leaf", 4000),
	];
}

async function listenOnHost(server: Server, host: string): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, host);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error(`Expected ${host} listener to expose an address`);
	}
	return address.port;
}

async function waitForListening(server: Server): Promise<number> {
	if (!server.listening) {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
		});
	}
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected listener to expose an address");
	}
	return address.port;
}

async function closeTestServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isUnavailableIpv6Error(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "ENETUNREACH";
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

	it("serves health, init, and history on IPv4 and hostname listeners", async () => {
		for (const host of ["127.0.0.1", "localhost"]) {
			const hostServer = createPiServer({
				authToken: "test-token",
				host,
				sessionStoreDir: join(sessionStoreDir, host),
				uploadDir,
			} as Partial<ServerConfig>);
			const port = await listenOnHost(hostServer, host);
			const hostBaseUrl = `http://${host}:${port}`;
			try {
				const health = await fetch(`${hostBaseUrl}/health`);
				expect(health.status).toBe(200);
				expect(await health.json()).toEqual({ status: "ok" });

				const sessionId = `host-${host}`;
				const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
				const init = await fetch(`${hostBaseUrl}/api/session/init`, {
					method: "POST",
					headers,
					body: JSON.stringify({ sessionId, staticContext: { systemPrompt: host } }),
				});
				expect(init.status).toBe(200);

				const history = await fetch(`${hostBaseUrl}/api/session/${sessionId}/history`, {
					headers: { Authorization: "Bearer test-token" },
				});
				expect(history.status).toBe(200);
				expect(((await history.json()) as ServerResponse).sessionId).toBe(sessionId);

				const unknown = await fetch(`${hostBaseUrl}/not-found`, {
					headers: { Authorization: "Bearer test-token" },
				});
				expect(unknown.status).toBe(404);
				const healthAfterError = await fetch(`${hostBaseUrl}/health`);
				expect(healthAfterError.status).toBe(200);
			} finally {
				await closeTestServer(hostServer);
			}
		}
	});

	it("serves IPv6 loopback requests and logs a bracketed listening URL", async ({ skip }) => {
		const host = "::1";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const ipv6Server = startServer({
			authToken: "test-token",
			host,
			port: 0,
			sessionStoreDir: join(sessionStoreDir, "ipv6"),
			uploadDir,
		} as Partial<ServerConfig>);
		let port: number;
		try {
			port = await waitForListening(ipv6Server);
		} catch (error) {
			logSpy.mockRestore();
			await closeTestServer(ipv6Server);
			if (isUnavailableIpv6Error(error)) {
				skip(`IPv6 loopback unavailable: ${(error as NodeJS.ErrnoException).code}`);
			}
			throw error;
		}
		try {
			expect(logSpy).toHaveBeenCalledWith(`pi-server listening on [${host}]:${port}`);
			const base = `http://[${host}]:${port}`;
			const health = await fetch(`${base}/health`);
			expect(health.status).toBe(200);

			const sessionId = "ipv6-session";
			const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
			const init = await fetch(`${base}/api/session/init`, {
				method: "POST",
				headers,
				body: JSON.stringify({ sessionId, staticContext: { systemPrompt: "ipv6" } }),
			});
			expect(init.status).toBe(200);
			const history = await fetch(`${base}/api/session/${sessionId}/history`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(history.status).toBe(200);
			const unknown = await fetch(`${base}/not-found`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(unknown.status).toBe(404);
			expect((await fetch(`${base}/health`)).status).toBe(200);
		} finally {
			logSpy.mockRestore();
			await closeTestServer(ipv6Server);
		}
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

	it("returns a structured error code for tree divergence", async () => {
		const res = await fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({
				sessionId: "tree-error",
				entries: [
					{
						type: "message",
						id: "child",
						parentId: "missing-parent",
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "test", timestamp: 1000 },
					},
				],
				leafId: "child",
			}),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: "parent entry missing-parent does not exist",
			code: "PARENT_ENTRY_NOT_FOUND",
			details: { parentId: "missing-parent" },
		});
	});

	it("returns a response for an unknown chunk target", async () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "unknown-target" }), "utf8").toString("base64");
		const res = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({
				requestId: "unknown-target-request",
				target: "/api/session/removed",
				chunkIndex: 0,
				totalChunks: 1,
				sha256: sha256(encoded),
				chunk: encoded,
			}),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
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

	it("rejects a JSON compaction result after the active leaf changes", async () => {
		const sessionId = "compact-stale-switch-json";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		const entries = branchEntries();
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries, leafId: "a2" }),
		});

		const gate = createCompactGate("Summary of BRANCH A only", "a2");
		vi.mocked(compactAgentCore).mockImplementationOnce(gate.implementation);
		const compactRequest = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		await gate.started;

		const switchResponse = await fetch(`${baseUrl}/api/session/tree/switch`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, leafId: "b2" }),
		});
		expect(switchResponse.status).toBe(200);
		gate.release();

		const compactResponse = await compactRequest;
		expect(compactResponse.status).toBe(200);
		const compactBody = (await compactResponse.json()) as ServerResponse;
		expect(compactBody).toMatchObject({
			code: "SESSION_STATE_CONFLICT",
			error: "Session changed while compaction was running",
		});
		expect(getSession(sessionId)?.entries.map((entry) => entry.id)).toEqual(["a1", "a2", "b1", "b2"]);
		expect(getSession(sessionId)?.leafId).toBe("b2");
		expect(getSession(sessionId)?.messages.map((message) => message.content)).toEqual([
			"BRANCH B root",
			"BRANCH B leaf",
		]);
	});

	it("emits a clear SSE conflict when compaction observes a changed leaf", async () => {
		const sessionId = "compact-stale-switch-sse";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries: branchEntries(), leafId: "a2" }),
		});

		const gate = createCompactGate("Summary of BRANCH A only", "a2");
		vi.mocked(compactAgentCore).mockImplementationOnce(gate.implementation);
		const compactResponse = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				streamResponse: true,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		expect(compactResponse.headers.get("content-type")).toContain("text/event-stream");
		await gate.started;
		const reader = compactResponse.body!.getReader();
		const firstChunk = await reader.read();
		expect(firstChunk.done).toBe(false);
		expect(new TextDecoder().decode(firstChunk.value)).toContain(": keep-alive");

		const switchResponse = await fetch(`${baseUrl}/api/session/tree/switch`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, leafId: "b2" }),
		});
		expect(switchResponse.status).toBe(200);
		gate.release();

		const chunks = [new TextDecoder().decode(firstChunk.value)];
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			chunks.push(new TextDecoder().decode(chunk.value));
		}
		const body = chunks.join("");
		expect(body).toContain("event: error");
		expect(body).toContain('"code":"SESSION_STATE_CONFLICT"');
		expect(getSession(sessionId)?.leafId).toBe("b2");
		expect(getSession(sessionId)?.entries).toHaveLength(4);
	});

	it("rejects compaction after a message append during summarization", async () => {
		const sessionId = "compact-stale-append";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries: branchEntries(), leafId: "a2" }),
		});

		const gate = createCompactGate("stale summary", "a2");
		vi.mocked(compactAgentCore).mockImplementationOnce(gate.implementation);
		const compactRequest = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		await gate.started;

		const appendResponse = await fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				entries: [userTreeEntry("a3", "a2", "BRANCH A appended", 5000)],
				leafId: "a3",
			}),
		});
		expect(appendResponse.status).toBe(200);
		gate.release();

		const compactResponse = await compactRequest;
		const compactBody = (await compactResponse.json()) as ServerResponse;
		expect(compactBody.code).toBe("SESSION_STATE_CONFLICT");
		expect(getSession(sessionId)?.leafId).toBe("a3");
		expect(getSession(sessionId)?.entries).toHaveLength(5);
	});

	it("rejects an older compaction after another compaction commits", async () => {
		const sessionId = "compact-stale-compact";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries: branchEntries(), leafId: "a2" }),
		});

		const firstGate = createCompactGate("first summary", "a2");
		const secondGate = createCompactGate("second summary", "a2");
		vi.mocked(compactAgentCore)
			.mockImplementationOnce(firstGate.implementation)
			.mockImplementationOnce(secondGate.implementation);
		const firstRequest = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		await firstGate.started;
		const secondRequest = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		await secondGate.started;

		secondGate.release();
		const secondResponse = await secondRequest;
		expect(secondResponse.status).toBe(200);
		await secondResponse.json();
		firstGate.release();

		const firstResponse = await firstRequest;
		const firstBody = (await firstResponse.json()) as ServerResponse;
		expect(firstBody.code).toBe("SESSION_STATE_CONFLICT");
		expect(getSession(sessionId)?.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not recreate a deleted session when compaction completes late", async () => {
		const sessionId = "compact-stale-delete";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries: branchEntries(), leafId: "a2" }),
		});

		const gate = createCompactGate("deleted summary", "a2");
		vi.mocked(compactAgentCore).mockImplementationOnce(gate.implementation);
		const compactRequest = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				model: compactModel(),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "a2" },
			}),
		});
		await gate.started;

		const deleteResponse = await fetch(`${baseUrl}/api/session/${sessionId}`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(deleteResponse.status).toBe(200);
		expect(getSession(sessionId)).toBeUndefined();
		gate.release();

		const compactResponse = await compactRequest;
		const compactBody = (await compactResponse.json()) as ServerResponse;
		expect(compactBody.code).toBe("SESSION_STATE_CONFLICT");
		expect(getSession(sessionId)).toBeUndefined();
		const historyResponse = await fetch(`${baseUrl}/api/session/${sessionId}/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(historyResponse.status).toBe(404);
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
				retainedTail: [],
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
				retainedTail: [],
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

	it("does not persist a compaction cancelled before the summary completes", async () => {
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
		const sessionId = "compact-cancelled";
		const runId = "compact-cancelled-run";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries, leafId: "u2" }),
		});

		let compactSignal: AbortSignal | undefined;
		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce((...args) => {
			compactSignal = args[4];
			return new Promise((resolve) => {
				resolveCompact = resolve;
			});
		});

		const compactResponse = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				runId,
				streamResponse: true,
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
		});
		expect(compactResponse.status).toBe(200);
		const reader = compactResponse.body!.getReader();
		const firstChunk = await reader.read();
		expect(firstChunk.done).toBe(false);
		expect(new TextDecoder().decode(firstChunk.value)).toContain(": keep-alive");
		await vi.waitFor(() => expect(compactSignal).toBeDefined());

		let abortSettled = false;
		const abortPromise = fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		}).then((response) => {
			abortSettled = true;
			return response;
		});
		await vi.waitFor(() => expect(compactSignal?.aborted).toBe(true));
		expect(abortSettled).toBe(false);
		resolveCompact?.({
			ok: true,
			value: { summary: "cancelled", firstKeptEntryId: "u2", tokensBefore: 10, retainedTail: [] },
		});
		const abort = await abortPromise;
		expect(abort.status).toBe(200);
		expect(await abort.json()).toMatchObject({ sessionId, runId, status: "aborted" });
		await reader.cancel();

		const history = await fetch(`${baseUrl}/api/session/${sessionId}/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const historyBody = (await history.json()) as ServerResponse;
		expect(historyBody.entryCount).toBe(2);
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

	it("records and replays a cancel-before-start tombstone", async () => {
		const sessionId = "stream-cancel-before-start";
		const runId = "cancel-before-start";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		const abort = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		});
		expect(abort.status).toBe(200);
		expect(await abort.json()).toMatchObject({ sessionId, runId, status: "aborted" });

		const duplicate = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		});
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({ sessionId, runId, status: "aborted" });

		const run = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(run.status).toBe(200);
		expect(((await run.json()) as RunResponse).status).toBe("aborted");

		const faux = registerFauxProvider();
		faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "text", text: "must not run" }],
				api: faux.models[0].api,
				provider: faux.models[0].provider,
				model: faux.models[0].id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, staticContext: { systemPrompt: "cancel" } }),
		});
		const stream = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId, model: faux.models[0] }),
		});
		expect(stream.status).toBe(409);
		expect(faux.state.callCount).toBe(0);
		faux.unregister();
	});

	it("rejects a compact run after cancel-before-start without starting or persisting it", async () => {
		const sessionId = "compact-cancel-before-start";
		const runId = "compact-cancel-before-start-run";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
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

		const abort = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		});
		expect(abort.status).toBe(200);
		expect(await abort.json()).toMatchObject({ sessionId, runId, status: "aborted" });

		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, entries, leafId: "u2" }),
		});
		vi.mocked(compactAgentCore).mockClear();

		const compact = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId,
				runId,
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
		});
		expect(compact.status).toBe(409);
		expect(await compact.json()).toMatchObject({ error: "Compaction run was aborted" });
		expect(compactAgentCore).not.toHaveBeenCalled();

		const history = await fetch(`${baseUrl}/api/session/${sessionId}/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(((await history.json()) as ServerResponse).entryCount).toBe(2);
	});

	it("waits for provider iterator cleanup before acknowledging run cancellation", async () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "delayed" }],
			api: "cleanup-gate",
			provider: "cleanup-gate-provider",
			model: "cleanup-gate-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const cleanup = registerCleanupGateProvider(message);
		const sessionId = "stream-cancel-running";
		const runId = "cancel-running";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, staticContext: { systemPrompt: "cancel" } }),
		});

		const stream = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId, model: cleanup.model }),
		});
		expect(stream.status).toBe(200);
		await cleanup.waitForStart();
		await cleanup.waitForDoneYield();

		let firstAbortSettled = false;
		let duplicateAbortSettled = false;
		const abortPromise = fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		}).then((response) => {
			firstAbortSettled = true;
			return response;
		});
		const duplicateAbortPromise = fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}/abort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId }),
		}).then((response) => {
			duplicateAbortSettled = true;
			return response;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(firstAbortSettled).toBe(false);
		expect(duplicateAbortSettled).toBe(false);
		cleanup.release();
		const [abort, duplicateAbort] = await Promise.all([abortPromise, duplicateAbortPromise]);
		const abortBody = (await abort.json()) as RunResponse & { sessionId: string; runId: string };
		const duplicateAbortBody = (await duplicateAbort.json()) as RunResponse & { sessionId: string; runId: string };
		expect(abort.status).toBe(200);
		expect(abortBody).toMatchObject({ sessionId, runId, status: "completed" });
		expect(duplicateAbort.status).toBe(200);
		expect(duplicateAbortBody).toMatchObject({ sessionId, runId, status: "completed" });
		expect(cleanup.getAbortCount()).toBe(0);
		await stream.body?.cancel();
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

	it("replays a completed run through a second stream request", async () => {
		const faux = registerFauxProvider();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "replay me" }],
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
		faux.setResponses([message]);
		const sessionId = "stream-replay";
		const runId = "run-replay";
		const init = { sessionId, staticContext: { systemPrompt: "Replay" } };
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify(init),
		});
		const first = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({ sessionId, runId, model: faux.models[0] }),
		});
		expect(first.status).toBe(200);
		await first.text();
		const second = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({ sessionId, runId, model: faux.models[0] }),
		});
		expect(second.status).toBe(200);
		const replay = await second.text();
		expect(replay).toContain('"type":"done"');
		expect(replay).toContain("replay me");
	});

	it("clears completed run journals when deleting a session", async () => {
		const faux = registerFauxProvider();
		const makeMessage = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
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
		});
		faux.setResponses([makeMessage("first"), makeMessage("second")]);
		const sessionId = "deleted-run-session";
		const runId = "reused-run";
		const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, staticContext: { systemPrompt: "test" } }),
		});
		let response = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId, model: faux.models[0] }),
		});
		await response.text();
		response = await fetch(`${baseUrl}/api/session/${sessionId}`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(response.status).toBe(200);
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, staticContext: { systemPrompt: "test" } }),
		});
		response = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, runId, model: faux.models[0] }),
		});
		const secondStream = await response.text();
		expect(secondStream).toContain("second");
		expect(faux.state.callCount).toBe(2);
	});

	it("preserves deferred response handles in proxied done events", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			{
				role: "assistant",
				content: [],
				api: faux.models[0].api,
				provider: faux.models[0].provider,
				model: faux.models[0].id,
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "deferred",
				deferred: {
					provider: faux.models[0].provider,
					modelId: faux.models[0].id,
					api: faux.models[0].api,
					id: "deferred-response-1",
				},
				timestamp: 1000,
			},
		]);

		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-deferred",
				staticContext: { systemPrompt: "Deferred test" },
			}),
		});

		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-deferred",
				model: faux.models[0],
			}),
		});

		const eventStream = await res.text();
		expect(eventStream).toContain('"reason":"deferred"');
		expect(eventStream).toContain('"id":"deferred-response-1"');
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
