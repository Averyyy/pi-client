import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { hashPiServerCompactRequest } from "../src/core/pi-server-client.ts";
import {
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	hashPiServerStaticContext,
} from "../src/core/pi-server-protocol.ts";
import { getPiServerRunStatePath, readPiServerPendingRun } from "../src/core/pi-server-run-state.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

interface FakeSession {
	staticContextHash: string;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
}

interface FakeRun {
	sessionId: string;
	runId: string;
	requestMac: string;
	events: string;
	acknowledged: boolean;
}

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

function parseBody(init?: RequestInit): Record<string, unknown> {
	const raw = (init?.body as string | undefined) ?? "";
	if (!raw) return {};
	const value = JSON.parse(raw) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected a JSON request object");
	}
	return value as Record<string, unknown>;
}

function streamRequestMac(body: Record<string, unknown>): string {
	const { runId: _runId, eventCursor: _eventCursor, ...identity } = body;
	const serialized = canonicalJsonStringify(identity);
	if (serialized === undefined) throw new Error("Expected a serializable stream request");
	return createHash("sha256").update(serialized).digest("hex");
}

function createFakePiServer(mainSessionId: string) {
	const sessions = new Map<string, FakeSession>();
	const runs = new Map<string, FakeRun>();
	const requests: CapturedRequest[] = [];
	const streamSessionIds: string[] = [];
	const acknowledgedSessionIds: string[] = [];
	let mainResponseCount = 0;
	let auxiliaryResponseCount = 0;

	const getSession = (sessionId: string): FakeSession => {
		let session = sessions.get(sessionId);
		if (!session) {
			session = {
				staticContextHash: "",
				entries: [],
				leafId: null,
				revision: 0,
			};
			sessions.set(sessionId, session);
		}
		return session;
	};
	const sessionBody = (sessionId: string) => {
		const session = getSession(sessionId);
		return {
			protocolVersion: 2,
			sessionId,
			staticContextHash: session.staticContextHash,
			staticContextRequired: false,
			treeHash: hashPiServerSessionEntries(session.entries),
			messageCount: session.entries.filter((entry) => entry.type === "message").length,
			entryCount: session.entries.length,
			leafId: session.leafId,
			revision: session.revision,
		};
	};

	const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
		const body = parseBody(init);
		requests.push({ url, body });
		const parsedUrl = new URL(url);

		if (parsedUrl.pathname === "/api/session/init") {
			const sessionId = body.sessionId;
			if (typeof sessionId !== "string") throw new Error("Expected init sessionId");
			const session = getSession(sessionId);
			if (typeof body.staticContextHash === "string") {
				session.staticContextHash = body.staticContextHash;
			} else if (body.staticContext !== undefined) {
				session.staticContextHash = hashPiServerStaticContext(
					body.staticContext as Parameters<typeof hashPiServerStaticContext>[0],
				);
			}
			return Response.json(sessionBody(sessionId));
		}

		if (
			parsedUrl.pathname === "/api/session/tree/append" ||
			parsedUrl.pathname === "/api/session/tree/sync" ||
			parsedUrl.pathname === "/api/session/tree/switch"
		) {
			const sessionId = body.sessionId;
			if (typeof sessionId !== "string") throw new Error("Expected tree sessionId");
			const session = getSession(sessionId);
			if (parsedUrl.pathname.endsWith("/sync")) {
				session.entries = [...((body.entries as SessionTreeEntry[] | undefined) ?? [])];
			} else if (parsedUrl.pathname.endsWith("/append")) {
				const knownIds = new Set(session.entries.map((entry) => entry.id));
				for (const entry of (body.entries as SessionTreeEntry[] | undefined) ?? []) {
					if (!knownIds.has(entry.id)) {
						session.entries.push(entry);
						knownIds.add(entry.id);
					}
				}
			}
			session.leafId = (body.leafId as string | null | undefined) ?? null;
			session.revision++;
			return Response.json(sessionBody(sessionId));
		}

		if (parsedUrl.pathname === "/api/stream") {
			const sessionId = body.sessionId;
			const runId = body.runId;
			if (typeof sessionId !== "string" || typeof runId !== "string") {
				throw new Error("Expected stream sessionId and runId");
			}
			const blockingRun = [...runs.values()].find(
				(run) => run.sessionId === sessionId && run.runId !== runId && !run.acknowledged,
			);
			if (blockingRun) {
				return Response.json({ error: "session already has an unacknowledged stream run" }, { status: 409 });
			}
			streamSessionIds.push(sessionId);
			const requestMac = streamRequestMac(body);
			const text =
				sessionId === mainSessionId ? `main-${++mainResponseCount}` : `auxiliary-${++auxiliaryResponseCount}`;
			const diagnostics = [
				{
					type: "pi_server_run",
					timestamp: 1,
					details: { sessionId, runId, requestMac, restartUnknown: false },
				},
			];
			const events = [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: text },
				{ type: "text_end", contentIndex: 0 },
				{
					type: "done",
					reason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					diagnostics,
				},
			];
			const encoded = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
			runs.set(runId, { sessionId, runId, requestMac, events: encoded, acknowledged: false });
			return new Response(encoded, { headers: { "Content-Type": "text/event-stream" } });
		}

		const runEventsMatch = parsedUrl.pathname.match(/^\/api\/session\/[^/]+\/runs\/([^/]+)\/events$/);
		if (runEventsMatch) {
			const run = runs.get(decodeURIComponent(runEventsMatch[1]));
			if (!run) return Response.json({ error: "Stream run not found" }, { status: 404 });
			return new Response(run.events, { headers: { "Content-Type": "text/event-stream" } });
		}

		const runStatusMatch = parsedUrl.pathname.match(/^\/api\/session\/[^/]+\/runs\/([^/]+)$/);
		if (runStatusMatch) {
			const run = runs.get(decodeURIComponent(runStatusMatch[1]));
			if (!run) return Response.json({ error: "Stream run not found" }, { status: 404 });
			return Response.json({
				sessionId: run.sessionId,
				runId: run.runId,
				requestMac: run.requestMac,
				status: "completed",
				nextSeq: 5,
			});
		}

		if (parsedUrl.pathname === "/api/session/run/ack") {
			const sessionId = body.sessionId;
			const runId = body.runId;
			if (typeof sessionId !== "string" || typeof runId !== "string") {
				throw new Error("Expected acknowledgement sessionId and runId");
			}
			const run = runs.get(runId);
			if (!run || run.sessionId !== sessionId) {
				return Response.json({ error: "Stream run not found" }, { status: 404 });
			}
			run.acknowledged = true;
			acknowledgedSessionIds.push(sessionId);
			return Response.json({
				acknowledged: true,
				sessionId,
				runId,
				requestMac: run.requestMac,
				status: "completed",
				acknowledgedAt: Date.now(),
			});
		}

		if (parsedUrl.pathname === "/api/session/compact") {
			const sessionId = body.sessionId;
			const operationId = body.operationId;
			if (typeof sessionId !== "string" || typeof operationId !== "string") {
				throw new Error("Expected compact sessionId and operationId");
			}
			const replacement = body.extensionCompaction;
			if (typeof replacement !== "object" || replacement === null || Array.isArray(replacement)) {
				return new Response('event: error\ndata: {"error":"expected extension replacement"}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			const value = replacement as Record<string, unknown>;
			const session = getSession(sessionId);
			const requestHash = hashPiServerCompactRequest(
				body as unknown as Parameters<typeof hashPiServerCompactRequest>[0],
			);
			const baseStaticContextHash = body.baseStaticContextHash as string;
			const baseTreeHash = body.baseTreeHash as string;
			const baseEntryCount = body.baseEntryCount as number;
			const baseLeafId = body.baseLeafId as string | null;
			const baseRevision = body.baseRevision as number;
			const entry = {
				type: "compaction" as const,
				id: randomUUID(),
				parentId: session.leafId,
				timestamp: new Date().toISOString(),
				summary: value.summary as string,
				firstKeptEntryId: value.firstKeptEntryId as string,
				tokensBefore: value.tokensBefore as number,
				...(value.details !== undefined ? { details: value.details } : {}),
				...(value.usage !== undefined
					? { usage: value.usage as Extract<SessionTreeEntry, { type: "compaction" }>["usage"] }
					: {}),
				fromHook: true,
				piServerCompactOperation: {
					version: 1,
					operationId,
					requestHash,
					baseStaticContextHash,
					baseTreeHash,
					baseEntryCount,
					baseLeafId,
					baseRevision,
				},
			};
			const entriesFrom = session.entries.length;
			session.entries.push(entry);
			session.leafId = entry.id;
			session.revision = baseRevision + 1;
			const responseBody = {
				protocolVersion: 2,
				sessionId,
				operationId,
				requestHash,
				treePatch: {
					baseStaticContextHash,
					baseTreeHash,
					baseEntryCount,
					baseLeafId,
					baseRevision,
					entriesFrom,
					entries: [entry],
					leafId: entry.id,
					revision: session.revision,
					treeHash: hashPiServerSessionEntries(session.entries),
				},
			};
			return new Response(`event: result\ndata: ${JSON.stringify(responseBody)}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		}

		if (parsedUrl.pathname === "/api/session/compact/ack") {
			const sessionId = body.sessionId;
			const operationId = body.operationId;
			const requestHash = body.requestHash;
			if (typeof sessionId !== "string" || typeof operationId !== "string" || typeof requestHash !== "string") {
				throw new Error("Expected compact acknowledgement identity");
			}
			return Response.json({
				acknowledged: true,
				sessionId,
				operationId,
				requestHash,
				status: "completed",
				acknowledgedAt: Date.now(),
			});
		}

		if (parsedUrl.pathname === "/api/session/compact/cancel") {
			return Response.json({ canceled: false, status: "settled" });
		}

		if (init?.method === "DELETE" && parsedUrl.pathname.startsWith("/api/session/")) {
			const sessionId = decodeURIComponent(parsedUrl.pathname.slice("/api/session/".length));
			sessions.delete(sessionId);
			for (const [runId, run] of runs) {
				if (run.sessionId === sessionId) runs.delete(runId);
			}
			return Response.json({ deleted: sessionId });
		}

		return Response.json({ error: `Unexpected fake pi-server request: ${parsedUrl.pathname}` }, { status: 500 });
	});

	return {
		fetchMock,
		requests,
		streamSessionIds,
		acknowledgedSessionIds,
		get mainResponseCount() {
			return mainResponseCount;
		},
		get auxiliaryResponseCount() {
			return auxiliaryResponseCount;
		},
	};
}

async function createTestModelRuntime(provider: string) {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	return getModelRuntime(modelRegistry);
}

describe("AgentSession pi-server auxiliary provider runs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete process.env.PI_SERVER_MODE;
	});

	it("ACKs auto-name as an independent transient run before a second main prompt", async () => {
		const tempDir = join(tmpdir(), `pi-aux-title-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const modelRuntime = await createTestModelRuntime(model.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const fake = createFakePiServer(sessionManager.getSessionId());
		process.env.PI_SERVER_MODE = "true";
		vi.stubGlobal("fetch", fake.fetchMock);

		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				sessionManager,
				autoSessionName: true,
			});
			try {
				await session.prompt("first main prompt");
				await session.agent.waitForIdle();
				await session.prompt("second main prompt");
				await session.agent.waitForIdle();

				const mainSessionId = sessionManager.getSessionId();
				expect(fake.mainResponseCount).toBe(2);
				expect(fake.auxiliaryResponseCount).toBe(1);
				expect(fake.streamSessionIds.filter((sessionId) => sessionId === mainSessionId)).toHaveLength(2);
				const auxiliarySessionIds = fake.streamSessionIds.filter((sessionId) => sessionId !== mainSessionId);
				expect(auxiliarySessionIds).toHaveLength(1);
				expect(
					fake.requests.find(
						(request) => request.url.endsWith("/api/stream") && request.body.sessionId === auxiliarySessionIds[0],
					)?.body.runMode,
				).toBe("auxiliary-transient");
				expect(fake.acknowledgedSessionIds).toEqual(
					expect.arrayContaining([mainSessionId, auxiliarySessionIds[0]]),
				);
				expect(
					fake.requests.some((request) =>
						request.url.endsWith(`/api/session/${encodeURIComponent(auxiliarySessionIds[0])}`),
					),
				).toBe(true);
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a persisted session file");
				expect(readPiServerPendingRun(getPiServerRunStatePath(sessionFile))).toBeUndefined();
				expect(
					fake.requests.filter(
						(request) =>
							request.body.sessionId === mainSessionId && request.url.endsWith("/api/session/tree/sync"),
					),
				).toHaveLength(0);
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("validates and ACKs consecutive main runs for an in-memory session", async () => {
		const tempDir = join(tmpdir(), `pi-main-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const modelRuntime = await createTestModelRuntime(model.provider);
		const sessionManager = SessionManager.inMemory(cwd);
		const mainSessionId = sessionManager.getSessionId();
		const fake = createFakePiServer(mainSessionId);
		process.env.PI_SERVER_MODE = "true";
		vi.stubGlobal("fetch", fake.fetchMock);

		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				sessionManager,
				autoSessionName: false,
			});
			try {
				await session.prompt("first in-memory main prompt");
				await session.agent.waitForIdle();
				await session.prompt("second in-memory main prompt");
				await session.agent.waitForIdle();

				expect(fake.mainResponseCount).toBe(2);
				expect(fake.acknowledgedSessionIds.filter((sessionId) => sessionId === mainSessionId)).toHaveLength(2);
				expect(session.messages.at(-1)?.role).toBe("assistant");
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses a transient run for branch summary and leaves the next main prompt recoverable", async () => {
		const tempDir = join(tmpdir(), `pi-aux-branch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const modelRuntime = await createTestModelRuntime(model.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const mainSessionId = sessionManager.getSessionId();
		const fake = createFakePiServer(mainSessionId);
		process.env.PI_SERVER_MODE = "true";
		vi.stubGlobal("fetch", fake.fetchMock);

		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				sessionManager,
				autoSessionName: false,
			});
			try {
				await session.prompt("first branch prompt");
				await session.agent.waitForIdle();
				await session.prompt("abandoned branch prompt");
				await session.agent.waitForIdle();
				const firstUserEntry = sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (!firstUserEntry) throw new Error("Expected the first user entry");

				const navigation = await session.navigateTree(firstUserEntry.id, { summarize: true });
				expect(navigation.cancelled).toBe(false);
				expect(navigation.summaryEntry?.type).toBe("branch_summary");

				await session.prompt("continue after branch summary");
				await session.agent.waitForIdle();

				expect(fake.mainResponseCount).toBe(3);
				expect(fake.auxiliaryResponseCount).toBeGreaterThanOrEqual(1);
				const auxiliarySessionIds = new Set(
					fake.streamSessionIds.filter((sessionId) => sessionId !== mainSessionId),
				);
				expect(auxiliarySessionIds.size).toBeGreaterThanOrEqual(1);
				for (const auxiliarySessionId of auxiliarySessionIds) {
					expect(fake.acknowledgedSessionIds).toContain(auxiliarySessionId);
				}
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a persisted session file");
				expect(readPiServerPendingRun(getPiServerRunStatePath(sessionFile))).toBeUndefined();
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sends extension compaction replacement to pi-server and preserves fromExtension", async () => {
		const tempDir = join(tmpdir(), `pi-extension-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const extensionsDir = join(agentDir, "extensions");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "compact.ts"),
			`export default function (pi) {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "extension authoritative summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: { source: "extension" },
					},
				}));
				pi.on("session_compact", (event) => {
					if (!event.fromExtension) throw new Error("session_compact lost fromExtension");
				});
			}`,
		);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const modelRuntime = await createTestModelRuntime(model.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const fake = createFakePiServer(sessionManager.getSessionId());
		process.env.PI_SERVER_MODE = "true";
		vi.stubGlobal("fetch", fake.fetchMock);

		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				sessionManager,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
				}),
				autoSessionName: false,
			});
			try {
				await session.prompt("first compact prompt");
				await session.agent.waitForIdle();
				await session.prompt("second compact prompt");
				await session.agent.waitForIdle();
				const result = await session.compact();

				expect(result?.summary).toBe("extension authoritative summary");
				const compactRequest = fake.requests.find((request) => request.url.endsWith("/api/session/compact"));
				expect(compactRequest?.body.extensionCompaction).toMatchObject({
					summary: "extension authoritative summary",
					details: { source: "extension" },
				});
				const compactionEntry = sessionManager.getEntries().at(-1);
				expect(compactionEntry?.type).toBe("compaction");
				expect(compactionEntry?.type === "compaction" ? compactionEntry.fromHook : undefined).toBe(true);
				expect(fake.auxiliaryResponseCount).toBe(0);
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("honors session_before_compact cancellation before contacting pi-server compact", async () => {
		const tempDir = join(tmpdir(), `pi-cancel-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const extensionsDir = join(agentDir, "extensions");
		const sessionsDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "cancel-compact.ts"),
			`export default function (pi) {
				pi.on("session_before_compact", () => ({ cancel: true }));
			}`,
		);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const modelRuntime = await createTestModelRuntime(model.provider);
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const fake = createFakePiServer(sessionManager.getSessionId());
		process.env.PI_SERVER_MODE = "true";
		vi.stubGlobal("fetch", fake.fetchMock);

		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				sessionManager,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
				}),
				autoSessionName: false,
			});
			try {
				await session.prompt("first cancellation prompt");
				await session.agent.waitForIdle();
				await session.prompt("second cancellation prompt");
				await session.agent.waitForIdle();
				await expect(session.compact()).rejects.toThrow("Compaction cancelled");
				expect(fake.requests.some((request) => request.url.endsWith("/api/session/compact"))).toBe(false);
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
