import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getSystemMessageText,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { McpError } from "@earendil-works/pi-mcp";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { type AcpConfigOption, type AcpSession, AntigravityAcp, acpChoices } from "./antigravity-acp.ts";
import { type AntigravityToolExecutor, openAntigravityTools } from "./antigravity-tools.ts";

interface AcpPermission {
	toolCall: { title?: string };
	options: { optionId: string; name: string }[];
}

interface AcpUpdate {
	sessionUpdate: string;
	content?: TextContent | ImageContent;
	configOptions?: AcpConfigOption[];
}

interface AntigravityClient {
	executeTool?: (
		call: Parameters<AntigravityToolExecutor>[0],
		assistant: AssistantMessage,
		signal: AbortSignal,
	) => ReturnType<AntigravityToolExecutor>;
	requestPermission?: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
}

interface Conversation {
	sessionId: string;
	configOptions: AcpConfigOption[];
	history: Message[];
	systemPrompt: string;
	toolDefinitions: string;
	appendSystemPrompt: boolean;
	supportsImages: boolean;
}

/** A Pi session's live Antigravity conversation. Pi owns the visible transcript, agy owns its turn loop. */
export class AntigravityRuntime {
	private readonly cwd: string;
	private acp: AntigravityAcp | undefined;
	private conversation: Conversation | undefined;
	private toolServer: Awaited<ReturnType<typeof openAntigravityTools>> | undefined;
	private activeTurn:
		| {
				client?: AntigravityClient;
				executeTool?: AntigravityToolExecutor;
				signal: AbortSignal;
				update(update: AcpUpdate): void;
		  }
		| undefined;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	stream(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
		client?: AntigravityClient,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
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
				const reason = await this.prompt(model, context, options, client, output, emit.update);
				if (!client || reason === "cancelled") await this.close();
				emit.end();
				if (signal?.aborted || reason === "cancelled") throw new Error("Antigravity turn cancelled");
				if (reason === "max_turn_requests") throw new Error("Antigravity reached its turn request limit");
				output.stopReason = reason === "max_tokens" ? "length" : "stop";
				output.rawStopReason = reason;
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				await this.close();
				emit.end();
				output.stopReason = signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
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
	): Promise<string> {
		const signal = operationSignal(options?.signal);
		const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(options?.timeoutMs ?? 30_000)]);
		const systemMessage = getCurrentSystemMessage(context.messages);
		const systemPrompt = systemMessage ? getSystemMessageText(systemMessage) : "";
		const tools = systemMessage?.toolsAdded ?? [];
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
						const { sessionId, update } = params as { sessionId: string; update: AcpUpdate };
						if (sessionId !== this.conversation?.sessionId) return;
						if (update.sessionUpdate === "config_option_update" && update.configOptions) {
							this.conversation.configOptions = update.configOptions;
						}
						this.activeTurn?.update(update);
						return;
					}
					if (method === "session/request_permission") {
						return answerPermission(params as AcpPermission, this.activeTurn?.client, this.activeTurn?.signal);
					}
					throw new McpError(-32601, `Unsupported ACP client method ${method}`);
				},
			);
			this.acp = acp;
			const { agentCapabilities } = await acp.initialize(setupSignal);
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
		const calls = new Set<ReturnType<AntigravityToolExecutor>>();
		this.activeTurn = {
			client,
			signal,
			update: onUpdate,
			executeTool: execute
				? async (call) => {
						const running = execute(call, output, signal);
						calls.add(running);
						try {
							return await running;
						} finally {
							calls.delete(running);
						}
					}
				: undefined,
		};
		try {
			const result = await promptAcp(acp, conversation.sessionId, prompt, signal);
			conversation.history = [...history, output];
			return result.stopReason;
		} finally {
			this.activeTurn = undefined;
			await Promise.allSettled(calls);
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

async function answerPermission(request: AcpPermission, client?: AntigravityClient, signal?: AbortSignal) {
	if (!client?.requestPermission || signal?.aborted) return { outcome: { outcome: "cancelled" } };
	const selected = await raceWithAbortSignal(
		client.requestPermission(
			request.toolCall.title ?? "Antigravity tool permission",
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
