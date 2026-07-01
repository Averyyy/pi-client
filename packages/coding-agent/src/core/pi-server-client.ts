import { createHash, randomUUID } from "node:crypto";
import type { CompactResult, ProxyAssistantMessageEvent, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ChunkRequest } from "./pi-server-request.ts";

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
const sessionSyncedEntryIds = new Map<string, Set<string>>();
const sessionTreeHashes = new Map<string, string>();
const sessionTreeEntryCounts = new Map<string, number>();
const sessionTreeLeafIds = new Map<string, string | null>();
const sessionHasTemporaryTree = new Set<string>();
const RESPONSE_BODY_EXCERPT_CHARS = 500;

export function hashStaticContext(ctx: Context): string {
	const parts: string[] = [];
	if (ctx.systemPrompt !== undefined) parts.push(`sp:${ctx.systemPrompt}`);
	if (ctx.tools) {
		parts.push(
			`t:${JSON.stringify(ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))}`,
		);
	}
	return parts.join("|");
}

function hashEntries(entries: SessionTreeEntry[]): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
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
	sessionSyncedEntryIds.delete(sessionId);
	sessionTreeHashes.delete(sessionId);
	sessionTreeEntryCounts.delete(sessionId);
	sessionTreeLeafIds.delete(sessionId);
	sessionHasTemporaryTree.delete(sessionId);
}

export function resetAllSessionTracking(): void {
	sessionStaticContextHashes.clear();
	sessionSyncedEntryIds.clear();
	sessionTreeHashes.clear();
	sessionTreeEntryCounts.clear();
	sessionTreeLeafIds.clear();
	sessionHasTemporaryTree.clear();
}

interface SessionInitResponse {
	sessionId: string;
	staticContextHash: string;
	treeHash?: string;
	messageCount: number;
	entryCount?: number;
	leafId?: string | null;
	revision?: number;
	fromCache?: boolean;
}

export interface PiServerTreeSnapshot {
	entries: SessionTreeEntry[];
	leafId: string | null;
	replace?: boolean;
}

export interface PiServerCompactionResult {
	compaction: CompactResult;
	compactionEntry: SessionTreeEntry;
	entries: SessionTreeEntry[];
	leafId: string | null;
	messages: Message[];
}

export interface PiServerHistorySnapshot {
	entries: SessionTreeEntry[];
	leafId: string | null;
	messages: Message[];
}

export interface PiServerStreamOptions extends SimpleStreamOptions {
	sessionTree?: PiServerTreeSnapshot;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

interface PiServerResponseFailure {
	details: string;
	matchText: string;
}

interface PiServerHistoryResponse extends Partial<PiServerHistorySnapshot> {
	sessionId: string;
	treeHash?: string;
	entryCount?: number;
	leafId?: string | null;
}

interface PiServerSyncOptions {
	signal?: AbortSignal;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const bodyText = await response.text();
	return {
		details: formatResponseDetails(response, bodyText),
		matchText: getJsonErrorText(bodyText) ?? bodyText,
	};
}

async function readPiServerJson<T>(response: Response, errorPrefix: string): Promise<T> {
	const bodyText = await response.text();
	if (!response.ok) {
		throw new Error(`${errorPrefix} (${formatResponseDetails(response, bodyText)})`);
	}
	try {
		return JSON.parse(bodyText) as T;
	} catch {
		throw new Error(`${errorPrefix} (${formatResponseDetails(response, bodyText)}; expected JSON)`);
	}
}

async function ensurePiServerEventStream(response: Response): Promise<void> {
	const contentType = getResponseContentType(response);
	if (contentType.toLowerCase().split(";")[0]?.trim() === "text/event-stream") {
		return;
	}
	const bodyText = await response.text();
	throw new Error(`pi-server error: ${formatResponseDetails(response, bodyText)}; expected text/event-stream`);
}

async function ensureSessionInit(
	sessionId: string,
	context: Context,
	request: ChunkRequest,
): Promise<SessionInitResponse> {
	const currentHash = hashStaticContext(context);
	const previousHash = sessionStaticContextHashes.get(sessionId);

	if (previousHash === currentHash) {
		return {
			sessionId,
			staticContextHash: previousHash,
			messageCount: 0,
			fromCache: true,
		};
	}

	const staticContext = {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};

	const endpoint = previousHash === undefined ? "/api/session/init" : "/api/session/update";

	const response = await request.postJson(endpoint, { sessionId, staticContext });

	const result = await readPiServerJson<SessionInitResponse>(response, "Session init failed");
	sessionStaticContextHashes.set(sessionId, currentHash);
	if (result.treeHash !== undefined) {
		sessionTreeHashes.set(sessionId, result.treeHash);
		sessionTreeLeafIds.set(sessionId, result.leafId ?? null);
		if (result.entryCount !== undefined) {
			sessionTreeEntryCounts.set(sessionId, result.entryCount);
		}
	}
	return result;
}

function getStaticContext(context: Context) {
	return {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};
}

function markTreeSynced(sessionId: string, tree: PiServerTreeSnapshot): void {
	sessionSyncedEntryIds.set(sessionId, new Set(tree.entries.map((entry) => entry.id)));
	sessionTreeHashes.set(sessionId, hashEntries(tree.entries));
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
	const response = await request.postJson(endpoint, body);
	await readPiServerJson<unknown>(response, errorPrefix);
}

async function fetchPiServerHistory(
	sessionId: string,
	request: ChunkRequest,
): Promise<PiServerHistorySnapshot | undefined> {
	const response = await request.getJson(`/api/session/${encodeURIComponent(sessionId)}/history`);
	if (response.status === 404) {
		return undefined;
	}
	const history = await readPiServerJson<PiServerHistoryResponse>(response, "Session history reconciliation failed");
	if (!history.entries || history.leafId === undefined || !history.messages) {
		throw new Error("Session history reconciliation failed (response did not include the session tree)");
	}
	return {
		entries: history.entries,
		leafId: history.leafId,
		messages: history.messages,
	};
}

async function applyPiServerHistory(
	sessionId: string,
	snapshot: PiServerHistorySnapshot,
	onHistoryReconciled: ((snapshot: PiServerHistorySnapshot) => void | Promise<void>) | undefined,
): Promise<void> {
	markTreeSynced(sessionId, snapshot);
	await onHistoryReconciled?.(snapshot);
}

function getKnownServerPrefixIds(sessionId: string, entries: SessionTreeEntry[]): Set<string> | undefined {
	const entryCount = sessionTreeEntryCounts.get(sessionId);
	const treeHash = sessionTreeHashes.get(sessionId);
	if (entryCount === undefined || treeHash === undefined || entryCount > entries.length) {
		return undefined;
	}
	const prefix = entries.slice(0, entryCount);
	if (hashEntries(prefix) !== treeHash) {
		return undefined;
	}
	const ids = new Set(prefix.map((entry) => entry.id));
	sessionSyncedEntryIds.set(sessionId, ids);
	return ids;
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
	context: Context,
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
			staticContext: getStaticContext(context),
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
	context: Context,
	tree: PiServerTreeSnapshot,
	request: ChunkRequest,
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>,
): Promise<void> {
	if (shouldUseServerHistory(sessionId, tree)) {
		const snapshot = await fetchPiServerHistory(sessionId, request);
		if (snapshot && snapshot.entries.length > 0) {
			await applyPiServerHistory(sessionId, snapshot, onHistoryReconciled);
			throw new Error(
				"pi-server history differed from local history; local session was reconciled to server history",
			);
		}
	}

	await syncFullPiServerTree(sessionId, context, tree, request);
}

export async function syncPiServerTree(
	sessionId: string,
	context: Context,
	tree: PiServerTreeSnapshot,
	options?: PiServerSyncOptions,
): Promise<void> {
	const request = createPiServerRequest(options?.signal);
	await ensureSessionInit(sessionId, context, request);
	await syncPiServerTreeWithRequest(sessionId, context, tree, request, options?.onHistoryReconciled);
}

async function syncPiServerTreeWithRequest(
	sessionId: string,
	context: Context,
	tree: PiServerTreeSnapshot,
	request: ChunkRequest,
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>,
): Promise<void> {
	const syncTree = tree;
	const currentHash = hashEntries(syncTree.entries);
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
				await recoverPiServerTreeDivergence(sessionId, context, syncTree, request, onHistoryReconciled);
				return;
			}
			sessionTreeLeafIds.set(sessionId, syncTree.leafId);
		}
		markTreeSynced(sessionId, syncTree);
		return;
	}

	const syncedIds =
		!tree.replace && !sessionHasTemporaryTree.has(sessionId)
			? (sessionSyncedEntryIds.get(sessionId) ?? getKnownServerPrefixIds(sessionId, syncTree.entries))
			: undefined;
	if (syncedIds) {
		const deltaEntries = syncTree.entries.filter((entry) => !syncedIds.has(entry.id));
		if (deltaEntries.length > 0) {
			try {
				await postTreeJson(
					request,
					"/api/session/tree/append",
					{
						sessionId,
						entries: deltaEntries,
						leafId: syncTree.leafId,
						staticContext: getStaticContext(context),
					},
					"Session tree append failed",
				);
			} catch (error) {
				if (!isRecoverableTreeDivergenceError(error)) {
					throw error;
				}
				await recoverPiServerTreeDivergence(sessionId, context, syncTree, request, onHistoryReconciled);
				return;
			}
			markTreeSynced(sessionId, syncTree);
			return;
		}
	}

	await recoverPiServerTreeDivergence(sessionId, context, syncTree, request, onHistoryReconciled);
}

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
	};
}

export interface PiServerCompactOptions extends SimpleStreamOptions {
	customInstructions?: string;
	settings?: unknown;
	sessionTree?: PiServerTreeSnapshot;
	onHistoryReconciled?: (snapshot: PiServerHistorySnapshot) => void | Promise<void>;
}

export async function compactPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerCompactOptions,
): Promise<PiServerCompactionResult> {
	const sessionId = options?.sessionId ?? "default";
	const request = createPiServerRequest(options?.signal);

	await ensureSessionInit(sessionId, context, request);
	const tree = options?.sessionTree ?? getLinearTreeFromMessages(context.messages as Message[]);
	await syncPiServerTreeWithRequest(sessionId, context, tree, request, options?.onHistoryReconciled);

	const makeBody = () => ({
		sessionId,
		model,
		options: serializeOptions(options),
		settings: options?.settings,
		customInstructions: options?.customInstructions,
	});
	let response = await request.postJson("/api/session/compact", makeBody());
	if (!response.ok) {
		let failure = await readPiServerFailure(response);
		if (!options?.signal?.aborted && isRecoverableMissingServerState(response, failure.matchText)) {
			resetSessionTracking(sessionId);
			await ensureSessionInit(sessionId, context, request);
			await syncPiServerTreeWithRequest(sessionId, context, tree, request, options?.onHistoryReconciled);
			response = await request.postJson("/api/session/compact", makeBody());
			if (response.ok) {
				failure = { details: "", matchText: "" };
			} else {
				failure = await readPiServerFailure(response);
			}
		}
		if (!response.ok) {
			throw new Error(`Server compaction failed (${failure.details})`);
		}
	}
	const result = await readPiServerJson<Partial<PiServerCompactionResult>>(response, "Server compaction failed");
	if (!result.compaction) {
		throw new Error("Server compaction response did not include a compaction result");
	}
	if (!result.compactionEntry || !result.entries || result.leafId === undefined || !result.messages) {
		throw new Error("Server compaction response did not include the updated session tree");
	}
	markTreeSynced(sessionId, { entries: result.entries, leafId: result.leafId });
	return {
		compaction: result.compaction,
		compactionEntry: result.compactionEntry,
		entries: result.entries,
		leafId: result.leafId,
		messages: result.messages,
	};
}

export async function dropLastPiServerAssistantError(sessionId: string): Promise<void> {
	const request = createPiServerRequest();
	const response = await request.postJson("/api/session/drop-last-assistant-error", { sessionId });
	await readPiServerJson<unknown>(response, "Dropping server assistant error failed");
}

export async function streamPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerStreamOptions,
): Promise<PiServerEventStream> {
	const sessionId = options?.sessionId ?? randomUUID();
	const isEphemeralSession = options?.sessionId === undefined;
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
		try {
			const request = createPiServerRequest(options?.signal);
			await ensureSessionInit(sessionId, context, request);
			const tree = options?.sessionTree ?? {
				...getLinearTreeFromMessages(context.messages as Message[]),
				replace: true,
			};
			const syncTree = tree;
			await syncPiServerTreeWithRequest(sessionId, context, syncTree, request, options?.onHistoryReconciled);

			const makeBody = () => ({
				sessionId,
				model,
				options: serializeOptions(options),
			});
			let response = await request.postJson("/api/stream", makeBody());

			if (!response.ok) {
				let failure = await readPiServerFailure(response);
				if (!options?.signal?.aborted && isRecoverableMissingServerState(response, failure.matchText)) {
					resetSessionTracking(sessionId);
					await ensureSessionInit(sessionId, context, request);
					await syncPiServerTreeWithRequest(sessionId, context, syncTree, request, options?.onHistoryReconciled);
					response = await request.postJson("/api/stream", makeBody());
					if (response.ok) {
						failure = { details: "", matchText: "" };
					} else {
						failure = await readPiServerFailure(response);
					}
				}
				if (!response.ok) {
					throw new Error(`pi-server error: ${failure.details}`);
				}
			}

			await ensurePiServerEventStream(response);
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options?.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (!data) continue;
						const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
						const event = processProxyEvent(proxyEvent, partial);
						if (event) {
							stream.push(event);
						}
					}
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			if (isEphemeralSession) {
				resetSessionTracking(sessionId);
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options?.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
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
				content.thinkingSignature = proxyEvent.contentSignature;
				return { type: "thinking_end", contentIndex: proxyEvent.contentIndex, content: content.thinking, partial };
			}
			throw new Error("Received thinking_end for non-thinking content");
		}
		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} as any;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content };
				return { type: "toolcall_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}
		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				delete (content as any).partialJson;
				return { type: "toolcall_end", contentIndex: proxyEvent.contentIndex, toolCall: content, partial };
			}
			return undefined;
		}
		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };
		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };
		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}

export { getServerUrl, getAuthToken };
