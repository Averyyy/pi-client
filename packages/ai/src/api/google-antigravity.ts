import type { Content, GenerateContentResponse } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	JsonObject,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getCurrentTools } from "../utils/transcript.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	ANTIGRAVITY_USER_AGENT,
	antigravityRequestIdentity,
} from "./google-antigravity-client.ts";
import { type AntigravityRouteLevel, antigravityRoutes } from "./google-antigravity-model.ts";
import { adaptAntigravitySystemPrompt } from "./google-antigravity-prompt.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	resolveGoogleFunctionCallingMode,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/** Thinking levels Antigravity accepts; XHIGH exists only on its catalog routes. */
export type AntigravityThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

export interface GoogleAntigravityOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		level?: AntigravityThinkingLevel;
	};
}

interface AntigravityRequest {
	project: string;
	model: string;
	requestType: "agent";
	userAgent: "antigravity";
	requestId: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role: "user"; parts: { text: string }[] };
		generationConfig: {
			temperature?: number;
			maxOutputTokens?: number;
			thinkingConfig?: { includeThoughts: true; thinkingLevel: AntigravityThinkingLevel };
		};
		tools: { functionDeclarations: Record<string, unknown>[] }[];
		toolConfig?: { functionCallingConfig: { mode: ReturnType<typeof resolveGoogleFunctionCallingMode> } };
		labels?: Record<string, string>;
	};
}

interface AntigravityChunk {
	response?: GenerateContentResponse;
	error?: AntigravityError;
}

interface AntigravityError {
	code?: number;
	message?: string;
	status?: unknown;
	details?: unknown;
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export const stream: StreamFunction<"google-antigravity", GoogleAntigravityOptions> = (model, context, options) => {
	const events = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "google-antigravity",
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
		stopReason: "pending",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			if (typeof process !== "undefined" && process.env.PI_SERVER_MODE === "true") {
				throw new Error("Google Antigravity inference must use pi-server in PI_SERVER_MODE");
			}
			if (!options?.apiKey) throw new Error("Google Antigravity requires OAuth authentication. Use /login.");
			const credential = JSON.parse(options.apiKey) as { token: string; projectId: string };
			if (!credential || typeof credential.token !== "string" || typeof credential.projectId !== "string") {
				throw new Error("Invalid Google Antigravity credentials. Use /login to authenticate.");
			}
			let payload: unknown = buildRequest(model, context, credential.projectId, options);
			const transformed = await options.onPayload?.(payload, model);
			if (transformed !== undefined) payload = transformed;
			const headers = providerHeadersToRecord(
				{
					Authorization: `Bearer ${credential.token}`,
					"Content-Type": "application/json",
					"User-Agent": ANTIGRAVITY_USER_AGENT,
					...(model.id.startsWith("claude-") && model.reasoning
						? { "anthropic-beta": "interleaved-thinking-2025-05-14" }
						: {}),
				},
				model.headers,
				options.headers,
			);
			const body = JSON.stringify(payload);
			const { response, signal } = await retryProviderRequest(
				async () => {
					const timeout = AbortSignal.timeout(options.timeoutMs ?? 600_000);
					const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
					signal.throwIfAborted();
					let response: Response;
					try {
						response = await (options.fetch ?? globalThis.fetch)(
							`${(model.baseUrl || DEFAULT_ENDPOINT).replace(/\/$/, "")}/v1internal:streamGenerateContent?alt=sse`,
							{ method: "POST", redirect: "error", headers, body, signal },
						);
					} catch (error) {
						throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
							status: undefined,
							headers: undefined,
						});
					}
					await options.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (!response.ok) {
						throw Object.assign(new Error("Google Antigravity request failed"), {
							status: response.status,
							headers: response.headers,
							body: await response.text(),
						});
					}
					return { response, signal };
				},
				{ maxRetries: options.maxRetries ?? 2, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal },
			);
			events.push({ type: "start", partial: output });
			let promptTokens: number | undefined;
			let current: TextContent | ThinkingContent | undefined;
			const endBlock = () => {
				if (!current) return;
				const contentIndex = output.content.length - 1;
				if (current.type === "text") {
					events.push({ type: "text_end", contentIndex, content: current.text, partial: output });
				} else {
					events.push({ type: "thinking_end", contentIndex, content: current.thinking, partial: output });
				}
				current = undefined;
			};
			for await (const chunk of parseStream(response, signal)) {
				await options.onProviderStreamEvent?.(chunk, model);
				if (chunk.error) {
					appendAntigravityFailure(output, chunk.error.code, chunk.error);
					throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
				}
				if (!chunk.response) throw new Error("Google Antigravity stream event has no response");
				const data = chunk.response;
				output.responseId ||= data.responseId;
				output.responseModel ||= data.modelVersion;
				const candidate = data.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined || (part.thoughtSignature && !part.functionCall)) {
						const thinking = isThinkingPart(part);
						const signature = current?.type === "thinking" ? current.thinkingSignature : current?.textSignature;
						if (
							!current ||
							(thinking ? current.type !== "thinking" : current.type !== "text") ||
							(signature && part.thoughtSignature && signature !== part.thoughtSignature)
						) {
							endBlock();
							current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
							output.content.push(current);
							events.push({
								type: thinking ? "thinking_start" : "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						const delta = part.text ?? "";
						const contentIndex = output.content.length - 1;
						if (current.type === "thinking") {
							current.thinking += delta;
							current.thinkingSignature = retainThoughtSignature(
								current.thinkingSignature,
								part.thoughtSignature,
							);
							events.push({ type: "thinking_delta", contentIndex, delta, partial: output });
						} else {
							current.text += delta;
							current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
							events.push({ type: "text_delta", contentIndex, delta, partial: output });
						}
					}
					if (part.functionCall) {
						endBlock();
						const call = part.functionCall;
						if (
							!call.name ||
							(call.args !== undefined &&
								(call.args === null || Array.isArray(call.args) || typeof call.args !== "object"))
						) {
							throw new Error("Google Antigravity returned an invalid function call");
						}
						const toolCall: ToolCall = {
							type: "toolCall",
							id: call.id ?? `call_${crypto.randomUUID()}`,
							name: call.name,
							arguments: (call.args ?? {}) as JsonObject,
							...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
						};
						const contentIndex = output.content.length;
						output.content.push(toolCall);
						events.push({ type: "toolcall_start", contentIndex, partial: output });
						events.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						events.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					}
				}
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					switch (candidate.finishReason) {
						case "STOP":
							output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
							break;
						case "MAX_TOKENS":
							output.stopReason = "length";
							break;
						default:
							output.stopReason = "error";
					}
				}
				if (data.usageMetadata) {
					const usage = data.usageMetadata;
					// Later SSE frames may omit prompt counters already reported for this request.
					promptTokens = usage.promptTokenCount ?? promptTokens;
					output.usage.cacheRead = usage.cachedContentTokenCount ?? output.usage.cacheRead;
					output.usage.input = promptTokens === undefined ? 0 : promptTokens - output.usage.cacheRead;
					output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
					output.usage.reasoning = usage.thoughtsTokenCount ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead;
					calculateCost(model, output.usage);
				}
			}
			endBlock();
			signal.throwIfAborted();
			if (output.stopReason === "pending")
				throw new Error("Google Antigravity stream ended without a finish reason");
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(`Google Antigravity stopped with: ${output.rawStopReason}`);
			}
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const failure = normalizeProviderError(error);
			if (failure.status !== undefined) {
				let upstream: AntigravityError | undefined;
				if (failure.body) {
					try {
						upstream = (JSON.parse(failure.body) as { error?: AntigravityError } | null)?.error;
					} catch {
						// Non-JSON HTTP errors still carry the response status.
					}
				}
				appendAntigravityFailure(output, failure.status, upstream);
			}
			output.errorMessage = formatProviderError(failure);
			events.push({ type: "error", reason: output.stopReason, error: output });
		}
		events.end();
	})();
	return events;
};

const RPC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function appendAntigravityFailure(
	message: AssistantMessage,
	status: number | undefined,
	upstream?: AntigravityError,
): void {
	const details: JsonObject = {};
	if (status !== undefined) details.status = status;
	// Google RPC detail metadata and messages can contain the request and account identifiers.
	if (typeof upstream?.status === "string" && RPC_CODE_PATTERN.test(upstream.status)) {
		details.rpcStatus = upstream.status;
	}
	if (Array.isArray(upstream?.details)) {
		for (const entry of upstream.details as ({
			"@type": string;
			reason?: unknown;
			retryDelay?: unknown;
			violations?: unknown;
		} | null)[]) {
			switch (entry?.["@type"]) {
				case "type.googleapis.com/google.rpc.ErrorInfo":
					if (typeof entry.reason === "string" && RPC_CODE_PATTERN.test(entry.reason)) {
						details.reason = entry.reason;
					}
					break;
				case "type.googleapis.com/google.rpc.RetryInfo":
					if (typeof entry.retryDelay === "string" && /^\d{1,10}(?:\.\d{1,9})?s$/.test(entry.retryDelay)) {
						details.retryDelay = entry.retryDelay;
					}
					break;
				case "type.googleapis.com/google.rpc.QuotaFailure":
					if (Array.isArray(entry.violations)) details.quotaViolations = entry.violations.length;
					break;
			}
		}
	}
	appendAssistantMessageDiagnostic(message, {
		type: "google_antigravity_response_failure",
		timestamp: Date.now(),
		details,
	});
}

export const streamSimple: StreamFunction<"google-antigravity", SimpleStreamOptions> = (model, context, options) => {
	if (!options?.apiKey) throw new Error("Google Antigravity requires OAuth authentication. Use /login.");
	const base = { ...buildBaseOptions(model, context, options), toolChoice: options?.toolChoice };
	if (!options?.reasoning) return stream(model, context, { ...base, thinking: { enabled: false } });
	const level = clampThinkingLevel(model, options.reasoning);
	if (level === "off") return stream(model, context, { ...base, thinking: { enabled: false } });
	return stream(model, context, {
		...base,
		thinking: { enabled: true, level: antigravityThinkingLevel(model, level) },
	});
};

/** Resolve a pi level to the effort enum Antigravity accepts, honoring the model's map. */
function antigravityThinkingLevel(
	model: Model<"google-antigravity">,
	level: ModelThinkingLevel,
): AntigravityThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolved = (typeof mapped === "string" ? mapped : level).toLowerCase();
	switch (resolved) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
		case "xhigh":
			return "XHIGH";
		default:
			throw new Error(`Unsupported Antigravity thinking level for ${model.provider}/${model.id}: ${level}`);
	}
}

function buildRequest(
	model: Model<"google-antigravity">,
	context: TranscriptContext,
	projectId: string,
	options: GoogleAntigravityOptions,
): AntigravityRequest {
	const tools = getCurrentTools(context.messages);
	const systemPrompt = adaptAntigravitySystemPrompt(context.messages);
	const strict = supportsGoogleStrictToolSampling(model.id);
	const mode = tools.length > 0 ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined;
	const routes = antigravityRoutes(model);
	const route =
		(options.thinking?.enabled && options.thinking.level
			? routes?.levels[options.thinking.level.toLowerCase() as AntigravityRouteLevel]
			: undefined) ?? routes?.default;
	const runtimeId = route?.runtimeId ?? model.id;
	const contents = convertMessages(model, context);
	// The CLI replays tool results for this route as model turns; every other route keeps user.
	if (runtimeId === "gemini-3.8-flash-low") {
		for (const content of contents) {
			if (content.parts?.length && content.parts.every((part) => part.functionResponse !== undefined)) {
				content.role = "model";
			}
		}
	}
	const step = Math.max(0, contents.length - 1);
	const identity = antigravityRequestIdentity(options.sessionId);
	const timestamp = Date.now();
	const generationConfig: AntigravityRequest["request"]["generationConfig"] = {
		temperature: options.temperature,
		maxOutputTokens: options.maxTokens,
		...(options.thinking?.enabled && options.thinking.level
			? { thinkingConfig: { includeThoughts: true as const, thinkingLevel: options.thinking.level } }
			: {}),
	};
	return {
		project: projectId,
		model: runtimeId,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent/${identity.cascadeId}/${timestamp}/${identity.requestUuid}/${step}`,
		request: {
			contents,
			sessionId: ANTIGRAVITY_SESSION_ID,
			generationConfig,
			...(systemPrompt && {
				systemInstruction: { role: "user" as const, parts: [{ text: sanitizeSurrogates(systemPrompt) }] },
			}),
			// The CLI always sends the array, empty when the request declares no tools.
			tools: antigravityTools(tools, model.id.startsWith("claude-"), strict),
			...(route && {
				labels: antigravityLabels(route.runtimeId, route.modelEnum, identity, step),
			}),
			...(mode !== undefined && { toolConfig: { functionCallingConfig: { mode } } }),
		},
	};
}

/** One declaration per wrapper, matching the shape the official CLI sends. */
function antigravityTools(
	tools: Tool[],
	useParameters: boolean,
	strict: boolean,
): { functionDeclarations: Record<string, unknown>[] }[] {
	const converted = convertTools(tools, useParameters, strict) ?? [];
	return converted.flatMap((group) =>
		group.functionDeclarations.map((declaration) => ({ functionDeclarations: [declaration] })),
	);
}

/** Launch labels the official CLI attaches to every request. */
function antigravityLabels(
	runtimeId: string,
	modelEnum: string | undefined,
	identity: ReturnType<typeof antigravityRequestIdentity>,
	step: number,
): Record<string, string> {
	return {
		cascade_id: identity.cascadeId,
		root_cascade_id: identity.rootCascadeId,
		trajectory_id: identity.trajectoryId,
		request_id: `${identity.requestUuid}-0`,
		last_step_index: String(step),
		...(modelEnum ? { model_enum: modelEnum } : {}),
		used_claude: String(runtimeId.startsWith("claude-")),
		used_claude_conservative: String(runtimeId.startsWith("claude-")),
		used_non_gemini_model: String(!runtimeId.startsWith("gemini-")),
	};
}

async function* parseStream(response: Response, signal: AbortSignal): AsyncGenerator<AntigravityChunk> {
	if (!response.body) throw new Error("Google Antigravity response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const data: string[] = [];
	let cancellation: Promise<void> | undefined;
	const abort = () => {
		// Fetch may have already errored the body. The read path reports the request's abort reason.
		cancellation = reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			signal.throwIfAborted();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (done && buffer.length > 0) buffer += "\n";
			let end = buffer.indexOf("\n");
			while (end !== -1) {
				const line = buffer.slice(0, end).replace(/\r$/, "");
				buffer = buffer.slice(end + 1);
				if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
				if (line === "" && data.length > 0) {
					yield JSON.parse(data.join("\n")) as AntigravityChunk;
					data.length = 0;
				}
				end = buffer.indexOf("\n");
			}
			if (done) {
				if (data.length > 0) yield JSON.parse(data.join("\n")) as AntigravityChunk;
				break;
			}
		}
	} finally {
		signal.removeEventListener("abort", abort);
		try {
			await (cancellation ?? reader.cancel());
		} finally {
			reader.releaseLock();
		}
	}
}
