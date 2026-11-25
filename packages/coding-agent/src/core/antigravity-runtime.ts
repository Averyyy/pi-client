import { type AgentToolCallOutcome, createToolResultMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getSystemMessageText,
	type ImageContent,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { McpError } from "@earendil-works/pi-mcp";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import {
	type AcpConfigOption,
	type AcpSession,
	AntigravityAcp,
	acpChoices,
	isAntigravityAuthRequired,
} from "./antigravity-acp.ts";
import {
	type AcpFormRequest,
	type AcpPlanEntry,
	type answerAntigravityQuestion,
	antigravityPlanResult,
} from "./antigravity-interactions.ts";
import { type AntigravityToolExecutor, openAntigravityTools } from "./antigravity-tools.ts";

interface AcpPermission {
	sessionId?: string;
	title?: string;
	toolCall?: { toolCallId?: string; name?: string; title?: string };
	subject?: { type: "tool_call"; toolCall: { toolCallId: string; name?: string; title?: string } };
	options: { optionId: string; name: string }[];
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

export interface AntigravityClient {
	executeTool?: (
		call: Parameters<AntigravityToolExecutor>[0],
		assistant: AssistantMessage,
		signal: AbortSignal,
	) => ReturnType<AntigravityToolExecutor>;
	requestPermission?: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	answerQuestion?: (request: AcpFormRequest, signal: AbortSignal) => ReturnType<typeof answerAntigravityQuestion>;
	recordUpdate?: (sessionId: string, update: JsonObject) => void;
}

interface Conversation {
	sessionId: string;
	configOptions: AcpConfigOption[];
	history: Message[];
	systemPrompt: string;
	toolDefinitions: string;
	appendSystemPrompt: boolean;
	supportsImages: boolean;
	plans: Map<string | null, AcpPlanEntry[]>;
	planChanged: boolean;
	questionToolIds: Set<string>;
}

/** A Pi session's live Antigravity conversation. Pi owns the visible transcript, agy owns its turn loop. */
export class AntigravityRuntime {
	private readonly cwd: string;
	private readonly host: "Pi" | "PiServer";
	private acp: AntigravityAcp | undefined;
	private conversation: Conversation | undefined;
	private toolServer: Awaited<ReturnType<typeof openAntigravityTools>> | undefined;
	private activeTurn:
		| {
				client?: AntigravityClient;
				executeTool?: AntigravityToolExecutor;
				answerQuestion(
					request: AcpFormRequest,
				): Promise<Awaited<ReturnType<typeof answerAntigravityQuestion>>["result"]>;
				signal: AbortSignal;
				update(update: AcpUpdate): void;
		  }
		| undefined;

	constructor(cwd: string, host: "Pi" | "PiServer" = "Pi") {
		this.cwd = cwd;
		this.host = host;
	}

	stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions, client?: AntigravityClient) {
		const executedToolResults: ToolResultMessage[] = [];
		const stream = Object.assign(createAssistantMessageEventStream(), { executedToolResults });
		const toolCalls: AgentToolCallOutcome["toolCall"][] = [];
		const addToolResult = (outcome: AgentToolCallOutcome) => {
			toolCalls.push(outcome.toolCall);
			executedToolResults.push(createToolResultMessage(outcome));
		};
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
		const signal = options?.signal;
		void (async () => {
			try {
				stream.push({ type: "start", partial: output });
				const reason = await this.prompt(
					model,
					context,
					options,
					client,
					output,
					emit.update,
					addToolResult,
					executedToolResults,
				);
				if (!client || reason === "cancelled") await this.close();
				emit.end();
				if (signal?.aborted || reason === "cancelled") throw new Error("Antigravity turn cancelled");
				if (reason === "max_turn_requests") throw new Error("Antigravity reached its turn request limit");
				output.content.unshift(...toolCalls);
				output.stopReason = reason === "max_tokens" ? "length" : "stop";
				output.rawStopReason = reason;
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				await this.close();
				emit.end();
				output.content.unshift(...toolCalls);
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
		client: AntigravityClient | undefined,
		output: AssistantMessage,
		onUpdate: (update: AcpUpdate) => void,
		addToolResult: (outcome: AgentToolCallOutcome) => void,
		toolResults: readonly ToolResultMessage[],
	): Promise<string> {
		const signal = operationSignal(options?.signal);
		const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(options?.timeoutMs ?? 30_000)]);
		const systemMessage = getCurrentSystemMessage(context.messages);
		const systemPrompt = systemMessage ? getSystemMessageText(systemMessage) : "";
		const activeTools = systemMessage?.toolsAdded ?? [];
		const showTodo = activeTools.some((tool) => tool.name === "todo");
		const tools = activeTools.filter((tool) => tool.name !== "todo" && tool.name !== "ask_user_question");
		const toolDefinitions = JSON.stringify(tools);
		const history = context.messages.filter((message) => message.role !== "system");
		const previous = this.conversation;
		const reuse =
			previous &&
			previous.systemPrompt === systemPrompt &&
			previous.toolDefinitions === toolDefinitions &&
			previous.history.length < history.length &&
			previous.history.every((message, index) => sameMessage(message, history[index]));
		if (!reuse) {
			await this.close();
			if (tools.length > 0) {
				if (!client?.executeTool) throw new Error("Antigravity requires a Pi session to execute custom tools");
				this.toolServer = await openAntigravityTools(tools, () => this.activeTurn?.executeTool);
			}
			const acp = new AntigravityAcp(
				this.cwd,
				this.toolServer ? ["--process-per-session"] : [],
				async (method, params) => {
					if (method === "session/update") {
						const { sessionId, update } = params as { sessionId: string; update: AcpUpdate & JsonObject };
						if (sessionId !== this.conversation?.sessionId) return;
						if (update.sessionUpdate === "config_option_update" && update.configOptions) {
							this.conversation.configOptions = update.configOptions;
						}
						if (
							update.sessionUpdate === "tool_call" ||
							update.sessionUpdate === "tool_call_update" ||
							update.sessionUpdate === "tool_call_content_chunk" ||
							update.sessionUpdate === "terminal_output_chunk" ||
							update.sessionUpdate === "plan" ||
							update.sessionUpdate === "plan_update" ||
							update.sessionUpdate === "plan_removed"
						) {
							this.activeTurn?.client?.recordUpdate?.(sessionId, update);
						}
						if (
							(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
							update.name === "ask_question" &&
							update.toolCallId
						) {
							this.conversation.questionToolIds.add(update.toolCallId);
						}
						if (update.sessionUpdate === "plan" && update.entries) {
							this.conversation.plans.set(null, update.entries);
							this.conversation.planChanged = true;
						} else if (update.sessionUpdate === "plan_update" && update.plan) {
							const { plan } = update;
							if (plan.type === "items") {
								this.conversation.plans.set(plan.planId, plan.entries);
								this.conversation.planChanged = true;
							} else if (this.conversation.plans.delete(plan.planId)) {
								this.conversation.planChanged = true;
							}
						} else if (update.sessionUpdate === "plan_removed" && update.planId !== undefined) {
							if (this.conversation.plans.delete(update.planId)) this.conversation.planChanged = true;
						}
						this.activeTurn?.update(update);
						return;
					}
					if (method === "session/request_permission") {
						const request = params as AcpPermission;
						const toolCall = request.toolCall ?? request.subject?.toolCall;
						const title = request.title ?? toolCall?.title;
						const isQuestion =
							toolCall?.name === "ask_question" ||
							(toolCall?.toolCallId && this.conversation?.questionToolIds.has(toolCall.toolCallId));
						let result: AcpPermissionResult;
						if (isQuestion && title && request.sessionId && this.activeTurn?.client?.answerQuestion) {
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
							result = {
								outcome:
									answer.action === "accept"
										? { outcome: "selected", optionId: String(answer.content.choice) }
										: { outcome: "cancelled" },
							};
						} else {
							result = await answerPermission(request, this.activeTurn?.client, this.activeTurn?.signal);
						}
						if (request.sessionId && toolCall?.toolCallId) {
							this.activeTurn?.client?.recordUpdate?.(request.sessionId, {
								sessionUpdate: "permission_response",
								toolCallId: toolCall.toolCallId,
								...(title ? { title } : {}),
								options: request.options,
								...result,
							});
						}
						return result;
					}
					if (method === "elicitation/create") {
						const request = params as AcpFormRequest;
						if (request.sessionId !== this.conversation?.sessionId || !this.activeTurn) {
							throw new McpError(-32602, "Antigravity elicitation requires an active interactive Pi session");
						}
						return this.activeTurn.answerQuestion(request);
					}
					throw new McpError(-32601, `Unsupported ACP client method ${method}`);
				},
			);
			this.acp = acp;
			const { agentCapabilities } = await acp.initialize(setupSignal, client?.answerQuestion !== undefined);
			if (this.toolServer && !agentCapabilities?.mcpCapabilities?.http) {
				throw new Error("Antigravity CLI does not support ACP HTTP MCP servers. Update agy.");
			}
			const appendSystemPrompt = agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
			const session = await acp.request<AcpSession>(
				"session/new",
				{
					cwd: this.cwd,
					mcpServers: this.toolServer ? [this.toolServer.config] : [],
					...(appendSystemPrompt && systemPrompt
						? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } }
						: {}),
				},
				setupSignal,
			);
			this.conversation = {
				sessionId: session.sessionId,
				configOptions: session.configOptions ?? [],
				history: [],
				systemPrompt,
				toolDefinitions,
				appendSystemPrompt,
				supportsImages: agentCapabilities?.promptCapabilities?.image === true,
				plans: new Map(),
				planChanged: false,
				questionToolIds: new Set(),
			};
		}
		const acp = this.acp!;
		const conversation = this.conversation!;
		await selectModel(acp, conversation, model.id, options?.reasoning, setupSignal);
		const prompt = promptBlocks(
			history.slice(conversation.history.length),
			reuse || conversation.appendSystemPrompt ? "" : systemPrompt,
		);
		if (prompt.some((part) => part.type === "image") && !conversation.supportsImages) {
			throw new Error("Antigravity CLI does not support images over ACP");
		}
		setupSignal.throwIfAborted();
		const execute = client?.executeTool;
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
		this.activeTurn = {
			client,
			signal,
			update: onUpdate,
			answerQuestion: async (request) => {
				if (!client?.answerQuestion)
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
			if (conversation.planChanged && showTodo) {
				addToolResult(antigravityPlanResult([...conversation.plans.values()].flat()));
				conversation.planChanged = false;
			}
			conversation.history = [...history, output, ...toolResults];
		}
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
		throw new Error(`Antigravity model ${model} is unavailable in the local CLI session`);
	}
	if (selection.currentValue !== model) {
		const { configOptions } = await acp.request<{ configOptions: AcpConfigOption[] }>(
			"session/set_config_option",
			{
				sessionId: conversation.sessionId,
				configId: selection.id,
				value: model,
			},
			signal,
		);
		conversation.configOptions = configOptions;
		if (configOptions.find((option) => option.id === selection.id)?.currentValue !== model) {
			throw new Error(`Antigravity CLI did not select ${model}`);
		}
	}
	const thought = conversation.configOptions.find((option) => option.category === "thought_level");
	if (
		thought &&
		reasoning &&
		thought.currentValue !== reasoning &&
		acpChoices(thought).some((choice) => choice.value === reasoning)
	) {
		const { configOptions } = await acp.request<{ configOptions: AcpConfigOption[] }>(
			"session/set_config_option",
			{
				sessionId: conversation.sessionId,
				configId: thought.id,
				value: reasoning,
			},
			signal,
		);
		conversation.configOptions = configOptions;
	}
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

async function answerPermission(
	request: AcpPermission,
	client?: AntigravityClient,
	signal?: AbortSignal,
): Promise<AcpPermissionResult> {
	if (!client?.requestPermission || signal?.aborted) return { outcome: { outcome: "cancelled" } };
	const selected = await raceWithAbortSignal(
		client.requestPermission(
			request.title ?? request.toolCall?.title ?? request.subject?.toolCall.title ?? "Antigravity tool permission",
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

function sameMessage(previous: Message, current: Message): boolean {
	return (
		previous === current ||
		(previous.role === current.role &&
			previous.timestamp === current.timestamp &&
			JSON.stringify(previous.content) === JSON.stringify(current.content))
	);
}

function promptBlocks(messages: Message[], systemPrompt: string): (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [];
	if (systemPrompt) blocks.push({ type: "text", text: `Pi session instructions:\n${systemPrompt}` });
	for (const [index, message] of messages.entries()) {
		const currentPrompt = index === messages.length - 1 && message.role === "user";
		if (!currentPrompt) blocks.push({ type: "text", text: `Pi conversation history (${message.role}):` });
		if (typeof message.content === "string") {
			blocks.push({ type: "text", text: message.content });
			continue;
		}
		for (const part of message.content ?? []) {
			if (part.type === "text" || part.type === "image") blocks.push(part);
			else if (part.type === "toolCall")
				blocks.push({ type: "text", text: `${part.name} ${JSON.stringify(part.arguments)}` });
		}
	}
	return blocks;
}

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
