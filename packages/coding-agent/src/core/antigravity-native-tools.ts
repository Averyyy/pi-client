// Turns agy's own ACP tool calls into Pi tool calls, for live display and the session transcript.
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent, ToolCall } from "@earendil-works/pi-ai";

/** The ACP `tool_call` and `tool_call_update` fields Pi reads; wire input from agy. */
export interface AcpToolCallUpdate {
	sessionUpdate: "tool_call" | "tool_call_update";
	toolCallId: string;
	title?: string | null;
	name?: string | null;
	kind?: string | null;
	status?: string | null;
	content?: AcpToolCallContent[] | null;
	rawInput?: JsonValue;
	rawOutput?: JsonValue;
}

type AcpToolCallContent =
	| { type: "content"; content: { type: string; text?: string; data?: string; mimeType?: string } }
	| { type: "diff"; path: string }
	| { type: "terminal"; terminalId: string };

/** One change to an agy tool call, as Pi shows it. */
export type AntigravityNativeToolEvent =
	| { type: "start"; toolCall: ToolCall }
	| { type: "update"; toolCall: ToolCall; content: (TextContent | ImageContent)[] }
	| { type: "end"; started: boolean; outcome: AgentToolCallOutcome };

interface NativeCall {
	title?: string;
	name?: string;
	kind?: string;
	rawInput?: JsonValue;
	rawOutput?: JsonValue;
	content: AcpToolCallContent[];
}

/** Follows agy's tool calls through their ACP updates. */
export class AntigravityNativeTools {
	private readonly calls = new Map<string, NativeCall>();

	/** Apply one update; ACP sends only the fields that changed and replaces the content collection. */
	apply(update: AcpToolCallUpdate): AntigravityNativeToolEvent {
		const known = this.calls.get(update.toolCallId);
		const call = known ?? { content: [] };
		if (update.title != null) call.title = update.title;
		if (update.name != null) call.name = update.name;
		if (update.kind != null) call.kind = update.kind;
		if (update.rawInput !== undefined) call.rawInput = update.rawInput;
		if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
		if (update.content) call.content = update.content;
		const toolCall = toPiToolCall(update.toolCallId, call);
		if (update.status === "completed" || update.status === "failed") {
			this.calls.delete(update.toolCallId);
			return {
				type: "end",
				started: known !== undefined,
				outcome: outcome(toolCall, call, update.status === "failed"),
			};
		}
		this.calls.set(update.toolCallId, call);
		return known ? { type: "update", toolCall, content: toPiContent(call) } : { type: "start", toolCall };
	}

	/** End the calls agy left open when its turn ended, so every call in the transcript has a result. */
	finish(reason: string): AgentToolCallOutcome[] {
		const outcomes = [...this.calls].map(([toolCallId, call]) => ({
			...outcome(toPiToolCall(toolCallId, call), call, true),
			result: { content: [{ type: "text" as const, text: reason }], details: {} },
		}));
		this.calls.clear();
		return outcomes;
	}
}

function toPiToolCall(toolCallId: string, call: NativeCall): ToolCall {
	// Tool names must stay valid for every provider the session may switch to.
	const name = (call.name ?? call.kind ?? "tool").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
	const input = call.rawInput;
	return {
		type: "toolCall",
		id: toolCallId,
		name: `agy_${name}`,
		arguments:
			input !== null && typeof input === "object" && !Array.isArray(input)
				? (input as JsonObject)
				: call.title
					? { title: call.title }
					: {},
	};
}

function outcome(toolCall: ToolCall, call: NativeCall, isError: boolean): AgentToolCallOutcome {
	return {
		toolCall,
		result: {
			content: toPiContent(call),
			details: call.rawOutput === undefined ? {} : { rawOutput: call.rawOutput },
		},
		isError,
	};
}

function toPiContent(call: NativeCall): (TextContent | ImageContent)[] {
	const content = call.content.flatMap((item): (TextContent | ImageContent)[] => {
		if (item.type === "diff") return [{ type: "text", text: `Changed ${item.path}` }];
		if (item.type === "terminal") return [{ type: "text", text: `Terminal ${item.terminalId}` }];
		const block = item.content;
		if (block.type === "text" && block.text !== undefined) return [{ type: "text", text: block.text }];
		if (block.type === "image" && block.data && block.mimeType) {
			return [{ type: "image", data: block.data, mimeType: block.mimeType }];
		}
		return [];
	});
	if (content.length > 0) return content;
	if (call.rawOutput !== undefined) return [{ type: "text", text: JSON.stringify(call.rawOutput) }];
	return [{ type: "text", text: call.title ?? "Done" }];
}
