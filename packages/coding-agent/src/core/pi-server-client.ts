import { createHash, randomUUID } from "node:crypto";
import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
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

const sessionSentCounts = new Map<string, number>();
const sessionStaticContextHashes = new Map<string, string>();
const sessionLocalContextHashes = new Map<string, string>();

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

function getDelta(context: Context, sessionId: string): Message[] {
	const sentCount = sessionSentCounts.get(sessionId) ?? 0;
	const allMessages = context.messages;
	const delta = allMessages.slice(sentCount);
	return delta as Message[];
}

function hashMessages(messages: Message[]): string {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function markLocalSynced(sessionId: string, messages: Message[]): void {
	sessionSentCounts.set(sessionId, messages.length);
	sessionLocalContextHashes.set(sessionId, hashMessages(messages));
}

export function resetSessionTracking(sessionId: string): void {
	sessionSentCounts.delete(sessionId);
	sessionStaticContextHashes.delete(sessionId);
	sessionLocalContextHashes.delete(sessionId);
}

export function resetAllSessionTracking(): void {
	sessionSentCounts.clear();
	sessionStaticContextHashes.clear();
	sessionLocalContextHashes.clear();
}

interface SessionInitResponse {
	sessionId: string;
	staticContextHash: string;
	messageCount: number;
}

interface SessionHistoryResponse {
	sessionId: string;
	staticContextHash: string;
	messageCount: number;
	baseMessageCount?: number;
	messages: Message[];
}

export interface PiServerHistoryReconciliation {
	reason: "server_newer" | "server_authoritative";
	messages: Message[];
}

export interface PiServerStreamOptions extends SimpleStreamOptions {
	onHistoryReconciled?: (reconciliation: PiServerHistoryReconciliation) => void;
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
			messageCount: sessionSentCounts.get(sessionId) ?? 0,
		};
	}

	const staticContext = {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};

	const endpoint = previousHash === undefined ? "/api/session/init" : "/api/session/update";

	const response = await request.postJson(endpoint, { sessionId, staticContext });

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Session init failed (${response.status}): ${errorBody}`);
	}

	const result = (await response.json()) as SessionInitResponse;
	sessionStaticContextHashes.set(sessionId, currentHash);
	return result;
}

function getStaticContext(context: Context) {
	return {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};
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

async function fetchServerHistory(
	sessionId: string,
	request: ChunkRequest,
	from?: number,
): Promise<SessionHistoryResponse> {
	const query = from === undefined ? "" : `?from=${from}`;
	const response = await request.getJson(`/api/session/${encodeURIComponent(sessionId)}/history${query}`);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Session history failed (${response.status}): ${errorBody}`);
	}
	return (await response.json()) as SessionHistoryResponse;
}

function isPrefix(prefix: Message[], messages: Message[]): boolean {
	if (prefix.length > messages.length) return false;
	return hashMessages(messages.slice(0, prefix.length) as Message[]) === hashMessages(prefix);
}

async function syncPiServerSessionIfNeeded(
	sessionId: string,
	context: Context,
	request: ChunkRequest,
	serverMessageCount: number,
	options: {
		syncWhenUnsent?: boolean;
		onHistoryReconciled?: (reconciliation: PiServerHistoryReconciliation) => void;
	} = {},
): Promise<{ synced: boolean; messages: Message[] }> {
	const localMessages = context.messages as Message[];
	const syncedHash = sessionLocalContextHashes.get(sessionId);
	if (serverMessageCount === 0 && syncedHash === undefined && !options.syncWhenUnsent) {
		return { synced: false, messages: localMessages };
	}

	if (serverMessageCount > localMessages.length) {
		const history = await fetchServerHistory(sessionId, request, localMessages.length);
		const messages = [...localMessages, ...history.messages];
		markLocalSynced(sessionId, messages);
		options.onHistoryReconciled?.({ reason: "server_newer", messages });
		return { synced: true, messages };
	}

	if (serverMessageCount === localMessages.length) {
		if (syncedHash === hashMessages(localMessages)) {
			return { synced: false, messages: localMessages };
		}
		const history = await fetchServerHistory(sessionId, request);
		if (hashMessages(history.messages) === hashMessages(localMessages)) {
			markLocalSynced(sessionId, localMessages);
			return { synced: false, messages: localMessages };
		}
		markLocalSynced(sessionId, history.messages);
		options.onHistoryReconciled?.({ reason: "server_authoritative", messages: history.messages });
		return { synced: true, messages: history.messages };
	}

	const localServerPrefix = localMessages.slice(0, serverMessageCount) as Message[];
	if (serverMessageCount === 0 || syncedHash === hashMessages(localServerPrefix)) {
		const delta = localMessages.slice(serverMessageCount) as Message[];
		const response = await request.postJson("/api/session/append", {
			sessionId,
			messages: delta,
			staticContext: getStaticContext(context),
		});
		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Session append failed (${response.status}): ${errorBody}`);
		}
		markLocalSynced(sessionId, localMessages);
		return { synced: true, messages: localMessages };
	}

	const history = await fetchServerHistory(sessionId, request);
	if (!isPrefix(history.messages, localMessages)) {
		markLocalSynced(sessionId, history.messages);
		options.onHistoryReconciled?.({ reason: "server_authoritative", messages: history.messages });
		return { synced: true, messages: history.messages };
	}

	const delta = localMessages.slice(history.messages.length) as Message[];
	if (delta.length === 0 && !options.syncWhenUnsent) {
		return { synced: false, messages: localMessages };
	}

	const response = await request.postJson("/api/session/append", {
		sessionId,
		messages: delta,
		staticContext: getStaticContext(context),
	});
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Session append failed (${response.status}): ${errorBody}`);
	}
	markLocalSynced(sessionId, localMessages);
	return { synced: true, messages: localMessages };
}

export interface PiServerCompactOptions extends SimpleStreamOptions {
	customInstructions?: string;
	settings?: unknown;
	onHistoryReconciled?: (reconciliation: PiServerHistoryReconciliation) => void;
}

export async function compactPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerCompactOptions,
): Promise<void> {
	const sessionId = options?.sessionId ?? "default";
	const request = createPiServerRequest(options?.signal);

	const init = await ensureSessionInit(sessionId, context, request);
	const sync = await syncPiServerSessionIfNeeded(sessionId, context, request, init.messageCount, {
		syncWhenUnsent: true,
		onHistoryReconciled: options?.onHistoryReconciled,
	});

	const response = await request.postJson("/api/session/compact", {
		sessionId,
		model,
		options: serializeOptions(options),
		settings: options?.settings,
		customInstructions: options?.customInstructions,
	});
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Server compaction failed (${response.status}): ${errorBody}`);
	}
	markLocalSynced(sessionId, sync.messages);
}

interface DropLastAssistantErrorResponse {
	dropped?: boolean;
	messageCount?: number;
}

export async function dropLastPiServerAssistantError(sessionId: string, context: Context): Promise<void> {
	const request = createPiServerRequest();
	const response = await request.postJson("/api/session/drop-last-assistant-error", { sessionId });
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Dropping server assistant error failed (${response.status}): ${errorBody}`);
	}

	const result = (await response.json()) as DropLastAssistantErrorResponse;
	if (result.dropped) {
		markLocalSynced(sessionId, context.messages as Message[]);
		return;
	}

	const didSync = await syncPiServerSessionIfNeeded(sessionId, context, request, result.messageCount ?? 0, {
		syncWhenUnsent: true,
	});
	if (!didSync.synced) {
		markLocalSynced(sessionId, context.messages as Message[]);
	}
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
			const init = await ensureSessionInit(sessionId, context, request);

			const sync = await syncPiServerSessionIfNeeded(sessionId, context, request, init.messageCount, {
				onHistoryReconciled: options?.onHistoryReconciled,
			});
			const delta = sync.synced ? [] : getDelta(context, sessionId);

			const response = await request.postJson("/api/stream", {
				sessionId,
				model,
				delta,
				options: serializeOptions(options),
			});

			if (!response.ok) {
				let errorMessage = `pi-server error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `pi-server error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

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

			markLocalSynced(sessionId, [...sync.messages, partial]);
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
