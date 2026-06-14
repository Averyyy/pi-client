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
import { postJsonToPiServer } from "./pi-server-request.ts";

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

async function ensureSessionInit(sessionId: string, context: Context): Promise<void> {
	const currentHash = hashStaticContext(context);
	const previousHash = sessionStaticContextHashes.get(sessionId);

	if (previousHash === currentHash) return;

	const staticContext = {
		systemPrompt: context.systemPrompt,
		tools: context.tools,
	};

	const endpoint = previousHash === undefined ? "/api/session/init" : "/api/session/update";

	const serverUrl = getServerUrl();
	const authToken = getAuthToken();

	const response = await postJsonToPiServer(endpoint, { sessionId, staticContext }, { serverUrl, authToken });

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Session init failed (${response.status}): ${errorBody}`);
	}

	const result = (await response.json()) as SessionInitResponse;
	sessionStaticContextHashes.set(sessionId, currentHash);

	if (result.messageCount > 0 && !sessionSentCounts.has(sessionId)) {
		sessionSentCounts.set(sessionId, result.messageCount);
	}
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

async function syncPiServerSessionIfNeeded(
	sessionId: string,
	context: Context,
	options: { serverUrl: string; authToken: string; signal?: AbortSignal; syncWhenUnsent?: boolean },
): Promise<boolean> {
	const sentCount = sessionSentCounts.get(sessionId) ?? 0;
	const syncedHash = sessionLocalContextHashes.get(sessionId);
	if (sentCount === 0) {
		if (!options.syncWhenUnsent || context.messages.length === 0) return false;
	} else {
		const prefix = context.messages.slice(0, sentCount) as Message[];
		if (syncedHash !== undefined && context.messages.length >= sentCount && hashMessages(prefix) === syncedHash) {
			return false;
		}
	}

	const response = await postJsonToPiServer(
		"/api/session/sync",
		{
			sessionId,
			messages: context.messages,
			staticContext: getStaticContext(context),
		},
		options,
	);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Session sync failed (${response.status}): ${errorBody}`);
	}
	markLocalSynced(sessionId, context.messages as Message[]);
	return true;
}

export interface PiServerCompactOptions extends SimpleStreamOptions {
	customInstructions?: string;
	settings?: unknown;
	dropLastAssistantError?: boolean;
}

export async function compactPiServer(
	model: Model<any>,
	context: Context,
	options?: PiServerCompactOptions,
): Promise<void> {
	const sessionId = options?.sessionId ?? "default";
	const serverUrl = getServerUrl();
	const authToken = getAuthToken();

	await ensureSessionInit(sessionId, context);
	await syncPiServerSessionIfNeeded(sessionId, context, {
		serverUrl,
		authToken,
		signal: options?.signal,
		syncWhenUnsent: true,
	});

	const response = await postJsonToPiServer(
		"/api/session/compact",
		{
			sessionId,
			model,
			options: serializeOptions(options),
			settings: options?.settings,
			customInstructions: options?.customInstructions,
			dropLastAssistantError: options?.dropLastAssistantError,
		},
		{ serverUrl, authToken, signal: options?.signal },
	);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Server compaction failed (${response.status}): ${errorBody}`);
	}
	markLocalSynced(sessionId, context.messages as Message[]);
}

interface DropLastAssistantErrorResponse {
	dropped?: boolean;
}

export async function dropLastPiServerAssistantError(sessionId: string, context: Context): Promise<void> {
	const serverUrl = getServerUrl();
	const authToken = getAuthToken();
	const response = await postJsonToPiServer(
		"/api/session/drop-last-assistant-error",
		{ sessionId },
		{ serverUrl, authToken },
	);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Dropping server assistant error failed (${response.status}): ${errorBody}`);
	}

	const result = (await response.json()) as DropLastAssistantErrorResponse;
	if (result.dropped) {
		markLocalSynced(sessionId, context.messages as Message[]);
		return;
	}

	const didSync = await syncPiServerSessionIfNeeded(sessionId, context, {
		serverUrl,
		authToken,
		syncWhenUnsent: true,
	});
	if (!didSync) {
		markLocalSynced(sessionId, context.messages as Message[]);
	}
}

export async function streamPiServer(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
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
			await ensureSessionInit(sessionId, context);

			const serverUrl = getServerUrl();
			const authToken = getAuthToken();
			const requestOptions = { serverUrl, authToken, signal: options?.signal };
			const didSync = await syncPiServerSessionIfNeeded(sessionId, context, requestOptions);
			const delta = didSync ? [] : getDelta(context, sessionId);

			const response = await postJsonToPiServer(
				"/api/stream",
				{
					sessionId,
					model,
					delta,
					options: serializeOptions(options),
				},
				requestOptions,
			);

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

			markLocalSynced(sessionId, [...(context.messages as Message[]), partial]);
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
