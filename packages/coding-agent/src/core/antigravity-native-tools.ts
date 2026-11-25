// Turns agy's own ACP tool calls into Pi tool calls, so the session records them in a form every model can continue.
import type { AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { acpCommandLine, quoteShellArgument, rootRelativePath } from "./antigravity-workspace.ts";

/** The ACP `tool_call` and `tool_call_update` fields Pi reads; wire input from agy. */
export interface AcpToolCallUpdate {
	sessionUpdate: "tool_call" | "tool_call_update";
	toolCallId: string;
	title?: string | null;
	kind?: string | null;
	status?: string | null;
	content?: AcpToolCallContent[] | null;
	locations?: AcpToolCallLocation[] | null;
	rawOutput?: JsonValue;
}

type AcpToolCallContent =
	| { type: "content"; content: { type: string; text?: string; data?: string; mimeType?: string } }
	| { type: "diff"; path: string; oldText?: string | null; newText: string }
	| { type: "terminal"; terminalId: string }
	| { type: "session" };

interface AcpToolCallLocation {
	path: string;
	line?: number | null;
}

/** One change to an agy tool call, as Pi shows it while the turn runs. */
export type AntigravityToolDisplay =
	| { type: "start"; toolCall: ToolCall }
	| { type: "update"; toolCall: ToolCall; content: (TextContent | ImageContent)[] }
	| { type: "end"; toolCall: ToolCall; started: boolean; result: AgentToolResult<JsonObject>; isError: boolean };

/** How the session records a finished agy tool call: as the Pi tool call it maps to, or as a note in agy's reply. */
export type AntigravityToolRecord = { type: "tool"; outcome: AgentToolCallOutcome } | { type: "note"; text: string };

/** What one ACP update changes: its display, and its record once the call has finished. */
export interface AntigravityToolChange {
	display: AntigravityToolDisplay;
	record?: AntigravityToolRecord;
}

interface NativeCall {
	title?: string;
	kind?: string;
	rawOutput?: JsonValue;
	content: AcpToolCallContent[];
	locations: AcpToolCallLocation[];
}

interface PiTerminal {
	command: string;
	output?: string;
	exitCode?: number | null;
}

/**
 * Follows agy's tool calls through their ACP updates and the terminals Pi runs for them. A call maps to
 * Pi's `read`, `edit`, `write`, or `bash` when ACP's standard fields say exactly what it did; any other
 * call becomes a note, so no model is shown a tool it cannot call.
 */
export class AntigravityNativeTools {
	private readonly root: string;
	private readonly calls = new Map<string, NativeCall>();
	private readonly terminals = new Map<string, PiTerminal>();

	/** `root` is the agy session's working directory; paths under it are recorded relative to the workspace. */
	constructor(root: string) {
		this.root = root;
	}

	/** Apply one update; ACP sends only the fields that changed and replaces the content and location lists. */
	apply(update: AcpToolCallUpdate): AntigravityToolChange {
		const known = this.calls.get(update.toolCallId);
		const call = known ?? { content: [], locations: [] };
		if (update.title != null) call.title = update.title;
		if (update.kind != null) call.kind = update.kind;
		if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
		if (update.content) call.content = update.content;
		if (update.locations) call.locations = update.locations;
		if (update.status === "completed" || update.status === "failed") {
			this.calls.delete(update.toolCallId);
			return this.end(update.toolCallId, call, known !== undefined, update.status === "failed");
		}
		this.calls.set(update.toolCallId, call);
		const { toolCall } = this.translate(update.toolCallId, call);
		return {
			display: known ? { type: "update", toolCall, content: this.result(call) } : { type: "start", toolCall },
		};
	}

	/** Record what Pi's workspace answered agy, so a command's tool call can be recorded as the `bash` call it ran. */
	observe(method: string, params: JsonObject, result: unknown): void {
		if (method === "terminal/create") {
			// The workspace has checked `command` before answering with the terminal it created.
			const { terminalId } = result as { terminalId: string };
			const command = acpCommandLine(params.command as string, params.args);
			const cwd = typeof params.cwd === "string" ? this.path(params.cwd) : ".";
			this.terminals.set(terminalId, {
				command: cwd === "." ? command : `cd ${quoteShellArgument(cwd)} && ${command}`,
			});
			return;
		}
		const terminal = this.terminals.get(params.terminalId as string);
		if (!terminal) return;
		if (method === "terminal/output") {
			const output = result as { output: string; exitStatus?: { exitCode: number | null } | null };
			terminal.output = output.output;
			if (output.exitStatus) terminal.exitCode = output.exitStatus.exitCode;
		} else if (method === "terminal/wait_for_exit") {
			terminal.exitCode = (result as { exitCode: number | null }).exitCode;
		}
	}

	/** End the calls agy left open when its turn ended, so every call in the transcript has a result. */
	finish(reason: string): Required<AntigravityToolChange>[] {
		const changes = [...this.calls].map(([toolCallId, call]) =>
			this.end(toolCallId, call, true, true, [{ type: "text", text: reason }]),
		);
		this.calls.clear();
		this.terminals.clear();
		return changes;
	}

	private end(
		toolCallId: string,
		call: NativeCall,
		started: boolean,
		isError: boolean,
		content = this.result(call),
	): Required<AntigravityToolChange> {
		const { toolCall, translated } = this.translate(toolCallId, call);
		const details: JsonObject = call.rawOutput === undefined ? {} : { rawOutput: call.rawOutput };
		const result = { content, details };
		return {
			display: { type: "end", toolCall, started, result, isError },
			record: translated
				? { type: "tool", outcome: { toolCall, result, isError } }
				: { type: "note", text: note(call, content, isError) },
		};
	}

	/** The Pi tool call that did what agy's call did; calls ACP does not describe exactly keep an `agy_` name for display. */
	private translate(toolCallId: string, call: NativeCall): { toolCall: ToolCall; translated: boolean } {
		const pi = this.piCall(call);
		if (pi) return { toolCall: { type: "toolCall", id: toolCallId, ...pi }, translated: true };
		const kind = (call.kind ?? "tool").replace(/[^A-Za-z0-9_-]/g, "_");
		return {
			toolCall: {
				type: "toolCall",
				id: toolCallId,
				name: `agy_${kind}`,
				arguments: call.title ? { title: call.title } : {},
			},
			translated: false,
		};
	}

	private piCall(call: NativeCall): { name: string; arguments: JsonObject } | undefined {
		switch (call.kind) {
			case "read": {
				if (call.locations.length !== 1) return undefined;
				const [{ path, line }] = call.locations;
				return { name: "read", arguments: { path: this.path(path), ...(line != null ? { offset: line } : {}) } };
			}
			case "edit": {
				const diffs = call.content.filter((item) => item.type === "diff");
				if (diffs.length !== 1) return undefined;
				const [{ path, oldText, newText }] = diffs;
				return oldText
					? { name: "edit", arguments: { path: this.path(path), edits: [{ oldText, newText }] } }
					: { name: "write", arguments: { path: this.path(path), content: newText } };
			}
			case "execute": {
				const terminals = call.content.flatMap((item) => {
					const terminal = item.type === "terminal" ? this.terminals.get(item.terminalId) : undefined;
					return terminal ? [terminal] : [];
				});
				return terminals.length === 1 ? { name: "bash", arguments: { command: terminals[0].command } } : undefined;
			}
			default:
				return undefined;
		}
	}

	private result(call: NativeCall): (TextContent | ImageContent)[] {
		const content = call.content.flatMap((item): (TextContent | ImageContent)[] => {
			switch (item.type) {
				case "diff":
					return [{ type: "text", text: `Changed ${this.path(item.path)}` }];
				case "terminal": {
					const terminal = this.terminals.get(item.terminalId);
					return terminal?.output === undefined ? [] : [{ type: "text", text: terminalText(terminal) }];
				}
				case "content": {
					const block = item.content;
					if (block.type === "text" && block.text !== undefined) return [{ type: "text", text: block.text }];
					if (block.type === "image" && block.data && block.mimeType) {
						return [{ type: "image", data: block.data, mimeType: block.mimeType }];
					}
					return [];
				}
				default:
					return [];
			}
		});
		if (content.length > 0) return content;
		if (call.rawOutput !== undefined) return [{ type: "text", text: JSON.stringify(call.rawOutput) }];
		return [{ type: "text", text: call.title ?? "Done" }];
	}

	private path(path: string): string {
		const relative = rootRelativePath(path, this.root);
		return relative === undefined ? path : relative || ".";
	}
}

/** Pi's `bash` reports a non-zero exit after the output. */
function terminalText({ output, exitCode }: PiTerminal): string {
	return exitCode ? `${output}\n\nCommand exited with code ${exitCode}` : (output ?? "");
}

function note(call: NativeCall, content: (TextContent | ImageContent)[], isError: boolean): string {
	const action = call.title ?? call.kind ?? "tool call";
	const result = content
		.map((block) => (block.type === "text" ? block.text : "(image)"))
		.filter((text) => text !== action)
		.join("\n");
	return `[Antigravity ${isError ? "failed" : "ran"}: ${action}]${result ? `\n${result}` : ""}`;
}
