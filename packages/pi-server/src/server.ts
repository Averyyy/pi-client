import { Buffer } from "node:buffer";
import { createHash, type Hash, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
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
	type RetryPolicy,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ServerConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { encodeErrorEvent, encodeProxyEvent } from "./event-encoding.ts";
import {
	appendPiServerTreeHash,
	canonicalJsonStringify,
	hashPiServerTreeEntry,
	matchesPiServerStreamBase,
	PI_SERVER_EMPTY_TREE_HASH,
	type PiServerSessionIdentity,
	type PiServerStreamBaseIdentity,
} from "./pi-server-protocol.ts";
import { ReceiveUploadError, receiveUpload } from "./receive-upload.ts";
import { CHUNK_ENDPOINT, type RequestChunkBody, receiveRequestChunk } from "./request-chunks.ts";
import {
	deletePersistedSession,
	loadPersistedSessions,
	preflightPersistedSession,
	SessionPersistenceCapacityError,
	type SessionPersistenceFaultPoint,
	savePersistedSession,
} from "./session-persistence.ts";
import {
	applyPiServerCompactionEntry,
	applySessionMutation,
	clearAllSessions,
	configureSessionCapacityLimits,
	DEFAULT_SESSION_CAPACITY_LIMITS,
	deleteSession as deleteSessionFromStore,
	dropLastAssistantError,
	exportSessionState,
	getOrCreateSession,
	getSession,
	getSessionBranch,
	listSessions,
	type PiServerCompactionEntry,
	type PiServerCompactionOperationMetadata,
	preflightSessionCapacityMutation,
	resetSessionCapacityLimits,
	restoreSessionState,
	SessionCapacityError,
	type SessionState,
	type SessionStaticContext,
	switchSessionLeaf,
} from "./session-store.ts";
import {
	StreamRunConflictError,
	StreamRunCorruptionError,
	StreamRunNotFoundError,
	StreamRunPersistence,
	type StreamRunPersistenceFaultPoint,
	StreamRunPersistenceTimeoutError,
	StreamRunQuotaError,
	type StreamRunState,
	StreamRunStateError,
	StreamRunStoreLockedError,
} from "./stream-run-persistence.ts";

export { loadConfig, type ServerConfig } from "./config.ts";

interface PackageMetadata {
	version: string;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;
const PI_SERVER_VERSION = packageMetadata.version;
const PI_SERVER_PROTOCOL_VERSION = 2;

interface SessionInitBody {
	sessionId: string;
	staticContext?: SessionStaticContext;
	staticContextHash?: string;
}

interface StreamRequestBody {
	sessionId: string;
	runId?: string;
	eventCursor?: number;
	runMode?: "main-durable" | "auxiliary-transient";
	baseStaticContextHash?: string;
	baseRevision?: number;
	baseTreeHash?: string;
	baseEntryCount?: number;
	baseLeafId?: string | null;
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
	protocolVersion: number;
	sessionId: string;
	model: Model<any>;
	options?: SimpleStreamOptions;
	settings?: CompactionSettings;
	preparation?: CompactionPreparationOptions;
	extensionCompaction?: CompactResult;
	customInstructions?: string;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
	streamResponse: boolean;
	operationId: string;
	retry?: RetryPolicy;
}

function createRequestModels(model: Model<any>, options: SimpleStreamOptions) {
	const models = createModels();
	const streamWithRequestOptions = (requestModel: Model<any>, context: Context, streamOptions: SimpleStreamOptions) =>
		streamSimple(requestModel, context, { ...options, ...streamOptions });
	models.setProvider(
		createProvider({
			id: model.provider,
			name: model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: "pi-server request auth",
					resolve: async () => ({
						auth: { apiKey: options.apiKey, headers: options.headers },
						env: options.env,
					}),
				},
			},
			api: {
				stream: streamWithRequestOptions,
				streamSimple: streamWithRequestOptions,
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
	runId?: string;
	storageRunId: string;
	requestHash: string;
	status: "running" | "completed" | "failed";
	nextSeq: number;
	message?: AssistantMessage;
	errorMessage?: string;
	model: ResolvedStream["model"];
	contentDeltas: Map<number, { type: "text" | "thinking"; hash: Hash; bytes: number }>;
	abortController: AbortController;
	subscribers: Map<ServerResponse, StreamRunSubscriber>;
	providerFailureLogged: boolean;
	persistenceFailureLogged: boolean;
	pendingEvents: string[];
	pendingEventBytes: number;
	flushTimer?: ReturnType<typeof setTimeout>;
	flushPromise?: Promise<void>;
	persistenceError?: Error;
	terminalPromise?: Promise<void>;
	shuttingDown: boolean;
}

interface StreamRunSubscriber {
	heartbeat?: ReturnType<typeof setInterval>;
	heartbeatWrite?: Promise<void>;
	onClose: () => void;
	abortController: AbortController;
	cursor: number;
	flushing: boolean;
	flushAgain: boolean;
	pump?: Promise<void>;
}

interface StreamRunRuntime {
	store: StreamRunPersistence;
	activeRuns: Map<string, StreamRunRecord>;
	setupQueue: Promise<void>;
	subscriberPumps: Map<string, Set<Promise<void>>>;
	replayReaders: Map<string, Set<StreamRunReplay>>;
	drainIdleTimeoutMs: number;
	fatalPersistenceError?: Error;
	onFatalPersistenceError?: (error: Error) => void;
	closing: boolean;
}

interface StreamRunReplay {
	runId: string;
	response: ServerResponse;
	abortController: AbortController;
	promise?: Promise<void>;
}

interface CompactRunRecord {
	sessionId: string;
	operationId: string;
	requestHash: string;
	status: "running" | "settled";
	result?: SessionCompactHttpResponse;
	promise: Promise<SessionCompactHttpResponse>;
	abortController: AbortController;
	subscribers: Set<ServerResponse>;
	settlement?: Promise<SessionCompactHttpResponse>;
	resolveTerminal?: (response: SessionCompactHttpResponse) => void;
	rejectTerminal?: (error: unknown) => void;
}

interface CompactRunRuntime {
	store: StreamRunPersistence;
	activeRuns: Map<string, CompactRunRecord>;
	setupQueue: Promise<void>;
	drainIdleTimeoutMs: number;
	fatalPersistenceError?: Error;
	onFatalPersistenceError?: (error: Error) => void;
	closing: boolean;
}

interface SessionMutationRuntime {
	queues: Map<string, Promise<void>>;
}

interface ServerPersistenceRuntime {
	fatalError?: Error;
	streamRuntime?: StreamRunRuntime;
	compactRuntime?: CompactRunRuntime;
	onFatalPersistenceError?: (error: Error) => void;
	sessionFaultInjector?: (point: SessionPersistenceFaultPoint) => void;
}

interface CompactBaseIdentity {
	staticContextHash: string;
	treeHash: string;
	entryCount: number;
	leafId: string | null;
	revision: number;
}

interface CompactionCommitPlan {
	base: CompactBaseIdentity;
	entry: PiServerCompactionEntry;
	updatedTreeHash: string;
	updatedRevision: number;
}

interface CompactTerminalPlan {
	version: 1;
	sessionId: string;
	operationId: string;
	requestHash: string;
	response: SessionCompactHttpResponse;
	commit?: CompactionCommitPlan;
}

interface CapturedJsonResponse {
	status: number;
	bodyJson: string;
}

interface ChunkTargetResponseRecord extends CapturedJsonResponse {
	createdAt: number;
	bytes: number;
}

const jsonResponseCaptures = new WeakMap<ServerResponse, (response: CapturedJsonResponse) => void>();
const serverInitializations = new WeakMap<HttpServer, Promise<void>>();
let sessionCapacityMutationQueue: Promise<void> = Promise.resolve();
let piServerOwner: symbol | undefined;
let activeServerPersistenceRuntime: ServerPersistenceRuntime | undefined;

const STREAM_HEARTBEAT = ": keep-alive\n\n";
const JSON_HEARTBEAT = " \n";
const STREAM_HEARTBEAT_INTERVAL_MS = 25_000;
const STREAM_RUN_CLEANUP_INTERVAL_MS = 60_000;
const STREAM_RUN_MAX_RECORDS = 256;
const STREAM_RUN_MAX_SUBSCRIBERS = 8;
const STREAM_RUN_ERROR_LOG_CHARS = 1000;
const STREAM_RUN_BATCH_MAX_EVENTS = 64;
const STREAM_RUN_BATCH_MAX_BYTES = 64 * 1024;
const STREAM_RUN_BATCH_DELAY_MS = 12;
const STREAM_RUN_RESTART_ERROR_MESSAGE = "restart-unknown";
const STREAM_RUN_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const STREAM_RUN_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const STREAM_RUN_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const STREAM_RUN_TERMINAL_RESERVE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_STREAM_DRAIN_IDLE_TIMEOUT_MS = 90_000;
const CHUNK_ACK_HEADER = "X-Pi-Chunk-Ack";
const COMPACT_RUN_MAX_RECORDS = 32;
const COMPACT_RUN_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const COMPACT_RUN_MAX_BYTES = 128 * 1024 * 1024;
const COMPACT_RUN_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const COMPACT_RUN_TERMINAL_RESERVE_BYTES = 64 * 1024 * 1024;
const COMPACT_RUN_MAX_SUBSCRIBERS = 8;
const REQUEST_BODY_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_BODY_NO_PROGRESS_TIMEOUT_MS = 90_000;
const HEADERS_TIMEOUT_MS = 15_000;
const CHUNK_TARGET_RESPONSE_TTL_MS = 60_000;
const CHUNK_TARGET_RESPONSE_MAX_RECORDS = 128;
const CHUNK_TARGET_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const FATAL_SHUTDOWN_GRACE_MS = 10_000;

class RequestBodyTooLargeError extends Error {
	readonly statusCode = 413;
}

class RequestBodyIncompleteError extends Error {
	readonly statusCode = 400;
}

class RequestBodyNoProgressError extends Error {
	readonly statusCode = 408;
}

class ServerPersistenceUnavailableError extends Error {
	readonly statusCode = 503;

	constructor() {
		super("pi-server durable persistence is unavailable");
		this.name = "ServerPersistenceUnavailableError";
	}
}

export type PiServerOptions = Partial<ServerConfig> & {
	streamDrainIdleTimeoutMs?: number;
	streamRunMaxFrameBytes?: number;
	streamRunMaxBytes?: number;
	streamRunMaxTotalBytes?: number;
	streamRunTerminalReserveBytes?: number;
	streamRunIoNoProgressTimeoutMs?: number;
	streamRunFaultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>;
	compactRunMaxBytes?: number;
	compactRunMaxTotalBytes?: number;
	compactRunTerminalReserveBytes?: number;
	compactRunIoNoProgressTimeoutMs?: number;
	compactRunFaultInjector?: (point: StreamRunPersistenceFaultPoint) => void | Promise<void>;
	requestBodyNoProgressTimeoutMs?: number;
	sessionMaxEntries?: number;
	sessionMaxLogicalBytes?: number;
	sessionsMaxEntries?: number;
	sessionsMaxLogicalBytes?: number;
	maxLoadedSessions?: number;
	sessionPersistenceFaultInjector?: (point: SessionPersistenceFaultPoint) => void;
	sessionPersistenceDelete?: typeof deletePersistedSession;
	onFatalStreamPersistenceError?: (error: Error) => void;
	fatalShutdownGraceMs?: number;
	fatalExit?: (code: number) => void;
};

function positiveServerOption(
	value: number | undefined,
	environmentVariable: string,
	fallback: number,
	label: string,
): number {
	const environmentValue = process.env[environmentVariable];
	const resolved = value ?? (environmentValue === undefined ? fallback : Number(environmentValue));
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new Error(`${label} (${environmentVariable}) must be a positive safe integer`);
	}
	return resolved;
}

function acquirePiServerOwnership(): symbol {
	if (piServerOwner) {
		throw new Error(
			"pi-server already owns the process-wide session store; close the existing server before creating another",
		);
	}
	const owner = Symbol("pi-server-owner");
	piServerOwner = owner;
	clearAllSessions();
	resetSessionCapacityLimits();
	sessionCapacityMutationQueue = Promise.resolve();
	return owner;
}

function releasePiServerOwnership(owner: symbol): void {
	if (piServerOwner !== owner) return;
	clearAllSessions();
	resetSessionCapacityLimits();
	sessionCapacityMutationQueue = Promise.resolve();
	activeServerPersistenceRuntime = undefined;
	piServerOwner = undefined;
}

function assertServerPersistenceHealthy(): void {
	if (activeServerPersistenceRuntime?.fatalError) {
		throw new ServerPersistenceUnavailableError();
	}
}

export function readBody(
	req: IncomingMessage,
	maxBytes = REQUEST_BODY_MAX_BYTES,
	noProgressTimeoutMs = REQUEST_BODY_NO_PROGRESS_TIMEOUT_MS,
): Promise<string> {
	if (!Number.isSafeInteger(noProgressTimeoutMs) || noProgressTimeoutMs <= 0) {
		throw new Error("request body no-progress timeout must be a positive safe integer");
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let noProgressTimer: ReturnType<typeof setTimeout> | undefined;
		const chunks: Buffer[] = [];
		let receivedBytes = 0;

		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onAborted);
			req.off("close", onClose);
			if (noProgressTimer) clearTimeout(noProgressTimer);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				chunks.length = 0;
				reject(error);
				return;
			}
			resolve(Buffer.concat(chunks).toString("utf-8"));
		};
		const armNoProgressTimer = () => {
			if (noProgressTimer) clearTimeout(noProgressTimer);
			noProgressTimer = setTimeout(() => {
				finish(new RequestBodyNoProgressError(`Request body made no progress for ${noProgressTimeoutMs}ms`));
				req.resume();
			}, noProgressTimeoutMs);
			noProgressTimer.unref();
		};
		const onData = (chunk: Buffer) => {
			if (settled) return;
			if (chunk.byteLength === 0) return;
			armNoProgressTimer();
			receivedBytes += chunk.byteLength;
			if (receivedBytes > maxBytes) {
				finish(new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
				req.resume();
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => finish();
		const onError = (error: Error) => finish(error);
		const onAborted = () => finish(new RequestBodyIncompleteError("Request body was aborted before completion"));
		const onClose = () => finish(new RequestBodyIncompleteError("Request closed before body completion"));

		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onAborted);
		req.once("close", onClose);
		armNoProgressTimer();
		if (req.aborted) {
			onAborted();
			return;
		}
		if (req.destroyed && !req.complete) {
			onClose();
			return;
		}

		const contentLength = Number(req.headers["content-length"]);
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			finish(new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
			req.resume();
		}
	});
}

function requestErrorStatus(error: unknown, defaultStatus: number): number {
	if (error instanceof RequestBodyTooLargeError) return error.statusCode;
	if (error instanceof RequestBodyIncompleteError) return error.statusCode;
	if (error instanceof RequestBodyNoProgressError) return error.statusCode;
	if (error instanceof ServerPersistenceUnavailableError) return error.statusCode;
	if (error instanceof SessionCapacityError || error instanceof SessionPersistenceCapacityError) return 507;
	if (error instanceof StreamRunNotFoundError) return 404;
	if (error instanceof StreamRunConflictError || error instanceof StreamRunStateError) return 409;
	if (error instanceof StreamRunQuotaError || error instanceof StreamRunStoreLockedError) return 503;
	return defaultStatus;
}

function requestErrorBody(error: unknown): Record<string, unknown> {
	if (error instanceof SessionPersistenceCapacityError) {
		return {
			error: `Persisted session capacity exceeded: resource=${error.resource}, session=${error.sessionId}, requested=${error.requested}, limit=${error.limit}`,
			code: error.code,
			resource: error.resource,
			sessionId: error.sessionId,
			current: error.current,
			requested: error.requested,
			limit: error.limit,
			retryable: error.retryable,
			artifact: basename(error.path),
		};
	}
	if (error instanceof SessionCapacityError) {
		return {
			error: error.message,
			code: error.code,
			resource: error.resource,
			sessionId: error.sessionId,
			current: error.current,
			requested: error.requested,
			limit: error.limit,
			retryable: error.retryable,
		};
	}
	return { error: error instanceof Error ? error.message : String(error) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	const capture = jsonResponseCaptures.get(res);
	if (capture) {
		jsonResponseCaptures.delete(res);
		capture({ status, bodyJson: data });
	}
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
	res.end(data);
}

function sendCapturedJson(res: ServerResponse, response: CapturedJsonResponse): void {
	const data = response.bodyJson;
	res.writeHead(response.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
	res.end(data);
}

function logRequestError(req: IncomingMessage, error: unknown): void {
	if (error instanceof SessionCapacityError || error instanceof SessionPersistenceCapacityError) return;
	if (error instanceof ServerPersistenceUnavailableError) return;
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
		protocolVersion: PI_SERVER_PROTOCOL_VERSION,
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		messageCount: session.messages.length,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
	};
}

function sessionHistoryV2Summary(session: SessionState) {
	return {
		protocolVersion: PI_SERVER_PROTOCOL_VERSION,
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		messageCount: session.messages.length,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
	};
}

function currentServerPersistenceRuntime(): ServerPersistenceRuntime {
	const runtime = activeServerPersistenceRuntime;
	if (!runtime) {
		throw new ServerPersistenceUnavailableError();
	}
	return runtime;
}

function persistSession(config: ServerConfig, session: SessionState): void {
	const runtime = currentServerPersistenceRuntime();
	try {
		savePersistedSession(config.sessionStoreDir, session, {
			faultInjector: runtime.sessionFaultInjector,
		});
	} catch (error) {
		if (!(error instanceof SessionPersistenceCapacityError)) {
			failStopServerPersistence(runtime, error);
		}
		throw error;
	}
}

function mutateAndPersistSession(config: ServerConfig, sessionId: string, mutate: () => SessionState): SessionState {
	const runtime = currentServerPersistenceRuntime();
	const previous = getSession(sessionId);
	const previousState = previous ? exportSessionState(previous) : undefined;
	const session = mutate();
	try {
		persistSession(config, session);
		return session;
	} catch (error) {
		if (!(error instanceof SessionPersistenceCapacityError)) throw error;
		try {
			if (previousState) {
				restoreSessionState(previousState);
			} else {
				deleteSessionFromStore(sessionId);
			}
		} catch (rollbackError) {
			const failure = new AggregateError(
				[error, rollbackError],
				`Failed to restore session ${sessionId} after persistence capacity rejection`,
			);
			failStopServerPersistence(runtime, failure);
			throw failure;
		}
		throw error;
	}
}

function runKey(sessionId: string, runId: string): string {
	return `${sessionId}\0${runId}`;
}

function hashStreamRequest(body: StreamRequestBody): string {
	const serialized = canonicalJsonStringify({
		sessionId: body.sessionId,
		runMode: body.runMode,
		baseStaticContextHash: body.baseStaticContextHash,
		baseRevision: body.baseRevision,
		baseTreeHash: body.baseTreeHash,
		baseEntryCount: body.baseEntryCount,
		baseLeafId: body.baseLeafId,
		model: body.model,
		options: body.options,
		staticContext: body.staticContext,
		ephemeralMessages: body.ephemeralMessages,
		contextOverlay: body.contextOverlay,
	});
	if (serialized === undefined) {
		throw new Error("Failed to serialize pi-server stream request");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

function sessionIdentity(session: SessionState): PiServerSessionIdentity {
	return {
		staticContextHash: session.staticContextHash,
		treeHash: session.treeHash,
		entryCount: session.entries.length,
		leafId: session.leafId,
		revision: session.revision,
	};
}

function streamBaseIdentity(session: SessionState): PiServerStreamBaseIdentity {
	return {
		baseStaticContextHash: session.staticContextHash,
		baseTreeHash: session.treeHash,
		baseEntryCount: session.entries.length,
		baseLeafId: session.leafId,
		baseRevision: session.revision,
	};
}

function hashCompactRequest(body: SessionCompactBody): string {
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
	if (serialized === undefined) {
		throw new Error("Failed to serialize pi-server compaction request");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

function createStreamErrorEvent(
	errorMessage: string,
	reason: "aborted" | "error" = "error",
): Extract<ProxyAssistantMessageEvent, { type: "error" }> {
	return {
		type: "error",
		reason,
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createRestartFailureTerminal(identity: { sessionId: string; runId: string; requestMac: string }): {
	event: string;
	result: AssistantMessage;
	errorMessage: string;
} {
	const result: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "pi-server",
		model: STREAM_RUN_RESTART_ERROR_MESSAGE,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
		timestamp: Date.now(),
		diagnostics: [
			{
				type: "pi_server_run",
				timestamp: Date.now(),
				details: {
					sessionId: identity.sessionId,
					runId: identity.runId,
					requestMac: identity.requestMac,
					restartUnknown: true,
				},
			},
		],
	};
	return {
		event: encodeProxyEvent({
			type: "error",
			reason: "error",
			errorMessage: result.errorMessage,
			usage: result.usage,
			diagnostics: result.diagnostics,
			api: result.api,
			provider: result.provider,
			model: result.model,
			timestamp: result.timestamp,
		}),
		result,
		errorMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
	};
}

function clearStreamRunFlushTimer(run: StreamRunRecord): void {
	if (!run.flushTimer) return;
	clearTimeout(run.flushTimer);
	run.flushTimer = undefined;
}

function releaseTerminalStreamRun(runtime: StreamRunRuntime, run: StreamRunRecord): void {
	if (run.status === "running" || run.subscribers.size > 0) return;
	runtime.activeRuns.delete(runKey(run.sessionId, run.storageRunId));
}

function detachStreamRunSubscriber(runtime: StreamRunRuntime, run: StreamRunRecord, res: ServerResponse): void {
	const subscriber = run.subscribers.get(res);
	if (!subscriber) return;
	if (subscriber.heartbeat) {
		clearInterval(subscriber.heartbeat);
	}
	subscriber.abortController.abort();
	res.off("close", subscriber.onClose);
	run.subscribers.delete(res);
	releaseTerminalStreamRun(runtime, run);
}

export function waitForStreamDrain(
	res: ServerResponse,
	idleTimeoutMs = DEFAULT_STREAM_DRAIN_IDLE_TIMEOUT_MS,
): Promise<boolean> {
	if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
		throw new Error("stream drain idle timeout must be a positive safe integer");
	}
	return new Promise((resolve) => {
		if (res.destroyed || res.writableEnded) {
			resolve(false);
			return;
		}
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			res.off("drain", onDrain);
			res.off("close", onClose);
			if (timeout) clearTimeout(timeout);
		};
		const finish = (drained: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(drained);
		};
		const onDrain = () => finish(true);
		const onClose = () => finish(false);
		res.once("drain", onDrain);
		res.once("close", onClose);
		timeout = setTimeout(() => finish(false), idleTimeoutMs);
		timeout.unref();
		if (res.destroyed || res.writableEnded) {
			onClose();
		}
	});
}

async function writeWithStreamDrain(res: ServerResponse, data: string, idleTimeoutMs: number): Promise<boolean> {
	if (res.destroyed || res.writableEnded) return false;
	try {
		if (res.writableNeedDrain && !(await waitForStreamDrain(res, idleTimeoutMs))) return false;
		if (res.destroyed || res.writableEnded) return false;
		if (res.write(data)) return true;
		return waitForStreamDrain(res, idleTimeoutMs);
	} catch {
		return false;
	}
}

function messageFromDurableState(state: StreamRunState): AssistantMessage | undefined {
	const result = state.terminal?.result;
	if (typeof result !== "object" || result === null || !("role" in result) || result.role !== "assistant") {
		return undefined;
	}
	return result as AssistantMessage;
}

function applyDurableState(run: StreamRunRecord, state: StreamRunState): void {
	run.status = state.status;
	run.nextSeq = state.nextSeq;
	run.message = messageFromDurableState(state);
	run.errorMessage = state.terminal?.errorMessage;
}

async function pumpStreamRunSubscriber(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	res: ServerResponse,
	subscriber: StreamRunSubscriber,
): Promise<void> {
	try {
		do {
			subscriber.flushAgain = false;
			for await (const frame of runtime.store.iterateEvents(
				run.sessionId,
				run.storageRunId,
				subscriber.cursor,
				subscriber.abortController.signal,
			)) {
				if (run.subscribers.get(res) !== subscriber || res.destroyed || res.writableEnded) return;
				subscriber.cursor = frame.seq + 1;
				if (!res.write(frame.event) && !(await waitForStreamDrain(res, runtime.drainIdleTimeoutMs))) {
					detachStreamRunSubscriber(runtime, run, res);
					if (!res.destroyed) res.destroy();
					return;
				}
			}
			if (
				subscriber.abortController.signal.aborted ||
				run.subscribers.get(res) !== subscriber ||
				res.destroyed ||
				res.writableEnded
			) {
				return;
			}
			const state = await runtime.store.get(run.sessionId, run.storageRunId);
			if (!state) {
				throw new StreamRunNotFoundError(run.sessionId, run.storageRunId);
			}
			applyDurableState(run, state);
			if (run.status !== "running" && subscriber.cursor >= run.nextSeq) {
				detachStreamRunSubscriber(runtime, run, res);
				if (!res.destroyed && !res.writableEnded) res.end();
				return;
			}
			if (subscriber.cursor < run.nextSeq) subscriber.flushAgain = true;
		} while (subscriber.flushAgain);
	} catch {
		detachStreamRunSubscriber(runtime, run, res);
		if (!res.destroyed) res.destroy();
	}
}

function addSessionSubscriberPump(runtime: StreamRunRuntime, sessionId: string, pump: Promise<void>): void {
	let pumps = runtime.subscriberPumps.get(sessionId);
	if (!pumps) {
		pumps = new Set();
		runtime.subscriberPumps.set(sessionId, pumps);
	}
	pumps.add(pump);
}

function removeSessionSubscriberPump(runtime: StreamRunRuntime, sessionId: string, pump: Promise<void>): void {
	const pumps = runtime.subscriberPumps.get(sessionId);
	if (!pumps) return;
	pumps.delete(pump);
	if (pumps.size === 0) runtime.subscriberPumps.delete(sessionId);
}

function startStreamRunSubscriberPump(runtime: StreamRunRuntime, run: StreamRunRecord, res: ServerResponse): void {
	const subscriber = run.subscribers.get(res);
	if (!subscriber || res.destroyed || res.writableEnded) return;
	if (subscriber.heartbeatWrite) {
		subscriber.flushAgain = true;
		return;
	}
	if (subscriber.flushing) {
		subscriber.flushAgain = true;
		return;
	}
	subscriber.flushing = true;
	const pump = pumpStreamRunSubscriber(runtime, run, res, subscriber).finally(() => {
		subscriber.flushing = false;
		removeSessionSubscriberPump(runtime, run.sessionId, pump);
		if (subscriber.flushAgain && run.subscribers.get(res) === subscriber) {
			startStreamRunSubscriberPump(runtime, run, res);
		}
	});
	subscriber.pump = pump;
	addSessionSubscriberPump(runtime, run.sessionId, pump);
}

function notifyStreamRunSubscribers(runtime: StreamRunRuntime, run: StreamRunRecord): void {
	for (const res of [...run.subscribers.keys()]) {
		startStreamRunSubscriberPump(runtime, run, res);
	}
	releaseTerminalStreamRun(runtime, run);
}

function beginStreamResponse(res: ServerResponse): boolean {
	try {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.flushHeaders();
		return true;
	} catch {
		res.destroy();
		return false;
	}
}

function startStreamRunSubscriberHeartbeat(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	res: ServerResponse,
	subscriber: StreamRunSubscriber,
): void {
	if (subscriber.heartbeatWrite || subscriber.flushing || run.subscribers.get(res) !== subscriber) return;
	const heartbeatWrite = writeWithStreamDrain(res, STREAM_HEARTBEAT, runtime.drainIdleTimeoutMs)
		.then((succeeded) => {
			if (!succeeded && run.subscribers.get(res) === subscriber) {
				detachStreamRunSubscriber(runtime, run, res);
				if (!res.destroyed) res.destroy();
			}
		})
		.catch(() => {
			if (run.subscribers.get(res) === subscriber) {
				detachStreamRunSubscriber(runtime, run, res);
				if (!res.destroyed) res.destroy();
			}
		})
		.finally(() => {
			if (subscriber.heartbeatWrite === heartbeatWrite) subscriber.heartbeatWrite = undefined;
			if (run.subscribers.get(res) === subscriber && !res.destroyed && !res.writableEnded) {
				startStreamRunSubscriberPump(runtime, run, res);
			}
		});
	subscriber.heartbeatWrite = heartbeatWrite;
}

function subscribeToStreamRun(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	res: ServerResponse,
	cursor: number,
): void {
	const onClose = () => detachStreamRunSubscriber(runtime, run, res);
	const subscriber: StreamRunSubscriber = {
		onClose,
		abortController: new AbortController(),
		cursor,
		flushing: false,
		flushAgain: false,
	};
	if (run.status === "running") {
		subscriber.heartbeat = setInterval(() => {
			startStreamRunSubscriberHeartbeat(runtime, run, res, subscriber);
		}, STREAM_HEARTBEAT_INTERVAL_MS);
		subscriber.heartbeat.unref();
	}
	run.subscribers.set(res, subscriber);
	res.once("close", onClose);
	startStreamRunSubscriberHeartbeat(runtime, run, res, subscriber);
}

function enqueueStreamRunSetup<T>(runtime: StreamRunRuntime, operation: () => Promise<T>): Promise<T> {
	const guardedOperation = () => {
		assertServerPersistenceHealthy();
		return operation();
	};
	const result = runtime.setupQueue.then(guardedOperation, guardedOperation);
	runtime.setupQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function replayDurableStreamRun(
	runtime: StreamRunRuntime,
	state: StreamRunState,
	res: ServerResponse,
	cursor: number,
): Promise<void> {
	if (cursor > state.nextSeq) {
		sendJson(res, 409, { error: `eventCursor ${cursor} exceeds durable nextSeq ${state.nextSeq}` });
		return Promise.resolve();
	}
	if (!beginStreamResponse(res)) return Promise.resolve();
	const replay: StreamRunReplay = {
		runId: state.runId,
		response: res,
		abortController: new AbortController(),
	};
	let readers = runtime.replayReaders.get(state.sessionId);
	if (!readers) {
		readers = new Set();
		runtime.replayReaders.set(state.sessionId, readers);
	}
	readers.add(replay);
	const onClose = () => replay.abortController.abort();
	res.once("close", onClose);
	const operation = (async () => {
		try {
			if (!(await writeWithStreamDrain(res, STREAM_HEARTBEAT, runtime.drainIdleTimeoutMs))) {
				replay.abortController.abort();
				if (!res.destroyed) res.destroy();
				return;
			}
			for await (const frame of runtime.store.iterateEvents(
				state.sessionId,
				state.runId,
				cursor,
				replay.abortController.signal,
			)) {
				if (res.destroyed || res.writableEnded || replay.abortController.signal.aborted) return;
				if (!res.write(frame.event) && !(await waitForStreamDrain(res, runtime.drainIdleTimeoutMs))) {
					replay.abortController.abort();
					if (!res.destroyed) res.destroy();
					return;
				}
			}
			if (!res.destroyed && !res.writableEnded) res.end();
		} catch (error) {
			if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
		} finally {
			res.off("close", onClose);
			const currentReaders = runtime.replayReaders.get(state.sessionId);
			currentReaders?.delete(replay);
			if (currentReaders?.size === 0) runtime.replayReaders.delete(state.sessionId);
		}
	})();
	replay.promise = operation;
	return operation;
}

function createActiveStreamRun(
	state: StreamRunState,
	runId: string | undefined,
	model: ResolvedStream["model"],
): StreamRunRecord {
	return {
		sessionId: state.sessionId,
		runId,
		storageRunId: state.runId,
		requestHash: state.requestMac,
		status: state.status,
		nextSeq: state.nextSeq,
		model,
		contentDeltas: new Map(),
		abortController: new AbortController(),
		subscribers: new Map(),
		providerFailureLogged: false,
		persistenceFailureLogged: false,
		pendingEvents: [],
		pendingEventBytes: 0,
		shuttingDown: false,
	};
}

async function handleCancelSessionRun(
	runtime: StreamRunRuntime,
	body: SessionIdBody & { runId?: string },
	res: ServerResponse,
): Promise<void> {
	if (!body.sessionId || !body.runId) {
		sendJson(res, 400, { error: "sessionId and runId are required" });
		return;
	}
	const sessionId = body.sessionId;
	const runId = body.runId;
	const key = runKey(sessionId, runId);
	const activeRun = runtime.activeRuns.get(key);
	if (activeRun?.status === "running") {
		activeRun.abortController.abort();
	}
	await enqueueStreamRunSetup(runtime, async () => {
		const state = await runtime.store.get(sessionId, runId);
		if (!state) {
			sendJson(res, 200, { canceled: false, status: "missing" });
			return;
		}
		if (state.status !== "running") {
			sendJson(res, 200, { canceled: false, status: state.status });
			return;
		}
		const run = runtime.activeRuns.get(key);
		if (!run) {
			throw new StreamRunStateError("Durable running stream has no active provider execution");
		}
		try {
			await abortStreamRun(runtime, run, "Request aborted by user", "aborted");
		} catch (error) {
			await handleStreamRunPersistenceFailure(runtime, run, error);
			if (runtime.fatalPersistenceError) throw runtime.fatalPersistenceError;
			if (run.status === "running") throw error;
		}
		sendJson(res, 200, { canceled: true, status: run.status });
	});
}

function logProviderStreamFailure(run: StreamRunRecord, model: ResolvedStream["model"], errorMessage: string): void {
	if (run.providerFailureLogged) return;
	run.providerFailureLogged = true;
	const safeErrorMessage =
		errorMessage.length > STREAM_RUN_ERROR_LOG_CHARS
			? `${errorMessage.slice(0, STREAM_RUN_ERROR_LOG_CHARS - 3)}...`
			: errorMessage;
	console.error(
		JSON.stringify({
			phase: "provider_stream",
			sessionId: run.sessionId,
			runId: run.runId ?? null,
			model: { provider: model.provider, id: model.id, api: model.api },
			error: safeErrorMessage,
		}),
	);
}

function logStreamRunPersistenceFailure(run: StreamRunRecord, error: unknown): void {
	if (run.persistenceFailureLogged) return;
	run.persistenceFailureLogged = true;
	const rawMessage = error instanceof Error ? error.message : String(error);
	const safeErrorMessage =
		rawMessage.length > STREAM_RUN_ERROR_LOG_CHARS
			? `${rawMessage.slice(0, STREAM_RUN_ERROR_LOG_CHARS - 3)}...`
			: rawMessage;
	console.error(
		JSON.stringify({
			phase: "stream_persistence",
			sessionId: run.sessionId,
			runId: run.runId ?? run.storageRunId,
			error: safeErrorMessage,
		}),
	);
}

function withStreamRunDiagnostic(run: StreamRunRecord, message: AssistantMessage): AssistantMessage {
	return {
		...message,
		diagnostics: [
			...(message.diagnostics ?? []).filter((diagnostic) => diagnostic.type !== "pi_server_run"),
			{
				type: "pi_server_run",
				timestamp: Date.now(),
				details: {
					sessionId: run.sessionId,
					runId: run.runId ?? run.storageRunId,
					requestMac: run.requestHash,
				},
			},
		],
	};
}

function createSyntheticAssistantMessage(
	run: StreamRunRecord,
	errorMessage: string,
	reason: "aborted" | "error",
): AssistantMessage {
	return withStreamRunDiagnostic(run, {
		role: "assistant",
		content: [],
		api: run.model.api,
		provider: run.model.provider,
		model: run.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: reason,
		errorMessage,
		timestamp: Date.now(),
	});
}

function terminalProxyEvent(
	run: StreamRunRecord,
	message: AssistantMessage,
): Extract<ProxyAssistantMessageEvent, { type: "done" | "error" }> {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const event = toProxyEvent({ type: "error", reason: message.stopReason, error: message }, run);
		if (!event || event.type !== "error") {
			throw new Error("Failed to encode terminal stream error");
		}
		return event;
	}
	const event = toProxyEvent({ type: "done", reason: message.stopReason, message }, run);
	if (!event || event.type !== "done") {
		throw new Error("Failed to encode terminal stream completion");
	}
	return event;
}

async function flushPendingStreamRunEvents(runtime: StreamRunRuntime, run: StreamRunRecord): Promise<void> {
	clearStreamRunFlushTimer(run);
	if (run.flushPromise) {
		await run.flushPromise;
		if (run.pendingEvents.length > 0) await flushPendingStreamRunEvents(runtime, run);
		return;
	}
	if (run.pendingEvents.length === 0) return;
	const operation = (async () => {
		while (run.pendingEvents.length > 0) {
			if (run.persistenceError) throw run.persistenceError;
			const events = run.pendingEvents.splice(0);
			run.pendingEventBytes = 0;
			const frames = await runtime.store.appendEvents({
				sessionId: run.sessionId,
				runId: run.storageRunId,
				events,
				expectedSeq: run.nextSeq,
			});
			run.nextSeq += frames.length;
			notifyStreamRunSubscribers(runtime, run);
		}
	})();
	const tracked = operation.catch((error: unknown): never => {
		run.persistenceError = error instanceof Error ? error : new Error(String(error));
		throw run.persistenceError;
	});
	run.flushPromise = tracked;
	try {
		await tracked;
	} finally {
		if (run.flushPromise === tracked) run.flushPromise = undefined;
		if (!run.persistenceError && run.pendingEvents.length > 0 && !run.flushTimer) {
			run.flushTimer = setTimeout(() => {
				run.flushTimer = undefined;
				void flushPendingStreamRunEvents(runtime, run).catch((error: unknown) => {
					void handleStreamRunPersistenceFailure(runtime, run, error);
				});
			}, STREAM_RUN_BATCH_DELAY_MS);
			run.flushTimer.unref();
		}
	}
}

async function queueStreamRunEvent(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	event: ProxyAssistantMessageEvent,
): Promise<void> {
	if (run.persistenceError) throw run.persistenceError;
	if (run.status !== "running" || run.terminalPromise || run.abortController.signal.aborted) return;
	const encoded = encodeProxyEvent(event);
	run.pendingEvents.push(encoded);
	run.pendingEventBytes += Buffer.byteLength(encoded);
	if (run.pendingEvents.length >= STREAM_RUN_BATCH_MAX_EVENTS || run.pendingEventBytes >= STREAM_RUN_BATCH_MAX_BYTES) {
		await flushPendingStreamRunEvents(runtime, run);
		return;
	}
	if (run.flushTimer || run.flushPromise) return;
	run.flushTimer = setTimeout(() => {
		run.flushTimer = undefined;
		void flushPendingStreamRunEvents(runtime, run).catch((error: unknown) => {
			void handleStreamRunPersistenceFailure(runtime, run, error);
		});
	}, STREAM_RUN_BATCH_DELAY_MS);
	run.flushTimer.unref();
}

async function persistTerminalStreamRun(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	message: AssistantMessage,
	skipPendingFlush = false,
): Promise<void> {
	if (run.terminalPromise) return run.terminalPromise;
	const operation = (async () => {
		clearStreamRunFlushTimer(run);
		if (!skipPendingFlush) {
			await flushPendingStreamRunEvents(runtime, run);
		} else {
			run.pendingEvents.length = 0;
			run.pendingEventBytes = 0;
			await run.flushPromise?.catch(() => undefined);
		}
		if (run.status !== "running") return;
		const proxyEvent = terminalProxyEvent(run, message);
		let state: StreamRunState;
		try {
			state = await runtime.store.settle({
				sessionId: run.sessionId,
				runId: run.storageRunId,
				status: message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
				event: encodeProxyEvent(proxyEvent),
				result: message,
				errorMessage: message.errorMessage,
				expectedSeq: run.nextSeq,
			});
			if (!run.runId) {
				state = await runtime.store.acknowledge(run.sessionId, run.storageRunId);
			}
		} catch (error) {
			run.persistenceError = error instanceof Error ? error : new Error(String(error));
			throw run.persistenceError;
		}
		applyDurableState(run, state);
		notifyStreamRunSubscribers(runtime, run);
	})();
	run.terminalPromise = operation;
	try {
		await operation;
	} finally {
		if (run.terminalPromise === operation && run.status === "running") {
			run.terminalPromise = undefined;
		}
	}
}

function markStreamRunPersistenceFatal(runtime: StreamRunRuntime, persistenceError: Error): boolean {
	if (runtime.fatalPersistenceError) return false;
	runtime.fatalPersistenceError = persistenceError;
	runtime.closing = true;
	for (const activeRun of runtime.activeRuns.values()) {
		activeRun.shuttingDown = true;
		activeRun.persistenceError ??= persistenceError;
		clearStreamRunFlushTimer(activeRun);
		activeRun.abortController.abort();
		for (const res of [...activeRun.subscribers.keys()]) {
			detachStreamRunSubscriber(runtime, activeRun, res);
			res.destroy(new Error("pi-server stopped after an indeterminate stream persistence failure"));
		}
	}
	for (const replays of runtime.replayReaders.values()) {
		for (const replay of replays) {
			replay.abortController.abort();
			replay.response.destroy(new Error("pi-server stopped after an indeterminate stream persistence failure"));
		}
	}
	return true;
}

function failStopStreamRunPersistence(runtime: StreamRunRuntime, error: unknown): void {
	const persistenceError = error instanceof Error ? error : new Error(String(error));
	if (activeServerPersistenceRuntime?.streamRuntime === runtime) {
		failStopServerPersistence(activeServerPersistenceRuntime, persistenceError);
		return;
	}
	if (!markStreamRunPersistenceFatal(runtime, persistenceError)) return;
	queueMicrotask(() => runtime.onFatalPersistenceError?.(persistenceError));
}

async function handleStreamRunPersistenceFailure(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	error: unknown,
): Promise<void> {
	if (run.status !== "running" || run.shuttingDown) return;
	logStreamRunPersistenceFailure(run, error);
	const persistenceError = error instanceof Error ? error : new Error(String(error));
	if (
		persistenceError instanceof StreamRunCorruptionError ||
		persistenceError instanceof StreamRunPersistenceTimeoutError ||
		persistenceError instanceof StreamRunStoreLockedError ||
		persistenceError instanceof StreamRunStateError ||
		persistenceError instanceof StreamRunConflictError
	) {
		failStopStreamRunPersistence(runtime, persistenceError);
		return;
	}
	run.abortController.abort();
	const errorMessage = `pi-server could not durably persist the provider stream: ${persistenceError.message}`;
	const message = createSyntheticAssistantMessage(run, errorMessage, "error");
	try {
		await persistTerminalStreamRun(runtime, run, message, true);
	} catch (terminalError) {
		logStreamRunPersistenceFailure(run, terminalError);
		failStopStreamRunPersistence(runtime, terminalError);
	}
}

async function abortStreamRun(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	errorMessage: string,
	reason: "aborted" | "error" = "error",
): Promise<void> {
	if (run.status !== "running") return;
	run.abortController.abort();
	await persistTerminalStreamRun(runtime, run, createSyntheticAssistantMessage(run, errorMessage, reason));
}

function compactRunKey(sessionId: string, operationId: string): string {
	return `${sessionId}\0${operationId}`;
}

function enqueueCompactSetup<T>(runtime: CompactRunRuntime, operation: () => Promise<T>): Promise<T> {
	const guardedOperation = () => {
		assertServerPersistenceHealthy();
		return operation();
	};
	const result = runtime.setupQueue.then(guardedOperation, guardedOperation);
	runtime.setupQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

interface SessionDeletionFenceState {
	versions: Map<string, number>;
	active: Map<string, number>;
}

const sessionDeletionFences = new WeakMap<SessionMutationRuntime, SessionDeletionFenceState>();

function sessionDeletionFenceState(runtime: SessionMutationRuntime): SessionDeletionFenceState {
	let state = sessionDeletionFences.get(runtime);
	if (!state) {
		state = { versions: new Map(), active: new Map() };
		sessionDeletionFences.set(runtime, state);
	}
	return state;
}

function advanceSessionDeletionVersion(state: SessionDeletionFenceState, sessionId: string): void {
	state.versions.set(sessionId, (state.versions.get(sessionId) ?? 0) + 1);
}

function cleanupSessionDeletionFence(runtime: SessionMutationRuntime, sessionId: string): void {
	const state = sessionDeletionFences.get(runtime);
	if (!state || (state.active.get(sessionId) ?? 0) > 0 || runtime.queues.has(sessionId)) return;
	state.versions.delete(sessionId);
	if (state.versions.size === 0 && state.active.size === 0) sessionDeletionFences.delete(runtime);
}

function enqueueSessionMutation<T>(
	runtime: SessionMutationRuntime,
	sessionId: string,
	operation: () => Promise<T> | T,
	bypassDeletionFence = false,
	expectedDeletionVersion?: number,
): Promise<T> {
	const deletionState = sessionDeletionFenceState(runtime);
	const deletionVersion = expectedDeletionVersion ?? deletionState.versions.get(sessionId) ?? 0;
	const previous = runtime.queues.get(sessionId) ?? Promise.resolve();
	const guardedOperation = () => {
		assertServerPersistenceHealthy();
		if (
			!bypassDeletionFence &&
			((deletionState.active.get(sessionId) ?? 0) > 0 ||
				(deletionState.versions.get(sessionId) ?? 0) !== deletionVersion)
		) {
			throw new StreamRunConflictError(
				`Session ${sessionId} was deleted while this mutation was queued; reconcile before retrying`,
			);
		}
		return operation();
	};
	const result = previous.then(guardedOperation, guardedOperation);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	runtime.queues.set(sessionId, tail);
	void tail.finally(() => {
		if (runtime.queues.get(sessionId) === tail) {
			runtime.queues.delete(sessionId);
			cleanupSessionDeletionFence(runtime, sessionId);
		}
	});
	return result;
}

function enqueueSessionCapacityMutation<T>(operation: () => Promise<T> | T): Promise<T> {
	const guardedOperation = () => {
		assertServerPersistenceHealthy();
		return operation();
	};
	const result = sessionCapacityMutationQueue.then(guardedOperation, guardedOperation);
	sessionCapacityMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function enqueueSessionStoreMutation<T>(
	runtime: SessionMutationRuntime,
	sessionId: string,
	operation: () => Promise<T> | T,
	bypassDeletionFence = false,
): Promise<T> {
	return enqueueSessionMutation(
		runtime,
		sessionId,
		() => enqueueSessionCapacityMutation(operation),
		bypassDeletionFence,
	);
}

function releaseCompactRun(runtime: CompactRunRuntime, run: CompactRunRecord): void {
	if (run.status === "running" || run.subscribers.size > 0) return;
	runtime.activeRuns.delete(compactRunKey(run.sessionId, run.operationId));
}

function markCompactPersistenceFatal(runtime: CompactRunRuntime, failure: Error): boolean {
	if (runtime.fatalPersistenceError) return false;
	runtime.fatalPersistenceError = failure;
	runtime.closing = true;
	for (const run of runtime.activeRuns.values()) {
		run.abortController.abort();
		for (const response of run.subscribers) {
			response.destroy(new Error("pi-server stopped after an indeterminate compaction persistence failure"));
		}
	}
	return true;
}

function failStopCompactPersistence(runtime: CompactRunRuntime, error: unknown): void {
	const failure = error instanceof Error ? error : new Error(String(error));
	if (activeServerPersistenceRuntime?.compactRuntime === runtime) {
		failStopServerPersistence(activeServerPersistenceRuntime, failure);
		return;
	}
	if (!markCompactPersistenceFatal(runtime, failure)) return;
	queueMicrotask(() => runtime.onFatalPersistenceError?.(failure));
}

function failStopServerPersistence(runtime: ServerPersistenceRuntime, error: unknown): void {
	if (runtime.fatalError) return;
	const failure = error instanceof Error ? error : new Error(String(error));
	runtime.fatalError = failure;
	if (runtime.streamRuntime) markStreamRunPersistenceFatal(runtime.streamRuntime, failure);
	if (runtime.compactRuntime) markCompactPersistenceFatal(runtime.compactRuntime, failure);
	queueMicrotask(() => runtime.onFatalPersistenceError?.(failure));
}

function createCompactTerminalPlan(
	run: Pick<CompactRunRecord, "sessionId" | "operationId" | "requestHash">,
	response: SessionCompactHttpResponse,
	commit?: CompactionCommitPlan,
): CompactTerminalPlan {
	return {
		version: 1,
		sessionId: run.sessionId,
		operationId: run.operationId,
		requestHash: run.requestHash,
		response,
		...(commit ? { commit } : {}),
	};
}

function createCompactFailureResponse(
	run: Pick<CompactRunRecord, "sessionId" | "operationId" | "requestHash">,
	status: number,
	error: string,
	operationDisposition: "terminal" | "not_started",
): { status: number; body: SessionCompactFailureBody } {
	return {
		status,
		body: {
			protocolVersion: PI_SERVER_PROTOCOL_VERSION,
			sessionId: run.sessionId,
			operationId: run.operationId,
			requestHash: run.requestHash,
			status: operationDisposition === "terminal" ? "failed" : "rejected",
			httpStatus: status,
			operationDisposition,
			error,
		},
	};
}

function createCompactCapacityFailureResponse(
	run: Pick<CompactRunRecord, "sessionId" | "operationId" | "requestHash">,
	error: SessionCapacityError | SessionPersistenceCapacityError,
	operationDisposition: "terminal" | "not_started",
): SessionCompactHttpResponse {
	const errorMessage =
		error instanceof SessionPersistenceCapacityError
			? `Persisted session capacity exceeded: resource=${error.resource}, session=${error.sessionId}, requested=${error.requested}, limit=${error.limit}`
			: error.message;
	const response = createCompactFailureResponse(run, 507, errorMessage, operationDisposition);
	return {
		status: response.status,
		body: {
			...response.body,
			code: error.code,
			resource: error.resource,
			current: error.current,
			requested: error.requested,
			limit: error.limit,
			retryable: false as const,
			...(error instanceof SessionPersistenceCapacityError ? { artifact: basename(error.path) } : {}),
		},
	};
}

function createCompactRestartFailureTerminal(identity: { sessionId: string; runId: string; requestMac: string }): {
	event: string;
	result: CompactTerminalPlan;
	errorMessage: string;
} {
	const response = createCompactFailureResponse(
		{ sessionId: identity.sessionId, operationId: identity.runId, requestHash: identity.requestMac },
		500,
		"restart-unknown: pi-server restarted before compaction reached a durable terminal state; provider execution will not be repeated",
		"terminal",
	);
	const result = createCompactTerminalPlan(
		{ sessionId: identity.sessionId, operationId: identity.runId, requestHash: identity.requestMac },
		response,
	);
	return {
		event: JSON.stringify(result),
		result,
		errorMessage: response.body.error as string,
	};
}

function compactTerminalPlanFromState(state: StreamRunState): CompactTerminalPlan {
	const result = state.terminal?.result;
	assertCompactTerminalPlan(result, `${state.sessionId}/${state.runId}`);
	if (
		result.sessionId !== state.sessionId ||
		result.operationId !== state.runId ||
		result.requestHash !== state.requestMac
	) {
		throw new StreamRunCorruptionError(
			`${state.sessionId}/${state.runId}`,
			"terminal compaction identity does not match durable run metadata",
		);
	}
	return result;
}

function applyCompactTerminalPlan(config: ServerConfig, plan: CompactTerminalPlan): void {
	const commit = plan.commit;
	if (!commit) return;
	mutateAndPersistSession(config, plan.sessionId, () =>
		applyPiServerCompactionEntry(plan.sessionId, {
			entry: commit.entry,
			operation: commit.entry.piServerCompactOperation,
			updatedTreeHash: commit.updatedTreeHash,
			updatedRevision: commit.updatedRevision,
		}),
	);
}

function preflightCompactTerminalPlan(config: ServerConfig, plan: CompactTerminalPlan): void {
	const commit = plan.commit;
	if (!commit) return;
	const current = getSession(plan.sessionId);
	if (!current) {
		throw new Error(`Session ${plan.sessionId} disappeared before compaction persistence preflight`);
	}
	const previousState = exportSessionState(current);
	try {
		const candidate = applyPiServerCompactionEntry(plan.sessionId, {
			entry: commit.entry,
			operation: commit.entry.piServerCompactOperation,
			updatedTreeHash: commit.updatedTreeHash,
			updatedRevision: commit.updatedRevision,
		});
		preflightPersistedSession(config.sessionStoreDir, candidate);
	} finally {
		restoreSessionState(previousState);
	}
}

function settleCompactRun(
	config: ServerConfig,
	runtime: CompactRunRuntime,
	mutations: SessionMutationRuntime,
	run: CompactRunRecord,
	planOrFactory: CompactTerminalPlan | (() => CompactTerminalPlan),
	status: "completed" | "failed" = "completed",
): Promise<SessionCompactHttpResponse> {
	if (run.settlement) return run.settlement;
	const settlement = (async () => {
		const durablePlan = await enqueueSessionMutation(mutations, run.sessionId, () =>
			enqueueSessionCapacityMutation(async () => {
				let plan = typeof planOrFactory === "function" ? planOrFactory() : planOrFactory;
				if (plan.commit) {
					try {
						preflightSessionCapacityMutation(run.sessionId, {
							content: {
								kind: "append_entries",
								entries: [plan.commit.entry],
								leafId: plan.commit.entry.id,
							},
						});
						preflightCompactTerminalPlan(config, plan);
					} catch (error) {
						if (!(error instanceof SessionCapacityError) && !(error instanceof SessionPersistenceCapacityError)) {
							throw error;
						}
						plan = createCompactTerminalPlan(run, createCompactCapacityFailureResponse(run, error, "terminal"));
					}
				}
				const durableStatus = plan.commit ? status : "failed";
				const state = await runtime.store.settle({
					sessionId: run.sessionId,
					runId: run.operationId,
					status: durableStatus,
					event: JSON.stringify(plan),
					result: plan,
					...(durableStatus === "failed"
						? {
								errorMessage:
									"error" in plan.response.body ? plan.response.body.error : "Compaction failed before commit",
							}
						: {}),
				});
				const settledPlan = compactTerminalPlanFromState(state);
				applyCompactTerminalPlan(config, settledPlan);
				return settledPlan;
			}),
		);
		run.status = "settled";
		run.result = durablePlan.response;
		run.resolveTerminal?.(durablePlan.response);
		run.resolveTerminal = undefined;
		run.rejectTerminal = undefined;
		return durablePlan.response;
	})().catch((error: unknown) => {
		run.rejectTerminal?.(error);
		run.resolveTerminal = undefined;
		run.rejectTerminal = undefined;
		failStopCompactPersistence(runtime, error);
		throw error;
	});
	run.settlement = settlement;
	void settlement.finally(() => releaseCompactRun(runtime, run)).catch(() => undefined);
	return settlement;
}

async function handleCancelSessionCompact(
	config: ServerConfig,
	runtime: CompactRunRuntime,
	mutations: SessionMutationRuntime,
	body: SessionIdBody & { operationId?: string; requestHash?: string },
	res: ServerResponse,
): Promise<void> {
	if (!body.sessionId || !body.operationId || !body.requestHash) {
		sendJson(res, 400, { error: "sessionId, operationId, and requestHash are required" });
		return;
	}
	const action = await enqueueCompactSetup(runtime, async () => {
		const state = await runtime.store.get(body.sessionId, body.operationId!);
		if (!state) return { kind: "missing" } as const;
		if (state.requestMac !== body.requestHash) {
			throw new StreamRunConflictError("operationId is bound to a different compaction request");
		}
		if (state.status !== "running") {
			return { kind: "terminal", state } as const;
		}
		const run = runtime.activeRuns.get(compactRunKey(body.sessionId, body.operationId!));
		if (!run) {
			throw new StreamRunStateError("Durable running compaction has no active provider execution");
		}
		run.abortController.abort();
		const response = createCompactFailureResponse(run, 499, "Compaction aborted by user", "terminal");
		return {
			kind: "canceled",
			promise: settleCompactRun(config, runtime, mutations, run, createCompactTerminalPlan(run, response), "failed"),
		} as const;
	});
	if (action.kind === "missing") {
		sendJson(res, 404, { error: "compaction operation not found" });
		return;
	}
	if (action.kind === "terminal") {
		const plan = compactTerminalPlanFromState(action.state);
		sendJson(res, 200, {
			canceled: false,
			status: action.state.status,
			sessionId: action.state.sessionId,
			operationId: action.state.runId,
			requestHash: action.state.requestMac,
			resultStatus: plan.response.status,
			terminal: plan.response.body,
		});
		return;
	}
	const terminalResponse = await action.promise;
	sendJson(res, 200, {
		canceled: true,
		status: "failed",
		sessionId: body.sessionId,
		operationId: body.operationId,
		requestHash: body.requestHash,
		resultStatus: 499,
		terminal: terminalResponse.body,
	});
}

function pruneChunkTargetResponses(
	responses: Map<string, ChunkTargetResponseRecord>,
	now = Date.now(),
	extraBytes = 0,
): void {
	for (const [requestId, response] of responses) {
		if (now - response.createdAt >= CHUNK_TARGET_RESPONSE_TTL_MS) {
			responses.delete(requestId);
		}
	}
	let retainedBytes = 0;
	for (const response of responses.values()) retainedBytes += response.bytes;
	while (
		responses.size >= CHUNK_TARGET_RESPONSE_MAX_RECORDS ||
		retainedBytes + extraBytes > CHUNK_TARGET_RESPONSE_MAX_BYTES
	) {
		const oldest = responses.keys().next();
		if (oldest.done) break;
		const oldestResponse = responses.get(oldest.value);
		if (!oldestResponse) throw new Error("Chunk target response cache became inconsistent");
		retainedBytes -= oldestResponse.bytes;
		responses.delete(oldest.value);
	}
}

function cacheChunkTargetResponse(
	responses: Map<string, ChunkTargetResponseRecord>,
	requestId: string,
	response: CapturedJsonResponse,
): void {
	const bytes = Buffer.byteLength(response.bodyJson);
	if (bytes > CHUNK_TARGET_RESPONSE_MAX_BYTES) return;
	pruneChunkTargetResponses(responses, Date.now(), bytes);
	if (responses.size >= CHUNK_TARGET_RESPONSE_MAX_RECORDS) return;
	responses.set(requestId, { ...response, createdAt: Date.now(), bytes });
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

function sessionHistoryV2FullResponseBody(session: SessionState) {
	return {
		...sessionHistoryV2Summary(session),
		entries: session.entries,
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

function sessionTreePatchV2ResponseBody(session: SessionState, entriesFrom: number, baseRevision: number | undefined) {
	return {
		...sessionHistoryV2Summary(session),
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
type ExtensionCompactionReplacement = CompactResult & { firstKeptEntryId: string; fromHook: true };

interface PreparedSessionCompact {
	preparation: PreparedCompaction;
	extensionCompaction?: ExtensionCompactionReplacement;
	options: SimpleStreamOptions;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
}

interface SessionCompactV2SuccessBody {
	error?: undefined;
	protocolVersion: typeof PI_SERVER_PROTOCOL_VERSION;
	sessionId: string;
	operationId: string;
	requestHash: string;
	treePatch: {
		baseStaticContextHash: string;
		baseTreeHash: string;
		baseEntryCount: number;
		baseLeafId: string | null;
		baseRevision: number;
		entriesFrom: number;
		entries: [PiServerCompactionEntry];
		leafId: string;
		revision: number;
		treeHash: string;
	};
}

interface SessionCompactFailureBody {
	error: string;
	protocolVersion?: number;
	sessionId?: string;
	operationId?: string;
	requestHash?: string;
	status?: "failed" | "rejected";
	httpStatus?: number;
	operationDisposition?: "terminal" | "not_started";
	code?: string;
	resource?: string;
	current?: number;
	requested?: number;
	limit?: number;
	retryable?: false;
	artifact?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCompactionUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	if (
		!isNonNegativeFiniteNumber(value.input) ||
		!isNonNegativeFiniteNumber(value.output) ||
		!isNonNegativeFiniteNumber(value.cacheRead) ||
		!isNonNegativeFiniteNumber(value.cacheWrite) ||
		!isNonNegativeFiniteNumber(value.totalTokens) ||
		!isNonNegativeFiniteNumber(value.cost.input) ||
		!isNonNegativeFiniteNumber(value.cost.output) ||
		!isNonNegativeFiniteNumber(value.cost.cacheRead) ||
		!isNonNegativeFiniteNumber(value.cost.cacheWrite) ||
		!isNonNegativeFiniteNumber(value.cost.total)
	) {
		return false;
	}
	return (
		(value.cacheWrite1h === undefined || isNonNegativeFiniteNumber(value.cacheWrite1h)) &&
		(value.reasoning === undefined || isNonNegativeFiniteNumber(value.reasoning))
	);
}

function assertCompactTerminalPlan(value: unknown, source: string): asserts value is CompactTerminalPlan {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		typeof value.operationId !== "string" ||
		value.operationId.length === 0 ||
		typeof value.requestHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.requestHash) ||
		!isRecord(value.response) ||
		!Number.isSafeInteger(value.response.status) ||
		(value.response.status as number) < 100 ||
		(value.response.status as number) > 599 ||
		!isRecord(value.response.body)
	) {
		throw new StreamRunCorruptionError(source, "terminal compaction plan has invalid identity or response");
	}
	if (value.commit === undefined) {
		if (
			value.response.body.protocolVersion !== PI_SERVER_PROTOCOL_VERSION ||
			value.response.body.sessionId !== value.sessionId ||
			value.response.body.operationId !== value.operationId ||
			value.response.body.requestHash !== value.requestHash ||
			value.response.body.status !== "failed" ||
			value.response.body.httpStatus !== value.response.status ||
			value.response.body.operationDisposition !== "terminal" ||
			typeof value.response.body.error !== "string" ||
			value.response.body.error.length === 0
		) {
			throw new StreamRunCorruptionError(source, "non-commit terminal compaction plan has no error response");
		}
		return;
	}
	if (!isRecord(value.commit) || !isRecord(value.commit.base) || !isRecord(value.commit.entry)) {
		throw new StreamRunCorruptionError(source, "terminal compaction commit is invalid");
	}
	const base = value.commit.base;
	const entry = value.commit.entry;
	if (
		typeof base.staticContextHash !== "string" ||
		(base.staticContextHash !== "" && !/^[a-f0-9]{64}$/u.test(base.staticContextHash)) ||
		typeof base.treeHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(base.treeHash) ||
		!Number.isSafeInteger(base.entryCount) ||
		(base.entryCount as number) < 0 ||
		(base.leafId !== null && (typeof base.leafId !== "string" || base.leafId.length === 0)) ||
		!Number.isSafeInteger(base.revision) ||
		(base.revision as number) < 0 ||
		entry.type !== "compaction" ||
		typeof entry.id !== "string" ||
		entry.id.length === 0 ||
		entry.parentId !== base.leafId ||
		typeof entry.timestamp !== "string" ||
		typeof entry.summary !== "string" ||
		typeof entry.firstKeptEntryId !== "string" ||
		entry.firstKeptEntryId.length === 0 ||
		!isNonNegativeFiniteNumber(entry.tokensBefore) ||
		!isRecord(entry.piServerCompactOperation) ||
		typeof value.commit.updatedTreeHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.commit.updatedTreeHash) ||
		!Number.isSafeInteger(value.commit.updatedRevision) ||
		value.commit.updatedRevision !== (base.revision as number) + 1
	) {
		throw new StreamRunCorruptionError(source, "terminal compaction commit fields are invalid");
	}
	const operation = entry.piServerCompactOperation;
	if (
		operation.version !== 1 ||
		operation.operationId !== value.operationId ||
		operation.requestHash !== value.requestHash ||
		operation.baseStaticContextHash !== base.staticContextHash ||
		operation.baseTreeHash !== base.treeHash ||
		operation.baseEntryCount !== base.entryCount ||
		operation.baseLeafId !== base.leafId ||
		operation.baseRevision !== base.revision ||
		appendPiServerTreeHash(base.treeHash as string, hashPiServerTreeEntry(entry as unknown as SessionTreeEntry)) !==
			value.commit.updatedTreeHash
	) {
		throw new StreamRunCorruptionError(source, "terminal compaction operation metadata is inconsistent");
	}
	const body = value.response.body;
	if (
		value.response.status !== 200 ||
		body.protocolVersion !== PI_SERVER_PROTOCOL_VERSION ||
		body.sessionId !== value.sessionId ||
		body.operationId !== value.operationId ||
		body.requestHash !== value.requestHash ||
		!isRecord(body.treePatch)
	) {
		throw new StreamRunCorruptionError(source, "terminal compaction response does not match its commit");
	}
	const patch = body.treePatch;
	if (
		patch.baseStaticContextHash !== base.staticContextHash ||
		patch.baseTreeHash !== base.treeHash ||
		patch.baseEntryCount !== base.entryCount ||
		patch.baseLeafId !== base.leafId ||
		patch.baseRevision !== base.revision ||
		patch.entriesFrom !== base.entryCount ||
		!Array.isArray(patch.entries) ||
		patch.entries.length !== 1 ||
		canonicalJsonStringify(patch.entries[0]) !== canonicalJsonStringify(entry) ||
		patch.leafId !== entry.id ||
		patch.revision !== value.commit.updatedRevision ||
		patch.treeHash !== value.commit.updatedTreeHash
	) {
		throw new StreamRunCorruptionError(source, "terminal compaction response patch is inconsistent");
	}
}

function normalizeExtensionCompaction(
	value: unknown,
	activeBranch: SessionTreeEntry[],
): ExtensionCompactionReplacement {
	if (!isRecord(value)) {
		throw new Error("extensionCompaction must be an object");
	}
	if (typeof value.summary !== "string") {
		throw new Error("extensionCompaction.summary must be a string");
	}
	if (typeof value.firstKeptEntryId !== "string" || value.firstKeptEntryId.length === 0) {
		throw new Error("extensionCompaction.firstKeptEntryId must be a non-empty string");
	}
	if (!activeBranch.some((entry) => entry.id === value.firstKeptEntryId)) {
		throw new Error("extensionCompaction.firstKeptEntryId must reference the active session branch");
	}
	if (!isNonNegativeFiniteNumber(value.tokensBefore)) {
		throw new Error("extensionCompaction.tokensBefore must be a non-negative finite number");
	}
	if (value.retainedTail !== undefined && !Array.isArray(value.retainedTail)) {
		throw new Error("extensionCompaction.retainedTail must be an array when provided");
	}
	if (value.usage !== undefined && !isCompactionUsage(value.usage)) {
		throw new Error("extensionCompaction.usage must be a valid non-negative usage object");
	}
	return {
		summary: value.summary,
		firstKeptEntryId: value.firstKeptEntryId,
		tokensBefore: value.tokensBefore,
		...(value.retainedTail !== undefined
			? { retainedTail: value.retainedTail as NonNullable<CompactResult["retainedTail"]> }
			: {}),
		...(value.details !== undefined ? { details: value.details } : {}),
		...(value.usage !== undefined ? { usage: value.usage } : {}),
		fromHook: true,
	};
}

interface SessionCompactHttpResponse {
	status: number;
	body: SessionCompactFailureBody | SessionCompactV2SuccessBody;
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
		const session = mutateAndPersistSession(config, body.sessionId, () =>
			applySessionMutation(body.sessionId, { staticContext: body.staticContext }),
		);
		sendJson(res, 200, sessionResponseBody(session));
		return;
	} else if (body.staticContextHash !== undefined) {
		if (!/^[a-f0-9]{64}$/i.test(body.staticContextHash)) {
			sendJson(res, 400, { error: "staticContextHash must be a 64-character hex digest" });
			return;
		}
		const session = mutateAndPersistSession(config, body.sessionId, () => getOrCreateSession(body.sessionId));
		sendJson(res, 200, {
			...sessionResponseBody(session),
			staticContextRequired: session.staticContextHash !== body.staticContextHash,
		});
		return;
	}
	const session = mutateAndPersistSession(config, body.sessionId, () => getOrCreateSession(body.sessionId));
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
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		applySessionMutation(body.sessionId, { staticContext: body.staticContext }),
	);
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
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		applySessionMutation(body.sessionId, {
			...(body.staticContext ? { staticContext: body.staticContext } : {}),
			content: { kind: "replace_messages", messages: body.messages },
		}),
	);
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
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		applySessionMutation(body.sessionId, {
			...(body.staticContext ? { staticContext: body.staticContext } : {}),
			content: { kind: "append_messages", messages: body.messages },
		}),
	);
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
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		applySessionMutation(body.sessionId, {
			...(body.staticContext ? { staticContext: body.staticContext } : {}),
			content: { kind: "replace_entries", entries: body.entries, leafId: body.leafId ?? null },
		}),
	);
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
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		applySessionMutation(body.sessionId, {
			...(body.staticContext ? { staticContext: body.staticContext } : {}),
			content: { kind: "append_entries", entries: body.entries, leafId: body.leafId ?? null },
		}),
	);
	sendJson(res, 200, sessionResponseBody(session));
}

function handleSessionTreeSwitch(config: ServerConfig, body: SessionTreeSwitchBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	const session = mutateAndPersistSession(config, body.sessionId, () =>
		switchSessionLeaf(body.sessionId, body.leafId ?? null),
	);
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
	if (
		body.baseStaticContextHash !== session.staticContextHash ||
		body.baseTreeHash !== session.treeHash ||
		body.baseEntryCount !== session.entries.length ||
		body.baseLeafId !== session.leafId ||
		body.baseRevision !== session.revision
	) {
		return {
			status: 409,
			body: { error: "Session base identity does not match the compaction request; reconcile and retry" },
		};
	}

	const entries = getSessionBranch(session);
	const preparationResult = prepareCompaction(entries, body.settings ?? DEFAULT_COMPACTION_SETTINGS, body.preparation);
	if (!preparationResult.ok) {
		return { status: 400, body: { error: preparationResult.error.message } };
	}
	if (!preparationResult.value) {
		return { status: 400, body: { error: "Nothing to compact" } };
	}

	let extensionCompaction: ExtensionCompactionReplacement | undefined;
	if (body.extensionCompaction !== undefined) {
		try {
			extensionCompaction = normalizeExtensionCompaction(body.extensionCompaction, entries);
		} catch (error) {
			return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
		}
	}

	const options = body.options ?? {};
	return {
		preparation: preparationResult.value,
		extensionCompaction,
		options,
		baseStaticContextHash: session.staticContextHash,
		baseTreeHash: session.treeHash,
		baseEntryCount: session.entries.length,
		baseLeafId: session.leafId,
		baseRevision: session.revision,
	};
}

function createCompactionCommitPlan(
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
	requestHash: string,
	compaction: CompactResult | ExtensionCompactionReplacement,
): CompactTerminalPlan {
	const firstKeptEntryId = compaction.firstKeptEntryId;
	if (!firstKeptEntryId) {
		return createCompactTerminalPlan(
			{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
			createCompactFailureResponse(
				{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
				500,
				"Compaction result is missing firstKeptEntryId",
				"terminal",
			),
		);
	}
	const currentSession = getSession(body.sessionId);
	if (
		!currentSession ||
		currentSession.staticContextHash !== prepared.baseStaticContextHash ||
		currentSession.treeHash !== prepared.baseTreeHash ||
		currentSession.entries.length !== prepared.baseEntryCount ||
		currentSession.leafId !== prepared.baseLeafId ||
		currentSession.revision !== prepared.baseRevision
	) {
		return createCompactTerminalPlan(
			{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
			createCompactFailureResponse(
				{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
				409,
				"Session changed while compaction was running; the stale compaction was not committed",
				"terminal",
			),
		);
	}
	const operation: PiServerCompactionOperationMetadata = {
		version: 1,
		operationId: body.operationId,
		requestHash,
		baseStaticContextHash: prepared.baseStaticContextHash,
		baseTreeHash: prepared.baseTreeHash,
		baseEntryCount: prepared.baseEntryCount,
		baseLeafId: prepared.baseLeafId,
		baseRevision: prepared.baseRevision,
	};
	const compactionEntry: PiServerCompactionEntry = {
		type: "compaction",
		id: randomUUID(),
		parentId: prepared.baseLeafId,
		timestamp: new Date().toISOString(),
		summary: compaction.summary,
		firstKeptEntryId,
		tokensBefore: compaction.tokensBefore,
		...(compaction.retainedTail !== undefined ? { retainedTail: compaction.retainedTail } : {}),
		...(compaction.details !== undefined ? { details: compaction.details } : {}),
		...(compaction.usage !== undefined ? { usage: compaction.usage } : {}),
		...("fromHook" in compaction && compaction.fromHook !== undefined ? { fromHook: compaction.fromHook } : {}),
		piServerCompactOperation: operation,
	};
	const updatedTreeHash = appendPiServerTreeHash(prepared.baseTreeHash, hashPiServerTreeEntry(compactionEntry));
	const updatedRevision = prepared.baseRevision + 1;
	const response: SessionCompactHttpResponse = {
		status: 200,
		body: {
			protocolVersion: PI_SERVER_PROTOCOL_VERSION,
			sessionId: body.sessionId,
			operationId: body.operationId,
			requestHash,
			treePatch: {
				baseStaticContextHash: prepared.baseStaticContextHash,
				baseTreeHash: prepared.baseTreeHash,
				baseEntryCount: prepared.baseEntryCount,
				baseLeafId: prepared.baseLeafId,
				baseRevision: prepared.baseRevision,
				entriesFrom: prepared.baseEntryCount,
				entries: [compactionEntry],
				leafId: compactionEntry.id,
				revision: updatedRevision,
				treeHash: updatedTreeHash,
			},
		},
	};
	return createCompactTerminalPlan(
		{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
		response,
		{
			base: {
				staticContextHash: prepared.baseStaticContextHash,
				treeHash: prepared.baseTreeHash,
				entryCount: prepared.baseEntryCount,
				leafId: prepared.baseLeafId,
				revision: prepared.baseRevision,
			},
			entry: compactionEntry,
			updatedTreeHash,
			updatedRevision,
		},
	);
}

async function computeSessionCompaction(
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
	signal: AbortSignal,
): Promise<CompactResult | ExtensionCompactionReplacement | SessionCompactHttpResponse> {
	if (prepared.extensionCompaction) return prepared.extensionCompaction;
	const result = await compact(
		prepared.preparation,
		createRequestModels(body.model, prepared.options),
		body.model,
		body.customInstructions,
		signal,
		prepared.options.reasoning,
		body.retry,
	);
	if (!result.ok) {
		return { status: 500, body: { error: result.error.message } };
	}
	return result.value;
}

function encodeServerSentEvent(event: string, body: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

function attachCompactRunSubscriber(
	runtime: CompactRunRuntime,
	run: CompactRunRecord,
	res: ServerResponse,
	drainIdleTimeoutMs: number,
) {
	let detached = false;
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const onClose = () => detach(false);
	const detach = (destroyResponse: boolean) => {
		if (detached) return;
		detached = true;
		res.off("close", onClose);
		run.subscribers.delete(res);
		releaseCompactRun(runtime, run);
		resolveClosed?.();
		if (destroyResponse && !res.destroyed) res.destroy();
	};
	run.subscribers.add(res);
	res.once("close", onClose);

	let writeTail = Promise.resolve(true);
	const write = (data: string): Promise<boolean> => {
		const writeResult = writeTail.then(async (previousWriteSucceeded) => {
			if (!previousWriteSucceeded || detached) return false;
			const succeeded = await writeWithStreamDrain(res, data, drainIdleTimeoutMs);
			if (!succeeded) detach(true);
			return succeeded;
		});
		writeTail = writeResult.catch(() => {
			detach(true);
			return false;
		});
		return writeResult;
	};
	return { closed, detach, write };
}

async function handleSessionCompactStream(
	runtime: CompactRunRuntime,
	run: CompactRunRecord,
	res: ServerResponse,
	drainIdleTimeoutMs: number,
): Promise<void> {
	try {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.flushHeaders();
	} catch {
		res.destroy();
		return;
	}

	const subscriber = attachCompactRunSubscriber(runtime, run, res, drainIdleTimeoutMs);
	if (!(await subscriber.write(STREAM_HEARTBEAT))) return;
	const heartbeat = setInterval(() => {
		void subscriber.write(STREAM_HEARTBEAT);
	}, STREAM_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	try {
		const outcome = await Promise.race([
			run.promise.then((result) => ({ type: "result" as const, result })),
			subscriber.closed.then(() => ({ type: "closed" as const })),
		]);
		if (outcome.type === "closed") return;
		clearInterval(heartbeat);
		await subscriber.write(
			encodeServerSentEvent(outcome.result.status >= 400 ? "error" : "result", outcome.result.body),
		);
	} finally {
		clearInterval(heartbeat);
		subscriber.detach(false);
		if (!res.destroyed && !res.writableEnded) {
			res.end();
		}
	}
}

async function handleSessionCompactJsonStream(
	runtime: CompactRunRuntime,
	run: CompactRunRecord,
	res: ServerResponse,
	drainIdleTimeoutMs: number,
): Promise<void> {
	try {
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.flushHeaders();
	} catch {
		res.destroy();
		return;
	}

	const subscriber = attachCompactRunSubscriber(runtime, run, res, drainIdleTimeoutMs);
	if (!(await subscriber.write(JSON_HEARTBEAT))) return;
	const heartbeat = setInterval(() => {
		void subscriber.write(JSON_HEARTBEAT);
	}, STREAM_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	try {
		const outcome = await Promise.race([
			run.promise.then((result) => ({ type: "result" as const, result })),
			subscriber.closed.then(() => ({ type: "closed" as const })),
		]);
		if (outcome.type === "closed") return;
		clearInterval(heartbeat);
		await subscriber.write(JSON.stringify(outcome.result.body));
	} finally {
		clearInterval(heartbeat);
		subscriber.detach(false);
		if (!res.destroyed && !res.writableEnded) {
			res.end();
		}
	}
}

function compactNotStartedResponse(
	body: Pick<SessionCompactBody, "sessionId" | "operationId">,
	requestHash: string,
	response: SessionCompactHttpResponse,
): SessionCompactHttpResponse {
	const error = typeof response.body.error === "string" ? response.body.error : "Compaction request was rejected";
	return createCompactFailureResponse(
		{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
		response.status,
		error,
		"not_started",
	);
}

function preflightCompactionCapacity(
	config: ServerConfig,
	body: SessionCompactBody,
	prepared: PreparedSessionCompact,
	requestHash: string,
): SessionCompactHttpResponse | undefined {
	try {
		const probePlan = createCompactionCommitPlan(body, prepared, requestHash, {
			summary: "",
			firstKeptEntryId: prepared.preparation.firstKeptEntryId,
			tokensBefore: 0,
		});
		if (!probePlan.commit) {
			throw new Error("Failed to construct the minimum compaction persistence probe");
		}
		preflightSessionCapacityMutation(body.sessionId, {
			content: {
				kind: "append_entries",
				entries: [probePlan.commit.entry],
				leafId: probePlan.commit.entry.id,
			},
		});
		preflightCompactTerminalPlan(config, probePlan);
	} catch (error) {
		if (!(error instanceof SessionCapacityError) && !(error instanceof SessionPersistenceCapacityError)) {
			throw error;
		}
		return createCompactCapacityFailureResponse(
			{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
			error,
			"not_started",
		);
	}
}

async function handleSessionCompact(
	config: ServerConfig,
	runtime: CompactRunRuntime,
	mutations: SessionMutationRuntime,
	body: SessionCompactBody,
	res: ServerResponse,
): Promise<void> {
	if (body.protocolVersion !== PI_SERVER_PROTOCOL_VERSION) {
		sendJson(res, 400, {
			error: `Unsupported pi-server protocol version: ${body.protocolVersion}`,
			protocolVersion: PI_SERVER_PROTOCOL_VERSION,
		});
		return;
	}
	if (!body.sessionId || !body.operationId) {
		sendJson(res, 400, { error: "sessionId and operationId are required" });
		return;
	}
	if (
		typeof body.baseStaticContextHash !== "string" ||
		(body.baseStaticContextHash !== "" && !/^[a-f0-9]{64}$/u.test(body.baseStaticContextHash)) ||
		typeof body.baseTreeHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(body.baseTreeHash) ||
		!Number.isSafeInteger(body.baseEntryCount) ||
		body.baseEntryCount < 0 ||
		(body.baseLeafId !== null && (typeof body.baseLeafId !== "string" || body.baseLeafId.length === 0)) ||
		!Number.isSafeInteger(body.baseRevision) ||
		body.baseRevision < 0
	) {
		sendJson(res, 400, { error: "A valid complete compaction base identity is required" });
		return;
	}
	if (typeof body.streamResponse !== "boolean") {
		sendJson(res, 400, { error: "streamResponse is required" });
		return;
	}
	const requestHash = hashCompactRequest(body);
	const action = await enqueueCompactSetup(runtime, async () => {
		if (runtime.closing) return { kind: "closing" } as const;
		await runtime.store.prune();
		const existingState = await runtime.store.get(body.sessionId, body.operationId);
		if (existingState) {
			if (existingState.requestMac !== requestHash) {
				return {
					kind: "response",
					response: createCompactFailureResponse(
						{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
						409,
						"operationId is already bound to a different compaction request",
						"not_started",
					),
				} as const;
			}
			if (existingState.status !== "running") {
				const plan = compactTerminalPlanFromState(existingState);
				await enqueueSessionStoreMutation(mutations, body.sessionId, () => applyCompactTerminalPlan(config, plan));
				const replay: CompactRunRecord = {
					sessionId: body.sessionId,
					operationId: body.operationId,
					requestHash,
					status: "settled",
					result: plan.response,
					promise: Promise.resolve(plan.response),
					abortController: new AbortController(),
					subscribers: new Set(),
				};
				return { kind: "run", run: replay } as const;
			}
			const activeRun = runtime.activeRuns.get(compactRunKey(body.sessionId, body.operationId));
			if (!activeRun) {
				throw new StreamRunStateError("Durable running compaction has no active provider execution");
			}
			return { kind: "run", run: activeRun } as const;
		}
		return enqueueSessionMutation(mutations, body.sessionId, async () => {
			const prepared = prepareSessionCompact(body);
			if ("status" in prepared) {
				return {
					kind: "response",
					response: compactNotStartedResponse(body, requestHash, prepared),
				} as const;
			}
			const capacityFailure = preflightCompactionCapacity(config, body, prepared, requestHash);
			if (capacityFailure) {
				return { kind: "response", response: capacityFailure } as const;
			}
			const state = await runtime.store.begin({
				sessionId: body.sessionId,
				runId: body.operationId,
				requestMac: requestHash,
			});
			if (state.status !== "running") {
				throw new StreamRunStateError("New durable compaction did not begin in running state");
			}
			const abortController = new AbortController();
			let resolveTerminal: ((response: SessionCompactHttpResponse) => void) | undefined;
			let rejectTerminal: ((error: unknown) => void) | undefined;
			const terminal = new Promise<SessionCompactHttpResponse>((resolve, reject) => {
				resolveTerminal = resolve;
				rejectTerminal = reject;
			});
			const run: CompactRunRecord = {
				sessionId: body.sessionId,
				operationId: body.operationId,
				requestHash,
				status: "running",
				promise: terminal,
				abortController,
				subscribers: new Set(),
				resolveTerminal,
				rejectTerminal,
			};
			runtime.activeRuns.set(compactRunKey(body.sessionId, body.operationId), run);
			void (async () => {
				let computed: CompactResult | ExtensionCompactionReplacement | SessionCompactHttpResponse;
				try {
					computed = await computeSessionCompaction(body, prepared, abortController.signal);
				} catch (error) {
					computed = {
						status: 500,
						body: { error: error instanceof Error ? error.message : String(error) },
					};
				}
				if ("status" in computed) {
					const error =
						typeof computed.body.error === "string" ? computed.body.error : "Compaction provider failed";
					return settleCompactRun(
						config,
						runtime,
						mutations,
						run,
						createCompactTerminalPlan(run, createCompactFailureResponse(run, computed.status, error, "terminal")),
						"failed",
					);
				}
				if (abortController.signal.aborted) {
					return settleCompactRun(
						config,
						runtime,
						mutations,
						run,
						createCompactTerminalPlan(
							run,
							createCompactFailureResponse(run, 499, "Compaction aborted by user", "terminal"),
						),
						"failed",
					);
				}
				return settleCompactRun(config, runtime, mutations, run, () =>
					createCompactionCommitPlan(body, prepared, requestHash, computed),
				);
			})().catch(() => undefined);
			return { kind: "run", run } as const;
		});
	});
	if (action.kind === "closing") {
		const response = createCompactFailureResponse(
			{ sessionId: body.sessionId, operationId: body.operationId, requestHash },
			503,
			"pi-server is closing",
			"not_started",
		);
		sendJson(res, response.status, response.body);
		return;
	}
	if (action.kind === "response") {
		sendJson(res, action.response.status, action.response.body);
		return;
	}
	const run = action.run;
	if (run.status === "running" && run.subscribers.size >= COMPACT_RUN_MAX_SUBSCRIBERS) {
		sendJson(res, 503, { error: "Too many subscribers for this compaction" });
		return;
	}

	if (body.streamResponse) {
		await handleSessionCompactStream(runtime, run, res, runtime.drainIdleTimeoutMs);
		return;
	}

	await handleSessionCompactJsonStream(runtime, run, res, runtime.drainIdleTimeoutMs);
}

async function handleSessionCompactRecovery(
	config: ServerConfig,
	runtime: CompactRunRuntime,
	mutations: SessionMutationRuntime,
	sessionId: string,
	operationId: string,
	requestHash: string | undefined,
	res: ServerResponse,
): Promise<void> {
	if (!requestHash || !/^[a-f0-9]{64}$/u.test(requestHash)) {
		sendJson(res, 400, { error: "requestHash is required and must be a lowercase SHA-256 digest" });
		return;
	}
	const action = await enqueueCompactSetup(runtime, async () => {
		const state = await runtime.store.get(sessionId, operationId);
		if (!state) return { kind: "missing" } as const;
		if (state.requestMac !== requestHash) {
			throw new StreamRunConflictError("operationId is bound to a different compaction request");
		}
		if (state.status === "running") {
			const active = runtime.activeRuns.get(compactRunKey(sessionId, operationId));
			if (!active) {
				throw new StreamRunStateError("Durable running compaction has no active provider execution");
			}
			return { kind: "run", run: active } as const;
		}
		const plan = compactTerminalPlanFromState(state);
		await enqueueSessionStoreMutation(mutations, sessionId, () => applyCompactTerminalPlan(config, plan));
		const replay: CompactRunRecord = {
			sessionId,
			operationId,
			requestHash,
			status: "settled",
			result: plan.response,
			promise: Promise.resolve(plan.response),
			abortController: new AbortController(),
			subscribers: new Set(),
		};
		return { kind: "run", run: replay } as const;
	});
	if (action.kind === "missing") {
		sendJson(res, 404, { error: "compaction operation not found" });
		return;
	}
	await handleSessionCompactStream(runtime, action.run, res, runtime.drainIdleTimeoutMs);
}

async function handleAcknowledgeSessionCompact(
	config: ServerConfig,
	runtime: CompactRunRuntime,
	mutations: SessionMutationRuntime,
	body: SessionIdBody & { operationId?: string; requestHash?: string },
	res: ServerResponse,
): Promise<void> {
	if (!body.sessionId || !body.operationId || !body.requestHash) {
		sendJson(res, 400, { error: "sessionId, operationId, and requestHash are required" });
		return;
	}
	const state = await enqueueCompactSetup(runtime, async () => {
		const current = await runtime.store.get(body.sessionId, body.operationId!);
		if (!current) return undefined;
		if (current.requestMac !== body.requestHash) {
			throw new StreamRunConflictError("operationId is bound to a different compaction request");
		}
		if (current.status === "running") {
			throw new StreamRunStateError("Cannot acknowledge a running compaction");
		}
		const plan = compactTerminalPlanFromState(current);
		await enqueueSessionStoreMutation(mutations, body.sessionId, () => applyCompactTerminalPlan(config, plan));
		const acknowledged = await runtime.store.acknowledge(body.sessionId, body.operationId!);
		await runtime.store.prune();
		return acknowledged;
	});
	if (!state) {
		sendJson(res, 404, { error: "compaction operation not found" });
		return;
	}
	sendJson(res, 200, {
		acknowledged: true,
		sessionId: state.sessionId,
		operationId: state.runId,
		requestHash: state.requestMac,
		status: state.status,
		acknowledgedAt: state.acknowledgedAt,
	});
}

interface ReservedCompactRunDeletion {
	run: CompactRunRecord;
	plan: CompactTerminalPlan;
	resolve: (response: SessionCompactHttpResponse) => void;
	reject: (error: unknown) => void;
}

async function reserveSessionCompactRunsForDeletion(
	runtime: CompactRunRuntime,
	sessionId: string,
): Promise<{ activeRuns: CompactRunRecord[]; reserved: ReservedCompactRunDeletion[] }> {
	const activeRuns = [...runtime.activeRuns.values()].filter((run) => run.sessionId === sessionId);
	const reserved: ReservedCompactRunDeletion[] = [];
	for (const run of activeRuns) {
		run.abortController.abort();
		if (run.settlement) {
			await run.settlement;
			continue;
		}
		const plan = createCompactTerminalPlan(
			run,
			createCompactFailureResponse(run, 499, "Session deleted while compaction was running", "terminal"),
		);
		let resolve!: (response: SessionCompactHttpResponse) => void;
		let reject!: (error: unknown) => void;
		const settlement = new Promise<SessionCompactHttpResponse>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		run.settlement = settlement;
		void settlement.catch(() => undefined);
		reserved.push({ run, plan, resolve, reject });
	}
	return { activeRuns, reserved };
}

async function deleteSessionCompactRunsLocked(
	runtime: CompactRunRuntime,
	sessionId: string,
	activeRuns: CompactRunRecord[],
	reserved: ReservedCompactRunDeletion[],
): Promise<void> {
	for (const { run, plan, resolve } of reserved) {
		const state = await runtime.store.settle({
			sessionId: run.sessionId,
			runId: run.operationId,
			status: "failed",
			event: JSON.stringify(plan),
			result: plan,
			errorMessage: plan.response.body.error as string,
		});
		const durablePlan = compactTerminalPlanFromState(state);
		run.status = "settled";
		run.result = durablePlan.response;
		run.resolveTerminal?.(durablePlan.response);
		run.resolveTerminal = undefined;
		run.rejectTerminal = undefined;
		resolve(durablePlan.response);
	}
	for (const run of activeRuns) {
		for (const response of run.subscribers) response.destroy();
		runtime.activeRuns.delete(compactRunKey(run.sessionId, run.operationId));
	}
	const states = await runtime.store.list();
	for (const state of states) {
		if (state.sessionId !== sessionId) continue;
		await runtime.store.delete(state.sessionId, state.runId);
	}
}

function handleDropLastAssistantError(config: ServerConfig, body: SessionIdBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	let dropped = false;
	const existingSession = getSession(body.sessionId);
	const session = existingSession
		? mutateAndPersistSession(config, body.sessionId, () => {
				dropped = dropLastAssistantError(body.sessionId);
				const updated = getSession(body.sessionId);
				if (!updated) throw new Error(`Session ${body.sessionId} disappeared while dropping its assistant error`);
				return updated;
			})
		: undefined;
	const messageCount = session?.messages.length ?? 0;
	sendJson(res, 200, { success: true, dropped, messageCount });
}

function handleSessionHistory(
	sessionId: string,
	from: number | undefined,
	entriesFrom: number | undefined,
	revision: number | undefined,
	baseTreeHash: string | undefined,
	protocolVersion: number | undefined,
	res: ServerResponse,
): void {
	const session = getSession(sessionId);
	if (!session) {
		sendJson(res, 404, { error: "session not found" });
		return;
	}
	if (protocolVersion !== undefined && protocolVersion !== PI_SERVER_PROTOCOL_VERSION) {
		sendJson(res, 400, {
			error: `Unsupported pi-server protocol version: ${protocolVersion}`,
			protocolVersion: PI_SERVER_PROTOCOL_VERSION,
		});
		return;
	}
	const baseMessageCount = from ?? 0;
	if (
		entriesFrom !== undefined &&
		entriesFrom <= session.entries.length &&
		(revision === undefined || revision <= session.revision) &&
		(baseTreeHash === undefined || baseTreeHash === session.prefixHashes[entriesFrom])
	) {
		sendJson(
			res,
			200,
			protocolVersion === PI_SERVER_PROTOCOL_VERSION
				? sessionTreePatchV2ResponseBody(session, entriesFrom, revision)
				: sessionTreePatchResponseBody(session, baseMessageCount, entriesFrom, revision),
		);
		return;
	}
	sendJson(
		res,
		200,
		protocolVersion === PI_SERVER_PROTOCOL_VERSION
			? sessionHistoryV2FullResponseBody(session)
			: sessionHistoryFullResponseBody(session, baseMessageCount),
	);
}

async function handleSessionRun(
	runtime: StreamRunRuntime,
	sessionId: string,
	runId: string,
	res: ServerResponse,
): Promise<void> {
	const state = await enqueueStreamRunSetup(runtime, async () => {
		await runtime.store.prune();
		return runtime.store.get(sessionId, runId);
	});
	if (!state) {
		sendJson(res, 404, { error: "run not found" });
		return;
	}
	sendJson(res, 200, {
		sessionId: state.sessionId,
		runId: state.runId,
		status: state.status,
		requestMac: state.requestMac,
		nextSeq: state.nextSeq,
		message: messageFromDurableState(state),
		errorMessage: state.terminal?.errorMessage,
		acknowledgedAt: state.acknowledgedAt,
	});
}

async function handleSessionRunEvents(
	runtime: StreamRunRuntime,
	sessionId: string,
	runId: string,
	from: number,
	res: ServerResponse,
): Promise<void> {
	const action = await enqueueStreamRunSetup(runtime, async () => {
		await runtime.store.prune();
		const state = await runtime.store.get(sessionId, runId);
		if (!state) return { kind: "missing" } as const;
		if (from > state.nextSeq) {
			return { kind: "invalid_cursor", nextSeq: state.nextSeq } as const;
		}
		if (state.status !== "running") {
			return { kind: "replay", promise: replayDurableStreamRun(runtime, state, res, from) } as const;
		}
		const run = runtime.activeRuns.get(runKey(sessionId, runId));
		if (!run) {
			return { kind: "unavailable" } as const;
		}
		if (run.subscribers.size >= STREAM_RUN_MAX_SUBSCRIBERS) {
			return { kind: "subscriber_limit" } as const;
		}
		if (!beginStreamResponse(res)) return { kind: "attached" } as const;
		subscribeToStreamRun(runtime, run, res, from);
		return { kind: "attached" } as const;
	});
	switch (action.kind) {
		case "missing":
			sendJson(res, 404, { error: "run not found" });
			return;
		case "invalid_cursor":
			sendJson(res, 409, { error: `from ${from} exceeds durable nextSeq ${action.nextSeq}` });
			return;
		case "unavailable":
			sendJson(res, 409, { error: "Durable running stream has no active provider execution" });
			return;
		case "subscriber_limit":
			sendJson(res, 503, { error: "Too many subscribers for this stream run" });
			return;
		case "replay":
			await action.promise;
			return;
		case "attached":
			return;
	}
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

async function terminateStreamRunWithProviderError(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	model: ResolvedStream["model"],
	errorMessage: string,
): Promise<void> {
	if (run.status !== "running") return;
	logProviderStreamFailure(run, model, errorMessage);
	await persistTerminalStreamRun(runtime, run, createSyntheticAssistantMessage(run, errorMessage, "error"));
}

function executeStreamRun(
	runtime: StreamRunRuntime,
	run: StreamRunRecord,
	model: ResolvedStream["model"],
	context: Context,
	streamOptions: SimpleStreamOptions,
): void {
	let stream: AsyncIterable<AssistantMessageEvent>;
	try {
		stream = streamSimple(model, context, { ...streamOptions, signal: run.abortController.signal });
	} catch (error) {
		void terminateStreamRunWithProviderError(
			runtime,
			run,
			model,
			error instanceof Error ? error.message : String(error),
		).catch((persistenceError: unknown) => {
			void handleStreamRunPersistenceFailure(runtime, run, persistenceError);
		});
		return;
	}

	void (async () => {
		try {
			for await (const event of stream) {
				if (run.status !== "running") return;
				if (event.type === "error") {
					if (event.reason === "error") {
						logProviderStreamFailure(run, model, event.error.errorMessage ?? event.reason);
					}
					await persistTerminalStreamRun(runtime, run, withStreamRunDiagnostic(run, event.error));
					return;
				}
				if (event.type === "done") {
					await persistTerminalStreamRun(runtime, run, withStreamRunDiagnostic(run, event.message));
					return;
				}
				const proxyEvent = toProxyEvent(event, run);
				if (proxyEvent) await queueStreamRunEvent(runtime, run, proxyEvent);
			}
			await terminateStreamRunWithProviderError(
				runtime,
				run,
				model,
				"Provider stream ended without a terminal event",
			);
		} catch (error) {
			if (run.shuttingDown || run.status !== "running") return;
			if (run.persistenceError) {
				await handleStreamRunPersistenceFailure(runtime, run, run.persistenceError);
				return;
			}
			await terminateStreamRunWithProviderError(
				runtime,
				run,
				model,
				error instanceof Error ? error.message : String(error),
			);
		}
	})().catch((error: unknown) => {
		void handleStreamRunPersistenceFailure(runtime, run, error);
	});
}

async function handleStream(
	config: ServerConfig,
	runtime: StreamRunRuntime,
	mutations: SessionMutationRuntime,
	body: StreamRequestBody,
	res: ServerResponse,
): Promise<void> {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (body.runMode !== undefined && body.runMode !== "main-durable" && body.runMode !== "auxiliary-transient") {
		sendJson(res, 400, { error: "runMode must be main-durable or auxiliary-transient" });
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
	if (body.baseStaticContextHash === undefined) {
		sendJson(res, 400, { error: "baseStaticContextHash is required" });
		return;
	}
	if (body.baseStaticContextHash !== "" && !/^[a-f0-9]{64}$/.test(body.baseStaticContextHash)) {
		sendJson(res, 400, {
			error: "baseStaticContextHash must be empty or a lowercase 64-character SHA-256 digest",
		});
		return;
	}
	if (body.baseRevision === undefined) {
		sendJson(res, 400, { error: "baseRevision is required" });
		return;
	}
	if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) {
		sendJson(res, 400, { error: "baseRevision must be a non-negative safe integer" });
		return;
	}
	const baseStaticContextHash = body.baseStaticContextHash;
	const baseRevision = body.baseRevision;
	const cursor = body.eventCursor ?? 0;
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		sendJson(res, 400, { error: "eventCursor must be a non-negative safe integer" });
		return;
	}
	if (body.baseTreeHash !== undefined && !/^[a-f0-9]{64}$/.test(body.baseTreeHash)) {
		sendJson(res, 400, { error: "baseTreeHash must be a lowercase 64-character SHA-256 digest" });
		return;
	}
	if (body.baseEntryCount !== undefined && (!Number.isSafeInteger(body.baseEntryCount) || body.baseEntryCount < 0)) {
		sendJson(res, 400, { error: "baseEntryCount must be a non-negative safe integer" });
		return;
	}
	if (
		body.baseLeafId !== undefined &&
		body.baseLeafId !== null &&
		(typeof body.baseLeafId !== "string" || body.baseLeafId.length === 0)
	) {
		sendJson(res, 400, { error: "baseLeafId must be a non-empty string or null" });
		return;
	}
	const requestHash = hashStreamRequest(body);
	const storageRunId = body.runId ?? `anonymous:${randomUUID()}`;
	const deletionVersion = sessionDeletionFences.get(mutations)?.versions.get(body.sessionId) ?? 0;
	const action = await enqueueStreamRunSetup(runtime, () =>
		enqueueSessionMutation(
			mutations,
			body.sessionId,
			async () => {
				if (runtime.closing) return { kind: "closing" } as const;
				await runtime.store.prune();
				const existingState = body.runId ? await runtime.store.get(body.sessionId, body.runId) : undefined;
				if (existingState) {
					if (existingState.requestMac !== requestHash) {
						throw new StreamRunConflictError("runId is already bound to a different stream request");
					}
					if (cursor > existingState.nextSeq) {
						throw new StreamRunConflictError(
							`eventCursor ${cursor} exceeds durable nextSeq ${existingState.nextSeq}`,
						);
					}
					if (existingState.status !== "running") {
						return {
							kind: "replay",
							promise: replayDurableStreamRun(runtime, existingState, res, cursor),
						} as const;
					}
					const existingRun = runtime.activeRuns.get(runKey(body.sessionId, body.runId!));
					if (!existingRun) {
						throw new StreamRunStateError("Durable running stream has no active provider execution");
					}
					if (existingRun.subscribers.size >= STREAM_RUN_MAX_SUBSCRIBERS) {
						return { kind: "subscriber_limit" } as const;
					}
					if (beginStreamResponse(res)) {
						subscribeToStreamRun(runtime, existingRun, res, cursor);
					}
					return { kind: "attached" } as const;
				}

				const existingSession = getSession(body.sessionId);
				if (!existingSession?.staticContext && !body.staticContext) {
					return { kind: "missing_context" } as const;
				}
				if (body.baseTreeHash === undefined || body.baseEntryCount === undefined || body.baseLeafId === undefined) {
					return { kind: "missing_tree_base" } as const;
				}
				if (
					!matchesPiServerStreamBase(
						{
							baseStaticContextHash,
							baseTreeHash: body.baseTreeHash,
							baseEntryCount: body.baseEntryCount,
							baseLeafId: body.baseLeafId,
							baseRevision,
						},
						existingSession
							? sessionIdentity(existingSession)
							: {
									staticContextHash: "",
									treeHash: PI_SERVER_EMPTY_TREE_HASH,
									entryCount: 0,
									leafId: null,
									revision: 0,
								},
					)
				) {
					return { kind: "session_conflict" } as const;
				}
				const staticContext = body.staticContext;
				const session =
					existingSession && !staticContext
						? existingSession
						: await enqueueSessionCapacityMutation(() =>
								mutateAndPersistSession(config, body.sessionId, () =>
									applySessionMutation(body.sessionId, staticContext ? { staticContext } : {}),
								),
							);
				const expectedIdentity = streamBaseIdentity(session);
				const resolved = resolveStreamOptions(config, body.model, body);
				const state = await runtime.store.begin({
					sessionId: body.sessionId,
					runId: storageRunId,
					requestMac: requestHash,
				});
				const currentSession = getSession(body.sessionId);
				if (!currentSession || !matchesPiServerStreamBase(expectedIdentity, sessionIdentity(currentSession))) {
					await runtime.store.rollbackUnstartedBegin({
						sessionId: body.sessionId,
						runId: storageRunId,
						requestMac: requestHash,
					});
					return { kind: "session_conflict" } as const;
				}
				const context = buildStreamContext(currentSession, body);
				const run = createActiveStreamRun(state, body.runId, resolved.model);
				runtime.activeRuns.set(runKey(body.sessionId, storageRunId), run);
				if (beginStreamResponse(res)) {
					subscribeToStreamRun(runtime, run, res, cursor);
				}
				return { kind: "start", run, context, resolved } as const;
			},
			false,
			deletionVersion,
		),
	);
	switch (action.kind) {
		case "closing":
			sendJson(res, 503, { error: "pi-server is closing" });
			return;
		case "subscriber_limit":
			sendJson(res, 503, { error: "Too many subscribers for this stream run" });
			return;
		case "missing_context":
			sendJson(res, 400, { error: "Session has no static context. Initialize with /api/session/init first." });
			return;
		case "missing_tree_base":
			sendJson(res, 400, { error: "baseTreeHash, baseEntryCount, and baseLeafId are required for a new run" });
			return;
		case "session_conflict":
			sendJson(res, 409, {
				error: "Stream request base identity does not match the current server session",
			});
			return;
		case "replay":
			await action.promise;
			return;
		case "attached":
			return;
		case "start":
			executeStreamRun(runtime, action.run, action.resolved.model, action.context, action.resolved.options);
			return;
	}
}

async function handleAcknowledgeSessionRun(
	runtime: StreamRunRuntime,
	body: SessionIdBody & { runId?: string },
	res: ServerResponse,
): Promise<void> {
	if (!body.sessionId || !body.runId) {
		sendJson(res, 400, { error: "sessionId and runId are required" });
		return;
	}
	const state = await enqueueStreamRunSetup(runtime, () => runtime.store.acknowledge(body.sessionId, body.runId!));
	sendJson(res, 200, {
		acknowledged: true,
		sessionId: state.sessionId,
		runId: state.runId,
		requestMac: state.requestMac,
		status: state.status,
		acknowledgedAt: state.acknowledgedAt,
	});
}

async function deleteSessionStreamRunsLocked(runtime: StreamRunRuntime, sessionId: string): Promise<void> {
	const activeRuns = [...runtime.activeRuns.values()].filter((run) => run.sessionId === sessionId);
	for (const run of activeRuns) {
		await abortStreamRun(runtime, run, "Session deleted while provider stream was running");
		for (const res of [...run.subscribers.keys()]) {
			detachStreamRunSubscriber(runtime, run, res);
			res.destroy();
		}
		runtime.activeRuns.delete(runKey(run.sessionId, run.storageRunId));
	}
	const replays = [...(runtime.replayReaders.get(sessionId) ?? [])];
	for (const replay of replays) {
		replay.abortController.abort();
		replay.response.destroy();
	}
	const pending = [
		...(runtime.subscriberPumps.get(sessionId) ?? []),
		...replays.flatMap((replay) => (replay.promise ? [replay.promise] : [])),
	];
	if (pending.length > 0) {
		await Promise.allSettled(pending);
	}
	const states = await runtime.store.list();
	for (const state of states) {
		if (state.sessionId !== sessionId) continue;
		await runtime.store.delete(state.sessionId, state.runId);
	}
}

async function deleteSessionAtomically(
	config: ServerConfig,
	deletePersistence: typeof deletePersistedSession,
	streamRuntime: StreamRunRuntime,
	compactRuntime: CompactRunRuntime,
	sessionMutations: SessionMutationRuntime,
	sessionId: string,
): Promise<void> {
	const deletionState = sessionDeletionFenceState(sessionMutations);
	advanceSessionDeletionVersion(deletionState, sessionId);
	deletionState.active.set(sessionId, (deletionState.active.get(sessionId) ?? 0) + 1);
	let fenceClosed = false;
	const closeFence = () => {
		if (fenceClosed) return;
		fenceClosed = true;
		const remaining = (deletionState.active.get(sessionId) ?? 1) - 1;
		if (remaining === 0) deletionState.active.delete(sessionId);
		else deletionState.active.set(sessionId, remaining);
		advanceSessionDeletionVersion(deletionState, sessionId);
		cleanupSessionDeletionFence(sessionMutations, sessionId);
	};
	let reserved: ReservedCompactRunDeletion[] = [];
	try {
		await enqueueStreamRunSetup(streamRuntime, () =>
			enqueueCompactSetup(compactRuntime, async () => {
				const compactDeletion = await reserveSessionCompactRunsForDeletion(compactRuntime, sessionId);
				reserved = compactDeletion.reserved;
				await enqueueSessionStoreMutation(
					sessionMutations,
					sessionId,
					async () => {
						try {
							await deleteSessionStreamRunsLocked(streamRuntime, sessionId);
							await deleteSessionCompactRunsLocked(
								compactRuntime,
								sessionId,
								compactDeletion.activeRuns,
								compactDeletion.reserved,
							);
							deleteSessionFromStore(sessionId);
							deletePersistence(config.sessionStoreDir, sessionId);
						} finally {
							closeFence();
						}
					},
					true,
				);
			}),
		);
	} catch (error) {
		for (const { run, reject } of reserved) {
			if (run.status !== "running") continue;
			run.rejectTerminal?.(error);
			run.resolveTerminal = undefined;
			run.rejectTerminal = undefined;
			reject(error);
		}
		failStopServerPersistence(currentServerPersistenceRuntime(), error);
		throw error;
	} finally {
		closeFence();
	}
}

async function handlePostRequest(
	config: ServerConfig,
	streamRuntime: StreamRunRuntime,
	compactRuntime: CompactRunRuntime,
	sessionMutations: SessionMutationRuntime,
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
		const request = body as SessionInitBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionInit(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/update") {
		const request = body as SessionInitBody & { staticContext: SessionStaticContext };
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionUpdate(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/sync") {
		const request = body as SessionSyncBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionSync(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/append") {
		const request = body as SessionAppendBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionAppend(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/tree/sync") {
		const request = body as SessionTreeSyncBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionTreeSync(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/tree/append") {
		const request = body as SessionTreeSyncBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionTreeAppend(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/tree/switch") {
		const request = body as SessionTreeSwitchBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleSessionTreeSwitch(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/drop-last-assistant-error") {
		const request = body as SessionIdBody;
		await enqueueSessionStoreMutation(sessionMutations, request.sessionId, () =>
			handleDropLastAssistantError(config, request, res),
		);
		return true;
	}

	if (pathname === "/api/session/run/cancel") {
		await handleCancelSessionRun(streamRuntime, body as SessionIdBody & { runId?: string }, res);
		return true;
	}

	if (pathname === "/api/session/run/ack") {
		await handleAcknowledgeSessionRun(streamRuntime, body as SessionIdBody & { runId?: string }, res);
		return true;
	}

	if (pathname === "/api/session/compact/cancel") {
		await handleCancelSessionCompact(
			config,
			compactRuntime,
			sessionMutations,
			body as SessionIdBody & { operationId?: string; requestHash?: string },
			res,
		);
		return true;
	}

	if (pathname === "/api/session/compact/ack") {
		await handleAcknowledgeSessionCompact(
			config,
			compactRuntime,
			sessionMutations,
			body as SessionIdBody & { operationId?: string; requestHash?: string },
			res,
		);
		return true;
	}

	if (pathname === "/api/session/compact") {
		await handleSessionCompact(config, compactRuntime, sessionMutations, body as SessionCompactBody, res);
		return true;
	}

	if (pathname === "/api/stream") {
		await handleStream(config, streamRuntime, sessionMutations, body as StreamRequestBody, res);
		return true;
	}

	return false;
}

function createOwnedPiServer(configOverride: PiServerOptions | undefined, ownership: symbol): HttpServer {
	const config = loadConfig(configOverride);
	const drainIdleTimeoutMs = positiveServerOption(
		configOverride?.streamDrainIdleTimeoutMs,
		"PI_SERVER_STREAM_DRAIN_IDLE_TIMEOUT_MS",
		DEFAULT_STREAM_DRAIN_IDLE_TIMEOUT_MS,
		"streamDrainIdleTimeoutMs",
	);
	const requestBodyNoProgressTimeoutMs = positiveServerOption(
		configOverride?.requestBodyNoProgressTimeoutMs,
		"PI_SERVER_REQUEST_BODY_NO_PROGRESS_TIMEOUT_MS",
		REQUEST_BODY_NO_PROGRESS_TIMEOUT_MS,
		"requestBodyNoProgressTimeoutMs",
	);
	const streamRunMaxFrameBytes = positiveServerOption(
		configOverride?.streamRunMaxFrameBytes,
		"PI_SERVER_STREAM_RUN_MAX_FRAME_BYTES",
		STREAM_RUN_MAX_FRAME_BYTES,
		"streamRunMaxFrameBytes",
	);
	const streamRunMaxBytes = positiveServerOption(
		configOverride?.streamRunMaxBytes,
		"PI_SERVER_STREAM_RUN_MAX_BYTES",
		STREAM_RUN_MAX_BYTES,
		"streamRunMaxBytes",
	);
	const streamRunMaxTotalBytes = positiveServerOption(
		configOverride?.streamRunMaxTotalBytes,
		"PI_SERVER_STREAM_RUN_MAX_TOTAL_BYTES",
		STREAM_RUN_MAX_TOTAL_BYTES,
		"streamRunMaxTotalBytes",
	);
	const streamRunTerminalReserveBytes = positiveServerOption(
		configOverride?.streamRunTerminalReserveBytes,
		"PI_SERVER_STREAM_RUN_TERMINAL_RESERVE_BYTES",
		STREAM_RUN_TERMINAL_RESERVE_BYTES,
		"streamRunTerminalReserveBytes",
	);
	const streamRunIoNoProgressTimeoutMs = positiveServerOption(
		configOverride?.streamRunIoNoProgressTimeoutMs,
		"PI_SERVER_STREAM_RUN_IO_NO_PROGRESS_TIMEOUT_MS",
		120_000,
		"streamRunIoNoProgressTimeoutMs",
	);
	const compactRunMaxBytes = positiveServerOption(
		configOverride?.compactRunMaxBytes,
		"PI_SERVER_COMPACT_RUN_MAX_BYTES",
		COMPACT_RUN_MAX_BYTES,
		"compactRunMaxBytes",
	);
	const compactRunMaxTotalBytes = positiveServerOption(
		configOverride?.compactRunMaxTotalBytes,
		"PI_SERVER_COMPACT_RUN_MAX_TOTAL_BYTES",
		COMPACT_RUN_MAX_TOTAL_BYTES,
		"compactRunMaxTotalBytes",
	);
	const compactRunTerminalReserveBytes = positiveServerOption(
		configOverride?.compactRunTerminalReserveBytes,
		"PI_SERVER_COMPACT_RUN_TERMINAL_RESERVE_BYTES",
		COMPACT_RUN_TERMINAL_RESERVE_BYTES,
		"compactRunTerminalReserveBytes",
	);
	const compactRunIoNoProgressTimeoutMs = positiveServerOption(
		configOverride?.compactRunIoNoProgressTimeoutMs,
		"PI_SERVER_COMPACT_RUN_IO_NO_PROGRESS_TIMEOUT_MS",
		120_000,
		"compactRunIoNoProgressTimeoutMs",
	);
	const sessionMaxEntries = positiveServerOption(
		configOverride?.sessionMaxEntries,
		"PI_SERVER_SESSION_MAX_ENTRIES",
		DEFAULT_SESSION_CAPACITY_LIMITS.maxEntriesPerSession,
		"sessionMaxEntries",
	);
	const sessionMaxLogicalBytes = positiveServerOption(
		configOverride?.sessionMaxLogicalBytes,
		"PI_SERVER_SESSION_MAX_LOGICAL_BYTES",
		DEFAULT_SESSION_CAPACITY_LIMITS.maxLogicalBytesPerSession,
		"sessionMaxLogicalBytes",
	);
	const sessionsMaxEntries = positiveServerOption(
		configOverride?.sessionsMaxEntries,
		"PI_SERVER_SESSIONS_MAX_ENTRIES",
		DEFAULT_SESSION_CAPACITY_LIMITS.maxAggregateEntries,
		"sessionsMaxEntries",
	);
	const sessionsMaxLogicalBytes = positiveServerOption(
		configOverride?.sessionsMaxLogicalBytes,
		"PI_SERVER_SESSIONS_MAX_LOGICAL_BYTES",
		DEFAULT_SESSION_CAPACITY_LIMITS.maxAggregateLogicalBytes,
		"sessionsMaxLogicalBytes",
	);
	const maxLoadedSessions = positiveServerOption(
		configOverride?.maxLoadedSessions,
		"PI_SERVER_MAX_LOADED_SESSIONS",
		DEFAULT_SESSION_CAPACITY_LIMITS.maxLoadedSessions,
		"maxLoadedSessions",
	);
	configureSessionCapacityLimits({
		maxEntriesPerSession: sessionMaxEntries,
		maxLogicalBytesPerSession: sessionMaxLogicalBytes,
		maxAggregateEntries: sessionsMaxEntries,
		maxAggregateLogicalBytes: sessionsMaxLogicalBytes,
		maxLoadedSessions,
	});
	const persistenceRuntime: ServerPersistenceRuntime = {
		onFatalPersistenceError: configOverride?.onFatalStreamPersistenceError,
		sessionFaultInjector: configOverride?.sessionPersistenceFaultInjector,
	};
	activeServerPersistenceRuntime = persistenceRuntime;
	let streamRuntime: StreamRunRuntime;
	const streamStore = new StreamRunPersistence({
		rootDir: join(config.sessionStoreDir, ".runs"),
		lockPath: join(config.sessionStoreDir, ".pi-server-owner.sqlite"),
		maxRuns: STREAM_RUN_MAX_RECORDS,
		maxFrameBytes: streamRunMaxFrameBytes,
		maxRunBytes: streamRunMaxBytes,
		maxTotalBytes: streamRunMaxTotalBytes,
		terminalReserveBytes: streamRunTerminalReserveBytes,
		maxBatchBytes: streamRunMaxFrameBytes,
		ioNoProgressTimeoutMs: streamRunIoNoProgressTimeoutMs,
		faultInjector: configOverride?.streamRunFaultInjector,
		restartFailureEvent: encodeProxyEvent(createStreamErrorEvent(STREAM_RUN_RESTART_ERROR_MESSAGE)),
		restartFailureMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
		restartFailureTerminal: createRestartFailureTerminal,
		onFatalError: (error) => failStopServerPersistence(persistenceRuntime, error),
	});
	streamRuntime = {
		store: streamStore,
		activeRuns: new Map(),
		setupQueue: Promise.resolve(),
		subscriberPumps: new Map(),
		replayReaders: new Map(),
		drainIdleTimeoutMs,
		closing: false,
	};
	persistenceRuntime.streamRuntime = streamRuntime;
	const sessionMutations: SessionMutationRuntime = { queues: new Map() };
	let compactRuntime: CompactRunRuntime;
	const compactStore = new StreamRunPersistence({
		rootDir: join(config.sessionStoreDir, ".compactions"),
		lockPath: join(config.sessionStoreDir, ".pi-server-compact-owner.sqlite"),
		maxRuns: COMPACT_RUN_MAX_RECORDS,
		maxFrameBytes: COMPACT_RUN_MAX_FRAME_BYTES,
		maxRunBytes: compactRunMaxBytes,
		maxTotalBytes: compactRunMaxTotalBytes,
		terminalReserveBytes: compactRunTerminalReserveBytes,
		maxBatchBytes: COMPACT_RUN_MAX_FRAME_BYTES,
		ioNoProgressTimeoutMs: compactRunIoNoProgressTimeoutMs,
		faultInjector: configOverride?.compactRunFaultInjector,
		restartFailureMessage: "restart-unknown",
		restartFailureEvent: JSON.stringify({ error: "restart-unknown" }),
		restartFailureTerminal: createCompactRestartFailureTerminal,
		onFatalError: (error) => failStopServerPersistence(persistenceRuntime, error),
	});
	compactRuntime = {
		store: compactStore,
		activeRuns: new Map(),
		setupQueue: Promise.resolve(),
		drainIdleTimeoutMs,
		closing: false,
	};
	persistenceRuntime.compactRuntime = compactRuntime;
	let streamStoreInitialized = false;
	let compactStoreInitialized = false;
	const serverInitialization = (async () => {
		await streamStore.initialize();
		streamStoreInitialized = true;
		await compactStore.initialize();
		compactStoreInitialized = true;
		loadPersistedSessions(config.sessionStoreDir);
		const compactStates = await compactStore.list();
		for (const compactState of compactStates) {
			if (compactState.status === "running") {
				throw new StreamRunStateError("Compaction recovery left a durable operation running");
			}
			const state = await compactStore.get(compactState.sessionId, compactState.runId);
			if (!state) {
				throw new StreamRunCorruptionError(
					`${compactState.sessionId}/${compactState.runId}`,
					"compaction disappeared during startup recovery",
				);
			}
			applyCompactTerminalPlan(config, compactTerminalPlanFromState(state));
		}
	})();
	const serverReady = serverInitialization.catch((error: unknown) => {
		failStopServerPersistence(persistenceRuntime, error);
		if (streamStoreInitialized && !compactStoreInitialized) {
			void streamStore.close().catch(() => undefined);
		}
	});
	const chunkTargetResponses = new Map<string, ChunkTargetResponseRecord>();

	const server = createServer(async (req, res) => {
		try {
			await serverReady;
			const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

			if (persistenceRuntime.fatalError) {
				sendJson(res, 503, { status: "error", error: "durable operation persistence health failure" });
				return;
			}

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

			const runEventsMatch = /^\/api\/session\/([^/]+)\/runs\/([^/]+)\/events$/.exec(url.pathname);
			if (req.method === "GET" && runEventsMatch) {
				const fromParam = url.searchParams.get("from");
				const from = fromParam === null ? 0 : Number(fromParam);
				if (!Number.isSafeInteger(from) || from < 0) {
					sendJson(res, 400, { error: "from must be a non-negative safe integer" });
					return;
				}
				await handleSessionRunEvents(
					streamRuntime,
					decodeURIComponent(runEventsMatch[1]),
					decodeURIComponent(runEventsMatch[2]),
					from,
					res,
				);
				return;
			}

			const runMatch = /^\/api\/session\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
			if (req.method === "GET" && runMatch) {
				await handleSessionRun(
					streamRuntime,
					decodeURIComponent(runMatch[1]),
					decodeURIComponent(runMatch[2]),
					res,
				);
				return;
			}

			const compactMatch = /^\/api\/session\/([^/]+)\/compactions\/([^/]+)$/.exec(url.pathname);
			if (req.method === "GET" && compactMatch) {
				await handleSessionCompactRecovery(
					config,
					compactRuntime,
					sessionMutations,
					decodeURIComponent(compactMatch[1]),
					decodeURIComponent(compactMatch[2]),
					url.searchParams.get("requestHash") ?? undefined,
					res,
				);
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
				const protocolVersionParam = url.searchParams.get("protocolVersion");
				const protocolVersion = protocolVersionParam === null ? undefined : Number(protocolVersionParam);
				if (protocolVersion !== undefined && !Number.isInteger(protocolVersion)) {
					sendJson(res, 400, { error: "protocolVersion must be an integer" });
					return;
				}
				handleSessionHistory(
					decodeURIComponent(encodedSessionId),
					from,
					entriesFrom,
					revision,
					url.searchParams.get("baseTreeHash") ?? undefined,
					protocolVersion,
					res,
				);
				return;
			}

			if (req.method === "POST" && url.pathname === CHUNK_ENDPOINT) {
				try {
					const body = JSON.parse(
						await readBody(req, REQUEST_BODY_MAX_BYTES, requestBodyNoProgressTimeoutMs),
					) as RequestChunkBody;
					const chunkResult = receiveRequestChunk(body);
					if (!chunkResult.complete) {
						res.setHeader(CHUNK_ACK_HEADER, "1");
						sendJson(res, 200, chunkResult.ack);
						return;
					}
					res.setHeader(CHUNK_ACK_HEADER, "0");
					const targetBody = JSON.parse(chunkResult.bodyJson) as unknown;
					const targetUsesOwnJournal =
						chunkResult.target === "/api/stream" || chunkResult.target === "/api/session/compact";
					if (targetUsesOwnJournal) {
						const record =
							typeof targetBody === "object" && targetBody !== null
								? (targetBody as Record<string, unknown>)
								: undefined;
						const id = chunkResult.target === "/api/stream" ? record?.runId : record?.operationId;
						if (typeof id !== "string" || id.length === 0) {
							sendJson(res, 400, {
								error: `${chunkResult.target} chunk requests require an idempotency id`,
							});
							return;
						}
					} else if (chunkResult.replayed) {
						pruneChunkTargetResponses(chunkTargetResponses);
						const cachedResponse = chunkTargetResponses.get(chunkResult.requestId);
						if (!cachedResponse) {
							sendJson(res, 409, {
								error: "Chunk target response expired; reconcile target state before retrying",
							});
							return;
						}
						sendCapturedJson(res, cachedResponse);
						return;
					} else {
						jsonResponseCaptures.set(res, (response) => {
							cacheChunkTargetResponse(chunkTargetResponses, chunkResult.requestId, response);
						});
					}
					await handlePostRequest(
						config,
						streamRuntime,
						compactRuntime,
						sessionMutations,
						chunkResult.target,
						targetBody,
						res,
					);
					if (!targetUsesOwnJournal && jsonResponseCaptures.has(res)) {
						throw new Error(`Chunk target ${chunkResult.target} ended without a JSON response`);
					}
				} catch (err) {
					logRequestError(req, err);
					if (!res.headersSent) {
						sendJson(res, requestErrorStatus(err, 400), requestErrorBody(err));
					} else {
						res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
						res.end();
					}
				} finally {
					jsonResponseCaptures.delete(res);
				}
				return;
			}

			if (req.method === "POST") {
				try {
					const body = JSON.parse(
						await readBody(req, REQUEST_BODY_MAX_BYTES, requestBodyNoProgressTimeoutMs),
					) as unknown;
					if (
						await handlePostRequest(
							config,
							streamRuntime,
							compactRuntime,
							sessionMutations,
							url.pathname,
							body,
							res,
						)
					) {
						return;
					}
				} catch (err) {
					logRequestError(req, err);
					if (!res.headersSent) {
						sendJson(res, requestErrorStatus(err, 500), requestErrorBody(err));
					} else {
						res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
						res.end();
					}
					return;
				}
			}

			if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
				const sessionId = decodeURIComponent(url.pathname.slice("/api/session/".length));
				await deleteSessionAtomically(
					config,
					configOverride?.sessionPersistenceDelete ?? deletePersistedSession,
					streamRuntime,
					compactRuntime,
					sessionMutations,
					sessionId,
				);
				sendJson(res, 200, { deleted: sessionId });
				return;
			}

			sendJson(res, 404, { error: "Not found" });
		} catch (error) {
			logRequestError(req, error);
			if (res.headersSent) {
				res.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			sendJson(res, error instanceof URIError ? 400 : requestErrorStatus(error, 500), requestErrorBody(error));
		}
	});
	serverInitializations.set(server, serverInitialization);
	server.requestTimeout = 0;
	server.headersTimeout = HEADERS_TIMEOUT_MS;

	const streamRunCleanup = setInterval(() => {
		void streamStore.prune().catch((error: unknown) => {
			console.error(
				JSON.stringify({
					phase: "stream_persistence",
					operation: "prune",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		});
		pruneChunkTargetResponses(chunkTargetResponses);
	}, STREAM_RUN_CLEANUP_INTERVAL_MS);
	streamRunCleanup.unref();
	const compactRunCleanup = setInterval(() => {
		void compactStore.prune().catch((error: unknown) => failStopCompactPersistence(compactRuntime, error));
	}, STREAM_RUN_CLEANUP_INTERVAL_MS);
	compactRunCleanup.unref();
	let shutdownPromise: Promise<void> | undefined;
	const shutDownRuns = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		clearInterval(streamRunCleanup);
		clearInterval(compactRunCleanup);
		streamRuntime.closing = true;
		compactRuntime.closing = true;
		const pendingCompactSettlements: Promise<SessionCompactHttpResponse>[] = [];
		for (const run of streamRuntime.activeRuns.values()) {
			run.shuttingDown = true;
			clearStreamRunFlushTimer(run);
			run.abortController.abort();
			for (const res of [...run.subscribers.keys()]) {
				detachStreamRunSubscriber(streamRuntime, run, res);
				res.destroy();
			}
		}
		streamRuntime.activeRuns.clear();
		for (const replays of streamRuntime.replayReaders.values()) {
			for (const replay of replays) {
				replay.abortController.abort();
				replay.response.destroy();
			}
		}
		for (const run of compactRuntime.activeRuns.values()) {
			run.abortController.abort();
			pendingCompactSettlements.push(
				settleCompactRun(
					config,
					compactRuntime,
					sessionMutations,
					run,
					createCompactTerminalPlan(
						run,
						createCompactFailureResponse(run, 499, "Server closed while compaction was running", "terminal"),
					),
					"failed",
				),
			);
			for (const res of run.subscribers) {
				res.destroy();
			}
		}
		compactRuntime.activeRuns.clear();
		chunkTargetResponses.clear();
		shutdownPromise = (async () => {
			const cleanupErrors: unknown[] = [];
			try {
				await serverReady;
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				await streamRuntime.setupQueue;
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				await compactRuntime.setupQueue;
			} catch (error) {
				cleanupErrors.push(error);
			}
			if (pendingCompactSettlements.length > 0) {
				const settlements = await Promise.allSettled(pendingCompactSettlements);
				for (const settlement of settlements) {
					if (settlement.status === "rejected") cleanupErrors.push(settlement.reason);
				}
			}
			if (streamStoreInitialized) {
				try {
					await streamStore.flush();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (compactStoreInitialized) {
				try {
					await compactStore.flush();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			const pendingStreamReaders = [
				...[...streamRuntime.subscriberPumps.values()].flatMap((pumps) => [...pumps]),
				...[...streamRuntime.replayReaders.values()].flatMap((replays) =>
					[...replays].flatMap((replay) => (replay.promise ? [replay.promise] : [])),
				),
			];
			if (pendingStreamReaders.length > 0) {
				await Promise.allSettled(pendingStreamReaders);
			}
			if (streamStoreInitialized) {
				try {
					await streamStore.close();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (compactStoreInitialized) {
				try {
					await compactStore.close();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (cleanupErrors.length === 1) throw cleanupErrors[0];
			if (cleanupErrors.length > 1) {
				throw new AggregateError(cleanupErrors, "pi-server shutdown encountered persistence errors");
			}
		})();
		return shutdownPromise;
	};
	const closeServer = server.close.bind(server);
	let ownershipReleased = false;
	const releaseOwnership = () => {
		if (ownershipReleased) return;
		ownershipReleased = true;
		releasePiServerOwnership(ownership);
	};
	server.close = ((callback?: (error?: Error) => void) => {
		const cleanup = shutDownRuns();
		let httpClosed = false;
		let cleanupDone = false;
		let finished = false;
		let closeError: Error | undefined;
		const finish = () => {
			if (finished || !httpClosed || !cleanupDone) return;
			finished = true;
			releaseOwnership();
			callback?.(closeError);
		};
		void cleanup.then(
			() => {
				cleanupDone = true;
				finish();
			},
			(error: unknown) => {
				cleanupDone = true;
				closeError = error instanceof Error ? error : new Error(String(error));
				finish();
			},
		);
		return closeServer((error?: Error) => {
			httpClosed = true;
			closeError ??= error;
			finish();
		});
	}) as typeof server.close;
	server.once("close", () => {
		void shutDownRuns()
			.finally(releaseOwnership)
			.catch(() => undefined);
	});

	return server;
}

export function createPiServer(configOverride?: PiServerOptions): HttpServer {
	const ownership = acquirePiServerOwnership();
	try {
		return createOwnedPiServer(configOverride, ownership);
	} catch (error) {
		releasePiServerOwnership(ownership);
		throw error;
	}
}

function toProxyEvent(event: AssistantMessageEvent, run: StreamRunRecord): ProxyAssistantMessageEvent | undefined {
	switch (event.type) {
		case "start":
			run.contentDeltas.clear();
			return { type: "start" };
		case "text_start": {
			run.contentDeltas.set(event.contentIndex, { type: "text", hash: createHash("sha256"), bytes: 0 });
			return { type: "text_start", contentIndex: event.contentIndex };
		}
		case "text_delta": {
			const accumulated = run.contentDeltas.get(event.contentIndex);
			const digest =
				accumulated?.type === "text"
					? accumulated
					: { type: "text" as const, hash: createHash("sha256"), bytes: 0 };
			digest.hash.update(event.delta, "utf-8");
			digest.bytes += Buffer.byteLength(event.delta, "utf-8");
			run.contentDeltas.set(event.contentIndex, digest);
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		}
		case "text_end": {
			const accumulated = run.contentDeltas.get(event.contentIndex);
			run.contentDeltas.delete(event.contentIndex);
			const contentBytes = Buffer.byteLength(event.content, "utf-8");
			const contentHash = createHash("sha256").update(event.content, "utf-8").digest("hex");
			const deltasMatch =
				accumulated?.type === "text" &&
				accumulated.bytes === contentBytes &&
				accumulated.hash.digest("hex") === contentHash;
			return {
				type: "text_end",
				contentIndex: event.contentIndex,
				content: deltasMatch ? undefined : event.content,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "text"
						? (event.partial.content[event.contentIndex] as { textSignature?: string }).textSignature
						: undefined,
			};
		}
		case "thinking_start": {
			run.contentDeltas.set(event.contentIndex, { type: "thinking", hash: createHash("sha256"), bytes: 0 });
			return { type: "thinking_start", contentIndex: event.contentIndex };
		}
		case "thinking_delta": {
			const accumulated = run.contentDeltas.get(event.contentIndex);
			const digest =
				accumulated?.type === "thinking"
					? accumulated
					: { type: "thinking" as const, hash: createHash("sha256"), bytes: 0 };
			digest.hash.update(event.delta, "utf-8");
			digest.bytes += Buffer.byteLength(event.delta, "utf-8");
			run.contentDeltas.set(event.contentIndex, digest);
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		}
		case "thinking_end": {
			const accumulated = run.contentDeltas.get(event.contentIndex);
			run.contentDeltas.delete(event.contentIndex);
			const contentBytes = Buffer.byteLength(event.content, "utf-8");
			const contentHash = createHash("sha256").update(event.content, "utf-8").digest("hex");
			const deltasMatch =
				accumulated?.type === "thinking" &&
				accumulated.bytes === contentBytes &&
				accumulated.hash.digest("hex") === contentHash;
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				content: deltasMatch ? undefined : event.content,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "thinking"
						? (event.partial.content[event.contentIndex] as { thinkingSignature?: string }).thinkingSignature
						: undefined,
				redacted:
					event.partial.content[event.contentIndex]?.type === "thinking"
						? (event.partial.content[event.contentIndex] as { redacted?: boolean }).redacted
						: undefined,
			};
		}
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
			return {
				type: "toolcall_end",
				contentIndex: event.contentIndex,
				thoughtSignature: event.toolCall.thoughtSignature,
				toolCall: event.toolCall,
			};
		case "done":
			run.contentDeltas.clear();
			return {
				type: "done",
				reason: event.reason,
				usage: event.message.usage,
				responseModel: event.message.responseModel,
				responseId: event.message.responseId,
				diagnostics: event.message.diagnostics,
				api: event.message.api,
				provider: event.message.provider,
				model: event.message.model,
				timestamp: event.message.timestamp,
			};
		case "error":
			run.contentDeltas.clear();
			return {
				type: "error",
				reason: event.reason,
				errorMessage: event.error.errorMessage,
				usage: event.error.usage,
				responseModel: event.error.responseModel,
				responseId: event.error.responseId,
				diagnostics: event.error.diagnostics,
				api: event.error.api,
				provider: event.error.provider,
				model: event.error.model,
				timestamp: event.error.timestamp,
			};
		default:
			return undefined;
	}
}

export function startServer(configOverride?: PiServerOptions): HttpServer {
	const config = loadConfig(configOverride);
	const externalFatalHandler = configOverride?.onFatalStreamPersistenceError;
	const fatalShutdownGraceMs = configOverride?.fatalShutdownGraceMs ?? FATAL_SHUTDOWN_GRACE_MS;
	if (!Number.isSafeInteger(fatalShutdownGraceMs) || fatalShutdownGraceMs <= 0) {
		throw new Error("fatalShutdownGraceMs must be a positive safe integer");
	}
	const fatalExit = configOverride?.fatalExit ?? ((code: number) => process.exit(code));
	let server: HttpServer;
	server = createPiServer({
		...configOverride,
		onFatalStreamPersistenceError: (error) => {
			process.exitCode = 1;
			const hardExitTimer = setTimeout(() => fatalExit(1), fatalShutdownGraceMs);
			server.close((closeError) => {
				if (!closeError) clearTimeout(hardExitTimer);
				if (closeError) {
					console.error(
						JSON.stringify({
							phase: "stream_persistence",
							operation: "fatal_shutdown",
							error: closeError.message,
						}),
					);
				}
				externalFatalHandler?.(error);
			});
		},
	});
	const initialization = serverInitializations.get(server);
	if (!initialization) {
		throw new Error("pi-server initialization promise was not registered");
	}
	void initialization.then(
		() => {
			server.listen(config.port, config.host, () => {
				console.log(`pi-server listening on ${config.host}:${config.port}`);
			});
		},
		() => undefined,
	);
	return server;
}
