// Serves agy's ACP file and terminal requests inside the Pi workspace.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { McpError } from "@earendil-works/pi-mcp";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getShellEnv } from "../utils/shell.ts";
import { createLocalBashOperations } from "./tools/bash.ts";

/** An ACP `fs/*` or `terminal/*` request, with the agy session's working directory as `root`. */
export interface AntigravityWorkspaceRequest {
	method: string;
	params: JsonObject;
	root: string;
}

interface TerminalExit {
	exitCode: number | null;
	signal: string | null;
}

interface Terminal {
	output: string;
	truncated: boolean;
	exitStatus?: TerminalExit;
	exited: Promise<TerminalExit>;
	controller: AbortController;
}

/**
 * The ACP client side of agy's file system and terminal capabilities. Paths under the agy
 * session's working directory map to the Pi workspace, so agy can run on another machine.
 */
export class AntigravityWorkspace {
	private readonly cwd: string;
	private readonly shellPath: string | undefined;
	private readonly terminals = new Map<string, Terminal>();

	constructor(cwd: string, shellPath?: string) {
		this.cwd = cwd;
		this.shellPath = shellPath;
	}

	/** Answer one ACP workspace request. Parameters are wire input from the agent. */
	async handle({ method, params, root }: AntigravityWorkspaceRequest, signal: AbortSignal): Promise<unknown> {
		const path = (value: unknown) => {
			if (typeof value !== "string" || !value) throw new McpError(-32602, `${method} requires an absolute path`);
			return toWorkspacePath(value, root, this.cwd);
		};
		switch (method) {
			case "fs/read_text_file": {
				const content = await readFile(path(params.path), "utf8");
				return { content: selectLines(content, params.line, params.limit) };
			}
			case "fs/write_text_file": {
				if (typeof params.content !== "string") throw new McpError(-32602, "fs/write_text_file requires content");
				const target = path(params.path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, params.content, "utf8");
				return {};
			}
			case "terminal/create":
				return { terminalId: this.createTerminal(params, params.cwd ? path(params.cwd) : this.cwd) };
			case "terminal/output": {
				const terminal = this.terminal(params.terminalId);
				return {
					output: terminal.output,
					truncated: terminal.truncated,
					...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
				};
			}
			case "terminal/wait_for_exit":
				return raceWithAbortSignal(this.terminal(params.terminalId).exited, signal);
			case "terminal/kill":
				this.terminal(params.terminalId).controller.abort();
				return {};
			case "terminal/release": {
				const terminal = this.terminal(params.terminalId);
				terminal.controller.abort();
				this.terminals.delete(params.terminalId as string);
				return {};
			}
			default:
				throw new McpError(-32601, `Unsupported ACP workspace method ${method}`);
		}
	}

	/** Stop every terminal the agent has not released. */
	close(): void {
		for (const terminal of this.terminals.values()) terminal.controller.abort();
		this.terminals.clear();
	}

	private terminal(terminalId: unknown): Terminal {
		const terminal = typeof terminalId === "string" ? this.terminals.get(terminalId) : undefined;
		if (!terminal) throw new McpError(-32602, `Unknown terminal ${String(terminalId)}`);
		return terminal;
	}

	private createTerminal(params: JsonObject, cwd: string): string {
		if (typeof params.command !== "string" || !params.command) {
			throw new McpError(-32602, "terminal/create requires a command");
		}
		const command = acpCommandLine(params.command, params.args);
		const env = getShellEnv();
		for (const variable of Array.isArray(params.env) ? params.env : []) {
			const { name, value } = variable as { name?: unknown; value?: unknown };
			if (typeof name === "string" && typeof value === "string") env[name] = value;
		}
		const limit = typeof params.outputByteLimit === "number" ? params.outputByteLimit : undefined;
		const controller = new AbortController();
		const decoder = new TextDecoder();
		const terminalId = randomUUID();
		const terminal: Terminal = {
			output: "",
			truncated: false,
			controller,
			exited: createLocalBashOperations({ shellPath: this.shellPath })
				.exec(command, cwd, {
					env,
					signal: controller.signal,
					onData: (data) => {
						terminal.output += decoder.decode(data, { stream: true });
						if (limit !== undefined) truncateOutput(terminal, limit);
					},
				})
				.then(
					({ exitCode }): TerminalExit => ({ exitCode, signal: null }),
					(error: unknown): TerminalExit => {
						if (!controller.signal.aborted) terminal.output += `${String(error)}\n`;
						return {
							exitCode: controller.signal.aborted ? null : 1,
							signal: controller.signal.aborted ? "SIGTERM" : null,
						};
					},
				)
				.then((exit) => {
					terminal.exitStatus = exit;
					return exit;
				}),
		};
		this.terminals.set(terminalId, terminal);
		return terminalId;
	}
}

/** Map a path under the agy session root into the Pi workspace; other absolute paths stay as they are. */
function toWorkspacePath(path: string, root: string, cwd: string): string {
	const relative = rootRelativePath(path, root);
	return relative === undefined ? path : join(cwd, ...relative.split("/").filter(Boolean));
}

/** `path` relative to `root` with `/` separators (empty for the root itself), or undefined outside `root`. */
export function rootRelativePath(path: string, root: string): string | undefined {
	const target = path.replace(/\\/g, "/");
	const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
	if (target === base) return "";
	return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : undefined;
}

/** ACP lines are 1-based; `limit` counts lines from `line`. */
function selectLines(content: string, line: unknown, limit: unknown): string {
	if (typeof line !== "number" && typeof limit !== "number") return content;
	const start = typeof line === "number" ? Math.max(line - 1, 0) : 0;
	const lines = content.split("\n");
	return lines.slice(start, typeof limit === "number" ? start + limit : undefined).join("\n");
}

/** Keep the newest `limit` bytes, cutting at a UTF-8 character boundary as ACP requires. */
function truncateOutput(terminal: Terminal, limit: number): void {
	const bytes = Buffer.from(terminal.output, "utf8");
	if (bytes.length <= limit) return;
	let start = bytes.length - limit;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	terminal.output = bytes.subarray(start).toString("utf8");
	terminal.truncated = true;
}

/** The shell command line of an ACP `terminal/create`: with arguments, `command` names a program; without, it is a command line. */
export function acpCommandLine(command: string, args: JsonValue | undefined): string {
	const values = Array.isArray(args) ? args.map(String) : [];
	return values.length ? [command, ...values].map(quoteShellArgument).join(" ") : command;
}

/** Quote one word for a POSIX shell. */
export function quoteShellArgument(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
