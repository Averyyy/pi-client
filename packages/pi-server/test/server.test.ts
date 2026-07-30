import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import {
	type ServerResponse as HttpServerResponse,
	request as httpRequest,
	type IncomingMessage,
	type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { compact as compactAgentCore } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type * as AiCompat from "@earendil-works/pi-ai/compat";
import {
	getCompatProviderExecutionRoute,
	registerApiProvider,
	registerFauxProvider,
	resetApiProviders,
} from "@earendil-works/pi-ai/compat";
import { hashRemoteProviderExecution } from "@earendil-works/pi-ai/provider-execution-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonStringify, PI_SERVER_EMPTY_TREE_HASH } from "../src/pi-server-protocol.ts";
import {
	createPiServer,
	type PiServerOptions,
	readBody,
	resolveStreamOptions,
	type ServerConfig,
	startServer,
	waitForStreamDrain,
} from "../src/server.ts";
import {
	configureSessionPersistenceArtifactLimits,
	resetSessionPersistenceArtifactLimits,
} from "../src/session-persistence.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";
import { StreamRunCorruptionError, StreamRunPersistence } from "../src/stream-run-persistence.ts";

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof AiCompat>();
	return {
		...actual,
		getCompatProviderExecutionRoute: vi.fn((model: Model<string>) =>
			model.provider === "faux"
				? {
						kind: "builtin_api" as const,
						id: model.api,
					}
				: actual.getCompatProviderExecutionRoute(model),
		),
	};
});

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
	protocolVersion?: number;
	sessionId?: string;
	operationId?: string;
	requestHash?: string;
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
	code?: string;
	resource?: string;
	current?: number;
	requested?: number;
	limit?: number;
	retryable?: boolean;
	artifact?: string;
	deleted?: string;
	dropped?: boolean;
	staticContext?: { systemPrompt?: string };
	messages?: Message[];
	entries?: unknown[];
	baseMessageCount?: number;
	compactionEntry?: unknown;
	treePatch?: {
		baseStaticContextHash?: string;
		baseTreeHash?: string;
		baseEntryCount?: number;
		baseLeafId?: string | null;
		entriesFrom: number;
		baseRevision?: number;
		entries: unknown[];
		leafId: string | null;
		revision: number;
		treeHash?: string;
	};
}

interface RunResponse {
	status?: "running" | "completed" | "failed";
	requestMac?: string;
	nextSeq?: number;
	acknowledgedAt?: number;
	message?: Message;
	errorMessage?: string;
}

const compactTestModel: Model<"openai-completions"> = {
	id: "test",
	name: "Test",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function executionFingerprint(model: Model<Api>): string {
	const route = getCompatProviderExecutionRoute(model);
	if (route.kind !== "builtin_provider" && route.kind !== "builtin_api") {
		throw new Error(`Test model ${model.provider}/${model.id} has unsupported route ${route.kind}`);
	}
	return hashRemoteProviderExecution(model, route);
}

function compactRequestHash(body: Record<string, unknown>): string {
	const serialized = canonicalJsonStringify({
		protocolVersion: body.protocolVersion,
		sessionId: body.sessionId,
		providerExecutionFingerprint: body.providerExecutionFingerprint,
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
	if (serialized === undefined) throw new Error("Failed to serialize test compaction request");
	return sha256(serialized);
}

function readPersistedDirectory(root: string): string {
	return (readdirSync(root, { recursive: true }) as string[])
		.map((relativePath) => join(root, relativePath))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path).toString("utf-8"))
		.join("\n");
}

function generatedAssistantMessageEventStream(
	generate: () => AsyncGenerator<AssistantMessageEvent>,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream[Symbol.asyncIterator] = generate;
	return stream;
}

describe("pi-server bounded I/O primitives", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		{ signal: "aborted", message: "Request body was aborted before completion" },
		{ signal: "close", message: "Request closed before body completion" },
	])("rejects a half-open upload on $signal and removes all body listeners", async ({ signal, message }) => {
		const request = Object.assign(new EventEmitter(), {
			headers: {},
			resume: vi.fn(),
		}) as unknown as IncomingMessage;
		const body = readBody(request);
		const rejected = expect(body).rejects.toThrow(message);
		request.emit("data", Buffer.from('{"sessionId":"half-open"'));
		request.emit(signal);
		await rejected;

		for (const event of ["data", "end", "error", "aborted", "close"]) {
			expect(request.listenerCount(event)).toBe(0);
		}
	});

	it("allows arbitrarily long uploads while non-empty body progress continues", async () => {
		vi.useFakeTimers();
		const request = Object.assign(new EventEmitter(), {
			headers: {},
			resume: vi.fn(),
		}) as unknown as IncomingMessage;
		const body = readBody(request, 1024, 100);

		for (let index = 0; index < 10; index++) {
			await vi.advanceTimersByTimeAsync(99);
			request.emit("data", Buffer.from("x"));
		}
		request.emit("end");

		await expect(body).resolves.toBe("x".repeat(10));
		expect(request.resume).not.toHaveBeenCalled();
	});

	it("does not treat empty data events as progress or retain them", async () => {
		vi.useFakeTimers();
		const request = Object.assign(new EventEmitter(), {
			headers: {},
			resume: vi.fn(),
		}) as unknown as IncomingMessage;
		const body = readBody(request, 1024, 100);
		const rejected = expect(body).rejects.toThrow("Request body made no progress for 100ms");

		await vi.advanceTimersByTimeAsync(99);
		for (let index = 0; index < 10_000; index++) {
			request.emit("data", Buffer.alloc(0));
		}
		await vi.advanceTimersByTimeAsync(1);

		await rejected;
		expect(request.resume).toHaveBeenCalledTimes(1);
		for (const event of ["data", "end", "error", "aborted", "close"]) {
			expect(request.listenerCount(event)).toBe(0);
		}
	});

	it("bounds one stream drain wait without treating backpressure as provider cancellation", async () => {
		vi.useFakeTimers();
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
		}) as unknown as HttpServerResponse;
		let result: boolean | undefined;
		const drain = waitForStreamDrain(response, 90_000).then((value) => {
			result = value;
			return value;
		});

		await vi.advanceTimersByTimeAsync(89_999);
		expect(result).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await expect(drain).resolves.toBe(false);
		expect(response.listenerCount("drain")).toBe(0);
		expect(response.listenerCount("close")).toBe(0);
	});
});

describe("pi-server HTTP", () => {
	let server: Server;
	let baseUrl: string;
	let sessionStoreDir: string;
	let uploadDir: string;

	beforeEach(() => {
		clearAllSessions();
		resetSessionPersistenceArtifactLimits();
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
				resetSessionPersistenceArtifactLimits();
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

	async function replaceServer(options: PiServerOptions): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		clearAllSessions();
		server = createPiServer({ authToken: "test-token", sessionStoreDir, uploadDir, ...options });
		server.listen(0);
		const addr = server.address();
		if (typeof addr !== "object" || addr === null) {
			throw new Error("Failed to get replacement server address");
		}
		baseUrl = `http://127.0.0.1:${addr.port}`;
	}

	async function initStreamSession(sessionId: string): Promise<void> {
		const response = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId,
				staticContext: { systemPrompt: `Stream test ${sessionId}` },
			}),
		});
		expect(response.status).toBe(200);
	}

	function postStream(
		sessionId: string,
		runId: string,
		model: Model<string>,
		overrides: Record<string, unknown> = {},
	): Promise<Response> {
		const session = getSession(sessionId);
		if (!session) throw new Error(`Missing test session: ${sessionId}`);
		return fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId,
				runId,
				providerExecutionFingerprint: executionFingerprint(model),
				baseStaticContextHash: session.staticContextHash,
				baseRevision: session.revision,
				baseTreeHash: session.treeHash,
				baseEntryCount: session.entries.length,
				baseLeafId: session.leafId,
				model,
				...overrides,
			}),
		});
	}

	function createCompactRequest(
		sessionId: string,
		operationId: string,
		model: Model<Api>,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		const session = getSession(sessionId);
		if (!session) throw new Error(`Missing test session: ${sessionId}`);
		return {
			protocolVersion: 2,
			sessionId,
			operationId,
			providerExecutionFingerprint: executionFingerprint(model),
			baseStaticContextHash: session.staticContextHash,
			baseTreeHash: session.treeHash,
			baseEntryCount: session.entries.length,
			baseLeafId: session.leafId,
			baseRevision: session.revision,
			streamResponse: false,
			model,
			...overrides,
		};
	}

	it("responds to health check", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.status).toBe("ok");
	});

	it("rejects a second in-process owner and releases global session state after close", async () => {
		const rejectedDirectory = mkdtempSync(join(tmpdir(), "pi-server-rejected-owner-"));
		try {
			expect(() =>
				createPiServer({
					authToken: "test-token",
					sessionStoreDir: rejectedDirectory,
					uploadDir: join(rejectedDirectory, "uploads"),
					maxLoadedSessions: 1,
				}),
			).toThrow("pi-server already owns the process-wide session store");

			for (const sessionId of ["owner-limit-a", "owner-limit-b"]) {
				const response = await fetch(`${baseUrl}/api/session/init`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer test-token",
					},
					body: JSON.stringify({ sessionId }),
				});
				expect(response.status).toBe(200);
			}

			const previousDirectory = sessionStoreDir;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			const replacementDirectory = mkdtempSync(join(tmpdir(), "pi-server-released-owner-"));
			sessionStoreDir = replacementDirectory;
			uploadDir = join(replacementDirectory, "uploads");
			server = createPiServer({ authToken: "test-token", sessionStoreDir, uploadDir });
			server.listen(0);
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				throw new Error("Failed to get replacement owner address");
			}
			baseUrl = `http://127.0.0.1:${address.port}`;
			const sessions = await fetch(`${baseUrl}/api/sessions`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(sessions.status).toBe(200);
			expect(await sessions.json()).toEqual({ sessions: [] });
			rmSync(previousDirectory, { recursive: true, force: true });
		} finally {
			rmSync(rejectedDirectory, { recursive: true, force: true });
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

	it("rejects oversized direct request bodies without creating a session", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "oversized-body",
				padding: "x".repeat(2 * 1024 * 1024),
			}),
		});

		expect(res.status).toBe(413);
		expect((await res.json()) as ServerResponse).toMatchObject({
			error: "Request body exceeds 2097152 bytes",
		});
		expect(getSession("oversized-body")).toBeUndefined();
	});

	it("stays responsive after a client closes a half-written upload", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const serverReceivedPartialBody = new Promise<void>((resolve) => {
				server.once("request", (incoming) => {
					incoming.once("data", () => resolve());
				});
			});
			const request = httpRequest(`${baseUrl}/api/session/init`, {
				method: "POST",
				headers: {
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
					"Content-Length": 4096,
				},
			});
			const clientSettled = new Promise<void>((resolve) => {
				request.once("error", () => resolve());
				request.once("close", () => resolve());
			});
			request.write('{"sessionId":"half-written-upload"');
			await serverReceivedPartialBody;
			request.destroy();
			await clientSettled;
			await vi.waitFor(() => {
				expect(stderr.mock.calls.some(([line]) => /before (?:body )?completion/.test(String(line)))).toBe(true);
			});

			const health = await fetch(`${baseUrl}/health`);
			expect(health.status).toBe(200);
			expect(getSession("half-written-upload")).toBeUndefined();
		} finally {
			stderr.mockRestore();
		}
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

	it("returns structured 507 capacity failures without creating or partially mutating sessions", async () => {
		await replaceServer({ sessionMaxLogicalBytes: 1000 });
		const headers = {
			"Content-Type": "application/json",
			Authorization: "Bearer test-token",
		};
		const oversizedInit = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "capacity-init",
				staticContext: { systemPrompt: "x".repeat(2000) },
			}),
		});
		expect(oversizedInit.status).toBe(507);
		expect((await oversizedInit.json()) as ServerResponse).toMatchObject({
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "session_logical_bytes",
			sessionId: "capacity-init",
			limit: 1000,
			retryable: false,
		});
		expect(getSession("capacity-init")).toBeUndefined();

		const initial = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "capacity-combined",
				staticContext: { systemPrompt: "initial" },
			}),
		});
		expect(initial.status).toBe(200);
		const before = getSession("capacity-combined");
		if (!before) throw new Error("Capacity test session was not initialized");
		const beforeIdentity = {
			staticContextHash: before.staticContextHash,
			treeHash: before.treeHash,
			entries: before.entries,
			revision: before.revision,
			logicalBytes: before.logicalBytes,
		};

		const combined = await fetch(`${baseUrl}/api/session/append`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "capacity-combined",
				staticContext: { systemPrompt: "s".repeat(600) },
				messages: [{ role: "user", content: "m".repeat(600), timestamp: 1000 }],
			}),
		});
		expect(combined.status).toBe(507);
		const capacityBody = (await combined.json()) as ServerResponse;
		expect(capacityBody).toMatchObject({
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "session_logical_bytes",
			sessionId: "capacity-combined",
			current: beforeIdentity.logicalBytes,
			limit: 1000,
			retryable: false,
		});
		expect(capacityBody.requested).toBeGreaterThan(1000);
		const after = getSession("capacity-combined");
		expect(after).toMatchObject(beforeIdentity);
		expect(after?.staticContext?.systemPrompt).toBe("initial");
	});

	it("atomically admits a final-fit static-context and full-history replacement", async () => {
		await replaceServer({ sessionMaxLogicalBytes: 1000 });
		const headers = {
			"Content-Type": "application/json",
			Authorization: "Bearer test-token",
		};
		const initial = await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "capacity-final-fit",
				staticContext: { systemPrompt: "initial" },
				messages: [{ role: "user", content: "m".repeat(650), timestamp: 1000 }],
			}),
		});
		expect(initial.status).toBe(200);

		const replacement = await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "capacity-final-fit",
				staticContext: { systemPrompt: "s".repeat(650) },
				messages: [{ role: "user", content: "small", timestamp: 2000 }],
			}),
		});
		expect(replacement.status).toBe(200);
		const session = getSession("capacity-final-fit");
		expect(session?.staticContext?.systemPrompt).toBe("s".repeat(650));
		expect(session?.messages).toEqual([{ role: "user", content: "small", timestamp: 2000 }]);
		expect(session?.logicalBytes).toBeLessThanOrEqual(1000);
	});

	it("returns a structured persistence 507 and restores the prior in-memory session", async () => {
		let fatalCalls = 0;
		await replaceServer({
			onFatalStreamPersistenceError: () => {
				fatalCalls++;
			},
		});
		await initStreamSession("persistence-capacity-rollback");
		const before = getSession("persistence-capacity-rollback");
		if (!before) throw new Error("Persistence capacity test session was not initialized");
		const beforeIdentity = {
			staticContextHash: before.staticContextHash,
			treeHash: before.treeHash,
			entries: structuredClone(before.entries),
			revision: before.revision,
		};
		configureSessionPersistenceArtifactLimits({ maxHeadBytes: 1 });

		const response = await fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "persistence-capacity-rollback",
				entries: [
					{
						type: "message",
						id: "persistence-capacity-u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "must roll back", timestamp: 1000 },
					},
				],
				leafId: "persistence-capacity-u1",
			}),
		});
		expect(response.status).toBe(507);
		const responseBody = (await response.json()) as ServerResponse;
		expect(responseBody).toMatchObject({
			code: "PI_SERVER_SESSION_PERSISTENCE_CAPACITY_EXCEEDED",
			resource: "head_artifact_bytes",
			sessionId: "persistence-capacity-rollback",
			artifact: expect.any(String),
			limit: 1,
			retryable: false,
		});
		expect(responseBody.error).not.toContain(sessionStoreDir);
		expect(getSession("persistence-capacity-rollback")).toMatchObject(beforeIdentity);
		expect(fatalCalls).toBe(0);
		expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
	});

	it("negotiates static context by hash before transferring the full context", async () => {
		const initial = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "hash-first-init",
				staticContext: { systemPrompt: "existing context", tools: [] },
			}),
		});
		const initialBody = (await initial.json()) as ServerResponse;
		if (!initialBody.staticContextHash) throw new Error("Initial static context hash is missing");

		const exact = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "hash-first-init",
				staticContextHash: initialBody.staticContextHash,
			}),
		});
		expect(await exact.json()).toMatchObject({
			protocolVersion: 2,
			staticContextRequired: false,
			staticContextHash: initialBody.staticContextHash,
		});

		const mismatch = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "hash-first-init",
				staticContextHash: "0".repeat(64),
			}),
		});
		expect(await mismatch.json()).toMatchObject({
			protocolVersion: 2,
			staticContextRequired: true,
			staticContextHash: initialBody.staticContextHash,
		});
		expect(getSession("hash-first-init")?.staticContext).toEqual({
			systemPrompt: "existing context",
			tools: [],
		});
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

		const completingChunkBody = {
			requestId,
			target: "/api/receive",
			chunkIndex: 1,
			totalChunks: 2,
			sha256: sha256(secondChunk),
			chunk: secondChunk,
		};
		const second = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(completingChunkBody),
		});
		expect(second.status).toBe(200);

		const responseBody = (await second.json()) as { path: string; files: number };
		expect(responseBody.path).toBe(join(uploadDir, "chunked-upload"));
		expect(responseBody.files).toBe(1);
		expect(readFileSync(join(uploadDir, "chunked-upload", "nested", "file.txt"), "utf-8")).toBe("hello");

		const retry = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(completingChunkBody),
		});
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual(responseBody);
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

	it("returns protocol v2 history patches without duplicated messages or static context", async () => {
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
			body: JSON.stringify({
				sessionId: "v2-history",
				entries,
				leafId: "u2",
				staticContext: { systemPrompt: "large static context" },
			}),
		});
		const syncBody = (await sync.json()) as ServerResponse;

		const patch = await fetch(
			`${baseUrl}/api/session/v2-history/history?protocolVersion=2&entriesFrom=1&revision=${syncBody.revision}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		const patchBody = (await patch.json()) as Record<string, unknown>;
		expect(patchBody.protocolVersion).toBe(2);
		expect(patchBody).not.toHaveProperty("messages");
		expect(patchBody).not.toHaveProperty("staticContext");
		expect(patchBody).not.toHaveProperty("baseMessageCount");
		expect((patchBody.treePatch as { entries: unknown[] }).entries).toEqual([entries[1]]);

		const full = await fetch(`${baseUrl}/api/session/v2-history/history?protocolVersion=2&entriesFrom=99`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const fullBody = (await full.json()) as Record<string, unknown>;
		expect(fullBody.entries).toEqual(entries);
		expect(fullBody).not.toHaveProperty("messages");
		expect(fullBody).not.toHaveProperty("staticContext");
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
			body: JSON.stringify(
				createCompactRequest("compact-delta", "compact-delta-operation", compactTestModel, {
					settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
					preparation: { firstKeptEntryId: "u2" },
				}),
			),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.entries).toBeUndefined();
		expect(body.messages).toBeUndefined();
		expect(body.treePatch?.baseTreeHash).toBe(syncBody.treeHash);
		expect(body.treePatch?.entriesFrom).toBe(2);
		expect(body.treePatch?.entries).toHaveLength(1);
		expect(body.treePatch?.leafId).toBe((body.treePatch?.entries[0] as { id?: string } | undefined)?.id);
		expect(getSession("compact-delta")?.entries).toHaveLength(3);
	});

	it("rejects invalid compact v2 requests before calling the provider", async () => {
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
			body: JSON.stringify({ sessionId: "compact-v2-cas", entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		const requestBody = createCompactRequest("compact-v2-cas", "compact-v2-cas-operation", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		const unsupported = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ ...requestBody, protocolVersion: 3 }),
		});
		expect(unsupported.status).toBe(400);
		expect((await unsupported.json()) as ServerResponse).toMatchObject({
			error: "Unsupported pi-server protocol version: 3",
			protocolVersion: 2,
		});

		const missingBaseHash = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ ...requestBody, baseTreeHash: undefined }),
		});
		expect(missingBaseHash.status).toBe(400);
		expect((await missingBaseHash.json()) as ServerResponse).toMatchObject({
			error: "A valid complete compaction base identity is required",
		});

		const staleBaseHash = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ ...requestBody, baseTreeHash: "0".repeat(64) }),
		});
		expect(staleBaseHash.status).toBe(409);
		expect((await staleBaseHash.json()) as ServerResponse).toMatchObject({
			error: "Session base identity does not match the compaction request; reconcile and retry",
		});

		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession("compact-v2-cas")?.entries).toEqual(entries);
	});

	it("rejects compaction capacity before durable begin or provider execution", async () => {
		await replaceServer({ sessionMaxEntries: 2 });
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
			body: JSON.stringify({ sessionId: "compact-capacity", entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		const requestBody = createCompactRequest("compact-capacity", "compact-capacity-operation", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;
		const response = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(requestBody),
		});

		expect(response.status).toBe(507);
		expect(await response.json()).toMatchObject({
			protocolVersion: 2,
			sessionId: "compact-capacity",
			operationId: "compact-capacity-operation",
			requestHash: compactRequestHash(requestBody),
			status: "rejected",
			httpStatus: 507,
			operationDisposition: "not_started",
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "session_entries",
			current: 2,
			requested: 3,
			limit: 2,
			retryable: false,
		});
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession("compact-capacity")?.entries).toEqual(entries);
		const recovery = await fetch(
			`${baseUrl}/api/session/compact-capacity/compactions/compact-capacity-operation?requestHash=${compactRequestHash(requestBody)}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(recovery.status).toBe(404);
	});

	it("rejects exact persistence capacity before durable begin or provider execution across restart", async () => {
		const sessionId = "compact-persistence-preflight";
		const operationId = "compact-persistence-preflight-operation";
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
			body: JSON.stringify({ sessionId, entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: 1 });
		const requestBody = createCompactRequest(sessionId, operationId, compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const requestHash = compactRequestHash(requestBody);
		const postCompact = () =>
			fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
		const expectRejectedBeforeStart = async () => {
			const response = await postCompact();
			expect(response.status).toBe(507);
			const responseBody = (await response.json()) as ServerResponse;
			expect(responseBody).toMatchObject({
				protocolVersion: 2,
				sessionId,
				operationId,
				requestHash,
				status: "rejected",
				httpStatus: 507,
				operationDisposition: "not_started",
				code: "PI_SERVER_SESSION_PERSISTENCE_CAPACITY_EXCEEDED",
				resource: "snapshot_artifact_bytes",
				artifact: expect.any(String),
				limit: 1,
				retryable: false,
			});
			expect(responseBody.error).not.toContain(sessionStoreDir);
		};
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		await expectRejectedBeforeStart();
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession(sessionId)?.entries).toEqual(entries);
		expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
		const recovery = await fetch(
			`${baseUrl}/api/session/${sessionId}/compactions/${operationId}?requestHash=${requestHash}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(recovery.status).toBe(404);

		resetSessionPersistenceArtifactLimits();
		await restartServer();
		expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
		const recoveryAfterRestart = await fetch(
			`${baseUrl}/api/session/${sessionId}/compactions/${operationId}?requestHash=${requestHash}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(recoveryAfterRestart.status).toBe(404);
		configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: 1 });
		await expectRejectedBeforeStart();
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession(sessionId)?.entries).toEqual(entries);
		const recoveryAfterSecondRejection = await fetch(
			`${baseUrl}/api/session/${sessionId}/compactions/${operationId}?requestHash=${requestHash}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(recoveryAfterSecondRejection.status).toBe(404);
	});

	it("journals an exact terminal capacity failure when compact output exceeds the remaining byte limit", async () => {
		await replaceServer({ sessionMaxLogicalBytes: 2000 });
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
			body: JSON.stringify({ sessionId: "compact-result-capacity", entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		vi.mocked(compactAgentCore).mockImplementationOnce(async () => ({
			ok: true,
			value: {
				summary: "x".repeat(4000),
				firstKeptEntryId: "u2",
				tokensBefore: 10,
			},
		}));
		const requestBody = createCompactRequest(
			"compact-result-capacity",
			"compact-result-capacity-operation",
			compactTestModel,
			{
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		const postCompact = () =>
			fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;
		const first = await postCompact();
		expect(first.status).toBe(200);
		const firstBody = await first.json();
		expect(firstBody).toMatchObject({
			protocolVersion: 2,
			sessionId: "compact-result-capacity",
			operationId: "compact-result-capacity-operation",
			requestHash: compactRequestHash(requestBody),
			status: "failed",
			httpStatus: 507,
			operationDisposition: "terminal",
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "session_logical_bytes",
			limit: 2000,
			retryable: false,
		});
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore + 1);
		expect(getSession("compact-result-capacity")?.entries).toEqual(entries);

		const replay = await postCompact();
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(firstBody);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore + 1);
	});

	it("preflights exact session artifacts before journaling a compact commit", async () => {
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
			body: JSON.stringify({ sessionId: "compact-persistence-capacity", entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		const requestBody = createCompactRequest(
			"compact-persistence-capacity",
			"compact-persistence-capacity-operation",
			compactTestModel,
			{
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		vi.mocked(compactAgentCore).mockImplementationOnce(async () => {
			configureSessionPersistenceArtifactLimits({ maxSnapshotBytes: 1 });
			return {
				ok: true,
				value: {
					summary: "summary",
					firstKeptEntryId: "u2",
					tokensBefore: 10,
				},
			};
		});
		const postCompact = () =>
			fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;
		const first = await postCompact();
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as ServerResponse;
		expect(firstBody).toMatchObject({
			protocolVersion: 2,
			sessionId: "compact-persistence-capacity",
			operationId: "compact-persistence-capacity-operation",
			requestHash: compactRequestHash(requestBody),
			status: "failed",
			httpStatus: 507,
			operationDisposition: "terminal",
			code: "PI_SERVER_SESSION_PERSISTENCE_CAPACITY_EXCEEDED",
			resource: "snapshot_artifact_bytes",
			artifact: expect.any(String),
			limit: 1,
			retryable: false,
		});
		expect(firstBody.error).not.toContain(sessionStoreDir);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore + 1);
		expect(getSession("compact-persistence-capacity")?.entries).toEqual(entries);
		expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

		const replay = await postCompact();
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(firstBody);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore + 1);

		resetSessionPersistenceArtifactLimits();
		await restartServer();
		expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
		const replayAfterRestart = await postCompact();
		expect(replayAfterRestart.status).toBe(200);
		expect(await replayAfterRestart.json()).toEqual(firstBody);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore + 1);
		expect(getSession("compact-persistence-capacity")?.entries).toEqual(entries);
	});

	it("serializes aggregate capacity across compact settlement and other-session mutations", async () => {
		let compactJournalWrites = 0;
		let reportSettleBlocked: (() => void) | undefined;
		let releaseSettle: (() => void) | undefined;
		const settleBlocked = new Promise<void>((resolve) => {
			reportSettleBlocked = resolve;
		});
		const settleRelease = new Promise<void>((resolve) => {
			releaseSettle = resolve;
		});
		await replaceServer({
			sessionsMaxEntries: 3,
			compactRunFaultInjector: async (point) => {
				if (point !== "journal_before_write") return;
				compactJournalWrites++;
				if (compactJournalWrites !== 2) return;
				reportSettleBlocked?.();
				await settleRelease;
			},
		});
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
			body: JSON.stringify({ sessionId: "compact-capacity-race", entries, leafId: "u2" }),
		});
		expect(sync.status).toBe(200);
		await initStreamSession("other-capacity-race");
		const compactBody = createCompactRequest(
			"compact-capacity-race",
			"compact-capacity-race-operation",
			compactTestModel,
			{
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		const compactResponsePromise = fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(compactBody),
		});
		await Promise.race([
			settleBlocked,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for compact settlement")), 1000),
			),
		]);

		let appendSettled = false;
		const appendPromise = fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "other-capacity-race",
				entries: [
					{
						type: "message",
						id: "other-u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "other", timestamp: 1000 },
					},
				],
				leafId: "other-u1",
			}),
		}).finally(() => {
			appendSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(appendSettled).toBe(false);

		releaseSettle?.();
		const compactResponse = await compactResponsePromise;
		expect(compactResponse.status).toBe(200);
		expect(await compactResponse.json()).toMatchObject({
			sessionId: "compact-capacity-race",
			operationId: "compact-capacity-race-operation",
		});
		const append = await appendPromise;
		expect(append.status).toBe(507);
		expect(await append.json()).toMatchObject({
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "aggregate_entries",
			current: 3,
			requested: 4,
			limit: 3,
			retryable: false,
		});
		expect(getSession("compact-capacity-race")?.entries).toHaveLength(3);
		expect(getSession("other-capacity-race")?.entries).toHaveLength(0);
	});

	it("rejects invalid compact execution fingerprints with not-started proof and no durable run", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-provider-parity", entries, leafId: "u2" }),
		});
		const validFingerprint = executionFingerprint(compactTestModel);
		const requests = [
			createCompactRequest("compact-provider-parity", "compact-missing-fingerprint", compactTestModel, {
				providerExecutionFingerprint: undefined,
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
			createCompactRequest("compact-provider-parity", "compact-wrong-fingerprint", compactTestModel, {
				providerExecutionFingerprint: "0".repeat(64),
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			}),
			createCompactRequest(
				"compact-provider-parity",
				"compact-model-mismatch",
				{ ...compactTestModel, id: "different-model" },
				{
					providerExecutionFingerprint: validFingerprint,
					settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
					preparation: { firstKeptEntryId: "u2" },
				},
			),
		];
		const customRouteRequest = createCompactRequest(
			"compact-provider-parity",
			"compact-custom-route",
			compactTestModel,
			{
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		for (const requestBody of requests) {
			const response = await fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				protocolVersion: 2,
				sessionId: "compact-provider-parity",
				operationId: requestBody.operationId,
				requestHash: compactRequestHash(requestBody),
				status: "rejected",
				operationDisposition: "not_started",
			});
		}

		vi.mocked(getCompatProviderExecutionRoute).mockImplementationOnce(() => ({
			kind: "custom_api",
			id: compactTestModel.api,
		}));
		const customRoute = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(customRouteRequest),
		});
		expect(customRoute.status).toBe(409);
		expect(await customRoute.json()).toMatchObject({
			operationId: "compact-custom-route",
			requestHash: compactRequestHash(customRouteRequest),
			status: "rejected",
			operationDisposition: "not_started",
		});
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);

		for (const requestBody of [...requests, customRouteRequest]) {
			const recovery = await fetch(
				`${baseUrl}/api/session/compact-provider-parity/compactions/${String(
					requestBody.operationId,
				)}?requestHash=${compactRequestHash(requestBody)}`,
				{ headers: { Authorization: "Bearer test-token" } },
			);
			expect(recovery.status).toBe(404);
		}
	});

	it("returns one authoritative compact v2 entry and replays it for the same operation", async () => {
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
			body: JSON.stringify({ sessionId: "compact-v2-payload", entries, leafId: "u2" }),
		});
		const syncBody = (await sync.json()) as ServerResponse;
		if (!syncBody.treeHash) throw new Error("Tree sync response did not include treeHash");

		const uniqueRetainedContent = `unique-retained-content-${"x".repeat(16_384)}`;
		const usage = {
			input: 40,
			output: 20,
			cacheRead: 10,
			cacheWrite: 5,
			cacheWrite1h: 3,
			reasoning: 7,
			totalTokens: 75,
			cost: { input: 0.4, output: 0.2, cacheRead: 0.1, cacheWrite: 0.05, total: 0.75 },
		};
		vi.mocked(compactAgentCore).mockImplementationOnce(async () => ({
			ok: true,
			value: {
				summary: "authoritative summary",
				firstKeptEntryId: "u2",
				tokensBefore: 100,
				retainedTail: [{ role: "user" as const, content: uniqueRetainedContent, timestamp: 3000 }],
				details: { source: "provider" },
				usage,
			},
		}));
		const requestBody = createCompactRequest("compact-v2-payload", "compact-v2-payload-operation", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const postCompact = () =>
			fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		const firstResponse = await postCompact();
		expect(firstResponse.status).toBe(200);
		const firstText = await firstResponse.text();
		const firstBody = JSON.parse(firstText) as Record<string, unknown>;
		expect(Object.keys(firstBody).sort()).toEqual([
			"operationId",
			"protocolVersion",
			"requestHash",
			"sessionId",
			"treePatch",
		]);
		expect(firstBody).toMatchObject({
			protocolVersion: 2,
			sessionId: "compact-v2-payload",
			operationId: "compact-v2-payload-operation",
			requestHash: compactRequestHash(requestBody),
		});
		expect(firstBody).not.toHaveProperty("success");
		expect(firstBody).not.toHaveProperty("compaction");
		expect(firstBody).not.toHaveProperty("compactionEntry");
		expect(firstBody).not.toHaveProperty("staticContext");
		expect(firstBody).not.toHaveProperty("entries");
		expect(firstBody).not.toHaveProperty("messages");

		const treePatch = firstBody.treePatch as {
			baseTreeHash: string;
			entriesFrom: number;
			entries: Array<Record<string, unknown>>;
			leafId: string;
			revision: number;
			treeHash: string;
		};
		expect(Object.keys(treePatch).sort()).toEqual([
			"baseEntryCount",
			"baseLeafId",
			"baseRevision",
			"baseStaticContextHash",
			"baseTreeHash",
			"entries",
			"entriesFrom",
			"leafId",
			"revision",
			"treeHash",
		]);
		expect(treePatch.baseTreeHash).toBe(syncBody.treeHash);
		expect(treePatch.entriesFrom).toBe(2);
		expect(treePatch.entries).toHaveLength(1);
		expect(treePatch.leafId).toBe(treePatch.entries[0]?.id);
		const compactionEntry = treePatch.entries[0];
		expect(compactionEntry).toMatchObject({
			type: "compaction",
			summary: "authoritative summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			retainedTail: [{ role: "user", content: uniqueRetainedContent, timestamp: 3000 }],
			details: { source: "provider" },
			usage,
			piServerCompactOperation: {
				version: 1,
				operationId: "compact-v2-payload-operation",
				requestHash: compactRequestHash(requestBody),
				baseTreeHash: syncBody.treeHash,
				baseEntryCount: 2,
				baseLeafId: "u2",
			},
		});
		expect(compactionEntry).not.toHaveProperty("fromHook");
		expect(firstText.split(uniqueRetainedContent)).toHaveLength(2);

		const storedSession = getSession("compact-v2-payload");
		expect(storedSession?.entries.at(-1)).toEqual(compactionEntry);
		expect(treePatch.treeHash).toBe(storedSession?.treeHash);
		expect(treePatch.revision).toBe(storedSession?.revision);

		const replayResponse = await postCompact();
		expect(replayResponse.status).toBe(200);
		const replayText = await replayResponse.text();
		expect(replayText.trim()).toBe(firstText.trim());
		expect(vi.mocked(compactAgentCore).mock.calls.length - callCountBefore).toBe(1);
		expect(storedSession?.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("commits a validated extension compaction without invoking the provider", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
			{
				type: "message" as const,
				id: "sibling",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user" as const, content: "inactive sibling", timestamp: 3000 },
			},
		];
		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "extension-compact", entries, leafId: "u2" }),
		});
		const syncBody = (await sync.json()) as ServerResponse;
		if (!syncBody.treeHash) throw new Error("Tree sync response did not include treeHash");

		const baseRequest = createCompactRequest("extension-compact", "extension-compact-unused", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		const invalid = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				...baseRequest,
				operationId: "extension-compact-invalid",
				extensionCompaction: {
					summary: "invalid sibling summary",
					firstKeptEntryId: "sibling",
					tokensBefore: 10,
				},
			}),
		});
		expect(invalid.status).toBe(400);
		expect((await invalid.json()) as ServerResponse).toMatchObject({
			error: "extensionCompaction.firstKeptEntryId must reference the active session branch",
		});

		const extensionUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const valid = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				...baseRequest,
				operationId: "extension-compact-valid",
				extensionCompaction: {
					summary: "extension summary",
					firstKeptEntryId: "u1",
					tokensBefore: 10,
					usage: extensionUsage,
					details: { source: "extension" },
				},
			}),
		});
		expect(valid.status).toBe(200);
		const validBody = (await valid.json()) as ServerResponse;
		const compactionEntry = validBody.treePatch?.entries[0] as Record<string, unknown>;
		expect(compactionEntry).toMatchObject({
			type: "compaction",
			summary: "extension summary",
			firstKeptEntryId: "u1",
			tokensBefore: 10,
			usage: extensionUsage,
			details: { source: "extension" },
			fromHook: true,
		});
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession("extension-compact")?.entries.at(-1)).toEqual(compactionEntry);
	});

	it("does not commit a compaction prepared from a stale session tree", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "stale-compact", entries, leafId: "u2" }),
		});

		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCompact = resolve;
				}),
		);
		const requestBody = createCompactRequest("stale-compact", "stale-compact-operation", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const compactResponse = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(requestBody),
		});

		const appendedEntry = {
			type: "message" as const,
			id: "u3",
			parentId: "u2",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user" as const, content: "concurrent", timestamp: 3000 },
		};
		const append = await fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "stale-compact", entries: [appendedEntry], leafId: "u3" }),
		});
		expect(append.status).toBe(200);

		if (!resolveCompact) throw new Error("Compact mock did not start");
		resolveCompact({
			ok: true,
			value: { summary: "stale summary", firstKeptEntryId: "u2", tokensBefore: 10 },
		});
		const compactBody = JSON.parse(await compactResponse.text()) as ServerResponse;
		expect(compactBody.error).toBe(
			"Session changed while compaction was running; the stale compaction was not committed",
		);
		expect(getSession("stale-compact")?.entries).toEqual([...entries, appendedEntry]);
	});

	it("reuses one running compaction for duplicate operation ids", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-operation", entries, leafId: "u2" }),
		});

		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCompact = resolve;
				}),
		);
		const requestBody = createCompactRequest("compact-operation", "operation-1", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const postCompact = () =>
			fetch(`${baseUrl}/api/session/compact`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify(requestBody),
			});
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;
		const first = await postCompact();
		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 7 * 60 * 60_000);
		let duplicate: Response;
		try {
			duplicate = await postCompact();
		} finally {
			dateNow.mockRestore();
		}

		if (!resolveCompact) throw new Error("Compact mock did not start");
		resolveCompact({
			ok: true,
			value: { summary: "shared summary", firstKeptEntryId: "u2", tokensBefore: 10 },
		});
		const [firstBody, duplicateBody] = await Promise.all([first.text(), duplicate.text()]);
		expect(duplicateBody).toBe(firstBody);
		expect(vi.mocked(compactAgentCore).mock.calls.length - callCountBefore).toBe(1);
		expect(getSession("compact-operation")?.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);

		const conflicting = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ ...requestBody, customInstructions: "different request" }),
		});
		expect(conflicting.status).toBe(409);
		expect((await conflicting.json()) as ServerResponse).toMatchObject({
			error: "operationId is already bound to a different compaction request",
		});
	});

	it("recovers an interrupted durable compaction as restart-unknown without invoking the provider", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "compact-restart-running", entries, leafId: "u2" }),
		});
		const requestBody = createCompactRequest(
			"compact-restart-running",
			"compact-restart-operation",
			compactTestModel,
			{
				streamResponse: true,
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		const requestHash = compactRequestHash(requestBody);
		const callCountBefore = vi.mocked(compactAgentCore).mock.calls.length;

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		clearAllSessions();
		const interruptedStore = new StreamRunPersistence({
			rootDir: join(sessionStoreDir, ".compactions"),
			lockPath: join(sessionStoreDir, ".pi-server-compact-owner.sqlite"),
			restartFailureMessage: "manual interrupted compact",
			restartFailureEvent: JSON.stringify({ error: "manual interrupted compact" }),
		});
		await interruptedStore.initialize();
		await interruptedStore.begin({
			sessionId: "compact-restart-running",
			runId: "compact-restart-operation",
			requestMac: requestHash,
		});
		await interruptedStore.close();

		server = createPiServer({ authToken: "test-token", sessionStoreDir, uploadDir } as Partial<ServerConfig>);
		server.listen(0);
		const address = server.address();
		if (typeof address !== "object" || address === null) {
			throw new Error("Failed to get compact-recovery server address");
		}
		baseUrl = `http://127.0.0.1:${address.port}`;

		const recovery = await fetch(
			`${baseUrl}/api/session/compact-restart-running/compactions/compact-restart-operation?requestHash=${requestHash}`,
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(recovery.status).toBe(200);
		const recoveryBody = await recovery.text();
		expect(recoveryBody).toContain("event: error");
		expect(recoveryBody).toContain(
			"restart-unknown: pi-server restarted before compaction reached a durable terminal state",
		);
		expect(recoveryBody).toContain(`"operationId":"compact-restart-operation"`);
		expect(recoveryBody).toContain(`"requestHash":"${requestHash}"`);

		const replay = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(requestBody),
		});
		expect(await replay.text()).toBe(recoveryBody);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBefore);
		expect(getSession("compact-restart-running")?.entries).toEqual(entries);

		const acknowledgement = await fetch(`${baseUrl}/api/session/compact/ack`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "compact-restart-running",
				operationId: "compact-restart-operation",
				requestHash,
			}),
		});
		expect(await acknowledgement.json()).toMatchObject({
			acknowledged: true,
			sessionId: "compact-restart-running",
			operationId: "compact-restart-operation",
			requestHash,
			status: "failed",
		});

		vi.mocked(compactAgentCore).mockImplementationOnce(async () => ({
			ok: true,
			value: { summary: "new operation", firstKeptEntryId: "u2", tokensBefore: 10 },
		}));
		const nextRequest = createCompactRequest(
			"compact-restart-running",
			"compact-after-restart-failure",
			compactTestModel,
			{
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u2" },
			},
		);
		const nextResponse = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(nextRequest),
		});
		expect(nextResponse.status).toBe(200);
		expect((await nextResponse.json()) as ServerResponse).toMatchObject({
			operationId: "compact-after-restart-failure",
			treePatch: { entries: [expect.objectContaining({ summary: "new operation" })] },
		});
		expect(vi.mocked(compactAgentCore).mock.calls.length - callCountBefore).toBe(1);
	});

	it("cancels a running compaction without committing its result", async () => {
		const entries = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "old", timestamp: 1000 },
			},
			{
				type: "message" as const,
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user" as const, content: "keep", timestamp: 2000 },
			},
		];
		await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-compact", entries, leafId: "u2" }),
		});

		let compactSignal: AbortSignal | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			(_preparation, _models, _model, _customInstructions, signal) => {
				compactSignal = signal;
				return new Promise(() => {});
			},
		);
		const requestBody = createCompactRequest("cancel-compact", "cancel-operation", compactTestModel, {
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const requestHash = compactRequestHash(requestBody);
		const compactResponse = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(requestBody),
		});

		const cancel = await fetch(`${baseUrl}/api/session/compact/cancel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-compact", operationId: "cancel-operation", requestHash }),
		});
		expect(await cancel.json()).toMatchObject({
			canceled: true,
			status: "failed",
			sessionId: "cancel-compact",
			operationId: "cancel-operation",
			requestHash,
			resultStatus: 499,
			terminal: {
				protocolVersion: 2,
				sessionId: "cancel-compact",
				operationId: "cancel-operation",
				requestHash,
				status: "failed",
				httpStatus: 499,
				operationDisposition: "terminal",
				error: "Compaction aborted by user",
			},
		});
		expect(compactSignal?.aborted).toBe(true);
		expect(JSON.parse(await compactResponse.text())).toMatchObject({
			protocolVersion: 2,
			sessionId: "cancel-compact",
			operationId: "cancel-operation",
			requestHash,
			status: "failed",
			httpStatus: 499,
			operationDisposition: "terminal",
			error: "Compaction aborted by user",
		});
		expect(getSession("cancel-compact")?.entries).toEqual(entries);

		const duplicateCancel = await fetch(`${baseUrl}/api/session/compact/cancel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-compact", operationId: "cancel-operation", requestHash }),
		});
		expect(await duplicateCancel.json()).toMatchObject({
			canceled: false,
			status: "failed",
			sessionId: "cancel-compact",
			operationId: "cancel-operation",
			requestHash,
			resultStatus: 499,
		});
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
			body: JSON.stringify(
				createCompactRequest("compact-stream", "compact-stream-operation", compactTestModel, {
					streamResponse: true,
					settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
					preparation: { firstKeptEntryId: "u2" },
				}),
			),
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
		expect(body).toContain('"protocolVersion":2');
		expect(body).toContain('"summary":"summary"');
	});

	it("detaches a stalled compact subscriber without canceling the authoritative operation", async () => {
		await replaceServer({ streamDrainIdleTimeoutMs: 20 });
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
			body: JSON.stringify({ sessionId: "stalled-compact", entries, leafId: "u2" }),
		});

		let resolveCompact: ((value: Awaited<ReturnType<typeof compactAgentCore>>) => void) | undefined;
		vi.mocked(compactAgentCore).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCompact = resolve;
				}),
		);
		const requestBody = createCompactRequest("stalled-compact", "stalled-operation", compactTestModel, {
			streamResponse: true,
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
			preparation: { firstKeptEntryId: "u2" },
		});
		const encodedRequest = JSON.stringify(requestBody);
		let interceptCompactSubscriber = true;
		let markServerSubscriberClosed: (() => void) | undefined;
		let interceptedServerResponse: HttpServerResponse | undefined;
		const serverSubscriberClosed = new Promise<void>((resolve) => {
			markServerSubscriberClosed = resolve;
		});
		server.prependListener("request", (request, response) => {
			if (!interceptCompactSubscriber || request.url !== "/api/session/compact") return;
			interceptCompactSubscriber = false;
			interceptedServerResponse = response;
			response.once("close", () => markServerSubscriberClosed?.());
		});
		const stalledResponse = await new Promise<IncomingMessage>((resolve, reject) => {
			const request = httpRequest(
				`${baseUrl}/api/session/compact`,
				{
					method: "POST",
					headers: {
						Authorization: "Bearer test-token",
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(encodedRequest),
					},
				},
				(response) => {
					response.pause();
					resolve(response);
				},
			);
			request.once("error", reject);
			request.end(encodedRequest);
		});
		stalledResponse.once("error", () => {});
		interceptedServerResponse?.socket?.cork();
		const callCountBeforeResult = vi.mocked(compactAgentCore).mock.calls.length;
		if (!resolveCompact) throw new Error("Compact mock did not start");
		const largeSummary = "s".repeat(4 * 1024 * 1024);
		resolveCompact({
			ok: true,
			value: { summary: largeSummary, firstKeptEntryId: "u2", tokensBefore: 10 },
		});

		await Promise.race([
			serverSubscriberClosed,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out detaching stalled compact subscriber")), 2000),
			),
		]);
		await vi.waitFor(() => {
			const compactionEntries =
				getSession("stalled-compact")?.entries.filter((entry) => entry.type === "compaction") ?? [];
			expect(compactionEntries).toHaveLength(1);
		});

		const replay = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: encodedRequest,
		});
		const replayBody = await replay.text();
		expect(replay.status).toBe(200);
		expect(replayBody).toContain("event: result");
		expect(replayBody).toContain(largeSummary);
		expect(vi.mocked(compactAgentCore).mock.calls.length).toBe(callCountBeforeResult);
		stalledResponse.destroy();
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
			body: JSON.stringify(
				createCompactRequest("compact-json-stream", "compact-json-stream-operation", compactTestModel, {
					settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
					preparation: { firstKeptEntryId: "u2" },
				}),
			),
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
		expect(getSession("compact-json-stream")?.entries).toHaveLength(3);
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

	it("returns a bounded error for malformed encoded paths and remains healthy", async () => {
		const malformed = await fetch(`${baseUrl}/api/session/%/history`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(malformed.status).toBe(400);
		expect((await malformed.json()) as ServerResponse).toMatchObject({
			error: "URI malformed",
		});

		const health = await fetch(`${baseUrl}/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ status: "ok" });
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
				baseStaticContextHash: "",
				baseRevision: 0,
				providerExecutionFingerprint: executionFingerprint(compactTestModel),
				model: compactTestModel,
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
		const heartbeatSession = getSession("stream-heartbeat");
		if (!heartbeatSession) throw new Error("Heartbeat session was not initialized");
		const heartbeatModel = { ...compactTestModel, baseUrl: "http://127.0.0.1:1" };

		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-heartbeat",
				baseStaticContextHash: heartbeatSession.staticContextHash,
				baseRevision: heartbeatSession.revision,
				baseTreeHash: heartbeatSession.treeHash,
				baseEntryCount: heartbeatSession.entries.length,
				baseLeafId: heartbeatSession.leafId,
				providerExecutionFingerprint: executionFingerprint(heartbeatModel),
				model: heartbeatModel,
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

	it("validates large text and thinking delta sequences incrementally and preserves authoritative mismatches", async () => {
		const faux = registerFauxProvider();
		const textDelta = "文".repeat(256);
		const thinkingDelta = "理".repeat(256);
		const deltaCount = 2048;
		const textContent = textDelta.repeat(deltaCount);
		const thinkingContent = thinkingDelta.repeat(deltaCount);
		const authoritativeMismatch = "authoritative final content";
		const finalMessage = fauxAssistantMessage([
			fauxText(textContent),
			fauxThinking(thinkingContent),
			fauxText(authoritativeMismatch),
		]);
		const createGeneratedStream = () =>
			generatedAssistantMessageEventStream(async function* () {
				yield { type: "start", partial: finalMessage };
				yield { type: "text_start", contentIndex: 0, partial: finalMessage };
				for (let index = 0; index < deltaCount; index++) {
					yield { type: "text_delta", contentIndex: 0, delta: textDelta, partial: finalMessage };
				}
				yield { type: "text_end", contentIndex: 0, content: textContent, partial: finalMessage };
				yield { type: "thinking_start", contentIndex: 1, partial: finalMessage };
				for (let index = 0; index < deltaCount; index++) {
					yield { type: "thinking_delta", contentIndex: 1, delta: thinkingDelta, partial: finalMessage };
				}
				yield { type: "thinking_end", contentIndex: 1, content: thinkingContent, partial: finalMessage };
				yield { type: "text_start", contentIndex: 2, partial: finalMessage };
				yield { type: "text_delta", contentIndex: 2, delta: "incorrect delta", partial: finalMessage };
				yield {
					type: "text_end",
					contentIndex: 2,
					content: authoritativeMismatch,
					partial: finalMessage,
				};
				yield { type: "done", reason: "stop", message: finalMessage };
			});
		registerApiProvider({
			api: faux.api,
			stream: createGeneratedStream,
			streamSimple: createGeneratedStream,
		});
		await initStreamSession("incremental-content-validation");

		const response = await postStream("incremental-content-validation", "incremental-content-run", faux.models[0]);
		const events = (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
		const matchingTextEnd = events.find((event) => event.type === "text_end" && event.contentIndex === 0);
		const matchingThinkingEnd = events.find((event) => event.type === "thinking_end" && event.contentIndex === 1);
		const mismatchingTextEnd = events.find((event) => event.type === "text_end" && event.contentIndex === 2);
		expect(response.status).toBe(200);
		expect(events.filter((event) => event.type === "text_delta")).toHaveLength(deltaCount + 1);
		expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(deltaCount);
		expect(matchingTextEnd).not.toHaveProperty("content");
		expect(matchingThinkingEnd).not.toHaveProperty("content");
		expect(mismatchingTextEnd).toMatchObject({ content: authoritativeMismatch });
		expect(events.at(-1)).toMatchObject({ type: "done" });
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
			responseModel: "resolved-journal-model",
			responseId: "response-journal-1",
			diagnostics: [
				{
					type: "provider_transport_failure",
					timestamp: 999,
					error: { name: "Error", message: "websocket fallback" },
					details: { transport: "websocket", fallback: "sse" },
				},
			],
			timestamp: 1000,
		};
		faux.setResponses([journaledMessage]);
		const runId = "run-journal-1";

		await initStreamSession("stream-run-journal");

		const res = await postStream("stream-run-journal", runId, faux.models[0]);
		expect(res.status).toBe(200);
		const originalEvents = await res.text();
		await restartServer();

		const runRes = await fetch(`${baseUrl}/api/session/stream-run-journal/runs/${runId}`, {
			headers: { Authorization: "Bearer test-token" },
		});

		expect(runRes.status).toBe(200);
		const runBody = (await runRes.json()) as RunResponse;
		expect(runBody.status).toBe("completed");
		expect(runBody.requestMac).toMatch(/^[a-f0-9]{64}$/);
		expect(runBody.nextSeq).toBeGreaterThan(0);
		expect(runBody.message?.role).toBe("assistant");
		expect(runBody.message?.content).toEqual([{ type: "text", text: "journaled" }]);
		expect(runBody).not.toHaveProperty("events");

		const terminalEvent = originalEvents
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
			.find((event) => event.type === "done");
		expect(terminalEvent).toMatchObject({
			responseModel: "resolved-journal-model",
			responseId: "response-journal-1",
		});
		const terminalDiagnostics = terminalEvent?.diagnostics;
		expect(terminalDiagnostics).toEqual([
			...(journaledMessage.diagnostics ?? []),
			expect.objectContaining({
				type: "pi_server_run",
				details: expect.objectContaining({
					sessionId: "stream-run-journal",
					runId,
					requestMac: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		]);
		if (runBody.message?.role !== "assistant") throw new Error("Recovered run did not include an assistant message");
		expect(runBody.message.diagnostics).toEqual(terminalDiagnostics);

		const allDataEvents = originalEvents.split("\n").filter((line) => line.startsWith("data: "));
		const suffixResponse = await fetch(`${baseUrl}/api/session/stream-run-journal/runs/${runId}/events?from=1`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(suffixResponse.status).toBe(200);
		expect((await suffixResponse.text()).split("\n").filter((line) => line.startsWith("data: "))).toEqual(
			allDataEvents.slice(1),
		);

		const replay = await postStream("stream-run-journal", runId, faux.models[0]);
		expect(await replay.text()).toBe(originalEvents);
		expect(faux.state.callCount).toBe(1);
		expect(getSession("stream-run-journal")?.entries).toHaveLength(0);
	});

	it("durably begins a run after a reliable 404 and before provider execution", async () => {
		const faux = registerFauxProvider();
		const sessionId = "durable-run-begin";
		const runId = "durable-run";
		faux.setResponses([
			() => {
				const runDirectory = join(sessionStoreDir, ".runs", sha256(`${sessionId}\0${runId}`));
				expect(existsSync(join(runDirectory, "events.bin"))).toBe(true);
				expect(readdirSync(runDirectory).some((name) => /^meta-\d{16}\.json$/.test(name))).toBe(true);
				return fauxAssistantMessage("durably started");
			},
		]);
		await initStreamSession(sessionId);
		const missing = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(missing.status).toBe(404);

		const response = await postStream(sessionId, runId, faux.models[0]);
		expect(response.status).toBe(200);
		await response.text();
		expect(faux.state.callCount).toBe(1);
	});

	it("replays a failed stream run without invoking the provider again or logging request secrets", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
			fauxAssistantMessage("must not run"),
		]);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		const init = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "failed-run-replay",
				staticContext: { systemPrompt: "TOP_SECRET_PROMPT" },
			}),
		});
		expect(init.status).toBe(200);
		const failedReplaySession = getSession("failed-run-replay");
		if (!failedReplaySession) throw new Error("Failed replay session was not initialized");

		const request = {
			sessionId: "failed-run-replay",
			runId: "failed-run",
			baseStaticContextHash: failedReplaySession.staticContextHash,
			baseRevision: failedReplaySession.revision,
			baseTreeHash: failedReplaySession.treeHash,
			baseEntryCount: failedReplaySession.entries.length,
			baseLeafId: failedReplaySession.leafId,
			model: faux.models[0],
			providerExecutionFingerprint: executionFingerprint(faux.models[0]),
			options: { apiKey: "TOP_SECRET_TOKEN" },
		};
		const first = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(request),
		});
		const firstEvents = await first.text();
		expect(firstEvents).toContain('"type":"error"');
		expect(firstEvents).toContain("provider exploded");
		const persistedRunData = readPersistedDirectory(join(sessionStoreDir, ".runs"));
		expect(persistedRunData).not.toContain("TOP_SECRET_PROMPT");
		expect(persistedRunData).not.toContain("TOP_SECRET_TOKEN");
		await restartServer();

		const replay = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(request),
		});
		expect(await replay.text()).toBe(firstEvents);
		expect(faux.state.callCount).toBe(1);
		expect(faux.getPendingResponseCount()).toBe(1);

		expect(stderr).toHaveBeenCalledTimes(1);
		const logLine = String(stderr.mock.calls[0]?.[0]);
		expect(JSON.parse(logLine)).toEqual({
			phase: "provider_stream",
			sessionId: "failed-run-replay",
			runId: "failed-run",
			model: {
				provider: faux.models[0].provider,
				id: faux.models[0].id,
				api: faux.models[0].api,
			},
			error: "provider exploded",
		});
		expect(logLine).not.toContain("TOP_SECRET_PROMPT");
		expect(logLine).not.toContain("TOP_SECRET_TOKEN");
		stderr.mockRestore();
	});

	it("lets duplicate requests follow one running provider stream", async () => {
		const faux = registerFauxProvider();
		let resolveProvider: ((message: AssistantMessage) => void) | undefined;
		const providerResult = new Promise<AssistantMessage>((resolve) => {
			resolveProvider = resolve;
		});
		faux.setResponses([() => providerResult]);
		await initStreamSession("running-run-replay");

		const first = await postStream("running-run-replay", "running-run", faux.models[0]);
		const duplicate = await postStream("running-run-replay", "running-run", faux.models[0]);
		expect(faux.state.callCount).toBe(1);

		if (!resolveProvider) throw new Error("Provider response did not start");
		resolveProvider(fauxAssistantMessage("shared terminal result"));
		const [firstEvents, duplicateEvents] = await Promise.all([first.text(), duplicate.text()]);
		expect(duplicateEvents).toBe(firstEvents);
		const text = firstEvents
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string })
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta ?? "")
			.join("");
		expect(text).toBe("shared terminal result");
		expect(faux.state.callCount).toBe(1);
	});

	it("lets GET events attach to a running provider stream without the request body", async () => {
		const faux = registerFauxProvider();
		let resolveProvider: ((message: AssistantMessage) => void) | undefined;
		faux.setResponses([
			() =>
				new Promise<AssistantMessage>((resolve) => {
					resolveProvider = resolve;
				}),
		]);
		await initStreamSession("running-events-replay");
		const initial = await postStream("running-events-replay", "events-run", faux.models[0]);
		if (!initial.body) throw new Error("Initial provider response body is missing");
		const initialReader = initial.body.getReader();
		await initialReader.read();
		await initialReader.cancel();

		const replay = await fetch(`${baseUrl}/api/session/running-events-replay/runs/events-run/events?from=0`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(replay.status).toBe(200);
		if (!resolveProvider) throw new Error("Provider response did not start");
		resolveProvider(fauxAssistantMessage("replayed from durable events"));
		const replayEvents = await replay.text();
		const replayedText = replayEvents
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string })
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta ?? "")
			.join("");
		expect(replayedText).toBe("replayed from durable events");
		expect(replayEvents).toContain('"type":"done"');
		expect(faux.state.callCount).toBe(1);
	});

	it("recovers an interrupted running stream as restart-unknown without invoking the provider again", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {}), fauxAssistantMessage("must not run")]);
		await initStreamSession("restart-running-run");
		const initial = await postStream("restart-running-run", "restart-run", faux.models[0]);
		if (!initial.body) throw new Error("Initial provider response body is missing");
		const reader = initial.body.getReader();
		await reader.read();
		await reader.cancel();

		await restartServer();
		const statusResponse = await fetch(`${baseUrl}/api/session/restart-running-run/runs/restart-run`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(statusResponse.status).toBe(200);
		const status = (await statusResponse.json()) as RunResponse;
		expect(status).toMatchObject({
			status: "failed",
			errorMessage: "restart-unknown",
			requestMac: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		if (status.message?.role !== "assistant") {
			throw new Error("Restart recovery did not return an assistant message");
		}
		const restartDiagnostic = status.message.diagnostics?.find((diagnostic) => diagnostic.type === "pi_server_run");
		expect(restartDiagnostic?.details).toMatchObject({
			sessionId: "restart-running-run",
			runId: "restart-run",
			requestMac: status.requestMac,
			restartUnknown: true,
		});

		const eventsResponse = await fetch(`${baseUrl}/api/session/restart-running-run/runs/restart-run/events?from=0`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const events = await eventsResponse.text();
		const terminal = events
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
			.find((event) => event.type === "error");
		expect(terminal).toMatchObject({
			errorMessage: "restart-unknown",
			diagnostics: status.message.diagnostics,
		});

		const replay = await postStream("restart-running-run", "restart-run", faux.models[0]);
		expect(await replay.text()).toBe(events);
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects a reused run id when the stream request body differs", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("original")]);
		await initStreamSession("run-request-binding");

		const first = await postStream("run-request-binding", "bound-run", faux.models[0]);
		expect(first.status).toBe(200);
		await first.text();
		const boundSession = getSession("run-request-binding");
		if (!boundSession) throw new Error("Bound run session was not initialized");

		const conflicting = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "run-request-binding",
				runId: "bound-run",
				baseStaticContextHash: boundSession.staticContextHash,
				baseRevision: boundSession.revision,
				baseTreeHash: boundSession.treeHash,
				baseEntryCount: boundSession.entries.length,
				baseLeafId: boundSession.leafId,
				model: faux.models[0],
				providerExecutionFingerprint: executionFingerprint(faux.models[0]),
				options: { temperature: 0.75 },
			}),
		});

		expect(conflicting.status).toBe(409);
		expect((await conflicting.json()) as ServerResponse).toMatchObject({
			error: "runId is already bound to a different stream request",
		});
		const revisionConflict = await postStream("run-request-binding", "bound-run", faux.models[0], {
			baseRevision: boundSession.revision + 1,
		});
		expect(revisionConflict.status).toBe(409);
		const staticContextConflict = await postStream("run-request-binding", "bound-run", faux.models[0], {
			baseStaticContextHash: "0".repeat(64),
		});
		expect(staticContextConflict.status).toBe(409);
		expect(faux.state.callCount).toBe(1);
	});

	it("binds a run id to the provider execution fingerprint but not the event cursor", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("fingerprinted"), fauxAssistantMessage("must not run")]);
		await initStreamSession("provider-fingerprint-binding");
		const fingerprint = executionFingerprint(faux.models[0]);
		const first = await postStream("provider-fingerprint-binding", "fingerprinted-run", faux.models[0], {
			providerExecutionFingerprint: fingerprint,
		});
		const firstEvents = await first.text();
		const replay = await postStream("provider-fingerprint-binding", "fingerprinted-run", faux.models[0], {
			eventCursor: 1,
			providerExecutionFingerprint: fingerprint,
		});
		expect(replay.status).toBe(200);
		expect((await replay.text()).split("\n").filter((line) => line.startsWith("data: "))).toEqual(
			firstEvents
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.slice(1),
		);

		const conflict = await postStream("provider-fingerprint-binding", "fingerprinted-run", faux.models[0], {
			providerExecutionFingerprint: "b".repeat(64),
		});
		expect(conflict.status).toBe(409);
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects missing, mismatched, model-mismatched, and custom stream execution routes before durable begin", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("valid execution")]);
		const sessionId = "stream-provider-parity";
		await initStreamSession(sessionId);
		const session = getSession(sessionId);
		if (!session) throw new Error("Provider parity session was not initialized");
		const validFingerprint = hashRemoteProviderExecution(faux.models[0], {
			kind: "builtin_api",
			id: faux.models[0].api,
		});
		const post = (runId: string, model: Model<any>, providerExecutionFingerprint?: string) =>
			fetch(`${baseUrl}/api/stream`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({
					sessionId,
					runId,
					baseStaticContextHash: session.staticContextHash,
					baseRevision: session.revision,
					baseTreeHash: session.treeHash,
					baseEntryCount: session.entries.length,
					baseLeafId: session.leafId,
					model,
					providerExecutionFingerprint,
				}),
			});

		const missing = await post("missing-fingerprint", faux.models[0]);
		expect(missing.status).toBe(409);
		const mismatched = await post("mismatched-fingerprint", faux.models[0], "0".repeat(64));
		expect(mismatched.status).toBe(409);
		const modelMismatched = await post(
			"model-mismatched-fingerprint",
			{ ...faux.models[0], id: `${faux.models[0].id}-different` },
			validFingerprint,
		);
		expect(modelMismatched.status).toBe(409);
		vi.mocked(getCompatProviderExecutionRoute).mockImplementationOnce(() => ({
			kind: "custom_api",
			id: faux.models[0].api,
		}));
		const customRoute = await post("custom-route", faux.models[0], validFingerprint);
		expect(customRoute.status).toBe(409);
		expect(faux.state.callCount).toBe(0);

		for (const runId of [
			"missing-fingerprint",
			"mismatched-fingerprint",
			"model-mismatched-fingerprint",
			"custom-route",
		]) {
			const status = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(status.status).toBe(404);
		}

		const valid = await post("valid-fingerprint", faux.models[0], validFingerprint);
		expect(valid.status).toBe(200);
		await valid.text();
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects over-capacity stream context before durable begin or provider execution", async () => {
		await replaceServer({ sessionMaxLogicalBytes: 1000 });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("must not run")]);
		const sessionId = "stream-capacity-preflight";
		const runId = "stream-capacity-run";
		await initStreamSession(sessionId);
		const before = getSession(sessionId);
		if (!before) throw new Error("Stream capacity session was not initialized");
		const beforeIdentity = {
			staticContextHash: before.staticContextHash,
			treeHash: before.treeHash,
			revision: before.revision,
			logicalBytes: before.logicalBytes,
		};

		const response = await postStream(sessionId, runId, faux.models[0], {
			staticContext: { systemPrompt: "x".repeat(2000) },
		});
		expect(response.status).toBe(507);
		expect((await response.json()) as ServerResponse).toMatchObject({
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			resource: "session_logical_bytes",
			sessionId,
			current: before.logicalBytes,
			limit: 1000,
			retryable: false,
		});
		expect(faux.state.callCount).toBe(0);
		expect(getSession(sessionId)).toMatchObject(beforeIdentity);

		const run = await fetch(`${baseUrl}/api/session/${sessionId}/runs/${runId}`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(run.status).toBe(404);
	});

	it("rejects missing-session stream bases and capacity without leaking loaded sessions", async () => {
		await replaceServer({ maxLoadedSessions: 1, sessionMaxLogicalBytes: 1000 });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("must not run")]);
		const postMissingStream = (sessionId: string, treeHash: string, systemPrompt: string) =>
			fetch(`${baseUrl}/api/stream`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({
					sessionId,
					runId: `${sessionId}-run`,
					providerExecutionFingerprint: executionFingerprint(faux.models[0]),
					baseStaticContextHash: "",
					baseRevision: 0,
					baseTreeHash: treeHash,
					baseEntryCount: 0,
					baseLeafId: null,
					staticContext: { systemPrompt },
					model: faux.models[0],
				}),
			});

		for (const sessionId of ["missing-stale-a", "missing-stale-b"]) {
			const stale = await postMissingStream(sessionId, "0".repeat(64), "small");
			expect(stale.status).toBe(409);
			expect(getSession(sessionId)).toBeUndefined();
		}
		const oversized = await postMissingStream("missing-oversized", PI_SERVER_EMPTY_TREE_HASH, "x".repeat(2000));
		expect(oversized.status).toBe(507);
		expect(getSession("missing-oversized")).toBeUndefined();
		expect(faux.state.callCount).toBe(0);

		const valid = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "loaded-capacity-remains",
				staticContext: { systemPrompt: "valid" },
			}),
		});
		expect(valid.status).toBe(200);
	});

	it("rejects a stale or missing tree base before durable begin and provider execution", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("current tree")]);
		await initStreamSession("stream-tree-binding");
		const stale = getSession("stream-tree-binding");
		if (!stale) throw new Error("Stream tree binding session was not initialized");
		const staleBase = {
			treeHash: stale.treeHash,
			entryCount: stale.entries.length,
			leafId: stale.leafId,
		};
		const append = await fetch(`${baseUrl}/api/session/tree/append`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-tree-binding",
				entries: [
					{
						type: "message",
						id: "tree-binding-u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "new tree", timestamp: 1000 },
					},
				],
				leafId: "tree-binding-u1",
			}),
		});
		expect(append.status).toBe(200);

		const staleResponse = await postStream("stream-tree-binding", "stale-tree-run", faux.models[0], {
			baseTreeHash: staleBase.treeHash,
			baseEntryCount: staleBase.entryCount,
			baseLeafId: staleBase.leafId,
		});
		expect(staleResponse.status).toBe(409);
		expect(faux.state.callCount).toBe(0);
		const missingResponse = await postStream("stream-tree-binding", "missing-tree-run", faux.models[0], {
			baseTreeHash: undefined,
			baseEntryCount: undefined,
			baseLeafId: undefined,
		});
		expect(missingResponse.status).toBe(400);
		expect(faux.state.callCount).toBe(0);

		const current = await postStream("stream-tree-binding", "current-tree-run", faux.models[0]);
		expect(current.status).toBe(200);
		await current.text();
		expect(faux.state.callCount).toBe(1);
	});

	it("requires and validates the static-context and revision base before provider execution", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("current identity")]);
		await initStreamSession("stream-session-identity");
		const stale = getSession("stream-session-identity");
		if (!stale) throw new Error("Stream identity session was not initialized");
		const staleStaticContextHash = stale.staticContextHash;
		const staleRevision = stale.revision;

		const update = await fetch(`${baseUrl}/api/session/update`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "stream-session-identity",
				staticContext: { systemPrompt: "updated identity" },
			}),
		});
		expect(update.status).toBe(200);
		const currentSession = getSession("stream-session-identity");
		if (!currentSession) throw new Error("Updated stream identity session is missing");

		const staleHash = await postStream("stream-session-identity", "stale-static-run", faux.models[0], {
			baseStaticContextHash: staleStaticContextHash,
			baseRevision: currentSession.revision,
		});
		expect(staleHash.status).toBe(409);
		expect(faux.state.callCount).toBe(0);

		const staleRevisionResponse = await postStream("stream-session-identity", "stale-revision-run", faux.models[0], {
			baseStaticContextHash: currentSession.staticContextHash,
			baseRevision: staleRevision,
		});
		expect(staleRevisionResponse.status).toBe(409);
		expect(faux.state.callCount).toBe(0);

		const missingHash = await postStream("stream-session-identity", "missing-static-run", faux.models[0], {
			baseStaticContextHash: undefined,
		});
		expect(missingHash.status).toBe(400);
		expect((await missingHash.json()) as ServerResponse).toMatchObject({
			error: "baseStaticContextHash is required",
		});

		const missingRevision = await postStream("stream-session-identity", "missing-revision-run", faux.models[0], {
			baseRevision: undefined,
		});
		expect(missingRevision.status).toBe(400);
		expect((await missingRevision.json()) as ServerResponse).toMatchObject({
			error: "baseRevision is required",
		});
		expect(faux.state.callCount).toBe(0);

		const current = await postStream("stream-session-identity", "current-identity-run", faux.models[0]);
		expect(current.status).toBe(200);
		await current.text();
		expect(faux.state.callCount).toBe(1);
	});

	it("serializes concurrent new run ids so only one provider executes per session", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {})]);
		await initStreamSession("concurrent-run-begin");
		const [left, right] = await Promise.all([
			postStream("concurrent-run-begin", "left-run", faux.models[0]),
			postStream("concurrent-run-begin", "right-run", faux.models[0]),
		]);
		const successful = left.status === 200 ? left : right;
		const blocked = left.status === 409 ? left : right;
		expect(successful.status).toBe(200);
		expect(blocked.status).toBe(409);
		expect((await blocked.json()) as ServerResponse).toMatchObject({
			error: expect.stringContaining("unacknowledged stream run"),
		});
		expect(faux.state.callCount).toBe(1);
		await successful.body?.cancel();
	});

	it("backpressures provider iteration at the durable batch bound and aborts before cancel persistence unblocks", async () => {
		let journalWriteCount = 0;
		let markWriteEntered: (() => void) | undefined;
		const writeEntered = new Promise<void>((resolve) => {
			markWriteEntered = resolve;
		});
		let releaseWrite: (() => void) | undefined;
		const writeReleased = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		await replaceServer({
			streamRunFaultInjector: async (point) => {
				if (point !== "journal_before_write") return;
				journalWriteCount++;
				if (journalWriteCount !== 2) return;
				markWriteEntered?.();
				await writeReleased;
			},
		});

		const faux = registerFauxProvider();
		let pulledEvents = 0;
		let markProviderAborted: (() => void) | undefined;
		const providerAborted = new Promise<void>((resolve) => {
			markProviderAborted = resolve;
		});
		const createPullStream = (
			_model: Model<string>,
			_context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const signal = options?.signal;
			if (signal?.aborted) {
				markProviderAborted?.();
			} else {
				signal?.addEventListener("abort", () => markProviderAborted?.(), { once: true });
			}
			const finalMessage = fauxAssistantMessage("x".repeat(256));
			return generatedAssistantMessageEventStream(async function* () {
				const events: AssistantMessageEvent[] = [
					{ type: "start", partial: finalMessage },
					{ type: "text_start", contentIndex: 0, partial: finalMessage },
					...Array.from(
						{ length: 200 },
						(): AssistantMessageEvent => ({
							type: "text_delta",
							contentIndex: 0,
							delta: "x",
							partial: finalMessage,
						}),
					),
				];
				for (const event of events) {
					if (signal?.aborted) {
						yield {
							type: "error",
							reason: "aborted",
							error: fauxAssistantMessage("", {
								stopReason: "aborted",
								errorMessage: "provider aborted",
							}),
						};
						return;
					}
					pulledEvents++;
					yield event;
				}
				yield { type: "text_end", contentIndex: 0, content: "x".repeat(200), partial: finalMessage };
				yield { type: "done", reason: "stop", message: finalMessage };
			});
		};
		registerApiProvider({
			api: faux.api,
			stream: createPullStream,
			streamSimple: createPullStream,
		});
		await initStreamSession("durable-backpressure");
		const streamResponse = await postStream("durable-backpressure", "backpressure-run", faux.models[0]);

		await Promise.race([
			writeEntered,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for blocked durable append")), 1000),
			),
		]);
		const pulledAtStall = pulledEvents;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(pulledAtStall).toBeGreaterThan(0);
		expect(pulledAtStall).toBeLessThanOrEqual(64);
		expect(pulledEvents).toBe(pulledAtStall);

		let cancelSettled = false;
		const cancelRequest = fetch(`${baseUrl}/api/session/run/cancel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "durable-backpressure", runId: "backpressure-run" }),
		}).finally(() => {
			cancelSettled = true;
		});
		await Promise.race([
			providerAborted,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for immediate provider abort")), 500),
			),
		]);
		expect(cancelSettled).toBe(false);

		releaseWrite?.();
		const cancel = await cancelRequest;
		expect(cancel.status).toBe(200);
		expect(await cancel.json()).toMatchObject({ canceled: true, status: "failed" });
		expect(await streamResponse.text()).toContain('"reason":"aborted"');
	});

	it("fail-stops on an indeterminate journal failure without retrying writes and exposes unhealthy state", async () => {
		let journalWriteCount = 0;
		let reportFatal: ((error: Error) => void) | undefined;
		const fatalReported = new Promise<Error>((resolve) => {
			reportFatal = resolve;
		});
		await replaceServer({
			streamRunFaultInjector: (point) => {
				if (point !== "journal_before_write") return;
				journalWriteCount++;
				if (journalWriteCount === 2) {
					throw new StreamRunCorruptionError("<fault-injected>", "unknown durable append outcome");
				}
			},
			onFatalStreamPersistenceError: (error) => reportFatal?.(error),
		});

		const faux = registerFauxProvider();
		let providerSignal: AbortSignal | undefined;
		const createFailingStream = (
			_model: Model<string>,
			_context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			providerSignal = options?.signal;
			const partial = fauxAssistantMessage("x".repeat(100));
			return generatedAssistantMessageEventStream(async function* () {
				yield { type: "start", partial };
				yield { type: "text_start", contentIndex: 0, partial };
				for (let index = 0; index < 100; index++) {
					yield { type: "text_delta", contentIndex: 0, delta: "x", partial };
				}
				yield { type: "text_end", contentIndex: 0, content: "x".repeat(100), partial };
				yield { type: "done", reason: "stop", message: partial };
			});
		};
		registerApiProvider({
			api: faux.api,
			stream: createFailingStream,
			streamSimple: createFailingStream,
		});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await initStreamSession("fatal-persistence-health");
			const response = await postStream("fatal-persistence-health", "fatal-run", faux.models[0]);
			const fatalError = await Promise.race([
				fatalReported,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for fatal persistence callback")), 1000),
				),
			]);
			expect(fatalError).toBeInstanceOf(StreamRunCorruptionError);
			expect(providerSignal?.aborted).toBe(true);
			expect(journalWriteCount).toBe(2);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(journalWriteCount).toBe(2);

			const health = await fetch(`${baseUrl}/health`);
			expect(health.status).toBe(503);
			expect(await health.json()).toEqual({
				status: "error",
				error: "durable operation persistence health failure",
			});
			const rejectedRequest = await fetch(`${baseUrl}/api/session/init`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ sessionId: "must-not-start" }),
			});
			expect(rejectedRequest.status).toBe(503);
			await response.body?.cancel().catch(() => undefined);
		} finally {
			stderr.mockRestore();
		}
	});

	it("fail-stops the whole server once after an indeterminate session WAL commit", async () => {
		let injectedWrites = 0;
		let fatalCalls = 0;
		let reportFatal: ((error: Error) => void) | undefined;
		const fatalReported = new Promise<Error>((resolve) => {
			reportFatal = resolve;
		});
		await replaceServer({
			sessionPersistenceFaultInjector: (point) => {
				if (point !== "wal_after_sync_before_head") return;
				injectedWrites++;
				throw new Error("fault-injected session WAL commit outcome");
			},
			onFatalStreamPersistenceError: (error) => {
				fatalCalls++;
				reportFatal?.(error);
			},
		});

		const faux = registerFauxProvider();
		let providerSignal: AbortSignal | undefined;
		const createStalledStream = (
			_model: Model<string>,
			_context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			providerSignal = options?.signal;
			return createAssistantMessageEventStream();
		};
		registerApiProvider({
			api: faux.api,
			stream: createStalledStream,
			streamSimple: createStalledStream,
		});
		await initStreamSession("session-fatal-active-run");
		const activeResponse = await postStream("session-fatal-active-run", "session-fatal-run", faux.models[0]);
		await vi.waitFor(() => expect(providerSignal).toBeDefined());
		await initStreamSession("session-fatal-mutation");

		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const failedMutation = await fetch(`${baseUrl}/api/session/tree/append`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({
					sessionId: "session-fatal-mutation",
					entries: [
						{
							type: "message",
							id: "session-fatal-u1",
							parentId: null,
							timestamp: "2026-01-01T00:00:00.000Z",
							message: { role: "user", content: "unknown commit", timestamp: 1000 },
						},
					],
					leafId: "session-fatal-u1",
				}),
			});
			expect(failedMutation.status).toBe(500);
			const fatalError = await Promise.race([
				fatalReported,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for session persistence fatal")), 1000),
				),
			]);
			expect(fatalError.message).toContain("fault-injected session WAL commit outcome");
			expect(injectedWrites).toBe(1);
			expect(fatalCalls).toBe(1);
			expect(providerSignal?.aborted).toBe(true);

			const health = await fetch(`${baseUrl}/health`);
			expect(health.status).toBe(503);
			const rejected = await fetch(`${baseUrl}/api/session/init`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ sessionId: "session-fatal-must-not-run" }),
			});
			expect(rejected.status).toBe(503);
			expect(injectedWrites).toBe(1);
			await activeResponse.body?.cancel().catch(() => undefined);
		} finally {
			stderr.mockRestore();
		}
	});

	it("closes the CLI server and sets a nonzero exit code after fatal stream persistence", async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		clearAllSessions();
		const faux = registerFauxProvider();
		const createFailingStream = (
			_model: Model<string>,
			_context: Context,
			_options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const partial = fauxAssistantMessage("x".repeat(100));
			return generatedAssistantMessageEventStream(async function* () {
				yield { type: "start", partial };
				yield { type: "text_start", contentIndex: 0, partial };
				for (let index = 0; index < 100; index++) {
					yield { type: "text_delta", contentIndex: 0, delta: "x", partial };
				}
			});
		};
		registerApiProvider({
			api: faux.api,
			stream: createFailingStream,
			streamSimple: createFailingStream,
		});
		let journalWriteCount = 0;
		let reportFatalShutdown: ((error: Error) => void) | undefined;
		const fatalShutdown = new Promise<Error>((resolve) => {
			reportFatalShutdown = resolve;
		});
		const previousExitCode = process.exitCode;
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			server = startServer({
				host: "127.0.0.1",
				port: 0,
				authToken: "test-token",
				sessionStoreDir,
				uploadDir,
				streamRunFaultInjector: (point) => {
					if (point !== "journal_before_write") return;
					journalWriteCount++;
					if (journalWriteCount === 2) {
						throw new StreamRunCorruptionError("<fault-injected>", "unknown durable append outcome");
					}
				},
				onFatalStreamPersistenceError: (error) => reportFatalShutdown?.(error),
			});
			if (!server.listening) {
				await new Promise<void>((resolve) => server.once("listening", resolve));
			}
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				throw new Error("Failed to get CLI server address");
			}
			baseUrl = `http://127.0.0.1:${address.port}`;
			await initStreamSession("fatal-cli-shutdown");
			const response = await postStream("fatal-cli-shutdown", "fatal-cli-run", faux.models[0]);
			const fatalError = await Promise.race([
				fatalShutdown,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for fatal CLI shutdown")), 1000),
				),
			]);
			expect(fatalError).toBeInstanceOf(StreamRunCorruptionError);
			expect(process.exitCode).toBe(1);
			expect(server.listening).toBe(false);
			expect(journalWriteCount).toBe(2);
			await response.body?.cancel().catch(() => undefined);
		} finally {
			process.exitCode = previousExitCode;
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it("hard exits the CLI after the fatal shutdown grace when graceful close cannot finish", async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		clearAllSessions();
		const faux = registerFauxProvider();
		let stalledWriteAttempts = 0;
		let resolveHardExit: ((code: number) => void) | undefined;
		const hardExit = new Promise<number>((resolve) => {
			resolveHardExit = resolve;
		});
		const previousExitCode = process.exitCode;
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			server = startServer({
				host: "127.0.0.1",
				port: 0,
				authToken: "test-token",
				sessionStoreDir,
				uploadDir,
				streamRunIoNoProgressTimeoutMs: 20,
				fatalShutdownGraceMs: 20,
				fatalExit: (code) => resolveHardExit?.(code),
				streamRunFaultInjector: (point) => {
					if (point !== "journal_before_write") return;
					stalledWriteAttempts++;
					return new Promise<void>((resolve) => setTimeout(resolve, 100));
				},
			});
			if (!server.listening) {
				await new Promise<void>((resolve) => server.once("listening", resolve));
			}
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				throw new Error("Failed to get CLI server address");
			}
			baseUrl = `http://127.0.0.1:${address.port}`;
			const gracefulClose = server.close.bind(server);
			server.close = (() => server) as typeof server.close;
			await initStreamSession("fatal-hard-exit");
			const responsePromise = postStream("fatal-hard-exit", "fatal-hard-exit-run", faux.models[0]);

			await expect(
				Promise.race([
					hardExit,
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("Timed out waiting for hard exit")), 1000),
					),
				]),
			).resolves.toBe(1);
			expect(process.exitCode).toBe(1);
			expect(stalledWriteAttempts).toBe(1);

			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			server.close = ((callback?: (error?: Error) => void) => gracefulClose(callback)) as typeof server.close;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			const response = await responsePromise;
			await response.body?.cancel().catch(() => undefined);
		} finally {
			process.exitCode = previousExitCode;
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it("cancels a running provider stream idempotently", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {})]);
		await initStreamSession("cancel-running-run");

		const streamResponse = await postStream("cancel-running-run", "cancel-run", faux.models[0]);
		expect(streamResponse.status).toBe(200);
		const prematureAck = await fetch(`${baseUrl}/api/session/run/ack`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-running-run", runId: "cancel-run" }),
		});
		expect(prematureAck.status).toBe(409);
		expect((await prematureAck.json()) as ServerResponse).toMatchObject({
			error: expect.stringContaining("Cannot acknowledge a running stream run"),
		});

		const cancel = await fetch(`${baseUrl}/api/session/run/cancel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-running-run", runId: "cancel-run" }),
		});
		expect(cancel.status).toBe(200);
		expect(await cancel.json()).toEqual({ canceled: true, status: "failed" });
		expect(await streamResponse.text()).toContain('"reason":"aborted"');

		const duplicateCancel = await fetch(`${baseUrl}/api/session/run/cancel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "cancel-running-run", runId: "cancel-run" }),
		});
		expect(await duplicateCancel.json()).toEqual({ canceled: false, status: "failed" });
		expect(faux.state.callCount).toBe(1);
	});

	it("closes without waiting for an unfinished provider stream", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {})]);
		await initStreamSession("close-running-run");
		const streamResponse = await postStream("close-running-run", "close-run", faux.models[0]);
		expect(streamResponse.status).toBe(200);

		await Promise.race([
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out closing pi-server")), 1000);
			}),
		]);
	});

	it("does not log a client disconnect when the provider run completes", async () => {
		const faux = registerFauxProvider();
		let resolveProvider: ((message: AssistantMessage) => void) | undefined;
		const providerResult = new Promise<AssistantMessage>((resolve) => {
			resolveProvider = resolve;
		});
		faux.setResponses([() => providerResult]);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		await initStreamSession("disconnected-subscriber");

		const response = await postStream("disconnected-subscriber", "disconnected-run", faux.models[0]);
		if (!response.body) throw new Error("Provider response body is missing");
		const reader = response.body.getReader();
		await reader.read();
		await reader.cancel();

		if (!resolveProvider) throw new Error("Provider response did not start");
		resolveProvider(fauxAssistantMessage("completed after disconnect"));

		await vi.waitFor(async () => {
			const runResponse = await fetch(`${baseUrl}/api/session/disconnected-subscriber/runs/disconnected-run`, {
				headers: { Authorization: "Bearer test-token" },
			});
			const run = (await runResponse.json()) as RunResponse;
			expect(run.status).toBe("completed");
		});
		expect(stderr).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("does not impose a server idle deadline on an active provider run", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {})]);
		await initStreamSession("long-running-provider");
		const response = await postStream("long-running-provider", "long-running-run", faux.models[0]);
		if (!response.body) throw new Error("Provider response body is missing");
		const reader = response.body.getReader();
		await reader.read();

		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 7 * 60 * 60_000);
		try {
			const runResponse = await fetch(`${baseUrl}/api/session/long-running-provider/runs/long-running-run`, {
				headers: { Authorization: "Bearer test-token" },
			});
			const run = (await runResponse.json()) as RunResponse;
			expect(run.status).toBe("running");
		} finally {
			dateNow.mockRestore();
			await reader.cancel();
		}
	});

	it("fails and logs a provider stream that ends without done or error", async () => {
		const faux = registerFauxProvider();
		let invocationCount = 0;
		const cleanEofStream = () => {
			invocationCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		registerApiProvider({
			api: faux.api,
			stream: cleanEofStream,
			streamSimple: cleanEofStream,
		});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		await initStreamSession("clean-eof-run");

		const first = await postStream("clean-eof-run", "clean-eof", faux.models[0]);
		const firstEvents = await first.text();
		expect(firstEvents).toContain("Provider stream ended without a terminal event");

		const runResponse = await fetch(`${baseUrl}/api/session/clean-eof-run/runs/clean-eof`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const run = (await runResponse.json()) as RunResponse;
		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("Provider stream ended without a terminal event");

		const replay = await postStream("clean-eof-run", "clean-eof", faux.models[0]);
		expect(await replay.text()).toBe(firstEvents);
		expect(invocationCount).toBe(1);
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(String(stderr.mock.calls[0]?.[0])).toContain('"phase":"provider_stream"');
		stderr.mockRestore();
	});

	it("retains terminal run journals until ACK, then expires acknowledged runs", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("complete")]);
		await initStreamSession("expired-run-journal");
		const response = await postStream("expired-run-journal", "expired-run", faux.models[0]);
		await response.text();

		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
		try {
			const retained = await fetch(`${baseUrl}/api/session/expired-run-journal/runs/expired-run`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(retained.status).toBe(200);
			const ack = await fetch(`${baseUrl}/api/session/run/ack`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ sessionId: "expired-run-journal", runId: "expired-run" }),
			});
			expect(ack.status).toBe(200);
			expect(await ack.json()).toMatchObject({
				acknowledged: true,
				sessionId: "expired-run-journal",
				runId: "expired-run",
				requestMac: expect.stringMatching(/^[a-f0-9]{64}$/),
				status: "completed",
			});
			dateNow.mockReturnValue(now + 22 * 60_000);
			const expired = await fetch(`${baseUrl}/api/session/expired-run-journal/runs/expired-run`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(expired.status).toBe(404);
		} finally {
			dateNow.mockRestore();
		}
	});

	it("allows only one unacknowledged run per session", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await initStreamSession("bounded-run-journals");

		const first = await postStream("bounded-run-journals", "run-0", faux.models[0]);
		expect(first.status).toBe(200);
		await first.text();
		const blocked = await postStream("bounded-run-journals", "run-1", faux.models[0]);
		expect(blocked.status).toBe(409);
		expect((await blocked.json()) as ServerResponse).toMatchObject({
			error: expect.stringContaining("unacknowledged stream run"),
		});
		expect(faux.state.callCount).toBe(1);
		const ack = await fetch(`${baseUrl}/api/session/run/ack`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "bounded-run-journals", runId: "run-0" }),
		});
		expect(ack.status).toBe(200);
		const second = await postStream("bounded-run-journals", "run-1", faux.models[0]);
		expect(second.status).toBe(200);
		await second.text();
		expect(faux.state.callCount).toBe(2);
	});

	it("returns 404 for unknown routes with auth", async () => {
		const res = await fetch(`${baseUrl}/unknown`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	it("deletes only the requested session, not all sessions", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("session run")]);
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
		const run = await postStream("session-a", "session-a-run", faux.models[0]);
		await run.text();

		const res = await fetch(`${baseUrl}/api/session/session-a`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.deleted).toBe("session-a");

		expect(getSession("session-a")).toBeUndefined();
		expect(getSession("session-b")).toBeDefined();
		const deletedRun = await fetch(`${baseUrl}/api/session/session-a/runs/session-a-run`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(deletedRun.status).toBe(404);
	});

	it("serializes deletion with queued streams and direct session mutations", async () => {
		let deletionStarted = false;
		let reportDeletionWriteBlocked: (() => void) | undefined;
		const deletionWriteBlocked = new Promise<void>((resolve) => {
			reportDeletionWriteBlocked = resolve;
		});
		let releaseDeletionWrite: (() => void) | undefined;
		const deletionWriteReleased = new Promise<void>((resolve) => {
			releaseDeletionWrite = resolve;
		});
		let blockedDeletionWrite = false;
		await replaceServer({
			streamRunFaultInjector: async (point) => {
				if (point !== "journal_before_write" || !deletionStarted || blockedDeletionWrite) return;
				blockedDeletionWrite = true;
				reportDeletionWriteBlocked?.();
				await deletionWriteReleased;
			},
		});
		const faux = registerFauxProvider();
		faux.setResponses([() => new Promise<AssistantMessage>(() => {}), fauxAssistantMessage("must not run")]);
		await initStreamSession("delete-race");
		const active = await postStream("delete-race", "active-run", faux.models[0]);

		deletionStarted = true;
		const deletion = fetch(`${baseUrl}/api/session/delete-race`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		try {
			await Promise.race([
				deletionWriteBlocked,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for deletion journal write")), 2000),
				),
			]);
			const queuedAppend = fetch(`${baseUrl}/api/session/append`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({
					sessionId: "delete-race",
					messages: [{ role: "user", content: "must not commit", timestamp: 1000 }],
				}),
			});
			const queuedStream = postStream("delete-race", "queued-run", faux.models[0], {
				baseStaticContextHash: "",
				baseRevision: 0,
				baseTreeHash: PI_SERVER_EMPTY_TREE_HASH,
				baseEntryCount: 0,
				baseLeafId: null,
				staticContext: { systemPrompt: "must not recreate" },
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(getSession("delete-race")?.entries).toEqual([]);
			expect(faux.state.callCount).toBe(1);

			releaseDeletionWrite?.();
			const [deleted, append, stream] = await Promise.all([deletion, queuedAppend, queuedStream]);
			expect(deleted.status).toBe(200);
			expect(append.status).toBe(409);
			expect(stream.status).toBe(409);
			expect(faux.state.callCount).toBe(1);
			expect(getSession("delete-race")).toBeUndefined();
			const deletedRun = await fetch(`${baseUrl}/api/session/delete-race/runs/active-run`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(deletedRun.status).toBe(404);
		} finally {
			releaseDeletionWrite?.();
			await active.body?.cancel().catch(() => undefined);
		}
	});

	it("fail-stops after an indeterminate persisted-session delete", async () => {
		let fatalCalls = 0;
		let reportFatal: ((error: Error) => void) | undefined;
		const fatalReported = new Promise<Error>((resolve) => {
			reportFatal = resolve;
		});
		await replaceServer({
			sessionPersistenceDelete: () => {
				throw new Error("fault-injected persisted-session delete outcome");
			},
			onFatalStreamPersistenceError: (error) => {
				fatalCalls++;
				reportFatal?.(error);
			},
		});
		await initStreamSession("delete-persistence-fatal");
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await fetch(`${baseUrl}/api/session/delete-persistence-fatal`, {
				method: "DELETE",
				headers: { Authorization: "Bearer test-token" },
			});
			expect(response.status).toBe(500);
			const fatalError = await Promise.race([
				fatalReported,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for delete persistence fatal")), 1000),
				),
			]);
			expect(fatalError.message).toContain("fault-injected persisted-session delete outcome");
			expect(fatalCalls).toBe(1);
			const health = await fetch(`${baseUrl}/health`);
			expect(health.status).toBe(503);
			const rejected = await fetch(`${baseUrl}/api/session/init`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ sessionId: "delete-persistence-must-not-run" }),
			});
			expect(rejected.status).toBe(503);
		} finally {
			stderr.mockRestore();
		}
	});

	it("deletes only the requested session's paused replay reader", async () => {
		const faux = registerFauxProvider();
		const largeText = "x".repeat(2 * 1024 * 1024);
		const largeStream = () => {
			const message = fauxAssistantMessage(largeText);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: largeText,
					partial: message,
				});
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		registerApiProvider({
			api: faux.api,
			stream: largeStream,
			streamSimple: largeStream,
		});
		await initStreamSession("delete-replay-target");
		await initStreamSession("delete-replay-other");
		await (await postStream("delete-replay-target", "target-run", faux.models[0])).text();
		await (await postStream("delete-replay-other", "other-run", faux.models[0])).text();

		const openPausedReplay = (sessionId: string, runId: string): Promise<IncomingMessage> =>
			new Promise((resolve, reject) => {
				const request = httpRequest(
					`${baseUrl}/api/session/${sessionId}/runs/${runId}/events?from=0`,
					{ headers: { Authorization: "Bearer test-token" } },
					(response) => {
						response.pause();
						response.on("error", () => {});
						resolve(response);
					},
				);
				request.once("error", reject);
				request.end();
			});
		const targetReplay = await openPausedReplay("delete-replay-target", "target-run");
		const otherReplay = await openPausedReplay("delete-replay-other", "other-run");
		expect(targetReplay.statusCode).toBe(200);
		expect(otherReplay.statusCode).toBe(200);

		const deleted = await fetch(`${baseUrl}/api/session/delete-replay-target`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
			signal: AbortSignal.timeout(2000),
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: "delete-replay-target" });
		expect(otherReplay.destroyed).toBe(false);

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				otherReplay.destroy();
				reject(new Error("Unrelated replay did not complete after deleting another session"));
			}, 2000);
			otherReplay.once("end", () => {
				clearTimeout(timeout);
				resolve();
			});
			otherReplay.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			otherReplay.resume();
		});
		expect(otherReplay.complete).toBe(true);
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
