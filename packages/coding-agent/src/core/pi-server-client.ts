import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	buildSessionContext,
	type CompactionEntry,
	type CompactionPreparationOptions,
	type CompactResult,
	convertToLlm,
	type ProxyAssistantMessageEvent,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
	type Model,
	parseStreamingJson,
	type RetryPolicy,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	acknowledgePiServerPendingCompact,
	type PiServerPendingCompactState,
	readPiServerPendingCompact,
	writePiServerAppliedCompact,
	writePiServerPendingCompact,
	writePiServerTerminalCompact,
} from "./pi-server-compact-state.ts";
import {
	appendPiServerTreeHash,
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	hashPiServerStaticContext,
	hashPiServerTreeEntry,
	PI_SERVER_EMPTY_TREE_HASH,
	PI_SERVER_PROTOCOL_VERSION,
} from "./pi-server-protocol.ts";
import { ChunkRequest, PiServerTransportBodyLimitError, readPiServerResponseText } from "./pi-server-request.ts";
import {
	acknowledgePiServerPendingRun,
	acquirePiServerRunStateLease,
	hashPiServerIdentity,
	type PiServerPendingRunState,
	type PiServerRunStateLease,
	readPiServerPendingRun,
	releasePiServerRunStateLease,
	writePiServerPendingRun,
} from "./pi-server-run-state.ts";

class PiServerEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function getServerUrl(): string {
	return process.env.PI_SERVER_URL ?? "http://127.0.0.1:4217";
}

function getAuthToken(): string {
	return process.env.PI_SERVER_AUTH_TOKEN ?? "";
}

function createPiServerRequest(signal?: AbortSignal): ChunkRequest {
	return new ChunkRequest({
		serverUrl: getServerUrl(),
		authToken: getAuthToken(),
		signal,
	});
}

const sessionStaticContextHashes = new Map<string, string>();
const sessionTreeHashes = new Map<string, string>();
const sessionTreeEntryCounts = new Map<string, number>();
const sessionTreeLeafIds = new Map<string, string | null>();
const sessionTreeRevisions = new Map<string, number>();
const sessionHasTemporaryTree = new Set<string>();
const sessionLocalTreeHashes = new Map<string, { entries: readonly SessionTreeEntry[]; treeHash: string }>();
const sessionPendingRuns = new Map<string, PiServerPendingRunState>();
const activePersistentRunLeases = new Map<
	string,
	{ sessionId: string; lease: PiServerRunStateLease; scope: "run" | "session" }
>();
const RESPONSE_BODY_EXCERPT_CHARS = 500;
const PI_SERVER_CANCEL_TIMEOUT_MS = 5000;
const PI_SERVER_COMPACT_DEFAULT_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;
const PI_SERVER_COMPACT_MAX_RECONNECT_DELAY_MS = 30_000;
const PI_SERVER_STREAM_DEFAULT_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;
const PI_SERVER_STREAM_MAX_RECONNECT_DELAY_MS = 30_000;
const PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS = 90_000;
const PI_SERVER_ERROR_BODY_MAX_BYTES = 64 * 1024;
const PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES = 256 * 1024 * 1024;
const TRANSIENT_PI_SERVER_RETRY_DELAYS_MS = [250, 750, 1500];
const TRANSIENT_PI_SERVER_STATUS_CODES = new Set([408, 425, 429, 502, 503, 504, 530]);

export function hashStaticContext(ctx: Context): string {
	return hashPiServerStaticContext(ctx);
}

function hashEntries(entries: SessionTreeEntry[]): string {
	return hashPiServerSessionEntries(entries);
}

function getLinearTreeFromMessages(messages: Message[]): { entries: SessionTreeEntry[]; leafId: string | null } {
	let parentId: string | null = null;
	const entries = messages.map((message, index): SessionTreeEntry => {
		const id = `message-${index}`;
		const entry: SessionTreeEntry = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
		parentId = id;
		return entry;
	});
	return { entries, leafId: parentId };
}

export function resetSessionTracking(sessionId: string): void {
	sessionStaticContextHashes.delete(sessionId);
	sessionTreeHashes.delete(sessionId);
	sessionTreeEntryCounts.delete(sessionId);
	sessionTreeLeafIds.delete(sessionId);
	sessionTreeRevisions.delete(sessionId);
	sessionHasTemporaryTree.delete(sessionId);
	sessionLocalTreeHashes.delete(sessionId);
}

export function resetAllSessionTracking(): void {
	for (const { lease } of activePersistentRunLeases.values()) {
		releasePiServerRunStateLease(lease);
	}
	activePersistentRunLeases.clear();
	sessionStaticContextHashes.clear();
	sessionTreeHashes.clear();
	sessionTreeEntryCounts.clear();
	sessionTreeLeafIds.clear();
	sessionTreeRevisions.clear();
	sessionHasTemporaryTree.clear();
	sessionLocalTreeHashes.clear();
	sessionPendingRuns.clear();
}

function acquirePersistentRunLease(sessionId: string, path: string): PiServerRunStateLease {
	const normalizedPath = resolve(path);
	if (activePersistentRunLeases.has(normalizedPath)) {
		throw new Error(`Cannot start pi-server run for ${sessionId}; this process already owns the session lease`);
	}
	const lease = acquirePiServerRunStateLease(normalizedPath);
	activePersistentRunLeases.set(normalizedPath, { sessionId, lease, scope: "run" });
	return lease;
}

export function releasePiServerRunLease(sessionId: string, path?: string): void {
	if (!path) return;
	const normalizedPath = resolve(path);
	const active = activePersistentRunLeases.get(normalizedPath);
	if (!active || active.sessionId !== sessionId || active.scope !== "run") return;
	activePersistentRunLeases.delete(normalizedPath);
	releasePiServerRunStateLease(active.lease);
}

export function acquirePiServerSessionLease(sessionId: string, path: string): void {
	const normalizedPath = resolve(path);
	if (activePersistentRunLeases.has(normalizedPath)) {
		throw new Error(`Cannot start pi-server session ${sessionId}; this process already owns the session lease`);
	}
	const lease = acquirePiServerRunStateLease(normalizedPath);
	activePersistentRunLeases.set(normalizedPath, { sessionId, lease, scope: "session" });
}

export function releasePiServerSessionLease(sessionId: string, path?: string): void {
	if (!path) return;
	const normalizedPath = resolve(path);
	const active = activePersistentRunLeases.get(normalizedPath);
	if (!active || active.sessionId !== sessionId || active.scope !== "session") return;
	activePersistentRunLeases.delete(normalizedPath);
	releasePiServerRunStateLease(active.lease);
}

function getPersistentRunLease(
	sessionId: string,
	path: string,
): { lease: PiServerRunStateLease; scope: "run" | "session" } | undefined {
	const active = activePersistentRunLeases.get(resolve(path));
	if (!active) return undefined;
	if (active.sessionId !== sessionId) {
		throw new Error(`Pi-server run lease belongs to session ${active.sessionId}, not ${sessionId}`);
	}
	return active;
}

interface PiServerSessionSummary {
	protocolVersion: number;
	sessionId: string;
	staticContextHash: string;
	treeHash: string;
	messageCount: number;
	entryCount: number;
	leafId: string | null;
	revision: number;
}

export interface PiServerTreeSnapshot {
	entries: SessionTreeEntry[];
	leafId: string | null;
	replace?: boolean;
}

export interface PiServerCompactionResult {
	sessionId: string;
	compaction: CompactResult;
	compactionEntry: SessionTreeEntry;
	entries: SessionTreeEntry[];
	leafId: string | null;
	messages: Message[];
	operationId: string;
	requestHash: string;
	revision: number;
	treeHash: string;
	compactStatePath?: string;
}

export interface PiServerHistorySnapshot {
	entries: SessionTreeEntry[];
	leafId: string | null;
	messages: Message[];
	treeHash: string;
	revision: number;
}

export interface PiServerStreamOptions extends SimpleStreamOptions {
	runMode?: "main-durable" | "auxiliary-transient";
	sessionTree?: PiServerTreeSnapshot;
	ephemeralMessages?: Message[];
	contextOverlay?: Message[];
	piServerRunStatePath?: string;
	piServerRecoveryWindowMs?: number;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

interface PiServerResponseFailure {
	details: string;
	matchText: string;
	bodyText: string;
}

interface PiServerHistoryResponse extends PiServerSessionSummary {
	entries?: SessionTreeEntry[];
	treePatch?: PiServerTreePatch;
}

interface PiServerTreePatch {
	entriesFrom: number;
	baseRevision?: number;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
}

interface ServerSentEvent {
	event: string;
	data: string;
}

class PiServerCompactOperationError extends Error {
	readonly payload: unknown;

	constructor(message: string, payload: unknown) {
		super(message);
		this.name = "PiServerCompactOperationError";
		this.payload = payload;
	}
}

class PiServerCompactProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiServerCompactProtocolError";
	}
}

class PiServerCompactInterruptionError extends Error {
	readonly observedProgress: boolean;

	constructor(message: string, observedProgress: boolean) {
		super(message);
		this.name = "PiServerCompactInterruptionError";
		this.observedProgress = observedProgress;
	}
}

class PiServerStreamProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiServerStreamProtocolError";
	}
}

class PiServerHttpResponseError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(message: string, status: number, retryable: boolean) {
		super(message);
		this.name = "PiServerHttpResponseError";
		this.status = status;
		this.retryable = retryable;
	}
}

interface PiServerRunResponse {
	sessionId: string;
	runId: string;
	requestMac: string;
	status: "running" | "completed" | "failed";
	nextSeq: number;
	message?: AssistantMessage;
	errorMessage?: string;
	acknowledgedAt?: number;
}

type PiServerRunRecoveryResult =
	| { status: "completed" | "failed" | "running"; requestMac: string }
	| { status: "not_found" }
	| { status: "unavailable"; details: string };

interface PiServerSyncOptions {
	signal?: AbortSignal;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

type PiServerFailurePhase = "session_init" | "tree_sync" | "provider_stream" | "history_reconcile";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface PiServerRunDiagnostic {
	sessionId: string;
	runId: string;
	requestMac: string;
	restartUnknown: boolean;
}

export function getPiServerRunDiagnostic(message: AssistantMessage): PiServerRunDiagnostic | undefined {
	const diagnostics = message.diagnostics?.filter((diagnostic) => diagnostic.type === "pi_server_run") ?? [];
	if (diagnostics.length === 0) return undefined;
	if (diagnostics.length !== 1) {
		throw new Error("pi-server assistant message contained multiple run diagnostics");
	}
	const details = diagnostics[0].details;
	if (
		!isObject(details) ||
		typeof details.sessionId !== "string" ||
		details.sessionId.length === 0 ||
		typeof details.runId !== "string" ||
		details.runId.length === 0 ||
		typeof details.requestMac !== "string" ||
		!/^[a-f0-9]{64}$/u.test(details.requestMac) ||
		(details.restartUnknown !== undefined && typeof details.restartUnknown !== "boolean")
	) {
		throw new Error("pi-server assistant message contained an invalid run diagnostic");
	}
	return {
		sessionId: details.sessionId,
		runId: details.runId,
		requestMac: details.requestMac,
		restartUnknown: details.restartUnknown === true,
	};
}

function hashPiServerStreamRequest(value: unknown): string {
	const serialized = canonicalJsonStringify(value);
	if (serialized === undefined) {
		throw new Error("Failed to serialize pi-server stream request identity");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

function parsePiServerSessionSummary(
	value: unknown,
	expectedSessionId: string,
	errorPrefix: string,
): PiServerSessionSummary {
	if (!isObject(value)) {
		throw new Error(`${errorPrefix} (response was not an object)`);
	}
	if (value.protocolVersion !== PI_SERVER_PROTOCOL_VERSION) {
		const received = value.protocolVersion === undefined ? "missing" : JSON.stringify(value.protocolVersion);
		throw new Error(
			`${errorPrefix} (unsupported pi-server protocol version: ${received}; expected ${PI_SERVER_PROTOCOL_VERSION})`,
		);
	}
	if (value.sessionId !== expectedSessionId) {
		throw new Error(`${errorPrefix} (response sessionId did not match the requested session)`);
	}
	if (
		typeof value.staticContextHash !== "string" ||
		(value.staticContextHash !== "" && !/^[a-f0-9]{64}$/i.test(value.staticContextHash))
	) {
		throw new Error(`${errorPrefix} (response staticContextHash was not a valid digest)`);
	}
	if (typeof value.treeHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.treeHash)) {
		throw new Error(`${errorPrefix} (response treeHash was not a valid digest)`);
	}
	if (!isNonNegativeInteger(value.messageCount)) {
		throw new Error(`${errorPrefix} (response messageCount was not a non-negative integer)`);
	}
	if (!isNonNegativeInteger(value.entryCount)) {
		throw new Error(`${errorPrefix} (response entryCount was not a non-negative integer)`);
	}
	if (value.leafId !== null && typeof value.leafId !== "string") {
		throw new Error(`${errorPrefix} (response leafId was not a string or null)`);
	}
	if (!isNonNegativeInteger(value.revision)) {
		throw new Error(`${errorPrefix} (response revision was not a non-negative integer)`);
	}
	return value as unknown as PiServerSessionSummary;
}

function recordPiServerSessionSummary(sessionId: string, summary: PiServerSessionSummary): void {
	sessionTreeHashes.set(sessionId, summary.treeHash);
	sessionTreeEntryCounts.set(sessionId, summary.entryCount);
	sessionTreeLeafIds.set(sessionId, summary.leafId);
	sessionTreeRevisions.set(sessionId, summary.revision);
}

function extendsCachedImmutableTree(
	cachedEntries: readonly SessionTreeEntry[],
	entries: readonly SessionTreeEntry[],
): boolean {
	if (cachedEntries.length > entries.length) return false;
	if (cachedEntries.length === 0) return true;
	return cachedEntries[cachedEntries.length - 1] === entries[cachedEntries.length - 1];
}

function hashLocalTree(sessionId: string, entries: SessionTreeEntry[]): string {
	const cached = sessionLocalTreeHashes.get(sessionId);
	let treeHash = PI_SERVER_EMPTY_TREE_HASH;
	let startIndex = 0;
	if (cached && extendsCachedImmutableTree(cached.entries, entries)) {
		treeHash = cached.treeHash;
		startIndex = cached.entries.length;
	}
	for (let index = startIndex; index < entries.length; index++) {
		treeHash = appendPiServerTreeHash(treeHash, hashPiServerTreeEntry(entries[index]));
	}
	sessionLocalTreeHashes.set(sessionId, { entries, treeHash });
	return treeHash;
}

function hashLocalTreePrefix(sessionId: string, entries: SessionTreeEntry[], entryCount: number): string {
	const cached = sessionLocalTreeHashes.get(sessionId);
	if (cached && cached.entries.length === entryCount && extendsCachedImmutableTree(cached.entries, entries)) {
		return cached.treeHash;
	}
	let treeHash = PI_SERVER_EMPTY_TREE_HASH;
	for (let index = 0; index < entryCount; index++) {
		treeHash = appendPiServerTreeHash(treeHash, hashPiServerTreeEntry(entries[index]));
	}
	return treeHash;
}

function getResponseStatus(response: Response): string {
	const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
	return response.status >= 500 ? `${status} (server error)` : status;
}

function getResponseContentType(response: Response): string {
	return response.headers.get("content-type") ?? "unknown";
}

function getBodyExcerpt(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "<empty>";
	const excerpt = trimmed.slice(0, RESPONSE_BODY_EXCERPT_CHARS);
	return excerpt.length < trimmed.length ? `${excerpt}...` : excerpt;
}

function getPiServerResponseNoProgressTimeoutMs(): number {
	const environmentValue = process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS;
	const value = environmentValue === undefined ? PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS : Number(environmentValue);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS must be positive finite milliseconds");
	}
	return value;
}

interface PiServerBodyNoProgressState {
	timeoutMs: number;
	deadlineMs: number;
}

function createPiServerBodyNoProgressState(): PiServerBodyNoProgressState {
	const timeoutMs = getPiServerResponseNoProgressTimeoutMs();
	return { timeoutMs, deadlineMs: Date.now() + timeoutMs };
}

function createPiServerResponseNoProgressError(timeoutMs: number): Error {
	const error = new Error(`pi-server response made no progress for ${timeoutMs}ms`);
	error.name = "PiServerResponseNoProgressError";
	return error;
}

async function readPiServerBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: PiServerBodyNoProgressState,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	while (true) {
		const remainingMs = state.deadlineMs - Date.now();
		if (remainingMs <= 0) {
			throw createPiServerResponseNoProgressError(state.timeoutMs);
		}
		const result = await new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>(
			(resolve, reject) => {
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(createPiServerResponseNoProgressError(state.timeoutMs));
				}, remainingMs);
				timer.unref();

				void reader.read().then(
					(value) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(value);
					},
					(error: unknown) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						reject(error);
					},
				);
			},
		);
		if (result.done || result.value.byteLength > 0) {
			if (!result.done) state.deadlineMs = Date.now() + state.timeoutMs;
			return result;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

function getJsonErrorText(text: string): string | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isObject(parsed)) return undefined;
		const error = parsed.error;
		return typeof error === "string" && error.length > 0 ? error : undefined;
	} catch {
		return undefined;
	}
}

function formatResponseDetails(response: Response, bodyText: string): string {
	const body = getJsonErrorText(bodyText) ?? getBodyExcerpt(bodyText);
	return `${getResponseStatus(response)}; content-type: ${getResponseContentType(response)}; body excerpt: ${body}`;
}

async function readPiServerFailure(response: Response): Promise<PiServerResponseFailure> {
	const bodyText = await readPiServerResponseText(response, PI_SERVER_ERROR_BODY_MAX_BYTES);
	return {
		details: formatResponseDetails(response, bodyText),
		matchText: getJsonErrorText(bodyText) ?? bodyText,
		bodyText,
	};
}

async function readPiServerJson<T>(response: Response, errorPrefix: string): Promise<T> {
	const bodyText = await readPiServerResponseText(
		response,
		response.ok ? Number.POSITIVE_INFINITY : PI_SERVER_ERROR_BODY_MAX_BYTES,
	);
	if (!response.ok) {
		throw new PiServerHttpResponseError(
			`${errorPrefix} (${formatResponseDetails(response, bodyText)})`,
			response.status,
			isTransientPiServerResponse(response, bodyText),
		);
	}
	try {
		return JSON.parse(bodyText) as T;
	} catch {
		throw new Error(`${errorPrefix} (${formatResponseDetails(response, bodyText)}; expected JSON)`);
	}
}

function getServerSentEventFieldValue(line: string, field: string): string {
	const prefix = `${field}:`;
	const value = line.slice(prefix.length);
	return value.startsWith(" ") ? value.slice(1) : value;
}

function updateEventStreamLineBytes(chunk: Uint8Array, currentLineBytes: number): number {
	let lineBytes = currentLineBytes;
	for (const byte of chunk) {
		if (byte === 0x0a) {
			lineBytes = 0;
			continue;
		}
		lineBytes++;
		if (lineBytes > PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES) return -1;
	}
	return lineBytes;
}

function extractDecodedEventStreamLines(decoded: string, incompleteLineParts: string[]): string[] {
	const lines: string[] = [];
	let start = 0;
	let newlineIndex = decoded.indexOf("\n");
	while (newlineIndex >= 0) {
		incompleteLineParts.push(decoded.slice(start, newlineIndex));
		lines.push(incompleteLineParts.join(""));
		incompleteLineParts.length = 0;
		start = newlineIndex + 1;
		newlineIndex = decoded.indexOf("\n", start);
	}
	if (start < decoded.length) {
		incompleteLineParts.push(decoded.slice(start));
	}
	return lines;
}

function parseServerSentEventData(event: ServerSentEvent, errorPrefix: string): unknown {
	try {
		return JSON.parse(event.data) as unknown;
	} catch {
		throw new PiServerCompactProtocolError(
			`${errorPrefix} (invalid event-stream JSON data: ${getBodyExcerpt(event.data)})`,
		);
	}
}

function formatServerSentEventError(response: Response, payload: unknown): string {
	const message = isObject(payload) && typeof payload.error === "string" ? payload.error : JSON.stringify(payload);
	return `${getResponseStatus(response)}; content-type: ${getResponseContentType(response)}; body excerpt: ${getBodyExcerpt(message)}`;
}

async function readPiServerEventStreamJson<T>(response: Response, errorPrefix: string): Promise<T> {
	if (!response.body) {
		throw new PiServerCompactInterruptionError(`${errorPrefix} (response body was missing)`, false);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const noProgress = createPiServerBodyNoProgressState();
	let observedProgress = false;
	const incompleteLineParts: string[] = [];
	let eventName = "message";
	let dataLines: string[] = [];
	let eventDataBytes = 0;
	let incompleteLineBytes = 0;

	const dispatchEvent = (): { result: T } | undefined => {
		if (dataLines.length === 0) {
			eventName = "message";
			return undefined;
		}
		const event: ServerSentEvent = { event: eventName, data: dataLines.join("\n") };
		eventName = "message";
		dataLines = [];
		eventDataBytes = 0;
		if (event.event === "error") {
			const payload = parseServerSentEventData(event, errorPrefix);
			throw new PiServerCompactOperationError(
				`${errorPrefix} (${formatServerSentEventError(response, payload)})`,
				payload,
			);
		}
		if (event.event === "result") {
			return { result: parseServerSentEventData(event, errorPrefix) as T };
		}
		return undefined;
	};

	const consumeLine = (rawLine: string): { result: T } | undefined => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") return dispatchEvent();
		if (line.startsWith(":")) return undefined;
		if (line.startsWith("event:")) {
			eventName = getServerSentEventFieldValue(line, "event");
		} else if (line.startsWith("data:")) {
			const data = getServerSentEventFieldValue(line, "data");
			eventDataBytes += Buffer.byteLength(data, "utf-8") + (dataLines.length === 0 ? 0 : 1);
			if (eventDataBytes > PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES) {
				throw new PiServerCompactProtocolError(
					`${errorPrefix} (event-stream frame exceeded ${PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES} bytes)`,
				);
			}
			dataLines.push(data);
		}
		return undefined;
	};

	try {
		while (true) {
			let readResult: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
			try {
				readResult = await readPiServerBodyChunk(reader, noProgress);
			} catch (error) {
				throw new PiServerCompactInterruptionError(
					error instanceof Error ? error.message : String(error),
					observedProgress,
				);
			}
			if (readResult.done) {
				const finalLines = extractDecodedEventStreamLines(decoder.decode(), incompleteLineParts);
				for (const line of finalLines) {
					const result = consumeLine(line);
					if (result) return result.result;
				}
				if (incompleteLineParts.length > 0) {
					const result = consumeLine(incompleteLineParts.join(""));
					if (result) return result.result;
					incompleteLineParts.length = 0;
				}
				const result = dispatchEvent();
				if (result) return result.result;
				throw new PiServerCompactInterruptionError(
					`${errorPrefix} (event stream ended before a result event)`,
					observedProgress,
				);
			}
			if (readResult.value.byteLength > 0) observedProgress = true;
			incompleteLineBytes = updateEventStreamLineBytes(readResult.value, incompleteLineBytes);
			if (incompleteLineBytes < 0) {
				throw new PiServerCompactProtocolError(
					`${errorPrefix} (event-stream line exceeded ${PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES} bytes)`,
				);
			}
			const lines = extractDecodedEventStreamLines(
				decoder.decode(readResult.value, { stream: true }),
				incompleteLineParts,
			);
			for (const line of lines) {
				const result = consumeLine(line);
				if (result) return result.result;
			}
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
}

async function readPiServerCompactResponse<T>(response: Response, errorPrefix: string): Promise<T> {
	const contentType = getResponseContentType(response).toLowerCase().split(";")[0]?.trim();
	if (contentType === "text/event-stream") {
		return readPiServerEventStreamJson<T>(response, errorPrefix);
	}
	let bodyText: string;
	try {
		bodyText = await readPiServerResponseText(response);
	} catch (error) {
		throw new PiServerCompactInterruptionError(error instanceof Error ? error.message : String(error), false);
	}
	try {
		return JSON.parse(bodyText) as T;
	} catch {
		throw new PiServerCompactProtocolError(
			`${errorPrefix} (${formatResponseDetails(response, bodyText)}; expected JSON)`,
		);
	}
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function isTransientPiServerFetchError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fetch failed|network|socket (?:hang up|closed|lost)|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|CONNECT timeout|response made no progress/i.test(
		message,
	);
}

function isTransientPiServerResponse(response: Response, _bodyText: string): boolean {
	return TRANSIENT_PI_SERVER_STATUS_CODES.has(response.status);
}

function isRetryablePiServerInterruption(error: unknown): boolean {
	if (error instanceof PiServerHttpResponseError) return error.retryable;
	if (error instanceof PiServerCompactInterruptionError) return true;
	if (error instanceof PiServerCompactProtocolError || error instanceof PiServerStreamProtocolError) return false;
	if (error instanceof PiServerTransportBodyLimitError) return false;
	return isTransientPiServerFetchError(error);
}

async function waitForPiServerRetry(attempt: number, signal: AbortSignal | undefined): Promise<void> {
	await sleep(TRANSIENT_PI_SERVER_RETRY_DELAYS_MS[attempt], undefined, { signal });
}

async function postPiServerJsonWithTransientRetry<T>(
	request: ChunkRequest,
	endpoint: string,
	body: unknown,
	errorPrefix: string,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await request.postJson(endpoint, body);
		} catch (error) {
			if (
				attempt < TRANSIENT_PI_SERVER_RETRY_DELAYS_MS.length &&
				!isAbortError(error, request.options.signal) &&
				isTransientPiServerFetchError(error)
			) {
				await waitForPiServerRetry(attempt, request.options.signal);
				continue;
			}
			throw error;
		}

		let bodyText: string;
		try {
			bodyText = await readPiServerResponseText(
				response,
				response.ok ? Number.POSITIVE_INFINITY : PI_SERVER_ERROR_BODY_MAX_BYTES,
			);
		} catch (error) {
			if (
				attempt < TRANSIENT_PI_SERVER_RETRY_DELAYS_MS.length &&
				!request.options.signal?.aborted &&
				isTransientPiServerFetchError(error)
			) {
				await waitForPiServerRetry(attempt, request.options.signal);
				continue;
			}
			throw error;
		}
		if (!response.ok) {
			if (
				attempt < TRANSIENT_PI_SERVER_RETRY_DELAYS_MS.length &&
				!request.options.signal?.aborted &&
				isTransientPiServerResponse(response, bodyText)
			) {
				await waitForPiServerRetry(attempt, request.options.signal);
				continue;
			}
			throw new PiServerHttpResponseError(
				`${errorPrefix} (${formatResponseDetails(response, bodyText)})`,
				response.status,
				isTransientPiServerResponse(response, bodyText),
			);
		}

		try {
			return JSON.parse(bodyText) as T;
		} catch {
			throw new Error(`${errorPrefix} (${formatResponseDetails(response, bodyText)}; expected JSON)`);
		}
	}
}

async function ensurePiServerEventStream(response: Response): Promise<void> {
	const contentType = getResponseContentType(response);
	if (contentType.toLowerCase().split(";")[0]?.trim() === "text/event-stream") {
		return;
	}
	const bodyText = await readPiServerResponseText(response, PI_SERVER_ERROR_BODY_MAX_BYTES);
	throw new Error(`pi-server error: ${formatResponseDetails(response, bodyText)}; expected text/event-stream`);
}

async function ensureSessionInit(sessionId: string, context: Context, request: ChunkRequest): Promise<void> {
	const currentHash = hashStaticContext(context);
	const previousHash = sessionStaticContextHashes.get(sessionId);

	if (previousHash === currentHash) {
		return;
	}

	const staticContext = {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};

	const probeValue = await postPiServerJsonWithTransientRetry<unknown>(
		request,
		"/api/session/init",
		{ sessionId, staticContextHash: currentHash },
		"Session init failed",
	);
	const probe = parsePiServerSessionSummary(probeValue, sessionId, "Session init failed");
	if (!isObject(probeValue) || typeof probeValue.staticContextRequired !== "boolean") {
		throw new Error("Session init failed (protocol v2 response did not include staticContextRequired)");
	}

	let result: PiServerSessionSummary = probe;
	if (probeValue.staticContextRequired) {
		const updateValue = await postPiServerJsonWithTransientRetry<unknown>(
			request,
			"/api/session/update",
			{ sessionId, staticContext },
			"Session static context update failed",
		);
		result = parsePiServerSessionSummary(updateValue, sessionId, "Session static context update failed");
	}
	if (result.staticContextHash !== currentHash) {
		throw new Error("Session init failed (server staticContextHash did not match the requested context)");
	}

	sessionStaticContextHashes.set(sessionId, currentHash);
	recordPiServerSessionSummary(sessionId, result);
}

function markTreeSynced(sessionId: string, tree: PiServerTreeSnapshot): void {
	sessionTreeHashes.set(sessionId, hashLocalTree(sessionId, tree.entries));
	sessionTreeEntryCounts.set(sessionId, tree.entries.length);
	sessionTreeLeafIds.set(sessionId, tree.leafId);
	if (tree.replace) {
		sessionHasTemporaryTree.add(sessionId);
	} else {
		sessionHasTemporaryTree.delete(sessionId);
	}
}

async function postTreeJson(
	request: ChunkRequest,
	endpoint: string,
	body: unknown,
	errorPrefix: string,
): Promise<void> {
	if (!isObject(body) || typeof body.sessionId !== "string") {
		throw new Error(`${errorPrefix} (request sessionId was missing)`);
	}
	const value = await postPiServerJsonWithTransientRetry<unknown>(request, endpoint, body, errorPrefix);
	const summary = parsePiServerSessionSummary(value, body.sessionId, errorPrefix);
	recordPiServerSessionSummary(body.sessionId, summary);
}

function parsePiServerTreeEntries(value: unknown, errorPrefix: string): SessionTreeEntry[] {
	if (
		!Array.isArray(value) ||
		value.some(
			(entry) =>
				!isObject(entry) ||
				typeof entry.type !== "string" ||
				typeof entry.id !== "string" ||
				(entry.parentId !== null && typeof entry.parentId !== "string") ||
				typeof entry.timestamp !== "string",
		)
	) {
		throw new Error(`${errorPrefix} (response entries were not a valid session tree array)`);
	}
	return value as SessionTreeEntry[];
}

function buildPiServerActiveBranch(
	entries: SessionTreeEntry[],
	leafId: string | null,
	errorPrefix: string,
): SessionTreeEntry[] {
	const entriesById = new Map<string, SessionTreeEntry>();
	for (const entry of entries) {
		if (entriesById.has(entry.id)) {
			throw new Error(`${errorPrefix} (response session tree contained duplicate entry ids)`);
		}
		entriesById.set(entry.id, entry);
	}
	const branch: SessionTreeEntry[] = [];
	const branchIds = new Set<string>();
	let current = leafId === null ? undefined : entriesById.get(leafId);
	if (leafId !== null && !current) {
		throw new Error(`${errorPrefix} (response leafId did not exist in the session tree)`);
	}
	while (current) {
		if (branchIds.has(current.id)) {
			throw new Error(`${errorPrefix} (response session tree contained a parent cycle)`);
		}
		branchIds.add(current.id);
		branch.push(current);
		if (current.parentId === null) break;
		const parent = entriesById.get(current.parentId);
		if (!parent) {
			throw new Error(`${errorPrefix} (response session tree contained a missing parent)`);
		}
		current = parent;
	}
	branch.reverse();
	return branch;
}

function buildPiServerHistorySnapshot(
	summary: PiServerSessionSummary,
	entries: SessionTreeEntry[],
	errorPrefix: string,
): PiServerHistorySnapshot {
	if (entries.length !== summary.entryCount) {
		throw new Error(`${errorPrefix} (response entryCount did not match the session tree)`);
	}
	if (hashEntries(entries) !== summary.treeHash) {
		throw new Error(`${errorPrefix} (response treeHash did not match the session tree)`);
	}

	const branch = buildPiServerActiveBranch(entries, summary.leafId, errorPrefix);
	const messages = convertToLlm(buildSessionContext(branch).messages);
	if (messages.length !== summary.messageCount) {
		throw new Error(`${errorPrefix} (response messageCount did not match the active session branch)`);
	}
	return {
		entries,
		leafId: summary.leafId,
		messages,
		treeHash: summary.treeHash,
		revision: summary.revision,
	};
}

async function fetchPiServerHistory(
	sessionId: string,
	request: ChunkRequest,
	localTree?: PiServerTreeSnapshot,
): Promise<PiServerHistorySnapshot | undefined> {
	const query = new URLSearchParams({ protocolVersion: String(PI_SERVER_PROTOCOL_VERSION) });
	if (localTree) {
		query.set("entriesFrom", String(localTree.entries.length));
		query.set("baseTreeHash", hashLocalTree(sessionId, localTree.entries));
		const revision = sessionTreeRevisions.get(sessionId);
		if (revision !== undefined) query.set("revision", String(revision));
	}
	const historyUrl = `/api/session/${encodeURIComponent(sessionId)}/history?${query.toString()}`;
	const response = await request.getJson(historyUrl);
	if (response.status === 404) {
		const failure = await readPiServerFailure(response);
		if (/session not found/i.test(failure.matchText)) return undefined;
		throw new Error(
			`Session history reconciliation failed (pi-server protocol v${PI_SERVER_PROTOCOL_VERSION} history endpoint unavailable; ${failure.details})`,
		);
	}
	const historyValue = await readPiServerJson<unknown>(response, "Session history reconciliation failed");
	const summary = parsePiServerSessionSummary(historyValue, sessionId, "Session history reconciliation failed");
	const expectedStaticContextHash = sessionStaticContextHashes.get(sessionId);
	if (expectedStaticContextHash !== undefined && summary.staticContextHash !== expectedStaticContextHash) {
		throw new Error("Session history reconciliation failed (server staticContextHash changed unexpectedly)");
	}
	const history = historyValue as PiServerHistoryResponse;
	if (history.treePatch !== undefined) {
		if (!localTree || !isObject(history.treePatch)) {
			throw new Error("Session history reconciliation failed (unexpected tree patch response)");
		}
		const patch = history.treePatch as unknown as Record<string, unknown>;
		const expectedBaseRevision = sessionTreeRevisions.get(sessionId);
		if (
			!isNonNegativeInteger(patch.entriesFrom) ||
			patch.entriesFrom !== localTree.entries.length ||
			!isNonNegativeInteger(patch.revision) ||
			patch.revision !== summary.revision ||
			(patch.baseRevision !== undefined && !isNonNegativeInteger(patch.baseRevision)) ||
			(expectedBaseRevision !== undefined && patch.baseRevision !== expectedBaseRevision) ||
			(patch.leafId !== null && typeof patch.leafId !== "string") ||
			patch.leafId !== summary.leafId
		) {
			throw new Error("Session history reconciliation failed (response tree patch metadata was invalid)");
		}
		const patchEntries = parsePiServerTreeEntries(patch.entries, "Session history reconciliation failed");
		return buildPiServerHistorySnapshot(
			summary,
			[...localTree.entries.slice(0, patch.entriesFrom), ...patchEntries],
			"Session history reconciliation failed",
		);
	}
	return buildPiServerHistorySnapshot(
		summary,
		parsePiServerTreeEntries(history.entries, "Session history reconciliation failed"),
		"Session history reconciliation failed",
	);
}

async function applyPiServerHistory(
	sessionId: string,
	snapshot: PiServerHistorySnapshot,
	onHistoryReconciled: ((snapshot: PiServerHistorySnapshot) => void | Promise<void>) | undefined,
): Promise<void> {
	markTreeSynced(sessionId, snapshot);
	sessionTreeRevisions.set(sessionId, snapshot.revision);
	await onHistoryReconciled?.(snapshot);
}

async function fetchPiServerRun(
	sessionId: string,
	runId: string,
	request: ChunkRequest,
): Promise<PiServerRunResponse | undefined> {
	const response = await request.getJson(
		`/api/session/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
	);
	if (response.status === 404) {
		const contentType = getResponseContentType(response).toLowerCase();
		const failure = await readPiServerFailure(response);
		if (contentType.includes("application/json") && /stream run not found|run not found/i.test(failure.matchText)) {
			return undefined;
		}
		throw new Error(`Session run recovery failed (${failure.details}; expected structured run-not-found response)`);
	}
	const value = await readPiServerJson<unknown>(response, "Session run recovery failed");
	if (!isObject(value)) {
		throw new Error("Session run recovery failed (response was not an object)");
	}
	if (value.sessionId !== sessionId) {
		throw new Error("Session run recovery failed (response sessionId did not match the requested session)");
	}
	if (value.runId !== runId) {
		throw new Error("Session run recovery failed (response runId did not match the requested run)");
	}
	if (typeof value.requestMac !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestMac)) {
		throw new Error("Session run recovery failed (response requestMac was not a lowercase SHA-256 digest)");
	}
	if (value.status !== "running" && value.status !== "completed" && value.status !== "failed") {
		throw new Error("Session run recovery failed (response included an unsupported run status)");
	}
	if (!isNonNegativeInteger(value.nextSeq)) {
		throw new Error("Session run recovery failed (response nextSeq was not a non-negative integer)");
	}
	if (value.message !== undefined && !isObject(value.message)) {
		throw new Error("Session run recovery failed (response message was not an object)");
	}
	if (value.errorMessage !== undefined && typeof value.errorMessage !== "string") {
		throw new Error("Session run recovery failed (response errorMessage was not a string)");
	}
	if (value.acknowledgedAt !== undefined && !isNonNegativeInteger(value.acknowledgedAt)) {
		throw new Error("Session run recovery failed (response acknowledgedAt was not a non-negative integer)");
	}
	return value as unknown as PiServerRunResponse;
}

async function cancelPiServerRun(sessionId: string, runId: string): Promise<void> {
	const request = createPiServerRequest(AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS));
	const response = await request.postJson("/api/session/run/cancel", { sessionId, runId });
	await readPiServerJson<unknown>(response, "Session run cancel failed");
}

export async function acknowledgePiServerRunMessage(
	sessionId: string,
	message: AssistantMessage,
	runStatePath?: string,
	signal?: AbortSignal,
): Promise<void> {
	const activeLease = runStatePath ? getPersistentRunLease(sessionId, runStatePath) : undefined;
	let lease = activeLease?.lease;
	let releaseLeaseAfterAcknowledgement = activeLease?.scope === "run";
	try {
		const diagnostic = getPiServerRunDiagnostic(message);
		if (!diagnostic) return;
		if (runStatePath && !lease) {
			lease = acquirePersistentRunLease(sessionId, runStatePath);
			releaseLeaseAfterAcknowledgement = true;
		}
		const pending = runStatePath ? readPiServerPendingRun(runStatePath, lease) : sessionPendingRuns.get(sessionId);
		if (!pending) return;
		if (
			diagnostic.sessionId !== sessionId ||
			diagnostic.sessionId !== pending.sessionId ||
			diagnostic.runId !== pending.runId ||
			diagnostic.requestMac !== pending.requestHash
		) {
			throw new Error("Cannot acknowledge pi-server run: terminal diagnostic did not match durable pending state");
		}
		const ackSignal = signal?.aborted ? AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS) : signal;
		const request = createPiServerRequest(ackSignal);
		const response = await request.postJson("/api/session/run/ack", { sessionId, runId: pending.runId });
		if (response.status === 404) {
			const failure = await readPiServerFailure(response);
			if (!/stream run not found|run not found/i.test(failure.matchText)) {
				throw new Error(`Session run acknowledgement failed (${failure.details})`);
			}
			// The caller only reaches this point after the matching terminal assistant and tree
			// are fsynced locally. A server-side acknowledged journal may already have expired.
			if (runStatePath) {
				acknowledgePiServerPendingRun(runStatePath, pending.runId, Date.now(), lease);
			} else {
				sessionPendingRuns.delete(sessionId);
			}
			return;
		}
		const value = await readPiServerJson<unknown>(response, "Session run acknowledgement failed");
		if (
			!isObject(value) ||
			value.acknowledged !== true ||
			value.sessionId !== sessionId ||
			value.runId !== pending.runId ||
			value.requestMac !== pending.requestHash ||
			(value.status !== "completed" && value.status !== "failed") ||
			!isNonNegativeInteger(value.acknowledgedAt)
		) {
			throw new Error("Session run acknowledgement failed (response did not match the terminal pending run)");
		}
		if (runStatePath) {
			acknowledgePiServerPendingRun(runStatePath, pending.runId, Date.now(), lease);
		} else {
			sessionPendingRuns.delete(sessionId);
		}
	} finally {
		if (runStatePath && lease && releaseLeaseAfterAcknowledgement) {
			releasePiServerRunLease(sessionId, runStatePath);
		}
	}
}

async function cancelPiServerCompact(
	sessionId: string,
	operationId: string,
	requestHash: string,
): Promise<PiServerCompactTerminalPayload> {
	const request = createPiServerRequest(AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS));
	const response = await request.postJson("/api/session/compact/cancel", { sessionId, operationId, requestHash });
	const value = await readPiServerJson<unknown>(response, "Session compaction cancel failed");
	if (
		!isObject(value) ||
		(value.canceled !== true && value.canceled !== false) ||
		value.sessionId !== sessionId ||
		value.operationId !== operationId ||
		value.requestHash !== requestHash ||
		value.status !== "failed" ||
		value.resultStatus !== 499
	) {
		throw new PiServerCompactProtocolError("Session compaction cancel failed (response identity was invalid)");
	}
	return parsePiServerCompactTerminalPayload(
		value.terminal,
		sessionId,
		operationId,
		requestHash,
		"Session compaction cancel failed",
	);
}

async function recoverPiServerRun(
	sessionId: string,
	runId: string,
	request: ChunkRequest,
	signal: AbortSignal | undefined,
): Promise<PiServerRunRecoveryResult> {
	try {
		const run = await fetchPiServerRun(sessionId, runId, request);
		return run ? { status: run.status, requestMac: run.requestMac } : { status: "not_found" };
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		if (!isRetryablePiServerInterruption(error)) {
			throw error;
		}
		return {
			status: "unavailable",
			details: `recovery request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function getKnownServerPrefixCount(sessionId: string, entries: SessionTreeEntry[]): number | undefined {
	const entryCount = sessionTreeEntryCounts.get(sessionId);
	const treeHash = sessionTreeHashes.get(sessionId);
	if (entryCount === undefined || treeHash === undefined || entryCount > entries.length) {
		return undefined;
	}
	if (hashLocalTreePrefix(sessionId, entries, entryCount) !== treeHash) {
		return undefined;
	}
	return entryCount;
}

function isRecoverableTreeDivergenceError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /parent entry .* does not exist|leafId .* does not exist|entry .* already exists/i.test(message);
}

function isRecoverableMissingServerState(response: Response, errorBody: string): boolean {
	if (response.status !== 400 && response.status !== 404) return false;
	return /Session has no static context|session not found|parent entry .* does not exist|leafId .* does not exist|entry .* already exists/i.test(
		errorBody,
	);
}

async function syncFullPiServerTree(
	sessionId: string,
	tree: PiServerTreeSnapshot,
	request: ChunkRequest,
): Promise<void> {
	await postTreeJson(
		request,
		"/api/session/tree/sync",
		{
			sessionId,
			entries: tree.entries,
			leafId: tree.leafId,
		},
		"Session tree sync failed",
	);
	markTreeSynced(sessionId, tree);
}

function shouldUseServerHistory(sessionId: string, tree: PiServerTreeSnapshot): boolean {
	return !tree.replace && !sessionHasTemporaryTree.has(sessionId) && (sessionTreeEntryCounts.get(sessionId) ?? 0) > 0;
}

async function recoverPiServerTreeDivergence(
	sessionId: string,
	tree: PiServerTreeSnapshot,
	request: ChunkRequest,
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>,
): Promise<void> {
	if (shouldUseServerHistory(sessionId, tree)) {
		const snapshot = await fetchPiServerHistory(sessionId, request, tree);
		if (snapshot && snapshot.entries.length > 0) {
			await applyPiServerHistory(sessionId, snapshot, onHistoryReconciled);
			throw new Error(
				"pi-server history differed from local history; local session was reconciled to server history",
			);
		}
	}

	await syncFullPiServerTree(sessionId, tree, request);
}

export async function syncPiServerTree(
	sessionId: string,
	context: Context,
	tree: PiServerTreeSnapshot,
	options?: PiServerSyncOptions,
): Promise<void> {
	const request = createPiServerRequest(options?.signal);
	await ensureSessionInit(sessionId, context, request);
	await syncPiServerTreeWithRequest(sessionId, tree, request, options?.onHistoryReconciled);
}

async function syncPiServerTreeWithRequest(
	sessionId: string,
	tree: PiServerTreeSnapshot,
	request: ChunkRequest,
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>,
): Promise<void> {
	const syncTree = tree;
	const knownServerPrefixCount =
		!tree.replace && !sessionHasTemporaryTree.has(sessionId)
			? getKnownServerPrefixCount(sessionId, syncTree.entries)
			: undefined;
	const currentHash = hashLocalTree(sessionId, syncTree.entries);
	const previousHash = sessionTreeHashes.get(sessionId);
	const previousLeafId = sessionTreeLeafIds.get(sessionId);

	if (!tree.replace && previousHash === currentHash) {
		if (previousLeafId !== syncTree.leafId) {
			try {
				await postTreeJson(
					request,
					"/api/session/tree/switch",
					{ sessionId, leafId: syncTree.leafId },
					"Session tree switch failed",
				);
			} catch (error) {
				if (!isRecoverableTreeDivergenceError(error)) {
					throw error;
				}
				await recoverPiServerTreeDivergence(sessionId, syncTree, request, onHistoryReconciled);
				return;
			}
			sessionTreeLeafIds.set(sessionId, syncTree.leafId);
		}
		markTreeSynced(sessionId, syncTree);
		return;
	}

	if (knownServerPrefixCount !== undefined) {
		const deltaEntries = syncTree.entries.slice(knownServerPrefixCount);
		if (deltaEntries.length > 0) {
			try {
				await postTreeJson(
					request,
					"/api/session/tree/append",
					{
						sessionId,
						entries: deltaEntries,
						leafId: syncTree.leafId,
					},
					"Session tree append failed",
				);
			} catch (error) {
				if (!isRecoverableTreeDivergenceError(error)) {
					throw error;
				}
				await recoverPiServerTreeDivergence(sessionId, syncTree, request, onHistoryReconciled);
				return;
			}
			markTreeSynced(sessionId, syncTree);
			return;
		}
	}

	await recoverPiServerTreeDivergence(sessionId, syncTree, request, onHistoryReconciled);
}

type SerializableSimpleStreamOptions = {
	[Key in Exclude<keyof SimpleStreamOptions, "signal" | "onPayload" | "onResponse">]-?: SimpleStreamOptions[Key];
};

function serializeOptions(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		reasoning: options?.reasoning,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		apiKey: options?.apiKey,
		headers: options?.headers,
		metadata: options?.metadata,
		transport: options?.transport,
		thinkingBudgets: options?.thinkingBudgets,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		env: options?.env,
	} satisfies SerializableSimpleStreamOptions;
}

interface PiServerCompactRequestBody {
	protocolVersion: number;
	sessionId: string;
	operationId: string;
	model: Model<any>;
	options: SimpleStreamOptions;
	settings?: unknown;
	preparation?: CompactionPreparationOptions;
	extensionCompaction?: CompactResult;
	customInstructions?: string;
	retry?: RetryPolicy;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
	streamResponse: boolean;
}

export function hashPiServerCompactRequest(body: PiServerCompactRequestBody): string {
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
		throw new Error("Failed to serialize pi-server compaction request identity");
	}
	return createHash("sha256").update(serialized).digest("hex");
}

export interface PiServerCompactOptions extends SimpleStreamOptions {
	customInstructions?: string;
	settings?: unknown;
	preparation?: CompactionPreparationOptions;
	extensionCompaction?: CompactResult;
	retry?: RetryPolicy;
	sessionTree?: PiServerTreeSnapshot;
	piServerRecoveryWindowMs?: number;
	piServerCompactStatePath?: string;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

function createPiServerCompactAbortError(cancelFailure?: unknown): Error {
	const cancelDetails =
		cancelFailure === undefined
			? ""
			: ` (cancel request failed: ${cancelFailure instanceof Error ? cancelFailure.message : String(cancelFailure)})`;
	const error = new Error(`Compaction cancelled${cancelDetails}`);
	error.name = "AbortError";
	return error;
}

function getPiServerCompactReconnectDelay(attempt: number): number {
	if (attempt === 0) return 0;
	return Math.min(1000 * 2 ** Math.min(attempt - 1, 5), PI_SERVER_COMPACT_MAX_RECONNECT_DELAY_MS);
}

function getPiServerCompactRecoveryWindowMs(configuredWindowMs: number | undefined): number {
	const environmentValue = process.env.PI_SERVER_COMPACT_RECOVERY_WINDOW_MS;
	const value =
		configuredWindowMs ??
		(environmentValue === undefined ? PI_SERVER_COMPACT_DEFAULT_RECOVERY_WINDOW_MS : Number(environmentValue));
	if ((!Number.isFinite(value) && value !== Number.POSITIVE_INFINITY) || value <= 0) {
		throw new Error(
			"pi-server compact recovery window must be positive milliseconds or Infinity (PiServerCompactOptions.piServerRecoveryWindowMs or PI_SERVER_COMPACT_RECOVERY_WINDOW_MS)",
		);
	}
	return value;
}

async function waitForPiServerCompactReconnect(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		throw createPiServerCompactAbortError();
	}
	if (delayMs === 0) return;

	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(createPiServerCompactAbortError());
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function getPiServerStreamReconnectDelay(attempt: number): number {
	if (attempt === 0) return 0;
	return Math.min(1000 * 2 ** Math.min(attempt - 1, 5), PI_SERVER_STREAM_MAX_RECONNECT_DELAY_MS);
}

function getPiServerStreamRecoveryWindowMs(configuredWindowMs: number | undefined): number {
	const environmentValue = process.env.PI_SERVER_STREAM_RECOVERY_WINDOW_MS;
	const value =
		configuredWindowMs ??
		(environmentValue === undefined ? PI_SERVER_STREAM_DEFAULT_RECOVERY_WINDOW_MS : Number(environmentValue));
	if ((!Number.isFinite(value) && value !== Number.POSITIVE_INFINITY) || value <= 0) {
		throw new Error(
			"pi-server stream recovery window must be positive milliseconds or Infinity (PiServerStreamOptions.piServerRecoveryWindowMs or PI_SERVER_STREAM_RECOVERY_WINDOW_MS)",
		);
	}
	return value;
}

function createPiServerStreamAbortError(): Error {
	const error = new Error("Request aborted by user");
	error.name = "AbortError";
	return error;
}

async function waitForPiServerStreamReconnect(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		throw createPiServerStreamAbortError();
	}
	if (delayMs === 0) return;

	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(createPiServerStreamAbortError());
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function isRecoverablePiServerCompactResponse(response: Response): boolean {
	return response.status >= 500 || response.status === 408 || response.status === 425 || response.status === 429;
}

interface PiServerCompactTerminalPayload {
	protocolVersion: typeof PI_SERVER_PROTOCOL_VERSION;
	sessionId: string;
	operationId: string;
	requestHash: string;
	status: "failed" | "rejected";
	httpStatus: number;
	operationDisposition: "terminal" | "not_started";
	error: string;
}

function parsePiServerCompactTerminalPayload(
	value: unknown,
	sessionId: string,
	operationId: string,
	requestHash: string,
	errorPrefix: string,
): PiServerCompactTerminalPayload {
	if (
		!isObject(value) ||
		value.protocolVersion !== PI_SERVER_PROTOCOL_VERSION ||
		value.sessionId !== sessionId ||
		value.operationId !== operationId ||
		value.requestHash !== requestHash ||
		(value.operationDisposition !== "terminal" && value.operationDisposition !== "not_started") ||
		(value.status !== "failed" && value.status !== "rejected") ||
		(value.operationDisposition === "terminal" && value.status !== "failed") ||
		(value.operationDisposition === "not_started" && value.status !== "rejected") ||
		!Number.isSafeInteger(value.httpStatus) ||
		(value.httpStatus as number) < 100 ||
		(value.httpStatus as number) > 599 ||
		typeof value.error !== "string" ||
		value.error.length === 0
	) {
		throw new PiServerCompactProtocolError(`${errorPrefix} (terminal operation identity was invalid)`);
	}
	return value as unknown as PiServerCompactTerminalPayload;
}

function normalizePiServerCompactionResult(
	result: unknown,
	sessionId: string,
	operationId: string,
	requestHash: string,
	tree: PiServerTreeSnapshot,
	base: {
		staticContextHash: string;
		treeHash: string;
		entryCount: number;
		leafId: string | null;
		revision: number;
	},
	compactStatePath?: string,
): PiServerCompactionResult {
	const errorPrefix = "Server compaction failed";
	const protocolError = (details: string): PiServerCompactProtocolError =>
		new PiServerCompactProtocolError(`${errorPrefix} (${details})`);
	if (!isObject(result)) {
		throw protocolError("protocol v2 response was not an object");
	}
	if (result.protocolVersion !== PI_SERVER_PROTOCOL_VERSION) {
		const received = result.protocolVersion === undefined ? "missing" : JSON.stringify(result.protocolVersion);
		throw protocolError(
			`unsupported pi-server protocol version: ${received}; expected ${PI_SERVER_PROTOCOL_VERSION}`,
		);
	}
	if (result.sessionId !== sessionId) {
		throw protocolError("response sessionId did not match the requested session");
	}
	if (result.operationId !== operationId) {
		throw protocolError("response operationId did not match the requested operation");
	}
	if (result.requestHash !== requestHash) {
		throw protocolError("response requestHash did not match the requested operation");
	}
	if (!isObject(result.treePatch)) {
		throw protocolError("protocol v2 response did not include a treePatch");
	}

	const patch = result.treePatch;
	if (patch.baseStaticContextHash !== base.staticContextHash) {
		throw protocolError("treePatch baseStaticContextHash did not match the submitted context");
	}
	if (patch.baseTreeHash !== base.treeHash) {
		throw protocolError("treePatch baseTreeHash did not match the submitted tree");
	}
	if (
		patch.baseEntryCount !== base.entryCount ||
		patch.entriesFrom !== base.entryCount ||
		base.entryCount !== tree.entries.length
	) {
		throw protocolError("treePatch entriesFrom did not match the submitted tree");
	}
	if (patch.baseLeafId !== base.leafId || tree.leafId !== base.leafId) {
		throw protocolError("treePatch baseLeafId did not match the submitted tree");
	}
	if (patch.baseRevision !== base.revision) {
		throw protocolError("treePatch baseRevision did not match the submitted revision");
	}
	if (!Array.isArray(patch.entries) || patch.entries.length !== 1) {
		throw protocolError("treePatch must contain exactly one compaction entry");
	}
	const rawEntry = patch.entries[0];
	if (
		!isObject(rawEntry) ||
		rawEntry.type !== "compaction" ||
		typeof rawEntry.id !== "string" ||
		rawEntry.id.length === 0 ||
		typeof rawEntry.timestamp !== "string" ||
		typeof rawEntry.summary !== "string" ||
		typeof rawEntry.firstKeptEntryId !== "string" ||
		rawEntry.firstKeptEntryId.length === 0 ||
		typeof rawEntry.tokensBefore !== "number" ||
		!Number.isFinite(rawEntry.tokensBefore) ||
		rawEntry.tokensBefore < 0 ||
		(rawEntry.retainedTail !== undefined && !Array.isArray(rawEntry.retainedTail)) ||
		(rawEntry.usage !== undefined && !isObject(rawEntry.usage)) ||
		(rawEntry.fromHook !== undefined && typeof rawEntry.fromHook !== "boolean") ||
		!isObject(rawEntry.piServerCompactOperation)
	) {
		throw protocolError("treePatch entry was not a valid compaction entry");
	}
	const operation = rawEntry.piServerCompactOperation;
	if (
		operation.version !== 1 ||
		operation.operationId !== operationId ||
		operation.requestHash !== requestHash ||
		operation.baseStaticContextHash !== base.staticContextHash ||
		operation.baseTreeHash !== base.treeHash ||
		operation.baseEntryCount !== base.entryCount ||
		operation.baseLeafId !== base.leafId ||
		operation.baseRevision !== base.revision
	) {
		throw protocolError("compaction entry durable operation metadata did not match the request");
	}
	if (rawEntry.parentId !== tree.leafId) {
		throw protocolError("compaction entry parentId did not match the submitted leaf");
	}
	if (tree.entries.some((entry) => entry.id === rawEntry.id)) {
		throw protocolError("compaction entry id already existed in the submitted tree");
	}
	if (patch.leafId !== rawEntry.id) {
		throw protocolError("treePatch leafId did not match the compaction entry");
	}
	if (!isNonNegativeInteger(patch.revision) || patch.revision !== base.revision + 1) {
		throw protocolError("treePatch revision did not advance the submitted revision exactly once");
	}
	const compactionEntry = rawEntry as unknown as CompactionEntry;
	const entries = [...tree.entries, compactionEntry];
	if (typeof patch.treeHash !== "string" || !/^[a-f0-9]{64}$/i.test(patch.treeHash)) {
		throw protocolError("treePatch treeHash was not a valid digest");
	}
	if (hashEntries(entries) !== patch.treeHash) {
		throw protocolError("treePatch treeHash did not match the updated tree");
	}
	const branch = buildPiServerActiveBranch(entries, compactionEntry.id, errorPrefix);
	const compaction: CompactResult = {
		summary: compactionEntry.summary,
		firstKeptEntryId: compactionEntry.firstKeptEntryId,
		tokensBefore: compactionEntry.tokensBefore,
		retainedTail: compactionEntry.retainedTail,
		details: compactionEntry.details,
		usage: compactionEntry.usage,
	};
	return {
		sessionId,
		compaction,
		compactionEntry,
		entries,
		leafId: compactionEntry.id,
		messages: convertToLlm(buildSessionContext(branch).messages),
		operationId,
		requestHash,
		revision: patch.revision,
		treeHash: patch.treeHash,
		compactStatePath,
	};
}

function parseCompactTerminalFailureBody(
	bodyText: string,
	sessionId: string,
	operationId: string,
	requestHash: string,
	errorPrefix: string,
): PiServerCompactTerminalPayload | undefined {
	let value: unknown;
	try {
		value = JSON.parse(bodyText) as unknown;
	} catch {
		return undefined;
	}
	if (!isObject(value) || value.operationDisposition === undefined) return undefined;
	return parsePiServerCompactTerminalPayload(value, sessionId, operationId, requestHash, errorPrefix);
}

async function acknowledgeObservedPiServerCompactTerminal(
	pending: PiServerPendingCompactState,
	compactStatePath: string,
	signal?: AbortSignal,
): Promise<void> {
	const observation = pending.observation;
	if (!observation || observation.kind !== "terminal") {
		throw new Error("Cannot acknowledge pi-server compaction failure without a durable terminal observation");
	}
	if (observation.operationDisposition === "not_started") {
		acknowledgePiServerPendingCompact(compactStatePath, pending.operationId, "server_rejected_not_started");
		return;
	}
	const ackSignal = signal?.aborted ? AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS) : signal;
	const request = createPiServerRequest(ackSignal);
	const response = await request.postJson("/api/session/compact/ack", {
		sessionId: pending.sessionId,
		operationId: pending.operationId,
		requestHash: pending.requestHash,
	});
	if (response.status === 404) {
		const contentType = getResponseContentType(response).toLowerCase();
		const failure = await readPiServerFailure(response);
		if (!contentType.includes("application/json") || !/compaction operation not found/i.test(failure.matchText)) {
			throw new Error(`Session compaction acknowledgement failed (${failure.details})`);
		}
		acknowledgePiServerPendingCompact(compactStatePath, pending.operationId, "server_missing_after_terminal_failure");
		return;
	}
	const value = await readPiServerJson<unknown>(response, "Session compaction acknowledgement failed");
	if (
		!isObject(value) ||
		value.acknowledged !== true ||
		value.sessionId !== pending.sessionId ||
		value.operationId !== pending.operationId ||
		value.requestHash !== pending.requestHash ||
		value.status !== "failed" ||
		!isNonNegativeInteger(value.acknowledgedAt)
	) {
		throw new Error("Session compaction acknowledgement failed (terminal response identity was invalid)");
	}
	acknowledgePiServerPendingCompact(compactStatePath, pending.operationId);
}

async function persistAndCompletePiServerCompactTerminal(
	payload: PiServerCompactTerminalPayload,
	compactStatePath: string | undefined,
	signal?: AbortSignal,
): Promise<never> {
	await persistAndAcknowledgePiServerCompactTerminal(payload, compactStatePath, signal);
	throw new PiServerCompactOperationError(`Server compaction failed (${payload.error})`, payload);
}

async function persistAndAcknowledgePiServerCompactTerminal(
	payload: PiServerCompactTerminalPayload,
	compactStatePath: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!compactStatePath) {
		throw new Error("Cannot complete pi-server compaction failure without a durable compact-state path");
	}
	writePiServerTerminalCompact(compactStatePath, {
		operationId: payload.operationId,
		requestHash: payload.requestHash,
		httpStatus: payload.httpStatus,
		error: payload.error,
		operationDisposition: payload.operationDisposition,
		status: payload.status,
	});
	const pending = readPiServerPendingCompact(compactStatePath);
	if (!pending) {
		throw new Error("Pi-server compact terminal observation disappeared before acknowledgement");
	}
	await acknowledgeObservedPiServerCompactTerminal(pending, compactStatePath, signal);
}

export async function compactPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerCompactOptions,
): Promise<PiServerCompactionResult> {
	const sessionId = options?.sessionId ?? "default";
	const signal = options?.signal;
	const recoveryWindowMs = getPiServerCompactRecoveryWindowMs(options?.piServerRecoveryWindowMs);
	const request = createPiServerRequest(options?.signal);
	const tree = options?.sessionTree ?? getLinearTreeFromMessages(context.messages as Message[]);
	const compactStatePath = options?.piServerCompactStatePath;
	if (!compactStatePath) {
		throw new Error("Durable pi-server compaction requires a compact-state path");
	}
	const recovered = await recoverPendingPiServerCompaction(sessionId, tree, compactStatePath, {
		signal,
		recoveryWindowMs,
	});
	if (recovered) return recovered;
	const operationId = randomUUID();
	let operationSubmissionStarted = false;
	let requestHash: string | undefined;
	let cancelPromise: Promise<PiServerCompactTerminalPayload> | undefined;
	const cancelOperation = (): Promise<PiServerCompactTerminalPayload | undefined> => {
		if (!operationSubmissionStarted || !requestHash) return Promise.resolve(undefined);
		cancelPromise ??= cancelPiServerCompact(sessionId, operationId, requestHash);
		void cancelPromise.catch(() => undefined);
		return cancelPromise;
	};
	const onAbort = () => {
		void cancelOperation();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await ensureSessionInit(sessionId, context, request);
		await syncPiServerTreeWithRequest(sessionId, tree, request, options?.onHistoryReconciled);
		const base = {
			staticContextHash: sessionStaticContextHashes.get(sessionId) ?? hashStaticContext(context),
			treeHash: sessionTreeHashes.get(sessionId) ?? hashEntries(tree.entries),
			entryCount: sessionTreeEntryCounts.get(sessionId) ?? tree.entries.length,
			leafId: sessionTreeLeafIds.get(sessionId) ?? tree.leafId,
			revision: sessionTreeRevisions.get(sessionId) ?? 0,
		};
		if (base.entryCount !== tree.entries.length || base.leafId !== tree.leafId) {
			throw new Error("Cannot begin pi-server compaction from an unverified local/server tree identity");
		}

		const body = Object.freeze(
			JSON.parse(
				JSON.stringify({
					protocolVersion: PI_SERVER_PROTOCOL_VERSION,
					sessionId,
					operationId,
					model,
					options: serializeOptions(options),
					settings: options?.settings,
					preparation: options?.preparation,
					extensionCompaction: options?.extensionCompaction,
					customInstructions: options?.customInstructions,
					retry: options?.retry,
					baseStaticContextHash: base.staticContextHash,
					baseTreeHash: base.treeHash,
					baseEntryCount: base.entryCount,
					baseLeafId: base.leafId,
					baseRevision: base.revision,
					streamResponse: true,
				}),
			) as PiServerCompactRequestBody,
		);
		const compactRequestHash = hashPiServerCompactRequest(body);
		requestHash = compactRequestHash;
		writePiServerPendingCompact(compactStatePath, {
			serverHash: hashPiServerIdentity(getServerUrl()),
			sessionId,
			operationId,
			requestHash: compactRequestHash,
			baseStaticContextHash: base.staticContextHash,
			baseTreeHash: base.treeHash,
			baseEntryCount: base.entryCount,
			baseLeafId: base.leafId,
			baseRevision: base.revision,
		});
		let recoveryDeadline: number | undefined;
		let reconnectAttempt = 0;
		let lastInterruption: unknown;

		for (;;) {
			if (signal?.aborted) {
				throw createPiServerCompactAbortError();
			}

			if (recoveryDeadline !== undefined) {
				const remainingMs = recoveryDeadline - Date.now();
				if (remainingMs <= 0) {
					const details = lastInterruption instanceof Error ? lastInterruption.message : String(lastInterruption);
					throw new Error(`Server compaction recovery exhausted for operation ${operationId}: ${details}`);
				}
				const delayMs = Math.min(getPiServerCompactReconnectDelay(reconnectAttempt), remainingMs);
				reconnectAttempt++;
				await waitForPiServerCompactReconnect(delayMs, signal);
				if (Date.now() >= recoveryDeadline) {
					const details = lastInterruption instanceof Error ? lastInterruption.message : String(lastInterruption);
					throw new Error(`Server compaction recovery exhausted for operation ${operationId}: ${details}`);
				}
			}

			let response: Response;
			try {
				operationSubmissionStarted = true;
				response = await request.postJson("/api/session/compact", body);
			} catch (error) {
				if (isAbortError(error, signal)) {
					throw error;
				}
				if (!isRetryablePiServerInterruption(error)) {
					throw error;
				}
				lastInterruption = error;
				recoveryDeadline ??= Date.now() + recoveryWindowMs;
				continue;
			}

			if (!response.ok) {
				let failure: PiServerResponseFailure;
				try {
					failure = await readPiServerFailure(response);
				} catch (error) {
					if (isAbortError(error, signal)) {
						throw error;
					}
					if (!isRecoverablePiServerCompactResponse(response) || !isRetryablePiServerInterruption(error)) {
						throw error;
					}
					lastInterruption = error;
					recoveryDeadline ??= Date.now() + recoveryWindowMs;
					continue;
				}
				const terminal = parseCompactTerminalFailureBody(
					failure.bodyText,
					sessionId,
					operationId,
					compactRequestHash,
					"Server compaction failed",
				);
				if (terminal) {
					if (terminal.httpStatus !== response.status) {
						throw new PiServerCompactProtocolError(
							"Server compaction failed (terminal HTTP status did not match the response)",
						);
					}
					return await persistAndCompletePiServerCompactTerminal(terminal, compactStatePath, signal);
				}
				if (isRecoverablePiServerCompactResponse(response)) {
					lastInterruption = new Error(`Server compaction failed (${failure.details})`);
					recoveryDeadline ??= Date.now() + recoveryWindowMs;
					continue;
				}
				throw new Error(`Server compaction failed (${failure.details})`);
			}

			try {
				const responseResult = await readPiServerCompactResponse<unknown>(response, "Server compaction failed");
				const result = normalizePiServerCompactionResult(
					responseResult,
					sessionId,
					operationId,
					compactRequestHash,
					tree,
					base,
					compactStatePath,
				);
				if (signal?.aborted) {
					throw createPiServerCompactAbortError();
				}
				markTreeSynced(sessionId, { entries: result.entries, leafId: result.leafId });
				sessionTreeRevisions.set(sessionId, result.revision);
				return result;
			} catch (error) {
				if (error instanceof PiServerCompactOperationError) {
					const terminal = parsePiServerCompactTerminalPayload(
						error.payload,
						sessionId,
						operationId,
						compactRequestHash,
						"Server compaction failed",
					);
					return await persistAndCompletePiServerCompactTerminal(terminal, compactStatePath, signal);
				}
				if (error instanceof PiServerCompactProtocolError) {
					throw error;
				}
				if (isAbortError(error, signal)) {
					throw error;
				}
				if (!isRetryablePiServerInterruption(error)) {
					throw error;
				}
				lastInterruption = error;
				if (error instanceof PiServerCompactInterruptionError && error.observedProgress) {
					recoveryDeadline = Date.now() + recoveryWindowMs;
					reconnectAttempt = 0;
				} else {
					recoveryDeadline ??= Date.now() + recoveryWindowMs;
				}
			}
		}
	} catch (error) {
		if (isAbortError(error, signal)) {
			let cancelFailure: unknown;
			try {
				if (!operationSubmissionStarted && requestHash) {
					await persistAndAcknowledgePiServerCompactTerminal(
						{
							protocolVersion: PI_SERVER_PROTOCOL_VERSION,
							sessionId,
							operationId,
							requestHash,
							status: "rejected",
							httpStatus: 499,
							operationDisposition: "not_started",
							error: "Compaction cancelled before server submission",
						},
						compactStatePath,
					);
				} else {
					const terminal = await cancelOperation();
					if (terminal) {
						await persistAndAcknowledgePiServerCompactTerminal(
							terminal,
							compactStatePath,
							AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS),
						);
					}
				}
			} catch (cancelError) {
				cancelFailure = cancelError;
			}
			throw createPiServerCompactAbortError(cancelFailure);
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function assertPendingPiServerCompactMatches(
	pending: PiServerPendingCompactState,
	sessionId: string,
	tree: PiServerTreeSnapshot,
): PiServerTreeSnapshot {
	if (
		pending.serverHash !== hashPiServerIdentity(getServerUrl()) ||
		pending.sessionId !== sessionId ||
		pending.baseEntryCount > tree.entries.length
	) {
		throw new Error(
			`Cannot safely resume pending pi-server compaction ${pending.operationId}: server, session, or tree identity changed`,
		);
	}
	const baseEntries = tree.entries.slice(0, pending.baseEntryCount);
	if (
		hashEntries(baseEntries) !== pending.baseTreeHash ||
		(pending.baseLeafId !== null && !baseEntries.some((entry) => entry.id === pending.baseLeafId))
	) {
		throw new Error(
			`Cannot safely resume pending pi-server compaction ${pending.operationId}: local base tree no longer matches its durable marker`,
		);
	}
	if (!pending.observation || pending.observation.kind === "terminal") {
		if (tree.entries.length !== pending.baseEntryCount || tree.leafId !== pending.baseLeafId) {
			throw new Error(
				`Cannot safely resume pending pi-server compaction ${pending.operationId}: local tree changed before a committed compaction was observed`,
			);
		}
	}
	return { entries: baseEntries, leafId: pending.baseLeafId };
}

function recoverLocallyAppliedPiServerCompaction(
	pending: PiServerPendingCompactState,
	tree: PiServerTreeSnapshot,
	baseTree: PiServerTreeSnapshot,
	compactStatePath: string,
): PiServerCompactionResult {
	const applied = pending.observation;
	if (!applied || applied.kind !== "applied") {
		throw new Error("Pending pi-server compaction does not contain a durable local apply observation");
	}
	const entry = tree.entries[pending.baseEntryCount];
	if (
		tree.entries.length !== pending.baseEntryCount + 1 ||
		!entry ||
		entry.id !== applied.entryId ||
		hashPiServerTreeEntry(entry) !== applied.entryHash ||
		tree.leafId !== applied.updatedLeafId ||
		applied.updatedLeafId !== applied.entryId ||
		hashEntries(tree.entries) !== applied.updatedTreeHash ||
		applied.updatedRevision !== pending.baseRevision + 1
	) {
		throw new Error(
			`Cannot safely resume pending pi-server compaction ${pending.operationId}: local applied tree does not match its durable observation`,
		);
	}
	return normalizePiServerCompactionResult(
		{
			protocolVersion: PI_SERVER_PROTOCOL_VERSION,
			sessionId: pending.sessionId,
			operationId: pending.operationId,
			requestHash: pending.requestHash,
			treePatch: {
				baseStaticContextHash: pending.baseStaticContextHash,
				baseTreeHash: pending.baseTreeHash,
				baseEntryCount: pending.baseEntryCount,
				baseLeafId: pending.baseLeafId,
				baseRevision: pending.baseRevision,
				entriesFrom: pending.baseEntryCount,
				entries: [entry],
				leafId: applied.updatedLeafId,
				revision: applied.updatedRevision,
				treeHash: applied.updatedTreeHash,
			},
		},
		pending.sessionId,
		pending.operationId,
		pending.requestHash,
		baseTree,
		{
			staticContextHash: pending.baseStaticContextHash,
			treeHash: pending.baseTreeHash,
			entryCount: pending.baseEntryCount,
			leafId: pending.baseLeafId,
			revision: pending.baseRevision,
		},
		compactStatePath,
	);
}

export async function recoverPendingPiServerCompaction(
	sessionId: string,
	tree: PiServerTreeSnapshot,
	compactStatePath: string,
	options?: { signal?: AbortSignal; recoveryWindowMs?: number },
): Promise<PiServerCompactionResult | undefined> {
	const pending = readPiServerPendingCompact(compactStatePath);
	if (!pending) return undefined;
	const baseTree = assertPendingPiServerCompactMatches(pending, sessionId, tree);
	const locallyApplied =
		pending.observation?.kind === "applied"
			? recoverLocallyAppliedPiServerCompaction(pending, tree, baseTree, compactStatePath)
			: undefined;
	if (pending.observation?.kind === "terminal" && pending.observation.operationDisposition === "not_started") {
		return await persistAndCompletePiServerCompactTerminal(
			{
				protocolVersion: PI_SERVER_PROTOCOL_VERSION,
				sessionId: pending.sessionId,
				operationId: pending.operationId,
				requestHash: pending.requestHash,
				status: pending.observation.status,
				httpStatus: pending.observation.httpStatus,
				operationDisposition: pending.observation.operationDisposition,
				error: pending.observation.error,
			},
			compactStatePath,
			options?.signal,
		);
	}
	const recoveryWindowMs = getPiServerCompactRecoveryWindowMs(options?.recoveryWindowMs);
	const request = createPiServerRequest(options?.signal);
	let recoveryDeadline: number | undefined;
	let reconnectAttempt = 0;
	let lastInterruption: unknown = new Error("pending compaction has not reached a terminal response");
	for (;;) {
		if (options?.signal?.aborted) {
			let cancelFailure: unknown;
			try {
				const terminal = await cancelPiServerCompact(sessionId, pending.operationId, pending.requestHash);
				await persistAndAcknowledgePiServerCompactTerminal(
					terminal,
					compactStatePath,
					AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS),
				);
			} catch (error) {
				cancelFailure = error;
			}
			throw createPiServerCompactAbortError(cancelFailure);
		}
		if (recoveryDeadline !== undefined) {
			const remainingMs = recoveryDeadline - Date.now();
			if (remainingMs <= 0) {
				throw new Error(
					`Pending server compaction recovery exhausted for operation ${pending.operationId}: ${
						lastInterruption instanceof Error ? lastInterruption.message : String(lastInterruption)
					}`,
				);
			}
			await waitForPiServerCompactReconnect(
				Math.min(getPiServerCompactReconnectDelay(reconnectAttempt), remainingMs),
				options?.signal,
			);
			reconnectAttempt++;
		}
		let response: Response;
		try {
			response = await request.getJson(
				`/api/session/${encodeURIComponent(sessionId)}/compactions/${encodeURIComponent(
					pending.operationId,
				)}?requestHash=${encodeURIComponent(pending.requestHash)}`,
			);
		} catch (error) {
			if (!isRetryablePiServerInterruption(error)) throw error;
			lastInterruption = error;
			recoveryDeadline ??= Date.now() + recoveryWindowMs;
			continue;
		}
		if (!response.ok) {
			const failure = await readPiServerFailure(response);
			if (response.status === 404) {
				if (locallyApplied) return locallyApplied;
				if (pending.observation?.kind === "terminal") {
					await acknowledgeObservedPiServerCompactTerminal(pending, compactStatePath, options?.signal);
					throw new PiServerCompactOperationError(
						`Pending server compaction failed (${pending.observation.error})`,
						pending.observation,
					);
				}
				throw new Error(
					`Pending pi-server compaction ${pending.operationId} is missing from the durable server journal; ` +
						"the local marker was retained and automatic provider resubmission is disabled",
				);
			}
			if (!isRecoverablePiServerCompactResponse(response)) {
				throw new Error(`Pending server compaction recovery failed (${failure.details})`);
			}
			lastInterruption = new Error(`Pending server compaction recovery failed (${failure.details})`);
			recoveryDeadline ??= Date.now() + recoveryWindowMs;
			continue;
		}
		try {
			const responseResult = await readPiServerCompactResponse<unknown>(
				response,
				"Pending server compaction recovery failed",
			);
			const result = normalizePiServerCompactionResult(
				responseResult,
				sessionId,
				pending.operationId,
				pending.requestHash,
				baseTree,
				{
					staticContextHash: pending.baseStaticContextHash,
					treeHash: pending.baseTreeHash,
					entryCount: pending.baseEntryCount,
					leafId: pending.baseLeafId,
					revision: pending.baseRevision,
				},
				compactStatePath,
			);
			if (
				locallyApplied &&
				(canonicalJsonStringify(result.compactionEntry) !==
					canonicalJsonStringify(locallyApplied.compactionEntry) ||
					result.treeHash !== locallyApplied.treeHash ||
					result.revision !== locallyApplied.revision)
			) {
				throw new PiServerCompactProtocolError(
					"Pending server compaction recovery returned a result that differed from the durably applied tree",
				);
			}
			markTreeSynced(sessionId, { entries: result.entries, leafId: result.leafId });
			sessionTreeRevisions.set(sessionId, result.revision);
			return result;
		} catch (error) {
			if (error instanceof PiServerCompactOperationError) {
				const terminal = parsePiServerCompactTerminalPayload(
					error.payload,
					sessionId,
					pending.operationId,
					pending.requestHash,
					"Pending server compaction recovery failed",
				);
				return await persistAndCompletePiServerCompactTerminal(terminal, compactStatePath, options?.signal);
			}
			if (error instanceof PiServerCompactProtocolError) {
				throw error;
			}
			if (!isRetryablePiServerInterruption(error)) throw error;
			lastInterruption = error;
			if (error instanceof PiServerCompactInterruptionError && error.observedProgress) {
				recoveryDeadline = Date.now() + recoveryWindowMs;
				reconnectAttempt = 0;
			} else {
				recoveryDeadline ??= Date.now() + recoveryWindowMs;
			}
		}
	}
}

export function recordPiServerCompactionApplied(result: PiServerCompactionResult): void {
	const compactStatePath = result.compactStatePath;
	if (!compactStatePath) {
		throw new Error("Cannot record pi-server compaction apply without a durable compact-state path");
	}
	const pending = readPiServerPendingCompact(compactStatePath);
	if (
		!pending ||
		pending.sessionId !== result.sessionId ||
		pending.operationId !== result.operationId ||
		pending.requestHash !== result.requestHash
	) {
		throw new Error("Cannot record pi-server compaction apply: durable pending marker did not match the result");
	}
	writePiServerAppliedCompact(compactStatePath, {
		operationId: result.operationId,
		requestHash: result.requestHash,
		entryId: result.compactionEntry.id,
		entryHash: hashPiServerTreeEntry(result.compactionEntry),
		updatedTreeHash: result.treeHash,
		updatedLeafId: result.compactionEntry.id,
		updatedRevision: result.revision,
	});
}

export async function acknowledgePiServerCompaction(
	result: PiServerCompactionResult,
	signal?: AbortSignal,
): Promise<void> {
	const compactStatePath = result.compactStatePath;
	if (!compactStatePath) {
		throw new Error("Cannot acknowledge pi-server compaction without a durable compact-state path");
	}
	const pending = readPiServerPendingCompact(compactStatePath);
	if (
		!pending ||
		pending.sessionId !== result.sessionId ||
		pending.operationId !== result.operationId ||
		pending.requestHash !== result.requestHash
	) {
		throw new Error("Cannot acknowledge pi-server compaction: durable pending marker did not match the result");
	}
	const applied = pending.observation;
	if (
		!applied ||
		applied.kind !== "applied" ||
		applied.entryId !== result.compactionEntry.id ||
		applied.entryHash !== hashPiServerTreeEntry(result.compactionEntry) ||
		applied.updatedTreeHash !== result.treeHash ||
		applied.updatedLeafId !== result.leafId ||
		applied.updatedRevision !== result.revision ||
		result.entries.length !== pending.baseEntryCount + 1 ||
		hashEntries(result.entries) !== result.treeHash
	) {
		throw new Error(
			"Cannot acknowledge pi-server compaction: durable local apply observation did not match the result",
		);
	}
	const request = createPiServerRequest(signal);
	const response = await request.postJson("/api/session/compact/ack", {
		sessionId: pending.sessionId,
		operationId: pending.operationId,
		requestHash: pending.requestHash,
	});
	if (response.status === 404) {
		const contentType = getResponseContentType(response).toLowerCase();
		const failure = await readPiServerFailure(response);
		if (!contentType.includes("application/json") || !/compaction operation not found/i.test(failure.matchText)) {
			throw new Error(`Session compaction acknowledgement failed (${failure.details})`);
		}
		acknowledgePiServerPendingCompact(compactStatePath, pending.operationId, "server_missing_after_tree_applied");
		return;
	}
	const value = await readPiServerJson<unknown>(response, "Session compaction acknowledgement failed");
	if (
		!isObject(value) ||
		value.acknowledged !== true ||
		value.sessionId !== pending.sessionId ||
		value.operationId !== pending.operationId ||
		value.requestHash !== pending.requestHash ||
		value.status !== "completed" ||
		!isNonNegativeInteger(value.acknowledgedAt)
	) {
		throw new Error("Session compaction acknowledgement failed (response identity was invalid)");
	}
	acknowledgePiServerPendingCompact(compactStatePath, pending.operationId);
}

export async function dropLastPiServerAssistantError(sessionId: string): Promise<void> {
	const request = createPiServerRequest();
	const response = await request.postJson("/api/session/drop-last-assistant-error", { sessionId });
	await readPiServerJson<unknown>(response, "Dropping server assistant error failed");
}

function findPendingPiServerRunTerminal(
	entries: SessionTreeEntry[],
	pending: PiServerPendingRunState,
): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const diagnostic = getPiServerRunDiagnostic(message);
		if (!diagnostic || diagnostic.runId !== pending.runId) continue;
		if (diagnostic.sessionId !== pending.sessionId || diagnostic.requestMac !== pending.requestHash) {
			throw new Error("Cannot recover pi-server run: persisted terminal diagnostic did not match pending state");
		}
		return message;
	}
	return undefined;
}

function assertPendingPiServerRunMatches(
	pending: PiServerPendingRunState,
	serverHash: string,
	sessionId: string,
	tree: PiServerTreeSnapshot,
): void {
	if (
		pending.serverHash !== serverHash ||
		pending.sessionId !== sessionId ||
		pending.baseEntryCount > tree.entries.length ||
		hashLocalTreePrefix(sessionId, tree.entries, pending.baseEntryCount) !== pending.baseTreeHash ||
		pending.baseLeafId !== tree.leafId
	) {
		throw new Error(
			`Cannot safely resume pending pi-server run ${pending.runId}: server, tree, or provider request identity changed`,
		);
	}
}

function missingDurablePiServerRunError(runId: string, cause?: string): Error {
	const prefix = cause ? `${cause}; ` : "";
	return new Error(
		`${prefix}pi-server no longer has durable journal for pending run ${runId}. ` +
			"The provider outcome is unknown and the pending marker was retained. Restore the server journal, " +
			"or after independently verifying that the provider did not execute, start an explicit new session or fork; " +
			"automatic provider resubmission is disabled.",
	);
}

export async function streamPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerStreamOptions,
): Promise<PiServerEventStream> {
	const runMode = options?.runMode;
	if (runMode === "auxiliary-transient" && options?.piServerRunStatePath) {
		throw new Error("Auxiliary pi-server streams cannot use the main durable run-state path");
	}
	const sessionId = options?.sessionId ?? randomUUID();
	let runId: string = randomUUID();
	const recoveryWindowMs = getPiServerStreamRecoveryWindowMs(options?.piServerRecoveryWindowMs);
	const isEphemeralSession = runMode === "auxiliary-transient" || options?.sessionId === undefined;
	const stream = new PiServerEventStream();

	const partial: AssistantMessage = {
		role: "assistant",
		stopReason: "stop",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};

	(async () => {
		let phase: PiServerFailurePhase = "session_init";
		let receivedProxyEventCount = 0;
		let runSubmissionStarted = false;
		let unresolvedRunPending = false;
		let cancelFailure: unknown;
		let cancelPromise: Promise<void> | undefined;
		let transientRunAcknowledged = false;
		let pendingTransientTerminalEvent: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
		const runStatePath = options?.piServerRunStatePath;
		let runStateLease: PiServerRunStateLease | undefined;

		const attachRunStateLease = (): void => {
			if (!runStatePath) return;
			const active = getPersistentRunLease(sessionId, runStatePath);
			if (active) {
				if (active.scope !== "session") {
					throw new Error(`Cannot start another pi-server run while session ${sessionId} is already streaming`);
				}
				runStateLease = active.lease;
				return;
			}
			runStateLease = acquirePersistentRunLease(sessionId, runStatePath);
		};
		const releaseRunStateLease = (): void => {
			if (!runStatePath || !runStateLease) return;
			releasePiServerRunLease(sessionId, runStatePath);
			runStateLease = undefined;
		};

		const requestRunCancel = (): Promise<void> => {
			if (!runSubmissionStarted) return Promise.resolve();
			cancelPromise ??= cancelPiServerRun(sessionId, runId).catch((error: unknown) => {
				cancelFailure = error;
			});
			return cancelPromise;
		};
		const onAbort = (): void => {
			void requestRunCancel();
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		const endStream = (): void => {
			options?.signal?.removeEventListener("abort", onAbort);
			if (isEphemeralSession) {
				resetSessionTracking(sessionId);
			}
			stream.end();
		};
		const validateTerminalPendingRun = (): boolean => {
			const diagnostic = getPiServerRunDiagnostic(partial);
			const pending = runStatePath
				? readPiServerPendingRun(runStatePath, runStateLease)
				: sessionPendingRuns.get(sessionId);
			if (
				!diagnostic ||
				!pending ||
				diagnostic.sessionId !== sessionId ||
				diagnostic.sessionId !== pending.sessionId ||
				diagnostic.runId !== pending.runId ||
				diagnostic.requestMac !== pending.requestHash
			) {
				throw new PiServerStreamProtocolError("Pi-server terminal run diagnostic did not match the pending run");
			}
			return runStatePath !== undefined && runStateLease !== undefined;
		};
		const getDurableRunEvents = (request: ChunkRequest, eventCursor: number): Promise<Response> =>
			request.getJson(
				`/api/session/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?from=${eventCursor}`,
			);
		const acknowledgeTransientTerminal = async (
			event: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
		): Promise<void> => {
			const message = event.type === "done" ? event.message : event.error;
			if (!transientRunAcknowledged) {
				validateTerminalPendingRun();
				await acknowledgePiServerRunMessage(sessionId, message, undefined, options?.signal);
				if (sessionPendingRuns.has(sessionId)) {
					throw new PiServerStreamProtocolError(
						"Auxiliary pi-server terminal acknowledgement did not clear transient pending state",
					);
				}
				transientRunAcknowledged = true;
			}
			const cleanupSignal = options?.signal?.aborted
				? AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS)
				: options?.signal;
			const cleanupRequest = createPiServerRequest(cleanupSignal);
			const cleanupResponse = await cleanupRequest.deleteJson(`/api/session/${encodeURIComponent(sessionId)}`);
			const cleanupResult = await readPiServerJson<unknown>(
				cleanupResponse,
				"Auxiliary pi-server session cleanup failed",
			);
			if (!isObject(cleanupResult) || cleanupResult.deleted !== sessionId) {
				throw new PiServerStreamProtocolError(
					"Auxiliary pi-server session cleanup response did not match the transient session",
				);
			}
			unresolvedRunPending = false;
			pendingTransientTerminalEvent = undefined;
			stream.push(event);
		};

		const settleStreamFailure = async (failure: unknown, retryable = phase === "provider_stream"): Promise<void> => {
			const reason = options?.signal?.aborted ? "aborted" : "error";
			if (reason === "aborted") {
				await requestRunCancel();
				if (cancelFailure === undefined && runSubmissionStarted) {
					try {
						const recoveryRequest = createPiServerRequest(AbortSignal.timeout(PI_SERVER_CANCEL_TIMEOUT_MS));
						const response = await getDurableRunEvents(recoveryRequest, receivedProxyEventCount);
						if (response.ok) {
							const recovered = await readStreamResponse(response, receivedProxyEventCount, true);
							if (recovered.terminal) {
								endStream();
								return;
							}
							cancelFailure = recovered.failure;
						} else {
							const cancelRecoveryFailure = await readPiServerFailure(response);
							cancelFailure = new Error(
								`pi-server canceled run replay failed: ${cancelRecoveryFailure.details}`,
							);
						}
					} catch (error) {
						cancelFailure = error;
					}
				}
			}
			const initialErrorMessage = failure instanceof Error ? failure.message : String(failure);
			const errorMessage =
				cancelFailure === undefined
					? initialErrorMessage
					: `${initialErrorMessage}; pi-server run cancel failed: ${
							cancelFailure instanceof Error ? cancelFailure.message : String(cancelFailure)
						}`;
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			partial.diagnostics = partial.diagnostics?.filter((diagnostic) => diagnostic.type !== "pi_server_run");
			partial.diagnostics = [
				...(partial.diagnostics ?? []),
				{
					type: "pi_server_failure",
					timestamp: Date.now(),
					error: { name: failure instanceof Error ? failure.name : "Error", message: errorMessage },
					details: {
						phase,
						source: "pi-server",
						retryable: reason === "aborted" ? false : retryable,
						runUnresolved: unresolvedRunPending,
					},
				},
			];
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			releaseRunStateLease();
			endStream();
		};

		const readStreamResponse = async (
			response: Response,
			eventCursor: number,
			ignoreCallerAbort = false,
		): Promise<
			{ terminal: true } | { terminal: false; failure: unknown; observedProgress: boolean; recoverable: boolean }
		> => {
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let observedProgress = false;
			try {
				try {
					await ensurePiServerEventStream(response);
				} catch (error) {
					throw new PiServerStreamProtocolError(
						`Invalid pi-server stream response: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				reader = response.body!.getReader();
				const decoder = new TextDecoder();
				const noProgress = createPiServerBodyNoProgressState();
				const incompleteLineParts: string[] = [];
				let incompleteLineBytes = 0;
				let replayEventIndex = eventCursor;

				while (true) {
					const { done, value } = await readPiServerBodyChunk(reader, noProgress);
					if (done) {
						return {
							terminal: false,
							failure: new Error("pi-server stream ended before a terminal event"),
							observedProgress,
							recoverable: true,
						};
					}
					if (value.byteLength > 0) observedProgress = true;

					if (!ignoreCallerAbort && options?.signal?.aborted) {
						throw new Error("Request aborted by user");
					}

					incompleteLineBytes = updateEventStreamLineBytes(value, incompleteLineBytes);
					if (incompleteLineBytes < 0) {
						throw new PiServerStreamProtocolError(
							`Invalid pi-server stream response: event line exceeded ${PI_SERVER_EVENT_STREAM_MAX_LINE_BYTES} bytes`,
						);
					}
					const lines = extractDecodedEventStreamLines(
						decoder.decode(value, { stream: true }),
						incompleteLineParts,
					);

					for (const rawLine of lines) {
						const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6).trim();
						if (!data) continue;
						const eventIndex = replayEventIndex;
						replayEventIndex++;
						if (eventIndex < receivedProxyEventCount) continue;

						let proxyEvent: ProxyAssistantMessageEvent;
						try {
							proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
						} catch {
							throw new PiServerStreamProtocolError(
								`Invalid pi-server stream event JSON: ${getBodyExcerpt(data)}`,
							);
						}
						let event: AssistantMessageEvent | undefined;
						try {
							event = processProxyEvent(proxyEvent, partial);
						} catch (error) {
							throw new PiServerStreamProtocolError(
								`Invalid pi-server stream event: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						receivedProxyEventCount++;
						if (!event) continue;
						if (event.type === "done" || event.type === "error") {
							if (runMode === "auxiliary-transient") {
								pendingTransientTerminalEvent = event;
								try {
									await acknowledgeTransientTerminal(event);
								} catch (error) {
									return {
										terminal: false,
										failure: error,
										observedProgress: true,
										recoverable: isRetryablePiServerInterruption(error),
									};
								}
							} else {
								const retainLease =
									runMode === "main-durable" || runStatePath !== undefined
										? validateTerminalPendingRun()
										: false;
								if (!retainLease) {
									releaseRunStateLease();
								}
								stream.push(event);
							}
							void reader.cancel().catch(() => undefined);
							return { terminal: true };
						}
						stream.push(event);
					}
				}
			} catch (error) {
				void reader?.cancel().catch(() => undefined);
				return {
					terminal: false,
					failure: error,
					observedProgress,
					recoverable: isRetryablePiServerInterruption(error),
				};
			}
		};

		try {
			const request = createPiServerRequest(options?.signal);
			await ensureSessionInit(sessionId, context, request);
			const tree = options?.sessionTree ?? {
				...getLinearTreeFromMessages(context.messages as Message[]),
				replace: true,
			};
			const syncTree = tree;
			if (runStatePath) {
				attachRunStateLease();
			}
			let pending = runStatePath
				? readPiServerPendingRun(runStatePath, runStateLease)
				: sessionPendingRuns.get(sessionId);
			unresolvedRunPending = pending !== undefined;
			let treeSynced = false;
			if (pending) {
				const persistedTerminal = findPendingPiServerRunTerminal(syncTree.entries, pending);
				if (persistedTerminal) {
					phase = "tree_sync";
					await syncPiServerTreeWithRequest(sessionId, syncTree, request, options?.onHistoryReconciled);
					treeSynced = true;
					await acknowledgePiServerRunMessage(sessionId, persistedTerminal, runStatePath, options?.signal);
					if (runStatePath) {
						attachRunStateLease();
					}
					pending = undefined;
					unresolvedRunPending = false;
				}
			}

			const buildRequestIdentity = (
				baseTreeHash: string,
				baseEntryCount: number,
				baseLeafId: string | null,
				baseStaticContextHash: string,
				baseRevision: number,
			): Record<string, unknown> =>
				JSON.parse(
					JSON.stringify({
						sessionId,
						runMode,
						model,
						options: serializeOptions(options),
						ephemeralMessages: options?.ephemeralMessages,
						contextOverlay: options?.contextOverlay,
						baseTreeHash,
						baseEntryCount,
						baseLeafId,
						baseStaticContextHash,
						baseRevision,
					}),
				) as Record<string, unknown>;

			let baseTreeHash = pending?.baseTreeHash ?? hashLocalTree(sessionId, syncTree.entries);
			let baseEntryCount = pending?.baseEntryCount ?? syncTree.entries.length;
			let baseLeafId = pending?.baseLeafId ?? syncTree.leafId;
			let baseStaticContextHash = hashStaticContext(context);
			let baseRevision = sessionTreeRevisions.get(sessionId) ?? 0;
			let requestIdentity = buildRequestIdentity(
				baseTreeHash,
				baseEntryCount,
				baseLeafId,
				baseStaticContextHash,
				baseRevision,
			);
			let requestHash = hashPiServerStreamRequest(requestIdentity);
			let resumedPendingRun = false;
			let recoveredPendingRun: PiServerRunRecoveryResult | undefined;
			if (pending) {
				assertPendingPiServerRunMatches(pending, hashPiServerIdentity(getServerUrl()), sessionId, syncTree);
				runId = pending.runId;
				phase = "provider_stream";
				recoveredPendingRun = await recoverPiServerRun(sessionId, runId, request, options?.signal);
				if (recoveredPendingRun.status === "not_found") {
					throw missingDurablePiServerRunError(pending.runId);
				} else {
					resumedPendingRun = true;
					runSubmissionStarted = true;
					requestHash = pending.requestHash;
				}
			}

			if (!pending) {
				if (!treeSynced) {
					phase = "tree_sync";
					await syncPiServerTreeWithRequest(sessionId, syncTree, request, options?.onHistoryReconciled);
					treeSynced = true;
				}
				baseTreeHash = hashLocalTree(sessionId, syncTree.entries);
				baseEntryCount = syncTree.entries.length;
				baseLeafId = syncTree.leafId;
				baseStaticContextHash = sessionStaticContextHashes.get(sessionId) ?? hashStaticContext(context);
				baseRevision = sessionTreeRevisions.get(sessionId) ?? 0;
				requestIdentity = buildRequestIdentity(
					baseTreeHash,
					baseEntryCount,
					baseLeafId,
					baseStaticContextHash,
					baseRevision,
				);
				requestHash = hashPiServerStreamRequest(requestIdentity);
				const pendingInput = {
					serverHash: hashPiServerIdentity(getServerUrl()),
					sessionId,
					runId,
					baseTreeHash,
					baseEntryCount,
					baseLeafId,
					requestHash,
				};
				const newPending = runStatePath
					? writePiServerPendingRun(runStatePath, pendingInput, runStateLease)
					: ({
							version: 1,
							kind: "run",
							sequence: 0,
							timestamp: Date.now(),
							...pendingInput,
						} satisfies PiServerPendingRunState);
				if (!runStatePath) sessionPendingRuns.set(sessionId, newPending);
				unresolvedRunPending = true;
			}

			const makeBody = (eventCursor: number) => ({
				...requestIdentity,
				runId,
				eventCursor,
			});
			const getRunEvents = (eventCursor: number): Promise<Response> => getDurableRunEvents(request, eventCursor);
			phase = "provider_stream";
			const postStream = async (eventCursor: number): Promise<Response> => {
				runSubmissionStarted = true;
				if (options?.signal?.aborted) {
					throw new Error("Request aborted by user");
				}
				return request.postJson("/api/stream", makeBody(eventCursor));
			};
			let response: Response | undefined;
			let activeResponse: Response | undefined;
			let activeEventCursor = 0;
			let interruption: unknown = new Error("pi-server stream ended before a terminal event");

			try {
				if (resumedPendingRun) {
					if (
						recoveredPendingRun?.status === "running" ||
						recoveredPendingRun?.status === "completed" ||
						recoveredPendingRun?.status === "failed"
					) {
						if (recoveredPendingRun.requestMac !== requestHash) {
							throw new Error("Pending pi-server run request identity did not match durable server state");
						}
						response = await getRunEvents(0);
					} else {
						interruption = new Error(
							`pi-server pending run recovery was unavailable: ${
								recoveredPendingRun?.status === "unavailable"
									? recoveredPendingRun.details
									: "unknown recovery state"
							}`,
						);
					}
				} else {
					response = await postStream(0);
				}
			} catch (error) {
				if (isAbortError(error, options?.signal)) throw error;
				if (!isRetryablePiServerInterruption(error)) throw error;
				interruption = error;
			}

			if (response && !response.ok) {
				let failure = await readPiServerFailure(response);
				if (!options?.signal?.aborted && isRecoverableMissingServerState(response, failure.matchText)) {
					resetSessionTracking(sessionId);
					phase = "session_init";
					await ensureSessionInit(sessionId, context, request);
					phase = "tree_sync";
					await syncPiServerTreeWithRequest(sessionId, syncTree, request, options?.onHistoryReconciled);
					phase = "provider_stream";
					try {
						response = await postStream(receivedProxyEventCount);
					} catch (error) {
						if (isAbortError(error, options?.signal)) throw error;
						if (!isRetryablePiServerInterruption(error)) throw error;
						response = undefined;
						interruption = error;
					}
					if (response && !response.ok) {
						failure = await readPiServerFailure(response);
					}
				}
				if (response && !response.ok) {
					const retryable = isTransientPiServerResponse(response, failure.bodyText);
					const responseError = new PiServerHttpResponseError(
						`pi-server error: ${failure.details}`,
						response.status,
						retryable,
					);
					if (!retryable) throw responseError;
					interruption = responseError;
				}
			}
			if (response?.ok) {
				activeResponse = response;
				activeEventCursor = receivedProxyEventCount;
			}
			let reconnectAttempt = 0;
			let recoveryDeadline: number | undefined;

			while (true) {
				if (pendingTransientTerminalEvent) {
					try {
						await acknowledgeTransientTerminal(pendingTransientTerminalEvent);
						endStream();
						return;
					} catch (error) {
						if (!isRetryablePiServerInterruption(error)) {
							await settleStreamFailure(error, false);
							return;
						}
						interruption = error;
						recoveryDeadline = Date.now() + recoveryWindowMs;
						reconnectAttempt = 0;
					}
				}
				if (activeResponse) {
					const result = await readStreamResponse(activeResponse, activeEventCursor);
					if (result.terminal) {
						endStream();
						return;
					}
					if (!result.recoverable) {
						await settleStreamFailure(result.failure, false);
						return;
					}
					interruption = result.failure;
					activeResponse = undefined;
					if (result.observedProgress) {
						recoveryDeadline = Date.now() + recoveryWindowMs;
						reconnectAttempt = 0;
					} else {
						recoveryDeadline ??= Date.now() + recoveryWindowMs;
					}
				}

				if (options?.signal?.aborted) {
					throw new Error("Request aborted by user");
				}
				recoveryDeadline ??= Date.now() + recoveryWindowMs;

				const recoveredRun = await recoverPiServerRun(sessionId, runId, request, options?.signal);
				const hasDurableRun =
					recoveredRun.status === "running" ||
					recoveredRun.status === "completed" ||
					recoveredRun.status === "failed";
				if (hasDurableRun && recoveredRun.requestMac !== requestHash) {
					await settleStreamFailure(
						new Error("pi-server recovered run request identity did not match the pending provider request"),
						false,
					);
					return;
				}
				if (recoveredRun.status === "not_found") {
					const failureMessage = interruption instanceof Error ? interruption.message : String(interruption);
					await settleStreamFailure(missingDurablePiServerRunError(runId, failureMessage), false);
					return;
				}
				if (recoveredRun.status === "unavailable") {
					const failureMessage = interruption instanceof Error ? interruption.message : String(interruption);
					interruption = new Error(
						`${failureMessage}; pi-server run recovery was unavailable: ${recoveredRun.details}`,
					);
				}
				const remainingMs = recoveryDeadline - Date.now();
				if (remainingMs <= 0) {
					const failureMessage = interruption instanceof Error ? interruption.message : String(interruption);
					await settleStreamFailure(
						new Error(`${failureMessage}; pi-server stream recovery exhausted after ${recoveryWindowMs}ms`),
						false,
					);
					return;
				}

				const delayMs = Math.min(getPiServerStreamReconnectDelay(reconnectAttempt), remainingMs);
				reconnectAttempt++;
				await waitForPiServerStreamReconnect(delayMs, options?.signal);
				if (Date.now() >= recoveryDeadline) {
					const failureMessage = interruption instanceof Error ? interruption.message : String(interruption);
					await settleStreamFailure(
						new Error(`${failureMessage}; pi-server stream recovery exhausted after ${recoveryWindowMs}ms`),
						false,
					);
					return;
				}

				try {
					const eventCursor = receivedProxyEventCount;
					if (recoveredRun.status === "unavailable") {
						continue;
					}
					const reconnectResponse = await getRunEvents(eventCursor);
					if (!reconnectResponse.ok) {
						const failure = await readPiServerFailure(reconnectResponse);
						if (!isTransientPiServerResponse(reconnectResponse, failure.bodyText)) {
							await settleStreamFailure(new Error(`pi-server reconnect failed: ${failure.details}`), false);
							return;
						}
						interruption = new Error(`pi-server reconnect failed: ${failure.details}`);
						continue;
					}
					activeResponse = reconnectResponse;
					activeEventCursor = eventCursor;
				} catch (error) {
					if (isAbortError(error, options?.signal)) {
						throw error;
					}
					if (!isRetryablePiServerInterruption(error)) {
						await settleStreamFailure(error, false);
						return;
					}
					interruption = error;
				}
			}
		} catch (error) {
			await settleStreamFailure(error, false);
		}
	})();

	return stream;
}

function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };
		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };
		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return { type: "text_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
			}
			throw new Error("Received text_delta for non-text content");
		}
		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				if (proxyEvent.content !== undefined) content.text = proxyEvent.content;
				content.textSignature = proxyEvent.contentSignature;
				return { type: "text_end", contentIndex: proxyEvent.contentIndex, content: content.text, partial };
			}
			throw new Error("Received text_end for non-text content");
		}
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return { type: "thinking_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}
		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				if (proxyEvent.content !== undefined) content.thinking = proxyEvent.content;
				content.thinkingSignature = proxyEvent.contentSignature;
				content.redacted = proxyEvent.redacted;
				return { type: "thinking_end", contentIndex: proxyEvent.contentIndex, content: content.thinking, partial };
			}
			throw new Error("Received thinking_end for non-thinking content");
		}
		case "toolcall_start": {
			const partialToolCall: ToolCall & { partialJson: string } = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			};
			partial.content[proxyEvent.contentIndex] = partialToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		}
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const partialToolCall = content as ToolCall & { partialJson?: string };
				if (partialToolCall.partialJson === undefined) {
					throw new Error("Received toolcall_delta without an active partial tool call");
				}
				partialToolCall.partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson(partialToolCall.partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content };
				return { type: "toolcall_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}
		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const toolCall = proxyEvent.toolCall ?? content;
				delete (toolCall as ToolCall & { partialJson?: string }).partialJson;
				toolCall.thoughtSignature = proxyEvent.thoughtSignature ?? toolCall.thoughtSignature;
				partial.content[proxyEvent.contentIndex] = toolCall;
				return { type: "toolcall_end", contentIndex: proxyEvent.contentIndex, toolCall, partial };
			}
			return undefined;
		}
		case "done":
			if (proxyEvent.reason !== "stop" && proxyEvent.reason !== "length" && proxyEvent.reason !== "toolUse") {
				throw new Error(`Received invalid terminal done reason: ${String(proxyEvent.reason)}`);
			}
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			partial.api = proxyEvent.api ?? partial.api;
			partial.provider = proxyEvent.provider ?? partial.provider;
			partial.model = proxyEvent.model ?? partial.model;
			partial.timestamp = proxyEvent.timestamp ?? partial.timestamp;
			partial.responseModel = proxyEvent.responseModel;
			partial.responseId = proxyEvent.responseId;
			partial.diagnostics = proxyEvent.diagnostics;
			return { type: "done", reason: proxyEvent.reason, message: partial };
		case "error":
			if (proxyEvent.reason !== "aborted" && proxyEvent.reason !== "error") {
				throw new Error(`Received invalid terminal error reason: ${String(proxyEvent.reason)}`);
			}
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			partial.api = proxyEvent.api ?? partial.api;
			partial.provider = proxyEvent.provider ?? partial.provider;
			partial.model = proxyEvent.model ?? partial.model;
			partial.timestamp = proxyEvent.timestamp ?? partial.timestamp;
			partial.responseModel = proxyEvent.responseModel;
			partial.responseId = proxyEvent.responseId;
			partial.diagnostics = proxyEvent.diagnostics;
			return { type: "error", reason: proxyEvent.reason, error: partial };
		default: {
			const _exhaustiveCheck: never = proxyEvent;
			throw new Error(`Unhandled proxy event: ${String(_exhaustiveCheck)}`);
		}
	}
}

export { getServerUrl, getAuthToken };
