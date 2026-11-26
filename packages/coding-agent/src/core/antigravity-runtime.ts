// A Pi session's live agy ACP conversation: agy is the agent, Pi shows and records its turns.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { type AgentToolCallOutcome, createToolResultMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	type ImageContent,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { McpError } from "@earendil-works/pi-mcp";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import {
	type AcpConfigOption,
	type AcpInitialize,
	type AcpSession,
	ANTIGRAVITY_PROVIDER,
	AntigravityAcp,
	acpChoices,
	isAntigravityAuthRequired,
} from "./antigravity-acp.ts";
import { type AntigravityInstructions, installAntigravityInstructions } from "./antigravity-instructions.ts";
import {
	type AcpFormRequest,
	type AcpPlanEntry,
	type answerAntigravityQuestion,
	antigravityPlanResult,
} from "./antigravity-interactions.ts";
import {
	type AcpToolCallUpdate,
	AntigravityNativeTools,
	type AntigravityToolDisplay,
	type AntigravityToolRecord,
} from "./antigravity-native-tools.ts";
import { type AntigravityToolExecutor, openAntigravityTools } from "./antigravity-tools.ts";
import type { AntigravityWorkspaceRequest } from "./antigravity-workspace.ts";
import { BRANCH_SUMMARY_PREFIX, COMPACTION_SUMMARY_PREFIX } from "./messages.ts";

interface AcpPermission {
	sessionId?: string;
	title?: string;
	toolCall?: { toolCallId?: string; name?: string; title?: string };
	subject?: { type: "tool_call"; toolCall: { toolCallId: string; name?: string; title?: string } };
	options: { optionId: string; name: string; kind?: string }[];
}

type AcpPermissionResult = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

interface AcpUpdate {
	sessionUpdate: string;
	content?: TextContent | ImageContent;
	configOptions?: AcpConfigOption[];
	entries?: AcpPlanEntry[];
	plan?: { planId: string } & ({ type: "items"; entries: AcpPlanEntry[] } | { type: "markdown"; content: string });
	planId?: string;
	toolCallId?: string;
	name?: string;
}

/** agy's report of a compaction of its own context; wire input. */
export type AcpCompactionUpdate =
	| { sessionUpdate: "compaction_update"; compactionId: string; status: string; error?: string | null }
	| { sessionUpdate: "compaction_summary_chunk"; compactionId: string };

/** What the interactive Pi session offers agy. Without one, agy does not run. */
export interface AntigravityClient {
	executeTool?: (
		call: Parameters<AntigravityToolExecutor>[0],
		assistant: AssistantMessage,
		signal: AbortSignal,
	) => ReturnType<AntigravityToolExecutor>;
	requestPermission?: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	answerQuestion?: (request: AcpFormRequest, signal: AbortSignal) => ReturnType<typeof answerAntigravityQuestion>;
	/** Show one of agy's own tool calls while it runs, as the Pi tool call it maps to. */
	showToolCall?: (display: AntigravityToolDisplay) => void;
	/** Show a compaction agy makes of its own context. */
	showCompaction?: (update: AcpCompactionUpdate) => void;
	/** Serve agy's `fs/*` and `terminal/*` requests in the Pi workspace. */
	workspace?: (request: AntigravityWorkspaceRequest, signal: AbortSignal) => Promise<unknown>;
	/** Pi tools agy may call over MCP: those from extensions and the SDK, never Pi's built-in tools. */
	toolNames?: readonly string[];
	/** Pi's global AGENTS.md and skills, written as agy's global rule and skill files before agy starts. */
	instructions?: AntigravityInstructions;
}

/** What a host stores to resume a conversation in a new agy process. */
export interface AntigravitySavedConversation {
	sessionId: string;
	/** Digest of the agy reply that ends the session; a branch without that reply starts a new session. */
	reply: string;
}

interface Conversation {
	sessionId: string;
	configOptions: AcpConfigOption[];
	toolDefinitions: string;
	/** Digest of agy's latest reply in this session; undefined before its first completed turn. */
	reply: string | undefined;
	supportsImages: boolean;
	plans: Map<string | null, AcpPlanEntry[]>;
	planChanged: boolean;
	questionToolIds: Set<string>;
	nativeTools: AntigravityNativeTools;
}

interface ActiveTurn {
	client: AntigravityClient;
	executeTool?: AntigravityToolExecutor;
	answerQuestion(request: AcpFormRequest): Promise<Awaited<ReturnType<typeof answerAntigravityQuestion>>["result"]>;
	record(record: AntigravityToolRecord): void;
	signal: AbortSignal;
	update(update: AcpUpdate): void;
}

/** Why agy refuses requests that do not come from the person driving a Pi session. */
export const ANTIGRAVITY_SESSION_ONLY =
	"Antigravity runs only as the agent of an interactive Pi session. Choose another model for summaries and extension requests, for example with the compaction.model setting.";

/**
 * A Pi session's live Antigravity conversation. agy owns its instructions, context, and tools;
 * Pi sends only what the user enters each turn and records agy's replies and tool calls. The
 * user's global AGENTS.md and Pi skills reach agy only as its own native rule and skill files.
 */
export class AntigravityRuntime {
	private readonly cwd: string;
	private readonly host: "Pi" | "PiServer";
	private acp: AntigravityAcp | undefined;
	private conversation: Conversation | undefined;
	private saved: AntigravitySavedConversation | undefined;
	private toolServer: Awaited<ReturnType<typeof openAntigravityTools>> | undefined;
	private activeTurn: ActiveTurn | undefined;

	/** `cwd` is the agy session's working directory; `saved` is a conversation to resume when it still matches. */
	constructor(cwd: string, host: "Pi" | "PiServer" = "Pi", saved?: AntigravitySavedConversation) {
		this.cwd = cwd;
		this.host = host;
		this.saved = saved;
	}

	/** The conversation as of the last completed turn, for a host that resumes it in a new agy process. */
	get savedConversation(): AntigravitySavedConversation | undefined {
		return this.saved;
	}

	stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions, client?: AntigravityClient) {
		const executedToolResults: ToolResultMessage[] = [];
		const stream = Object.assign(createAssistantMessageEventStream(), { executedToolResults });
		const output: AssistantMessage = {
			role: "assistant",
			api: model.api,
			model: model.id,
			provider: model.provider,
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const emit = streamAntigravityUpdates(stream, output);
		const record = (record: AntigravityToolRecord) => {
			if (record.type === "note") return emit.note(record.text);
			emit.toolCall(record.outcome.toolCall);
			executedToolResults.push(createToolResultMessage(record.outcome));
		};
		const signal = options?.signal;
		void (async () => {
			try {
				stream.push({ type: "start", partial: output });
				// agy serves a person driving an interactive Pi session, never Pi's own background requests.
				if (!client) throw new Error(ANTIGRAVITY_SESSION_ONLY);
				const reason = await this.prompt(model, context, options, client, output, emit.update, record);
				if (reason === "cancelled") await this.close();
				emit.end();
				if (signal?.aborted || reason === "cancelled") throw new Error("Antigravity turn cancelled");
				if (reason === "max_turn_requests") throw new Error("Antigravity reached its turn request limit");
				if (this.conversation) {
					this.conversation.reply = digestReply(output);
					this.saved = { sessionId: this.conversation.sessionId, reply: this.conversation.reply };
				}
				output.stopReason = reason === "max_tokens" ? "length" : "stop";
				output.rawStopReason = reason;
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				await this.close();
				emit.end();
				output.stopReason = signal?.aborted ? "aborted" : "error";
				output.errorMessage = isAntigravityAuthRequired(error)
					? `Sign in to agy on the machine running ${this.host}.`
					: error instanceof Error
						? error.message
						: String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				stream.end();
			}
		})();
		return stream;
	}

	async close(): Promise<void> {
		this.toolServer?.close();
		this.toolServer = undefined;
		this.conversation = undefined;
		const acp = this.acp;
		this.acp = undefined;
		await acp?.close();
	}

	private async prompt(
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		client: AntigravityClient,
		output: AssistantMessage,
		onUpdate: (update: AcpUpdate) => void,
		record: (record: AntigravityToolRecord) => void,
	): Promise<string> {
		const signal = operationSignal(options?.signal);
		const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(options?.timeoutMs ?? 30_000)]);
		const activeTools = getCurrentSystemMessage(context.messages)?.toolsAdded ?? [];
		const showTodo = activeTools.some((tool) => tool.name === "todo");
		const exposed = new Set(client.toolNames);
		// agy's native plan and questions stand in for Pi's todo and ask_user_question tools.
		const tools = activeTools.filter(
			(tool) => exposed.has(tool.name) && tool.name !== "todo" && tool.name !== "ask_user_question",
		);
		const toolDefinitions = JSON.stringify(tools);
		const history = context.messages.filter((message) => message.role !== "system");
		const prompt = promptBlocks(history);
		if (prompt.length === 0) throw new Error("Antigravity needs a new user message to start a turn");
		const lastReply = history.findLast(
			(message): message is AssistantMessage =>
				message.role === "assistant" && message.provider === ANTIGRAVITY_PROVIDER,
		);
		const reply = lastReply && digestReply(lastReply);
		const previous = this.conversation;
		const conversation =
			previous &&
			previous.reply !== undefined &&
			previous.reply === reply &&
			previous.toolDefinitions === toolDefinitions
				? previous
				: await this.open(tools, toolDefinitions, reply, client, setupSignal);
		const acp = this.acp!;
		await selectModel(acp, conversation, model.id, options?.reasoning, setupSignal);
		if (prompt.some((part) => part.type === "image") && !conversation.supportsImages) {
			throw new Error("Antigravity CLI does not support images over ACP");
		}
		setupSignal.throwIfAborted();
		const execute = client.executeTool;
		const calls = new Set<Promise<unknown>>();
		const questionController = new AbortController();
		const questionSignal = AbortSignal.any([signal, questionController.signal]);
		const track = async <T>(running: Promise<T>): Promise<T> => {
			calls.add(running);
			try {
				return await running;
			} finally {
				calls.delete(running);
			}
		};
		const addToolResult = (outcome: AgentToolCallOutcome) => record({ type: "tool", outcome });
		this.activeTurn = {
			client,
			signal,
			update: onUpdate,
			record,
			answerQuestion: async (request) => {
				if (!client.answerQuestion)
					throw new McpError(-32601, "Pi has no interactive UI for Antigravity elicitation");
				const answerQuestion = client.answerQuestion;
				return track(
					(async () => {
						const { result, outcome } = await answerQuestion(request, questionSignal);
						addToolResult(outcome);
						return result;
					})(),
				);
			},
			executeTool: execute
				? (call) =>
						track(
							(async () => {
								const outcome = await execute(call, output, signal);
								addToolResult(outcome);
								return outcome;
							})(),
						)
				: undefined,
		};
		try {
			const result = await promptAcp(acp, conversation.sessionId, prompt, signal);
			return result.stopReason;
		} finally {
			this.activeTurn = undefined;
			questionController.abort();
			await Promise.allSettled(calls);
			for (const change of conversation.nativeTools.finish("Antigravity ended the turn before this tool finished")) {
				client.showToolCall?.(change.display);
				record(change.record);
			}
			if (conversation.planChanged && showTodo) {
				addToolResult(antigravityPlanResult([...conversation.plans.values()].flat()));
				conversation.planChanged = false;
			}
		}
	}

	/** Start an agy process and resume the saved session when this branch ends with its reply, else create one. */
	private async open(
		tools: Parameters<typeof openAntigravityTools>[0],
		toolDefinitions: string,
		reply: string | undefined,
		client: AntigravityClient,
		signal: AbortSignal,
	): Promise<Conversation> {
		await this.close();
		// agy reads its global rules and skills when it starts, so Pi writes its own there first.
		if (client.instructions) await installAntigravityInstructions(client.instructions, homedir());
		if (tools.length > 0) {
			if (!client.executeTool) throw new Error("Antigravity requires a Pi session to execute custom tools");
			this.toolServer = await openAntigravityTools(tools, () => this.activeTurn?.executeTool);
		}
		// Launched exactly as editors launch it: `agy acp`, nothing else.
		const acp = new AntigravityAcp(this.cwd, [], (method, params) => this.answerAgent(method, params));
		this.acp = acp;
		const { agentCapabilities } = await acp.initialize(signal, {
			workspace: client.workspace !== undefined,
			questions: client.answerQuestion !== undefined,
			compaction: client.showCompaction !== undefined,
		});
		if (this.toolServer && !agentCapabilities?.mcpCapabilities?.http) {
			throw new Error("Antigravity CLI does not support ACP HTTP MCP servers. Update agy.");
		}
		// Beyond its native files, agy keeps its own instructions: Pi sends no system prompt and no transcript.
		const sessionParams = { cwd: this.cwd, mcpServers: this.toolServer ? [this.toolServer.config] : [] };
		const saved = reply !== undefined && this.saved?.reply === reply ? this.saved : undefined;
		const resumed = saved && (await this.resume(acp, agentCapabilities, sessionParams, saved.sessionId, signal));
		const session = resumed ?? (await acp.request<AcpSession>("session/new", sessionParams, signal));
		this.conversation = {
			sessionId: session.sessionId,
			configOptions: session.configOptions ?? [],
			toolDefinitions,
			reply: resumed ? reply : undefined,
			supportsImages: agentCapabilities?.promptCapabilities?.image === true,
			plans: new Map(),
			planChanged: false,
			questionToolIds: new Set(),
			nativeTools: new AntigravityNativeTools(this.cwd),
		};
		return this.conversation;
	}

	/** Reattach a saved agy session with `session/resume`, or `session/load`, which replays updates Pi ignores. */
	private async resume(
		acp: AntigravityAcp,
		capabilities: AcpInitialize["agentCapabilities"],
		sessionParams: JsonObject,
		sessionId: string,
		signal: AbortSignal,
	): Promise<AcpSession | undefined> {
		const method = capabilities?.sessionCapabilities?.resume
			? "session/resume"
			: capabilities?.loadSession
				? "session/load"
				: undefined;
		if (!method) return undefined;
		try {
			const response = await acp.request<Omit<AcpSession, "sessionId">>(
				method,
				{ ...sessionParams, sessionId },
				signal,
			);
			return { sessionId, configOptions: response.configOptions ?? undefined };
		} catch (error) {
			// agy no longer holds the session; the turn continues in a new one.
			if (signal.aborted) throw error;
			return undefined;
		}
	}

	private async answerAgent(method: string, params: unknown): Promise<unknown> {
		if (method === "session/update") {
			const { sessionId, update } = params as { sessionId: string; update: AcpUpdate & JsonObject };
			// Updates replayed by session/load arrive before the conversation exists and are skipped.
			if (sessionId !== this.conversation?.sessionId) return;
			this.trackUpdate(this.conversation, update);
			this.activeTurn?.update(update);
			return;
		}
		if (method === "session/request_permission") return this.answerPermission(params as AcpPermission);
		if (method === "elicitation/create") {
			const request = params as AcpFormRequest;
			if (request.sessionId !== this.conversation?.sessionId || !this.activeTurn) {
				throw new McpError(-32602, "Antigravity elicitation requires an active interactive Pi session");
			}
			return this.activeTurn.answerQuestion(request);
		}
		if (method.startsWith("fs/") || method.startsWith("terminal/")) {
			const turn = this.activeTurn;
			if (!turn?.client.workspace) throw new McpError(-32601, `Pi serves ${method} only during a turn`);
			const request = params as JsonObject;
			const result = await turn.client.workspace({ method, params: request, root: this.cwd }, turn.signal);
			this.conversation?.nativeTools.observe(method, request, result);
			return result;
		}
		throw new McpError(-32601, `Unsupported ACP client method ${method}`);
	}

	private trackUpdate(conversation: Conversation, update: AcpUpdate & JsonObject): void {
		if (update.sessionUpdate === "config_option_update" && update.configOptions) {
			conversation.configOptions = update.configOptions;
		}
		if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
			this.activeTurn?.client.showCompaction?.(update as unknown as AcpCompactionUpdate);
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			// agy asks its questions through a tool; Pi records the answer as ask_user_question instead.
			if (update.name === "ask_question" && update.toolCallId) conversation.questionToolIds.add(update.toolCallId);
			if (update.toolCallId && !conversation.questionToolIds.has(update.toolCallId)) {
				const change = conversation.nativeTools.apply(update as unknown as AcpToolCallUpdate);
				this.activeTurn?.client.showToolCall?.(change.display);
				if (change.record) this.activeTurn?.record(change.record);
			}
		}
		if (update.sessionUpdate === "plan" && update.entries) {
			conversation.plans.set(null, update.entries);
			conversation.planChanged = true;
		} else if (update.sessionUpdate === "plan_update" && update.plan) {
			const { plan } = update;
			if (plan.type === "items") {
				conversation.plans.set(plan.planId, plan.entries);
				conversation.planChanged = true;
			} else if (conversation.plans.delete(plan.planId)) {
				conversation.planChanged = true;
			}
		} else if (update.sessionUpdate === "plan_removed" && update.planId !== undefined) {
			if (conversation.plans.delete(update.planId)) conversation.planChanged = true;
		}
	}

	private async answerPermission(request: AcpPermission): Promise<AcpPermissionResult> {
		const toolCall = request.toolCall ?? request.subject?.toolCall;
		const title = request.title ?? toolCall?.title;
		const isQuestion =
			toolCall?.name === "ask_question" ||
			(toolCall?.toolCallId && this.conversation?.questionToolIds.has(toolCall.toolCallId));
		if (isQuestion && title && request.sessionId && this.activeTurn?.client.answerQuestion) {
			const answer = await this.activeTurn.answerQuestion({
				sessionId: request.sessionId,
				mode: "form",
				message: title,
				requestedSchema: {
					type: "object",
					properties: {
						choice: {
							type: "string",
							title: "Answer",
							oneOf: request.options.map(({ optionId, name }) => ({ const: optionId, title: name })),
						},
					},
					required: ["choice"],
				},
			});
			return {
				outcome:
					answer.action === "accept"
						? { outcome: "selected", optionId: String(answer.content.choice) }
						: { outcome: "cancelled" },
			};
		}
		return askPermission(request, title, this.activeTurn?.client, this.activeTurn?.signal);
	}
}

async function selectModel(
	acp: AntigravityAcp,
	conversation: Conversation,
	model: string,
	reasoning: SimpleStreamOptions["reasoning"],
	signal: AbortSignal,
): Promise<void> {
	const selection = conversation.configOptions.find((option) => option.id === "model");
	if (!selection || !acpChoices(selection).some((choice) => choice.value === model)) {
		throw new Error(`Antigravity model ${model} is unavailable in the agy session`);
	}
	if (selection.currentValue !== model) {
		conversation.configOptions = await setConfigOption(acp, conversation.sessionId, selection.id, model, signal);
		if (conversation.configOptions.find((option) => option.id === selection.id)?.currentValue !== model) {
			throw new Error(`Antigravity CLI did not select ${model}`);
		}
	}
	// Pi requests no reasoning level for "off"; agy keeps its last level unless told.
	const level = reasoning ?? "off";
	const thought = conversation.configOptions.find((option) => option.category === "thought_level");
	if (thought && thought.currentValue !== level && acpChoices(thought).some((choice) => choice.value === level)) {
		conversation.configOptions = await setConfigOption(acp, conversation.sessionId, thought.id, level, signal);
	}
}

async function setConfigOption(
	acp: AntigravityAcp,
	sessionId: string,
	configId: string,
	value: string,
	signal: AbortSignal,
): Promise<AcpConfigOption[]> {
	const { configOptions } = await acp.request<{ configOptions: AcpConfigOption[] }>(
		"session/set_config_option",
		{ sessionId, configId, value },
		signal,
	);
	return configOptions;
}

async function promptAcp(
	acp: AntigravityAcp,
	sessionId: string,
	prompt: (TextContent | ImageContent)[],
	signal: AbortSignal,
) {
	const pending = acp.request<{ stopReason: string }>("session/prompt", { sessionId, prompt });
	try {
		return await raceWithAbortSignal(pending, signal);
	} catch (error) {
		if (signal.aborted) {
			acp.notify("session/cancel", { sessionId });
			await raceWithAbortSignal(pending, AbortSignal.timeout(5_000)).catch(() => {});
		}
		throw error;
	}
}

async function askPermission(
	request: AcpPermission,
	title: string | undefined,
	client?: AntigravityClient,
	signal?: AbortSignal,
): Promise<AcpPermissionResult> {
	if (!client?.requestPermission || signal?.aborted) return { outcome: { outcome: "cancelled" } };
	const selected = await raceWithAbortSignal(
		client.requestPermission(
			title ?? "Antigravity tool permission",
			request.options.map((option) => option.name),
			signal,
		),
		signal,
	).catch((error) => {
		if (!signal?.aborted) throw error;
	});
	const option = request.options.find((option) => option.name === selected);
	return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}

/** Identify a reply by the fields every copy of it keeps, wherever Pi stored it. */
function digestReply(message: AssistantMessage): string {
	return createHash("sha256")
		.update(JSON.stringify([message.timestamp, message.content]))
		.digest("hex");
}

/**
 * The user's input for this turn: every user message since agy's last reply, so a turn after another
 * model's replies still carries what the user asked meanwhile. Without an agy reply, the input after the
 * last reply. Replies from other models and Pi's compaction and branch summaries stay out of agy's context.
 */
function promptBlocks(history: Message[]): (TextContent | ImageContent)[] {
	const agyReply = history.findLastIndex(
		(message) => message.role === "assistant" && message.provider === ANTIGRAVITY_PROVIDER,
	);
	const lastReply = agyReply >= 0 ? agyReply : history.findLastIndex((message) => message.role === "assistant");
	return history
		.slice(lastReply + 1)
		.filter((message): message is UserMessage => message.role === "user" && !isPiSummary(message))
		.flatMap((message) =>
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
		);
}

/** Pi's projection renders its summaries as user messages with these fixed prefixes (messages.ts). */
function isPiSummary(message: UserMessage): boolean {
	const [first] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	return (
		first?.type === "text" &&
		(first.text.startsWith(COMPACTION_SUMMARY_PREFIX) || first.text.startsWith(BRANCH_SUMMARY_PREFIX))
	);
}

/** Stream agy's message and thought chunks, and place executed tool calls where they finished. */
function streamAntigravityUpdates(stream: AssistantMessageEventStream, output: AssistantMessage) {
	let active: TextContent | Extract<AssistantMessage["content"][number], { type: "thinking" }> | undefined;
	const end = () => {
		if (!active) return;
		const contentIndex = output.content.length - 1;
		if (active.type === "text")
			stream.push({ type: "text_end", contentIndex, content: active.text, partial: output });
		else stream.push({ type: "thinking_end", contentIndex, content: active.thinking, partial: output });
		active = undefined;
	};
	return {
		end,
		toolCall: (toolCall: ToolCall) => {
			// Text after a tool call starts a new block instead of running into the text before it.
			end();
			output.content.push(toolCall);
			const contentIndex = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
		},
		/** A note on one of agy's tool calls that no Pi tool describes, as its own text block. */
		note: (text: string) => {
			end();
			output.content.push({ type: "text", text });
			const contentIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex, content: text, partial: output });
		},
		update: (update: AcpUpdate) => {
			if (update.content?.type !== "text") return;
			const delta = update.content.text;
			if (update.sessionUpdate === "agent_message_chunk") {
				if (active?.type !== "text") {
					end();
					active = { type: "text", text: "" };
					output.content.push(active);
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				}
				active.text += delta;
				stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta, partial: output });
			} else if (update.sessionUpdate === "agent_thought_chunk") {
				if (active?.type !== "thinking") {
					end();
					active = { type: "thinking", thinking: "" };
					output.content.push(active);
					stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
				}
				active.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta, partial: output });
			}
		},
	};
}
