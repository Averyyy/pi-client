import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, McpError, parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { killProcessTree } from "../utils/shell.ts";

export const ANTIGRAVITY_PROVIDER = "google-antigravity" as const;

/**
 * How this client names itself to agy: in ACP `clientInfo`, as its MCP server, and in agy's rule
 * file. It is the Averyyy fork, not upstream Pi, so it does not report Pi's name.
 */
export const ANTIGRAVITY_CLIENT_NAME = "avery-ui";

export function isAntigravityAuthRequired(error: unknown): boolean {
	return error instanceof McpError && error.code === -32000 && error.message === "Authentication required";
}

export interface AcpConfigOption {
	id: string;
	category?: string;
	type: string;
	currentValue: string | boolean;
	options?: (AcpChoice | { options: AcpChoice[] })[];
}

interface AcpChoice {
	value: string;
	name: string;
}

export interface AcpSession {
	sessionId: string;
	configOptions?: AcpConfigOption[];
}

/** The ACP major version Pi implements. */
const ACP_PROTOCOL_VERSION = 1;

export interface AcpInitialize {
	protocolVersion: number;
	agentCapabilities?: {
		auth?: { logout?: object };
		loadSession?: boolean;
		mcpCapabilities?: { http?: boolean };
		promptCapabilities?: { image?: boolean };
		sessionCapabilities?: { resume?: object | null; systemPrompt?: object | null };
		_meta?: { antigravity?: { systemPrompt?: { append?: boolean } } };
	};
}

/** Client features Pi offers the agent in one ACP connection. */
export interface AcpClientFeatures {
	/** Serve `fs/*` and `terminal/*` requests in the Pi workspace. */
	workspace: boolean;
	/** Answer form elicitations in an interactive UI. */
	questions: boolean;
	/** Show agy's context compactions. */
	compaction: boolean;
}

type AcpHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

function spawnAgy(args: string[], cwd: string) {
	return spawn(process.env.PI_ANTIGRAVITY_CLI ?? "agy", ["acp", ...args], {
		cwd,
		windowsHide: true,
		detached: process.platform !== "win32",
	});
}

function stopAgy(child: ReturnType<typeof spawnAgy>): void {
	if (child.pid && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
}

/** One newline-delimited JSON-RPC connection to the locally installed Antigravity CLI. */
export class AntigravityAcp {
	private readonly child: ReturnType<typeof spawnAgy>;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private nextId = 0;
	private failure: Error | undefined;
	private readonly exited: Promise<unknown>;

	constructor(cwd: string, args: string[], handle?: AcpHandler) {
		const child = spawnAgy(args, cwd);
		this.child = child;
		this.exited = new Promise((resolve) => child.once("close", resolve));
		child.stderr.resume();
		child.stdin.on("error", (error) => this.fail(error));
		child.on("error", (error) => this.fail(error));
		child.once("close", (code) => this.fail(new Error(`Antigravity CLI exited (${code})`)));
		createInterface({ input: child.stdout }).on("line", (line) => {
			if (!line.trim()) return;
			try {
				const message = parseJsonRpcMessage(JSON.parse(line));
				if ("method" in message) {
					if ("id" in message) void this.reply(message, handle);
					else if (handle)
						void Promise.resolve(handle(message.method, message.params)).catch((error) => this.fail(error));
					return;
				}
				if (typeof message.id !== "number") return;
				const pending = this.pending.get(message.id);
				this.pending.delete(message.id);
				if ("error" in message) pending?.reject(new McpError(message.error.code, message.error.message));
				else pending?.resolve(message.result);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async initialize(
		signal?: AbortSignal,
		features: AcpClientFeatures = { workspace: false, questions: false, compaction: false },
	): Promise<AcpInitialize> {
		const result = await this.request<AcpInitialize>(
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: { name: ANTIGRAVITY_CLIENT_NAME, title: "Avery UI" },
				clientCapabilities: {
					fs: { readTextFile: features.workspace, writeTextFile: features.workspace },
					terminal: features.workspace,
					...(features.questions ? { elicitation: { form: {} } } : {}),
					...(features.compaction ? { session: { compaction: {} } } : {}),
				},
			},
			signal,
		);
		if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
			throw new Error(`Antigravity CLI speaks ACP version ${result.protocolVersion}; Pi supports version 1`);
		}
		return result;
	}

	async request<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		if (this.failure) throw this.failure;
		const id = ++this.nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.pending.set(id, { resolve, reject });
		try {
			this.send({ id, method, params });
			return (await raceWithAbortSignal(promise, signal)) as T;
		} finally {
			this.pending.delete(id);
		}
	}

	notify(method: string, params: object): void {
		this.send({ method, params });
	}

	async close(): Promise<void> {
		stopAgy(this.child);
		await this.exited;
	}

	private send(message: object): void {
		if (!this.failure) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private async reply(request: JsonRpcRequest, handle: AcpHandler | undefined): Promise<void> {
		try {
			if (!handle) throw new McpError(-32601, `Unsupported ACP client request ${request.method}`);
			const result = await handle(request.method, request.params);
			this.send({ id: request.id, result });
		} catch (error) {
			this.send({
				id: request.id,
				error: { code: error instanceof McpError ? error.code : -32603, message: String(error) },
			});
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const pending of this.pending.values()) pending.reject(this.failure);
		this.pending.clear();
	}
}

export function acpChoices(option: AcpConfigOption | undefined): AcpChoice[] {
	return option?.type === "select"
		? (option.options ?? []).flatMap((choice) => ("value" in choice ? [choice] : choice.options))
		: [];
}

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function readAntigravityModels(
	cwd: string,
	signal?: AbortSignal,
): Promise<Model<"google-antigravity">[] | undefined> {
	const acp = new AntigravityAcp(cwd, []);
	try {
		const { agentCapabilities } = await acp.initialize(signal);
		const session = await acp.request<AcpSession>("session/new", { cwd, mcpServers: [] }, signal);
		let configOptions = session.configOptions ?? [];
		const model = configOptions.find((option) => option.id === "model" && option.type === "select");
		if (!model) throw new Error("Antigravity CLI did not report an ACP model selector. Update agy.");
		const models: Model<"google-antigravity">[] = [];
		for (const { value, name } of acpChoices(model)) {
			if (configOptions.find((option) => option.id === model.id)?.currentValue !== value) {
				({ configOptions } = await acp.request<{ configOptions: AcpConfigOption[] }>(
					"session/set_config_option",
					{
						sessionId: session.sessionId,
						configId: model.id,
						value,
					},
					signal,
				));
			}
			const thought = configOptions.find((option) => option.category === "thought_level");
			const efforts = new Set(acpChoices(thought).map((option) => option.value));
			models.push({
				id: value,
				name,
				provider: ANTIGRAVITY_PROVIDER,
				api: ANTIGRAVITY_PROVIDER,
				baseUrl: "",
				input: agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
				reasoning: THINKING_LEVELS.some((level) => level !== "off" && efforts.has(level)),
				thinkingLevelMap: Object.fromEntries(
					THINKING_LEVELS.map((level) => [level, efforts.has(level) ? level : null]),
				),
			});
		}
		return models;
	} catch (error) {
		if (isAntigravityAuthRequired(error)) return undefined;
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.PI_ANTIGRAVITY_CLI) return undefined;
		throw error;
	} finally {
		await acp.close();
	}
}

export async function logoutAntigravity(cwd: string, signal: AbortSignal): Promise<void> {
	const acp = new AntigravityAcp(cwd, []);
	try {
		const initialization = await acp.initialize(signal);
		if (!initialization.agentCapabilities?.auth?.logout)
			throw new Error("Antigravity CLI does not support ACP sign-out. Update agy.");
		await acp.request("logout", {}, signal);
	} finally {
		await acp.close();
	}
}
