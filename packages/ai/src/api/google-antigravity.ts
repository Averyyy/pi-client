import type { Content, GenerateContentResponse, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	type GoogleApiThinkingLevel,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";

export interface GoogleAntigravityOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
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
		systemInstruction?: { parts: { text: string }[] };
		generationConfig: { temperature?: number; maxOutputTokens?: number; thinkingConfig?: ThinkingConfig };
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: { functionCallingConfig: { mode: ReturnType<typeof resolveGoogleFunctionCallingMode> } };
	};
}

interface AntigravityChunk {
	response?: GenerateContentResponse;
	error?: { code?: number; message?: string; status?: string };
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
					Accept: "text/event-stream",
					"User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
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
							{ method: "POST", headers, body, signal },
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
				if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
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
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.stopReason === "stop" && output.content.some((part) => part.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
				}
				if (data.usageMetadata) {
					const usage = data.usageMetadata;
					output.usage.input = (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0);
					output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
					output.usage.cacheRead = usage.cachedContentTokenCount ?? 0;
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
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			events.push({ type: "error", reason: output.stopReason, error: output });
		}
		events.end();
	})();
	return events;
};

export const streamSimple: StreamFunction<"google-antigravity", SimpleStreamOptions> = (model, context, options) => {
	if (!options?.apiKey) throw new Error("Google Antigravity requires OAuth authentication. Use /login.");
	const base = { ...buildBaseOptions(model, context, options), toolChoice: options?.toolChoice };
	if (!options?.reasoning) return stream(model, context, { ...base, thinking: { enabled: false } });
	const level = clampThinkingLevel(model, options.reasoning);
	if (level === "off") return stream(model, context, { ...base, thinking: { enabled: false } });
	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: toGoogleThinkingLevel(resolveGoogleThinkingLevel(model, level)) },
		});
	}
	const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		level,
		options?.thinkingBudgets,
	);
	return stream(model, context, { ...base, maxTokens, thinking: { enabled: true, budgetTokens: thinkingBudget } });
};

function buildRequest(
	model: Model<"google-antigravity">,
	context: TranscriptContext,
	projectId: string,
	options: GoogleAntigravityOptions,
): AntigravityRequest {
	const tools = getCurrentTools(context.messages);
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const strict = supportsGoogleStrictToolSampling(model.id);
	const mode = tools.length > 0 ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined;
	const generationConfig: AntigravityRequest["request"]["generationConfig"] = {
		temperature: options.temperature,
		maxOutputTokens: options.maxTokens,
	};
	if (model.reasoning && options.thinking) {
		generationConfig.thinkingConfig = options.thinking.enabled
			? {
					includeThoughts: true,
					...(options.thinking.level !== undefined
						? { thinkingLevel: toGoogleSdkThinkingLevel(options.thinking.level) }
						: { thinkingBudget: options.thinking.budgetTokens }),
				}
			: getDisabledGoogleThinkingConfig(model);
	}
	return {
		project: projectId,
		model: model.id,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent-${crypto.randomUUID()}`,
		request: {
			contents: convertMessages(model, context),
			sessionId: options.sessionId,
			generationConfig,
			...(systemPrompt && { systemInstruction: { parts: [{ text: sanitizeSurrogates(systemPrompt) }] } }),
			...(tools.length > 0 && { tools: convertTools(tools, model.id.startsWith("claude-"), strict) }),
			...(mode !== undefined && { toolConfig: { functionCallingConfig: { mode } } }),
		},
	};
}

async function* parseStream(response: Response, signal: AbortSignal): AsyncGenerator<AntigravityChunk> {
	if (!response.body) throw new Error("Google Antigravity response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const data: string[] = [];
	const abort = () => {
		void reader.cancel(signal.reason);
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
		await reader.cancel();
		reader.releaseLock();
	}
}
