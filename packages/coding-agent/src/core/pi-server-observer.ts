import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, TextSignatureV1, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "../utils/abort.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import { bashExecutionToText } from "./messages.ts";
import { ChunkRequest } from "./pi-server-request.ts";
import { type ObserverSubagent, PiServerSubagents, resolvePiServerSubagents } from "./pi-server-subagents.ts";
import type { SessionEntry } from "./session-manager.ts";

const observers = new WeakMap<AgentSession, PiServerObserver>();

export async function closePiServerObserver(session: AgentSession): Promise<void> {
	await observers.get(session)?.close();
}

type ViewerContent =
	| { type: "text"; text: string; phase?: TextSignatureV1["phase"] }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "attachment"; label: string };

export interface ObserverMessage {
	id: string;
	role: string;
	content: string | ViewerContent[];
	timestamp: number;
	stopReason?: string;
	phase?: string;
	errorMessage?: string;
}

interface ObserverTool {
	id: string;
	name: string;
	arguments: unknown;
	result?: unknown;
	status: "running" | "completed" | "error";
}

export interface ObserverUpdate {
	sessionId: string;
	connectionId: string;
	sequence: number;
	cwd: string;
	title: string;
	subagents?: ObserverSubagent[];
	replace?: ObserverMessage[];
	append?: ObserverMessage[];
	status: "running" | "idle";
	live: { message: ObserverMessage | null; tools: ObserverTool[] };
}

function textPhase(signature: string | undefined): TextSignatureV1["phase"] {
	if (!signature?.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
		if (
			parsed.v === 1 &&
			typeof parsed.id === "string" &&
			(parsed.phase === "commentary" || parsed.phase === "final_answer")
		)
			return parsed.phase;
	} catch {
		// Provider signatures outside TextSignatureV1 have no display phase.
	}
	return undefined;
}

function projectContent(
	content: string | (TextContent | ThinkingContent | ImageContent | ToolCall)[],
): ObserverMessage["content"] {
	if (typeof content === "string") return content;
	return content.map((part): ViewerContent => {
		if (part.type === "text") return { type: "text", text: part.text, phase: textPhase(part.textSignature) };
		if (part.type === "thinking") return { type: "thinking", thinking: part.thinking };
		if (part.type === "toolCall")
			return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
		return { type: "attachment", label: part.mimeType };
	});
}

function projectMessage(id: string, message: AgentMessage, timestamp = message.timestamp): ObserverMessage | undefined {
	if (message.role === "system" || (message.role === "custom" && !message.display)) return undefined;
	let content: ObserverMessage["content"];
	if (message.role === "bashExecution") content = bashExecutionToText(message);
	else if (message.role === "compactionSummary" || message.role === "branchSummary") content = message.summary;
	else content = projectContent(message.content);
	const projected: ObserverMessage = { id, role: message.role, content, timestamp };
	if (message.role === "assistant") {
		projected.stopReason = message.stopReason;
		projected.errorMessage = message.errorMessage;
		for (const part of message.content) {
			const phase = part.type === "text" ? textPhase(part.textSignature) : undefined;
			if (phase) projected.phase = phase;
		}
	}
	return projected;
}

export function projectObserverEntries(entries: SessionEntry[]): ObserverMessage[] {
	const messages: ObserverMessage[] = [];
	for (const entry of entries) {
		let message: ObserverMessage | undefined;
		if (entry.type === "message") message = projectMessage(entry.id, entry.message, Date.parse(entry.timestamp));
		else if (entry.type === "custom_message" && entry.display) {
			message = {
				id: entry.id,
				role: "custom",
				content: projectContent(entry.content),
				timestamp: Date.parse(entry.timestamp),
			};
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			message = { id: entry.id, role: entry.type, content: entry.summary, timestamp: Date.parse(entry.timestamp) };
		}
		if (message) messages.push(message);
	}
	return messages;
}

/** Publishes transcript updates independently of provider requests and durable server trees. */
export class PiServerObserver {
	private readonly session: AgentSession;
	private readonly unsubscribe: () => void;
	private controller?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private connectionReady?: Promise<void>;
	private deletedSessionId?: string;
	private connectionId?: string;
	private connectedSessionId?: string;
	private sequence = 0;
	private sending = false;
	private flushPromise?: Promise<void>;
	private dirty = true;
	private historyDirty = true;
	private replace = true;
	private sentEntryId?: string;
	private pendingEntries: SessionEntry[] = [];
	private firstUserTitle = "";
	private liveMessage: AgentMessage | null = null;
	private liveMessageId = "";
	private readonly tools = new Map<string, ObserverTool>();
	private disconnected = false;
	private observedSessionId?: string;
	private readonly subagents: PiServerSubagents;
	private sentSubagentVersion = -1;

	constructor(session: AgentSession) {
		this.session = session;
		this.subagents = new PiServerSubagents(session, () => {
			this.dirty = true;
			this.historyDirty = true;
			this.schedule(0);
		});
		this.syncSession();
		observers.set(session, this);
		this.unsubscribe = session.subscribe((event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.reportError(error);
			}
		});
		void this.connect();
	}

	private handleEvent(event: AgentSessionEvent): void {
		this.syncSession();
		switch (event.type) {
			case "session_disposed":
				this.dispose();
				return;
			case "run_state_changed":
				resolvePiServerSubagents();
				if (!event.running) {
					this.liveMessage = null;
					this.tools.clear();
				}
				break;
			case "message_start":
				if (event.message.role !== "assistant") return;
				this.tools.clear();
				this.liveMessageId = randomUUID();
				this.liveMessage = event.message;
				break;
			case "message_update":
				this.liveMessage = event.message;
				break;
			case "entry_appended":
			case "message_committed":
				if (this.connectionId && !this.historyDirty) {
					this.pendingEntries.push(event.entry);
					if (this.pendingEntries.length > 64) {
						this.pendingEntries = [];
						this.historyDirty = true;
					}
				}
				if (event.entry.type === "message" && event.entry.message.role === "assistant") this.liveMessage = null;
				break;
			case "history_reconciled":
			case "session_tree_changed":
				this.subagents.restore();
				if (this.deletedSessionId && this.deletedSessionId !== this.session.sessionId) {
					this.deletedSessionId = undefined;
					void this.connect();
				}
				if (this.connectedSessionId && this.connectedSessionId !== this.session.sessionId) {
					this.connectionId = undefined;
					this.controller?.abort();
				}
				this.replace = true;
				this.historyDirty = true;
				break;
			case "compaction_end":
				this.historyDirty = true;
				break;
			case "compaction_start":
				break;
			case "session_info_changed":
				break;
			case "tool_execution_start":
				this.tools.set(event.toolCallId, {
					id: event.toolCallId,
					name: event.toolName,
					arguments: event.args,
					status: "running",
				});
				break;
			case "tool_execution_update": {
				const tool = this.tools.get(event.toolCallId);
				if (tool) tool.result = { content: projectContent(event.partialResult.content) };
				break;
			}
			case "tool_execution_end": {
				const tool = this.tools.get(event.toolCallId);
				if (tool) {
					tool.result = { content: projectContent(event.result.content), isError: event.isError };
					tool.status = event.isError ? "error" : "completed";
				}
				break;
			}
			default:
				return;
		}
		this.dirty = true;
		this.schedule(
			event.type === "run_state_changed" || event.type === "compaction_start" || event.type === "compaction_end"
				? 0
				: 80,
		);
	}

	private syncSession(): void {
		if (this.observedSessionId === this.session.sessionId) return;
		this.observedSessionId = this.session.sessionId;
		this.subagents.syncSession();
		this.sentSubagentVersion = -1;
		this.sentEntryId = undefined;
		this.pendingEntries = [];
		this.firstUserTitle = "";
		this.liveMessage = null;
		this.tools.clear();
	}

	private schedule(delay: number): void {
		if (
			this.disposed ||
			this.closing ||
			this.deletedSessionId === this.session.sessionId ||
			!this.dirty ||
			!this.connectionId ||
			this.sending ||
			this.timer
		)
			return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, delay);
		this.timer.unref();
	}

	private reportError(error: unknown): void {
		if (this.disposed || this.disconnected) return;
		this.disconnected = true;
		console.error(`pi-server observer disconnected: ${error instanceof Error ? error.message : String(error)}`);
	}

	private stopDeletedSession(sessionId: string, controller: AbortController): void {
		if (sessionId === this.session.sessionId) {
			this.deletedSessionId = sessionId;
			this.connectionId = undefined;
			this.pendingEntries = [];
			this.liveMessage = null;
			this.tools.clear();
			clearTimeout(this.timer);
			this.timer = undefined;
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		controller.abort();
	}

	private request(signal: AbortSignal): ChunkRequest {
		return new ChunkRequest({
			serverUrl: process.env.PI_SERVER_URL ?? "http://127.0.0.1:4217",
			authToken: process.env.PI_SERVER_AUTH_TOKEN ?? "",
			signal,
		});
	}

	private async connect(): Promise<void> {
		if (this.disposed || this.deletedSessionId === this.session.sessionId) return;
		this.syncSession();
		const controller = new AbortController();
		this.controller = controller;
		const sessionId = this.session.sessionId;
		this.connectedSessionId = sessionId;
		let resolveConnection: (() => void) | undefined;
		this.connectionReady = new Promise<void>((resolve) => {
			resolveConnection = resolve;
		});
		const timeout = setTimeout(() => controller.abort(new Error("connection timed out")), 10000);
		timeout.unref();
		try {
			const response = await this.request(controller.signal).getJson(
				`/api/observer/connect?sessionId=${encodeURIComponent(sessionId)}`,
			);
			if (response.status === 410) {
				this.stopDeletedSession(sessionId, controller);
				return;
			}
			if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
				throw new Error(`connection failed (HTTP ${response.status})`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let event = "";
			try {
				while (!this.disposed) {
					const { done, value } = await reader.read();
					if (done) throw new Error("connection closed");
					buffer += decoder.decode(value, { stream: true });
					let newline = buffer.indexOf("\n");
					while (newline !== -1) {
						const line = buffer.slice(0, newline).replace(/\r$/, "");
						buffer = buffer.slice(newline + 1);
						if (line.startsWith("event:")) event = line.slice(6).trim();
						if (event === "deleted" && line.startsWith("data:")) {
							this.stopDeletedSession(sessionId, controller);
							return;
						}
						if (event === "connected" && !this.connectionId && line.startsWith("data:")) {
							const connected = JSON.parse(line.slice(5)) as { connectionId: string };
							this.connectionId = connected.connectionId;
							this.sequence = 0;
							this.sentSubagentVersion = -1;
							clearTimeout(timeout);
							this.replace = true;
							this.historyDirty = true;
							this.dirty = true;
							this.schedule(0);
							resolveConnection?.();
						}
						newline = buffer.indexOf("\n");
					}
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
		} catch (error) {
			if (
				error instanceof TypeError &&
				error.message === "terminated" &&
				error.cause instanceof Error &&
				"code" in error.cause &&
				error.cause.code === "UND_ERR_SOCKET"
			)
				return;
			if (sessionId === this.session.sessionId && this.deletedSessionId !== sessionId) this.reportError(error);
		} finally {
			resolveConnection?.();
			clearTimeout(timeout);
			controller.abort();
			if (this.controller === controller) this.connectionId = undefined;
			if (this.controller === controller && !this.disposed && !this.closing && this.deletedSessionId !== sessionId) {
				this.reconnectTimer = setTimeout(
					() => {
						this.reconnectTimer = undefined;
						void this.connect();
					},
					sessionId === this.session.sessionId ? 2000 : 0,
				);
				this.reconnectTimer.unref();
			}
		}
	}

	private flush(): Promise<void> {
		if (this.flushPromise) return this.flushPromise;
		const promise = this.sendUpdate();
		this.flushPromise = promise;
		void promise.finally(() => {
			this.flushPromise = undefined;
		});
		return promise;
	}

	private async sendUpdate(): Promise<void> {
		this.subagents.resolve();
		const connectionId = this.connectionId;
		const sessionId = this.connectedSessionId;
		const controller = this.controller;
		if (
			!connectionId ||
			!sessionId ||
			sessionId !== this.session.sessionId ||
			!controller ||
			this.disposed ||
			this.deletedSessionId === sessionId ||
			this.sending ||
			!this.dirty
		)
			return;
		this.sending = true;
		this.dirty = false;
		try {
			const branch = this.historyDirty ? this.session.sessionManager.getBranch() : undefined;
			const sentIndex = branch && this.sentEntryId ? branch.findIndex((entry) => entry.id === this.sentEntryId) : -1;
			const replace = this.replace || (branch !== undefined && this.sentEntryId !== undefined && sentIndex === -1);
			this.historyDirty = false;
			this.replace = false;
			const entries = branch ? (replace ? branch : branch.slice(sentIndex + 1)) : this.pendingEntries;
			this.pendingEntries = [];
			const messages = projectObserverEntries(entries);
			if (replace) this.firstUserTitle = "";
			if (!this.firstUserTitle) {
				const firstUserContent = messages.find((message) => message.role === "user")?.content;
				this.firstUserTitle = (
					typeof firstUserContent === "string"
						? firstUserContent
						: (firstUserContent
								?.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("") ?? "")
				).slice(0, 120);
			}
			const subagentVersion = this.subagents.version;
			const update: ObserverUpdate = {
				sessionId,
				connectionId,
				sequence: ++this.sequence,
				cwd: this.session.sessionManager.getCwd(),
				title: this.session.sessionManager.getSessionName() ?? this.firstUserTitle,
				...(subagentVersion !== this.sentSubagentVersion ? { subagents: this.subagents.snapshot() } : {}),
				...(replace ? { replace: messages } : messages.length ? { append: messages } : {}),
				status: this.session.isIdle ? "idle" : "running",
				live: {
					message: this.liveMessage ? (projectMessage(this.liveMessageId, this.liveMessage) ?? null) : null,
					tools: [...this.tools.values()],
				},
			};
			const response = await this.request(controller.signal).postJson("/api/observer", update);
			if (response.status === 410) {
				this.stopDeletedSession(sessionId, controller);
				return;
			}
			if (!response.ok) throw new Error(`update failed (HTTP ${response.status})`);
			const result = (await response.json()) as { accepted: boolean };
			if (!result.accepted) throw new Error("update was not accepted");
			if (sessionId !== this.session.sessionId) return;
			this.sentSubagentVersion = subagentVersion;
			if (entries.length > 0) this.sentEntryId = entries.at(-1)?.id;
			else if (replace) this.sentEntryId = undefined;
			if (this.disconnected) {
				this.disconnected = false;
				console.error("pi-server observer connected");
			}
		} catch (error) {
			if (sessionId === this.session.sessionId && this.deletedSessionId !== sessionId) this.reportError(error);
			controller.abort();
		} finally {
			this.sending = false;
			this.schedule(80);
		}
	}

	close(): Promise<void> {
		this.closePromise ??= this.drainAndClose();
		return this.closePromise;
	}

	private async drainAndClose(): Promise<void> {
		if (this.disposed) return;
		this.closing = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		clearTimeout(this.reconnectTimer);
		try {
			await raceWithAbortSignal(
				(async () => {
					if (this.deletedSessionId === this.session.sessionId) return;
					if (!this.connectionId && this.controller?.signal.aborted) void this.connect();
					await this.connectionReady;
					await this.flushPromise;
					if (!this.connectionId) throw new Error("final transcript was not delivered: observer is disconnected");
					while (this.dirty && this.connectionId && !this.disposed) await this.flush();
					if (this.controller?.signal.aborted && this.deletedSessionId !== this.session.sessionId)
						throw new Error("final transcript was not delivered: observer update failed");
				})(),
				AbortSignal.timeout(10000),
			);
		} catch (error) {
			console.error(`pi-server observer shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.dispose();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.subagents.dispose();
		clearTimeout(this.timer);
		clearTimeout(this.reconnectTimer);
		this.controller?.abort();
		observers.delete(this.session);
	}
}
