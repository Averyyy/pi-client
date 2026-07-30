/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

// Internal import for JSON parsing utility
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";

export const DEFAULT_PROXY_RESPONSE_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_PROXY_RESPONSE_MAX_EVENT_BYTES = 257 * 1024 * 1024;
const PROXY_ERROR_BODY_MAX_BYTES = 64 * 1024;

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string; content?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string; redacted?: boolean; content?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; thoughtSignature?: string; toolCall?: ToolCall }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			responseModel?: string;
			responseId?: string;
			diagnostics?: AssistantMessage["diagnostics"];
			api?: AssistantMessage["api"];
			provider?: AssistantMessage["provider"];
			model?: string;
			timestamp?: number;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
			responseModel?: string;
			responseId?: string;
			diagnostics?: AssistantMessage["diagnostics"];
			api?: AssistantMessage["api"];
			provider?: AssistantMessage["provider"];
			model?: string;
			timestamp?: number;
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/**
	 * Maximum time without response headers or a non-empty response-body chunk.
	 * This is an idle timeout that resets on progress, not a total request deadline.
	 */
	responseNoProgressTimeoutMs?: number;
	/** Maximum UTF-8 size of one SSE line before the response is rejected. */
	responseMaxEventBytes?: number;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

function getProxyResponseNoProgressTimeoutMs(options: ProxyStreamOptions): number {
	const timeoutMs = options.responseNoProgressTimeoutMs ?? DEFAULT_PROXY_RESPONSE_NO_PROGRESS_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError("responseNoProgressTimeoutMs must be a positive safe integer");
	}
	return timeoutMs;
}

function getProxyResponseMaxEventBytes(options: ProxyStreamOptions): number {
	const maxEventBytes = options.responseMaxEventBytes ?? DEFAULT_PROXY_RESPONSE_MAX_EVENT_BYTES;
	if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
		throw new RangeError("responseMaxEventBytes must be a positive safe integer");
	}
	return maxEventBytes;
}

function createProxyResponseNoProgressError(timeoutMs: number): Error {
	const error = new Error(`Proxy response made no progress for ${timeoutMs}ms`);
	error.name = "ProxyResponseNoProgressError";
	return error;
}

function waitForProxyProgress<T>(
	operation: Promise<T>,
	waitMs: number,
	onTimeout: (error: Error) => void,
	reportedTimeoutMs = waitMs,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const error = createProxyResponseNoProgressError(reportedTimeoutMs);
			onTimeout(error);
			reject(error);
		}, waitMs);

		void operation.then(
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
	});
}

interface ProxyBodyNoProgressState {
	timeoutMs: number;
	deadlineMs: number;
}

async function readProxyBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: ProxyBodyNoProgressState,
	onTimeout: (error: Error) => void,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	while (true) {
		const remainingMs = state.deadlineMs - Date.now();
		if (remainingMs <= 0) {
			const error = createProxyResponseNoProgressError(state.timeoutMs);
			onTimeout(error);
			throw error;
		}
		const result = await waitForProxyProgress(reader.read(), remainingMs, onTimeout, state.timeoutMs);
		if (result.done || result.value.byteLength > 0) {
			if (!result.done) state.deadlineMs = Date.now() + state.timeoutMs;
			return result;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function readProxyResponseBodyText(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
	onTimeout: (error: Error) => void,
): Promise<string> {
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let receivedBytes = 0;
	const noProgress: ProxyBodyNoProgressState = {
		timeoutMs,
		deadlineMs: Date.now() + timeoutMs,
	};
	while (true) {
		const { done, value } = await readProxyBodyChunk(reader, noProgress, onTimeout);
		if (done) break;
		receivedBytes += value.byteLength;
		if (receivedBytes > PROXY_ERROR_BODY_MAX_BYTES) {
			throw new Error(`Proxy error response body exceeded ${PROXY_ERROR_BODY_MAX_BYTES} bytes`);
		}
		parts.push(decoder.decode(value, { stream: true }));
	}
	parts.push(decoder.decode());
	return parts.join("");
}

export function streamProxy(model: Model<Api>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		const requestController = new AbortController();
		// Initialize the partial message that we'll build up from events
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

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		const abortHandler = () => {
			requestController.abort(options.signal?.reason);
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
			if (options.signal.aborted) {
				abortHandler();
			}
		}

		try {
			const responseNoProgressTimeoutMs = getProxyResponseNoProgressTimeoutMs(options);
			const responseMaxEventBytes = getProxyResponseMaxEventBytes(options);
			const response = await waitForProxyProgress(
				fetch(`${options.proxyUrl}/api/stream`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${options.authToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model,
						context,
						options: buildProxyRequestOptions(options),
					}),
					signal: requestController.signal,
				}),
				responseNoProgressTimeoutMs,
				(error) => {
					requestController.abort(error);
				},
			);

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				if (response.body) {
					reader = response.body.getReader();
					const errorBody = await readProxyResponseBodyText(reader, responseNoProgressTimeoutMs, (error) => {
						requestController.abort(error);
						void reader?.cancel(error).catch(() => {});
					});
					try {
						const errorData = JSON.parse(errorBody) as { error?: string };
						if (errorData.error) {
							errorMessage = `Proxy error: ${errorData.error}`;
						}
					} catch {
						// Couldn't parse error response
					}
				}
				throw new Error(errorMessage);
			}

			if (!response.body) {
				throw new Error("Proxy response did not include a response body");
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			const encoder = new TextEncoder();
			const lineParts: string[] = [];
			let lineBytes = 0;
			let terminalReceived = false;
			const noProgress: ProxyBodyNoProgressState = {
				timeoutMs: responseNoProgressTimeoutMs,
				deadlineMs: Date.now() + responseNoProgressTimeoutMs,
			};

			const consumeLine = (rawLine: string): void => {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (!line.startsWith("data:")) return;
				const data = line.slice(5).trim();
				if (!data) return;
				const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
				const event = processProxyEvent(proxyEvent, partial);
				if (!event) return;
				if (event.type === "done" || event.type === "error") {
					terminalReceived = true;
				}
				stream.push(event);
			};

			const consumeDecodedText = (text: string, final: boolean): void => {
				let lineStart = 0;
				let newlineIndex = text.indexOf("\n", lineStart);
				while (newlineIndex !== -1) {
					const part = text.slice(lineStart, newlineIndex);
					lineBytes += encoder.encode(part).byteLength;
					if (lineBytes > responseMaxEventBytes) {
						throw new Error(`Proxy response event exceeded ${responseMaxEventBytes} bytes`);
					}
					lineParts.push(part);
					const line = lineParts.length === 1 ? lineParts[0] : lineParts.join("");
					lineParts.length = 0;
					lineBytes = 0;
					consumeLine(line);
					if (terminalReceived) return;
					lineStart = newlineIndex + 1;
					newlineIndex = text.indexOf("\n", lineStart);
				}
				const remainder = text.slice(lineStart);
				if (remainder.length > 0) {
					lineBytes += encoder.encode(remainder).byteLength;
					if (lineBytes > responseMaxEventBytes) {
						throw new Error(`Proxy response event exceeded ${responseMaxEventBytes} bytes`);
					}
					lineParts.push(remainder);
				}
				if (final && lineParts.length > 0) {
					const line = lineParts.length === 1 ? lineParts[0] : lineParts.join("");
					lineParts.length = 0;
					lineBytes = 0;
					consumeLine(line);
				}
			};

			while (true) {
				const { done, value } = await readProxyBodyChunk(reader, noProgress, (error) => {
					requestController.abort(error);
					void reader?.cancel(error).catch(() => {});
				});
				if (done) {
					consumeDecodedText(decoder.decode(), true);
					break;
				}

				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				consumeDecodedText(decoder.decode(value, { stream: true }), false);
				if (terminalReceived) {
					void reader.cancel("Terminal response received").catch(() => {});
					break;
				}
			}

			if (!terminalReceived && options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}
			if (!terminalReceived) {
				throw new Error("Proxy stream ended before a terminal response event");
			}

			stream.end();
		} catch (error) {
			const reason = options.signal?.aborted ? "aborted" : "error";
			const errorMessage =
				reason === "aborted" ? "Request aborted by user" : error instanceof Error ? error.message : String(error);
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
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
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				if (proxyEvent.content !== undefined) {
					content.text = proxyEvent.content;
				}
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
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
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				if (proxyEvent.content !== undefined) {
					content.thinking = proxyEvent.content;
				}
				content.thinkingSignature = proxyEvent.contentSignature;
				content.redacted = proxyEvent.redacted;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
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
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				delete (content as ToolCall & { partialJson?: string }).partialJson;
				const toolCall = proxyEvent.toolCall ?? content;
				toolCall.thoughtSignature = proxyEvent.thoughtSignature ?? toolCall.thoughtSignature;
				partial.content[proxyEvent.contentIndex] = toolCall;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			if (proxyEvent.reason !== "stop" && proxyEvent.reason !== "length" && proxyEvent.reason !== "toolUse") {
				throw new Error(`Received invalid terminal done reason: ${String(proxyEvent.reason)}`);
			}
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			partial.responseModel = proxyEvent.responseModel;
			partial.responseId = proxyEvent.responseId;
			partial.diagnostics = proxyEvent.diagnostics;
			partial.api = proxyEvent.api ?? partial.api;
			partial.provider = proxyEvent.provider ?? partial.provider;
			partial.model = proxyEvent.model ?? partial.model;
			partial.timestamp = proxyEvent.timestamp ?? partial.timestamp;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			if (proxyEvent.reason !== "aborted" && proxyEvent.reason !== "error") {
				throw new Error(`Received invalid terminal error reason: ${String(proxyEvent.reason)}`);
			}
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			partial.responseModel = proxyEvent.responseModel;
			partial.responseId = proxyEvent.responseId;
			partial.diagnostics = proxyEvent.diagnostics;
			partial.api = proxyEvent.api ?? partial.api;
			partial.provider = proxyEvent.provider ?? partial.provider;
			partial.model = proxyEvent.model ?? partial.model;
			partial.timestamp = proxyEvent.timestamp ?? partial.timestamp;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			return _exhaustiveCheck;
		}
	}
}
