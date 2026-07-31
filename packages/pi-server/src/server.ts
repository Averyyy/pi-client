import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import {
	type CompactionPreparationOptions,
	type CompactionSettings,
	type CompactResult,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	type ProxyAssistantMessageEvent,
	prepareCompaction,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createModels,
	createProvider,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ServerConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { encodeErrorEvent, encodeProxyEvent } from "./event-encoding.ts";
import { ReceiveUploadError, receiveUpload } from "./receive-upload.ts";
import { CHUNK_ENDPOINT, type RequestChunkBody, receiveRequestChunk } from "./request-chunks.ts";
import { deletePersistedSession, loadPersistedSessions, savePersistedSession } from "./session-persistence.ts";
import {
	appendCompactionEntry,
	appendMessages,
	appendSessionEntries,
	deleteSession as deleteSessionFromStore,
	dropLastAssistantError,
	getOrCreateSession,
	getSession,
	getSessionBranch,
	listSessions,
	replaceMessages,
	replaceSessionTree,
	type SessionState,
	type SessionStaticContext,
	setStaticContext,
	switchSessionLeaf,
} from "./session-store.ts";

export { loadConfig, type ServerConfig } from "./config.ts";

interface PackageMetadata {
	version: string;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;
const PI_SERVER_VERSION = packageMetadata.version;

interface SessionInitBody {
	sessionId: string;
	staticContext?: SessionStaticContext;
}

interface StreamRequestBody {
	sessionId: string;
	runId?: string;
	model: Model<any>;
	options?: SimpleStreamOptions;
	staticContext?: SessionStaticContext;
	ephemeralMessages?: Message[];
	contextOverlay?: Message[];
}

interface SessionSyncBody {
	sessionId: string;
	messages: Message[];
	staticContext?: SessionStaticContext;
}

interface SessionAppendBody {
	sessionId: string;
	messages: Message[];
	staticContext?: SessionStaticContext;
}

interface SessionTreeSyncBody {
	sessionId: string;
	entries: SessionTreeEntry[];
	leafId: string | null;
	staticContext?: SessionStaticContext;
}

interface SessionTreeSwitchBody {
	sessionId: string;
	leafId: string | null;
}

interface SessionCompactBody {
	sessionId: string;
	model: Model<any>;
	options?: SimpleStreamOptions;
	settings?: CompactionSettings;
	preparation?: CompactionPreparationOptions;
	customInstructions?: string;
	baseTreeHash?: string;
	fullResponse?: boolean;
	streamResponse?: boolean;
}

function createRequestModels(model: Model<any>, options: SimpleStreamOptions) {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: model.provider,
			name: model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: "pi-server request auth",
					resolve: async () => ({ auth: { apiKey: options.apiKey, headers: options.headers } }),
				},
			},
			api: {
				stream: (requestModel, context, streamOptions) => streamSimple(requestModel, context, streamOptions),
				streamSimple: (requestModel, context, streamOptions) => streamSimple(requestModel, context, streamOptions),
			},
		}),
	);
	return models;
}

interface SessionIdBody {
	sessionId: string;
}

interface StreamRunRecord {
	sessionId: string;
	runId: string;
	status: "running" | "completed" | "failed";
	events: ProxyAssistantMessageEvent[];
	message?: AssistantMessage;
	errorMessage?: string;
	createdAt: number;
	updatedAt: number;
}

const STREAM_HEARTBEAT = ": keep-alive\n\n";
const JSON_HEARTBEAT = " \n";
const STREAM_HEARTBEAT_INTERVAL_MS = 25_000;
const streamRuns = new Map<string, StreamRunRecord>();

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
	res.end(data);
}

function logRequestError(req: IncomingMessage, error: unknown): void {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	console.error(`${req.method ?? "UNKNOWN"} ${req.url ?? "/"} failed: ${message}`);
}

function authenticate(config: ServerConfig, req: IncomingMessage): boolean {
	if (!config.authToken) return true;
	const header = req.headers.authorization;
	if (!header) return false;
	const token = header.startsWith("Bearer ") ? header.slice(7) : header;
	return token === config.authToken;
}

interface ResolvedStream {
	model: Model<any>;
	options: SimpleStreamOptions;
}

function sessionResponseBody(session: SessionState) {
	return {
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		messageCount: session.messages.length,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
	};
}

function persistSession(config: ServerConfig, session: SessionState): void {
	savePersistedSession(config.sessionStoreDir, session);
}

function runKey(sessionId: string, runId: string): string {
	return `${sessionId}\0${runId}`;
}

function getStreamRun(sessionId: string, runId: string): StreamRunRecord | undefined {
	return streamRuns.get(runKey(sessionId, runId));
}

function startStreamRun(sessionId: string, runId: string): StreamRunRecord {
	const existing = getStreamRun(sessionId, runId);
	if (existing?.status === "completed" || existing?.status === "failed") return existing;
	const now = Date.now();
	const run: StreamRunRecord = existing ?? {
		sessionId,
		runId,
		status: "running",
		events: [],
		createdAt: now,
		updatedAt: now,
	};
	run.status = "running";
	run.updatedAt = now;
	streamRuns.set(runKey(sessionId, runId), run);
	return run;
}

function recordStreamRunEvent(run: StreamRunRecord | undefined, event: ProxyAssistantMessageEvent): void {
	if (!run) return;
	run.events.push(event);
	run.updatedAt = Date.now();
}

function completeStreamRun(run: StreamRunRecord | undefined, message: AssistantMessage): void {
	if (!run) return;
	run.status = "completed";
	run.message = message;
	run.errorMessage = undefined;
	run.updatedAt = Date.now();
}

function failStreamRun(run: StreamRunRecord | undefined, errorMessage: string): void {
	if (!run) return;
	run.status = "failed";
	run.errorMessage = errorMessage;
	run.updatedAt = Date.now();
}

function sessionHistoryFullResponseBody(session: SessionState, baseMessageCount: number) {
	return {
		sessionId: session.sessionId,
		staticContext: session.staticContext,
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		messageCount: session.messages.length,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
		entries: session.entries,
		baseMessageCount,
		messages: session.messages.slice(baseMessageCount),
	};
}

function sessionTreePatchResponseBody(
	session: SessionState,
	baseMessageCount: number,
	entriesFrom: number,
	baseRevision: number | undefined,
) {
	return {
		sessionId: session.sessionId,
		staticContext: session.staticContext,
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		messageCount: session.messages.length,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
		baseMessageCount,
		messages: session.messages.slice(baseMessageCount),
		treePatch: {
			entriesFrom,
			baseRevision,
			entries: session.entries.slice(entriesFrom),
			leafId: session.leafId,
			revision: session.revision,
		},
	};
}

type PreparedCompaction = Parameters<typeof compact>[0];

interface PreparedSessionCompact {
	session: SessionState;
	preparation: PreparedCompaction;
	options: SimpleStreamOptions;
}

interface SessionCompactSuccessBody {
	success: true;
	compaction: CompactResult;
	compactionEntry: SessionTreeEntry;
	sessionId: string;
	staticContextHash: string;
	treeHash: string;
	messageCount: number;
	entryCount: number;
	leafId: string | null;
	revision: number;
	staticContext?: SessionStaticContext;
	treePatch?: {
		baseTreeHash: string;
		entriesFrom: number;
		entries: SessionTreeEntry[];
		leafId: string | null;
		revision: number;
	};
	entries?: SessionTreeEntry[];
	messages?: Message[];
}

interface SessionCompactHttpResponse {
	status: number;
	body: { error: string } | SessionCompactSuccessBody;
}

export function resolveStreamOptions(
	_config: ServerConfig,
	model: Model<any>,
	body: StreamRequestBody,
): ResolvedStream {
	return { model, options: { ...(body.options ?? {}) } };
}

function handleSessionInit(config: ServerConfig, body: SessionInitBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	} else {
		getOrCreateSession(body.sessionId);
	}
	const session = getSession(body.sessionId)!;
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionUpdate(
	config: ServerConfig,
	body: SessionInitBody & { staticContext: SessionStaticContext },
	res: ServerResponse,
): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!body.staticContext) {
		sendJson(res, 400, { error: "staticContext is required for update" });
		return;
	}
	setStaticContext(body.sessionId, body.staticContext);
	const session = getSession(body.sessionId)!;
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionSync(config: ServerConfig, body: SessionSyncBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!Array.isArray(body.messages)) {
		sendJson(res, 400, { error: "messages is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}
	const session = replaceMessages(body.sessionId, body.messages);
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionAppend(config: ServerConfig, body: SessionAppendBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!Array.isArray(body.messages)) {
		sendJson(res, 400, { error: "messages is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}
	const session = appendMessages(body.sessionId, body.messages);
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionTreeSync(config: ServerConfig, body: SessionTreeSyncBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!Array.isArray(body.entries)) {
		sendJson(res, 400, { error: "entries is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}
	const session = replaceSessionTree(body.sessionId, body.entries, body.leafId ?? null);
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionTreeAppend(config: ServerConfig, body: SessionTreeSyncBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!Array.isArray(body.entries)) {
		sendJson(res, 400, { error: "entries is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}
	const session = appendSessionEntries(body.sessionId, body.entries, body.leafId ?? null);
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionTreeSwitch(config: ServerConfig, body: SessionTreeSwitchBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	const session = switchSessionLeaf(body.sessionId, body.leafId ?? null);
	persistSession(config, session);
	sendJson(res, 200, sessionResponseBody(session));
}

function prepareSessionCompact(body: SessionCompactBody): PreparedSessionCompact | SessionCompactHttpResponse {
	if (!body.sessionId) {
		return { status: 400, body: { error: "sessionId is required" } };
	}
	if (!body.model) {
		return { status: 400, body: { error: "model is required" } };
	}

	const session = getSession(body.sessionId);
	if (!session) {
		return { status: 404, body: { error: "session not found" } };
	}

	const entries = getSessionBranch(session);
	const preparationResult = prepareCompaction(entries, body.settings ?? DEFAULT_COMPACTION_SETTINGS, body.preparation);
	if (!preparationResult.ok) {
		return { status: 400, body: { error: preparationResult.error.message } };
	}
	if (!preparationResult.value) {
		return { status: 400, body: { error: "Nothing to compact" } };
	}

	const options = body.options ?? {};
	return {
		session,
		preparation: preparationResult.value,
		options,
	};
}

async function completeSessionCompact(
	config: ServerConfig,
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
): Promise<SessionCompactHttpResponse> {
	const result = await compact(
		prepared.preparation,
		createRequestModels(body.model, prepared.options),
		body.model,
		body.customInstructions,
		undefined,
		prepared.options.reasoning,
	);
	if (!result.ok) {
		return { status: 500, body: { error: result.error.message } };
	}

	const baseTreeHash = prepared.session.treeHash;
	const baseEntryCount = prepared.session.entries.length;
	const compaction = result.value;
	const firstKeptEntryId = compaction.firstKeptEntryId;
	if (!firstKeptEntryId) {
		return { status: 500, body: { error: "Compaction result is missing firstKeptEntryId" } };
	}
	const normalizedCompaction = { ...compaction, firstKeptEntryId };
	const { session: updatedSession, entry: compactionEntry } = appendCompactionEntry(
		body.sessionId,
		normalizedCompaction,
	);
	persistSession(config, updatedSession);
	if (!body.fullResponse && body.baseTreeHash === baseTreeHash) {
		return {
			status: 200,
			body: {
				success: true,
				compaction: normalizedCompaction satisfies CompactResult,
				compactionEntry,
				...sessionResponseBody(updatedSession),
				staticContext: updatedSession.staticContext,
				treePatch: {
					baseTreeHash,
					entriesFrom: baseEntryCount,
					entries: [compactionEntry],
					leafId: updatedSession.leafId,
					revision: updatedSession.revision,
				},
			},
		};
	}
	return {
		status: 200,
		body: {
			success: true,
			compaction: normalizedCompaction satisfies CompactResult,
			compactionEntry,
			...sessionResponseBody(updatedSession),
			staticContext: updatedSession.staticContext,
			entries: updatedSession.entries,
			messages: updatedSession.messages,
		},
	};
}

function writeServerSentEvent(res: ServerResponse, event: string, body: unknown): void {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function handleSessionCompactStream(
	config: ServerConfig,
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
	res: ServerResponse,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.flushHeaders();
	res.write(STREAM_HEARTBEAT);

	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			res.write(STREAM_HEARTBEAT);
		}
	}, STREAM_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	try {
		const result = await completeSessionCompact(config, body, prepared);
		writeServerSentEvent(res, result.status >= 400 ? "error" : "result", result.body);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		writeServerSentEvent(res, "error", { error: message });
	} finally {
		clearInterval(heartbeat);
		res.end();
	}
}

async function handleSessionCompactJsonStream(
	config: ServerConfig,
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
	res: ServerResponse,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "application/json",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.flushHeaders();
	res.write(JSON_HEARTBEAT);

	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			res.write(JSON_HEARTBEAT);
		}
	}, STREAM_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	try {
		const result = await completeSessionCompact(config, body, prepared);
		res.write(JSON.stringify(result.body));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.write(JSON.stringify({ error: message }));
	} finally {
		clearInterval(heartbeat);
		res.end();
	}
}

async function handleSessionCompact(
	config: ServerConfig,
	body: SessionCompactBody,
	res: ServerResponse,
): Promise<void> {
	const prepared = prepareSessionCompact(body);
	if ("status" in prepared) {
		sendJson(res, prepared.status, prepared.body);
		return;
	}

	if (body.streamResponse) {
		await handleSessionCompactStream(config, body, prepared, res);
		return;
	}

	await handleSessionCompactJsonStream(config, body, prepared, res);
}

function handleDropLastAssistantError(config: ServerConfig, body: SessionIdBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	const dropped = dropLastAssistantError(body.sessionId);
	const session = getSession(body.sessionId);
	if (session) {
		persistSession(config, session);
	}
	const messageCount = session?.messages.length ?? 0;
	sendJson(res, 200, { success: true, dropped, messageCount });
}

function handleSessionHistory(
	sessionId: string,
	from: number | undefined,
	entriesFrom: number | undefined,
	revision: number | undefined,
	baseTreeHash: string | undefined,
	res: ServerResponse,
): void {
	const session = getSession(sessionId);
	if (!session) {
		sendJson(res, 404, { error: "session not found" });
		return;
	}
	const baseMessageCount = from ?? 0;
	if (
		entriesFrom !== undefined &&
		entriesFrom <= session.entries.length &&
		(revision === undefined || revision <= session.revision) &&
		(baseTreeHash === undefined || baseTreeHash === session.prefixHashes[entriesFrom])
	) {
		sendJson(res, 200, sessionTreePatchResponseBody(session, baseMessageCount, entriesFrom, revision));
		return;
	}
	sendJson(res, 200, sessionHistoryFullResponseBody(session, baseMessageCount));
}

function handleSessionRun(sessionId: string, runId: string, res: ServerResponse): void {
	const run = getStreamRun(sessionId, runId);
	if (!run) {
		sendJson(res, 404, { error: "run not found" });
		return;
	}
	sendJson(res, 200, run);
}

export function buildStreamContext(
	session: SessionState,
	body: Pick<StreamRequestBody, "contextOverlay" | "ephemeralMessages">,
): Context {
	const messages = body.contextOverlay ?? [...session.messages, ...(body.ephemeralMessages ?? [])];
	return {
		systemPrompt: session.staticContext?.systemPrompt,
		messages,
		tools: session.staticContext?.tools,
	};
}

function handleStream(config: ServerConfig, body: StreamRequestBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!body.model) {
		sendJson(res, 400, { error: "model is required" });
		return;
	}

	const session = getOrCreateSession(body.sessionId);

	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
		persistSession(config, session);
	}

	if (!session.staticContext && !body.staticContext) {
		sendJson(res, 400, { error: "Session has no static context. Initialize with /api/session/init first." });
		return;
	}

	if (body.ephemeralMessages !== undefined && !Array.isArray(body.ephemeralMessages)) {
		sendJson(res, 400, { error: "ephemeralMessages must be an array" });
		return;
	}
	if (body.contextOverlay !== undefined && !Array.isArray(body.contextOverlay)) {
		sendJson(res, 400, { error: "contextOverlay must be an array" });
		return;
	}

	const context = buildStreamContext(session, body);
	const existingRun = body.runId ? getStreamRun(body.sessionId, body.runId) : undefined;

	const { model: resolvedModel, options: streamOptions } = resolveStreamOptions(config, body.model, body);

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.flushHeaders();
	res.write(STREAM_HEARTBEAT);

	if (existingRun?.status === "completed") {
		for (const event of existingRun.events) {
			res.write(encodeProxyEvent(event));
		}
		res.end();
		return;
	}

	const run = body.runId ? startStreamRun(body.sessionId, body.runId) : undefined;

	const heartbeat = setInterval(() => {
		if (!res.writableEnded) {
			res.write(STREAM_HEARTBEAT);
		}
	}, STREAM_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	let stream: AsyncIterable<AssistantMessageEvent>;
	try {
		stream = streamSimple(resolvedModel, context, streamOptions);
	} catch (err) {
		clearInterval(heartbeat);
		const message = err instanceof Error ? err.message : String(err);
		failStreamRun(run, message);
		res.write(encodeErrorEvent(message));
		res.end();
		return;
	}

	(async () => {
		try {
			for await (const event of stream) {
				const proxyEvent = toProxyEvent(event);
				if (proxyEvent) {
					recordStreamRunEvent(run, proxyEvent);
					res.write(encodeProxyEvent(proxyEvent));
				}
				if (event.type === "done") {
					completeStreamRun(run, event.message);
				} else if (event.type === "error") {
					failStreamRun(run, event.error.errorMessage ?? event.reason);
				}
			}
		} finally {
			clearInterval(heartbeat);
		}

		res.end();
	})().catch((err) => {
		clearInterval(heartbeat);
		const message = err instanceof Error ? err.message : String(err);
		failStreamRun(run, message);
		res.write(encodeErrorEvent(message));
		res.end();
	});
}

async function handlePostRequest(
	config: ServerConfig,
	pathname: string,
	body: unknown,
	res: ServerResponse,
): Promise<boolean> {
	if (pathname === "/api/receive") {
		try {
			sendJson(res, 200, receiveUpload(config.uploadDir, body));
		} catch (error) {
			if (!(error instanceof ReceiveUploadError)) throw error;
			sendJson(res, error.status, { error: error.message });
		}
		return true;
	}

	if (pathname === "/api/session/init") {
		handleSessionInit(config, body as SessionInitBody, res);
		return true;
	}

	if (pathname === "/api/session/update") {
		handleSessionUpdate(config, body as SessionInitBody & { staticContext: SessionStaticContext }, res);
		return true;
	}

	if (pathname === "/api/session/sync") {
		handleSessionSync(config, body as SessionSyncBody, res);
		return true;
	}

	if (pathname === "/api/session/append") {
		handleSessionAppend(config, body as SessionAppendBody, res);
		return true;
	}

	if (pathname === "/api/session/tree/sync") {
		handleSessionTreeSync(config, body as SessionTreeSyncBody, res);
		return true;
	}

	if (pathname === "/api/session/tree/append") {
		handleSessionTreeAppend(config, body as SessionTreeSyncBody, res);
		return true;
	}

	if (pathname === "/api/session/tree/switch") {
		handleSessionTreeSwitch(config, body as SessionTreeSwitchBody, res);
		return true;
	}

	if (pathname === "/api/session/drop-last-assistant-error") {
		handleDropLastAssistantError(config, body as SessionIdBody, res);
		return true;
	}

	if (pathname === "/api/session/compact") {
		await handleSessionCompact(config, body as SessionCompactBody, res);
		return true;
	}

	if (pathname === "/api/stream") {
		handleStream(config, body as StreamRequestBody, res);
		return true;
	}

	return false;
}

export function createPiServer(configOverride?: Partial<ServerConfig>): HttpServer {
	const config = loadConfig(configOverride);
	loadPersistedSessions(config.sessionStoreDir);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		if (!authenticate(config, req)) {
			const body =
				req.method === "GET" && url.pathname === "/"
					? { error: "Unauthorized", version: PI_SERVER_VERSION }
					: { error: "Unauthorized" };
			sendJson(res, 401, body);
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			sendJson(res, 200, { sessions: listSessions() });
			return;
		}

		const runMatch = /^\/api\/session\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
		if (req.method === "GET" && runMatch) {
			handleSessionRun(decodeURIComponent(runMatch[1]), decodeURIComponent(runMatch[2]), res);
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/history")) {
			const encodedSessionId = url.pathname.slice("/api/session/".length, -"/history".length);
			const fromParam = url.searchParams.get("from");
			const from = fromParam === null ? undefined : Number(fromParam);
			if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
				sendJson(res, 400, { error: "from must be a non-negative integer" });
				return;
			}
			const entriesFromParam = url.searchParams.get("entriesFrom");
			const entriesFrom = entriesFromParam === null ? undefined : Number(entriesFromParam);
			if (entriesFrom !== undefined && (!Number.isInteger(entriesFrom) || entriesFrom < 0)) {
				sendJson(res, 400, { error: "entriesFrom must be a non-negative integer" });
				return;
			}
			const revisionParam = url.searchParams.get("revision");
			const revision = revisionParam === null ? undefined : Number(revisionParam);
			if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
				sendJson(res, 400, { error: "revision must be a non-negative integer" });
				return;
			}
			handleSessionHistory(
				decodeURIComponent(encodedSessionId),
				from,
				entriesFrom,
				revision,
				url.searchParams.get("baseTreeHash") ?? undefined,
				res,
			);
			return;
		}

		if (req.method === "POST" && url.pathname === CHUNK_ENDPOINT) {
			try {
				const body = JSON.parse(await readBody(req)) as RequestChunkBody;
				const chunkResult = receiveRequestChunk(body);
				if (!chunkResult.complete) {
					sendJson(res, 200, chunkResult.ack);
					return;
				}
				await handlePostRequest(config, chunkResult.target, JSON.parse(chunkResult.bodyJson) as unknown, res);
			} catch (err) {
				logRequestError(req, err);
				if (!res.headersSent) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				} else {
					res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
					res.end();
				}
			}
			return;
		}

		if (req.method === "POST") {
			try {
				const body = JSON.parse(await readBody(req)) as unknown;
				if (await handlePostRequest(config, url.pathname, body, res)) return;
			} catch (err) {
				logRequestError(req, err);
				if (!res.headersSent) {
					sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
				} else {
					res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
					res.end();
				}
				return;
			}
		}

		if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
			const sessionId = decodeURIComponent(url.pathname.slice("/api/session/".length));
			deleteSessionFromStore(sessionId);
			deletePersistedSession(config.sessionStoreDir, sessionId);
			sendJson(res, 200, { deleted: sessionId });
			return;
		}

		sendJson(res, 404, { error: "Not found" });
	});

	return server;
}

function toProxyEvent(event: AssistantMessageEvent): ProxyAssistantMessageEvent | undefined {
	switch (event.type) {
		case "start":
			return { type: "start" };
		case "text_start":
			return { type: "text_start", contentIndex: event.contentIndex };
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return {
				type: "text_end",
				contentIndex: event.contentIndex,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "text"
						? (event.partial.content[event.contentIndex] as { textSignature?: string }).textSignature
						: undefined,
			};
		case "thinking_start":
			return { type: "thinking_start", contentIndex: event.contentIndex };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "thinking"
						? (event.partial.content[event.contentIndex] as { thinkingSignature?: string }).thinkingSignature
						: undefined,
			};
		case "toolcall_start":
			return {
				type: "toolcall_start",
				contentIndex: event.contentIndex,
				id:
					event.partial.content[event.contentIndex]?.type === "toolCall"
						? (event.partial.content[event.contentIndex] as { id: string }).id
						: "",
				toolName:
					event.partial.content[event.contentIndex]?.type === "toolCall"
						? (event.partial.content[event.contentIndex] as { name: string }).name
						: "",
			};
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex };
		case "done":
			return { type: "done", reason: event.reason, usage: event.message.usage };
		case "error":
			return {
				type: "error",
				reason: event.reason,
				errorMessage: event.error.errorMessage,
				usage: event.error.usage,
			};
		default:
			return undefined;
	}
}

export function startServer(configOverride?: Partial<ServerConfig>): HttpServer {
	const config = loadConfig(configOverride);
	const server = createPiServer(configOverride);
	server.listen(config.port, config.host, () => {
		console.log(`pi-server listening on ${config.host}:${config.port}`);
	});
	return server;
}
