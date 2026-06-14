import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	type CompactionSettings,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	type ProxyAssistantMessageEvent,
	prepareCompaction,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { type Context, type Message, type Model, type SimpleStreamOptions, streamSimple } from "@earendil-works/pi-ai";
import type { ServerConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { encodeErrorEvent, encodeProxyEvent } from "./event-encoding.ts";
import { CHUNK_ENDPOINT, type RequestChunkBody, receiveRequestChunk } from "./request-chunks.ts";
import {
	appendAssistantResponse,
	appendMessages,
	deleteSession as deleteSessionFromStore,
	dropLastAssistantError,
	getOrCreateSession,
	getSession,
	replaceMessages,
	type SessionStaticContext,
	setStaticContext,
} from "./session-store.ts";

export { loadConfig, type ServerConfig } from "./config.ts";

interface SessionInitBody {
	sessionId: string;
	staticContext?: SessionStaticContext;
}

interface StreamRequestBody {
	sessionId: string;
	model: Model<any>;
	delta: Message[];
	options?: SimpleStreamOptions;
	staticContext?: SessionStaticContext;
}

interface SessionSyncBody {
	sessionId: string;
	messages: Message[];
	staticContext?: SessionStaticContext;
}

interface SessionCompactBody {
	sessionId: string;
	model: Model<any>;
	options?: SimpleStreamOptions;
	settings?: CompactionSettings;
	customInstructions?: string;
	dropLastAssistantError?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
	res.end(data);
}

function authenticate(config: ServerConfig, req: IncomingMessage): boolean {
	if (!config.authToken) return true;
	const header = req.headers.authorization;
	if (!header) return false;
	const token = header.startsWith("Bearer ") ? header.slice(7) : header;
	return token === config.authToken;
}

interface ResolvedStream {
	model: Model<any>;
	options: SimpleStreamOptions;
}

export function resolveStreamOptions(
	_config: ServerConfig,
	model: Model<any>,
	body: StreamRequestBody,
): ResolvedStream {
	return { model, options: { ...(body.options ?? {}) } };
}

function handleSessionInit(body: SessionInitBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	} else {
		getOrCreateSession(body.sessionId);
	}
	const session = getSession(body.sessionId)!;
	sendJson(res, 200, {
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		messageCount: session.messages.length,
	});
}

function handleSessionUpdate(
	body: SessionInitBody & { staticContext: SessionStaticContext },
	res: ServerResponse,
): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!body.staticContext) {
		sendJson(res, 400, { error: "staticContext is required for update" });
		return;
	}
	setStaticContext(body.sessionId, body.staticContext);
	const session = getSession(body.sessionId)!;
	sendJson(res, 200, {
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		messageCount: session.messages.length,
	});
}

function handleSessionSync(body: SessionSyncBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!Array.isArray(body.messages)) {
		sendJson(res, 400, { error: "messages is required" });
		return;
	}
	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}
	const session = replaceMessages(body.sessionId, body.messages);
	sendJson(res, 200, {
		sessionId: session.sessionId,
		staticContextHash: session.staticContextHash,
		messageCount: session.messages.length,
	});
}

function messagesToEntries(messages: Message[]): SessionTreeEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const id = `message-${index}`;
		const entry: SessionTreeEntry = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
		parentId = id;
		return entry;
	});
}

function createCompactionSummaryMessage(summary: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}` }],
		timestamp: Date.now(),
	};
}

async function handleSessionCompact(body: SessionCompactBody, res: ServerResponse): Promise<void> {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!body.model) {
		sendJson(res, 400, { error: "model is required" });
		return;
	}

	const session = getSession(body.sessionId);
	if (!session) {
		sendJson(res, 404, { error: "session not found" });
		return;
	}

	if (body.dropLastAssistantError) {
		dropLastAssistantError(body.sessionId);
	}

	const entries = messagesToEntries(session.messages);
	const preparationResult = prepareCompaction(entries, body.settings ?? DEFAULT_COMPACTION_SETTINGS);
	if (!preparationResult.ok) {
		sendJson(res, 400, { error: preparationResult.error.message });
		return;
	}
	if (!preparationResult.value) {
		sendJson(res, 400, { error: "Nothing to compact" });
		return;
	}

	const options = body.options ?? {};
	const result = await compact(
		preparationResult.value,
		body.model,
		options.apiKey ?? "",
		options.headers,
		body.customInstructions,
		undefined,
		options.reasoning,
	);
	if (!result.ok) {
		sendJson(res, 500, { error: result.error.message });
		return;
	}

	const firstKeptIndex = entries.findIndex((entry) => entry.id === result.value.firstKeptEntryId);
	if (firstKeptIndex === -1) {
		sendJson(res, 500, { error: "Compaction result referenced an unknown kept message" });
		return;
	}

	const nextSession = replaceMessages(body.sessionId, [
		createCompactionSummaryMessage(result.value.summary),
		...session.messages.slice(firstKeptIndex),
	]);
	sendJson(res, 200, { success: true, messageCount: nextSession.messages.length });
}

function handleDropLastAssistantError(body: SessionInitBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	const dropped = dropLastAssistantError(body.sessionId);
	const session = getOrCreateSession(body.sessionId);
	sendJson(res, 200, { success: true, dropped, messageCount: session.messages.length });
}

function handleStream(config: ServerConfig, body: StreamRequestBody, res: ServerResponse): void {
	if (!body.sessionId) {
		sendJson(res, 400, { error: "sessionId is required" });
		return;
	}
	if (!body.model) {
		sendJson(res, 400, { error: "model is required" });
		return;
	}

	const session = getOrCreateSession(body.sessionId);

	if (body.staticContext) {
		setStaticContext(body.sessionId, body.staticContext);
	}

	if (!session.staticContext && !body.staticContext) {
		sendJson(res, 400, { error: "Session has no static context. Initialize with /api/session/init first." });
		return;
	}

	if (body.delta && body.delta.length > 0) {
		appendMessages(body.sessionId, body.delta);
	}

	const context: Context = {
		systemPrompt: session.staticContext?.systemPrompt,
		messages: session.messages,
		tools: session.staticContext?.tools,
	};

	const { model: resolvedModel, options: streamOptions } = resolveStreamOptions(config, body.model, body);

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const stream = streamSimple(resolvedModel, context, streamOptions);

	let assistantMessage: Message | undefined;

	(async () => {
		for await (const event of stream) {
			if (event.type === "done") {
				assistantMessage = event.message;
			} else if (event.type === "error") {
				assistantMessage = event.error;
			}

			const proxyEvent = toProxyEvent(event);
			if (proxyEvent) {
				res.write(encodeProxyEvent(proxyEvent));
			}
		}

		if (assistantMessage) {
			appendAssistantResponse(body.sessionId, assistantMessage);
		}

		res.end();
	})().catch((err) => {
		res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
		res.end();
	});
}

async function handlePostRequest(
	config: ServerConfig,
	pathname: string,
	body: unknown,
	res: ServerResponse,
): Promise<boolean> {
	if (pathname === "/api/session/init") {
		handleSessionInit(body as SessionInitBody, res);
		return true;
	}

	if (pathname === "/api/session/update") {
		handleSessionUpdate(body as SessionInitBody & { staticContext: SessionStaticContext }, res);
		return true;
	}

	if (pathname === "/api/session/sync") {
		handleSessionSync(body as SessionSyncBody, res);
		return true;
	}

	if (pathname === "/api/session/drop-last-assistant-error") {
		handleDropLastAssistantError(body as SessionInitBody, res);
		return true;
	}

	if (pathname === "/api/session/compact") {
		await handleSessionCompact(body as SessionCompactBody, res);
		return true;
	}

	if (pathname === "/api/stream") {
		handleStream(config, body as StreamRequestBody, res);
		return true;
	}

	return false;
}

export function createPiServer(configOverride?: Partial<ServerConfig>): HttpServer {
	const config = loadConfig(configOverride);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		if (!authenticate(config, req)) {
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}

		if (req.method === "POST" && url.pathname === CHUNK_ENDPOINT) {
			try {
				const body = JSON.parse(await readBody(req)) as RequestChunkBody;
				const chunkResult = receiveRequestChunk(body);
				if (!chunkResult.complete) {
					sendJson(res, 200, chunkResult.ack);
					return;
				}
				await handlePostRequest(config, chunkResult.target, JSON.parse(chunkResult.bodyJson) as unknown, res);
			} catch (err) {
				if (!res.headersSent) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				} else {
					res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
					res.end();
				}
			}
			return;
		}

		if (req.method === "POST") {
			try {
				const body = JSON.parse(await readBody(req)) as unknown;
				if (await handlePostRequest(config, url.pathname, body, res)) return;
			} catch (err) {
				if (!res.headersSent) {
					sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
				} else {
					res.write(encodeErrorEvent(err instanceof Error ? err.message : String(err)));
					res.end();
				}
				return;
			}
		}

		if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
			const sessionId = decodeURIComponent(url.pathname.slice("/api/session/".length));
			deleteSessionFromStore(sessionId);
			sendJson(res, 200, { deleted: sessionId });
			return;
		}

		sendJson(res, 404, { error: "Not found" });
	});

	return server;
}

function toProxyEvent(
	event: import("@earendil-works/pi-ai").AssistantMessageEvent,
): ProxyAssistantMessageEvent | undefined {
	switch (event.type) {
		case "start":
			return { type: "start" };
		case "text_start":
			return { type: "text_start", contentIndex: event.contentIndex };
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return {
				type: "text_end",
				contentIndex: event.contentIndex,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "text"
						? (event.partial.content[event.contentIndex] as { textSignature?: string }).textSignature
						: undefined,
			};
		case "thinking_start":
			return { type: "thinking_start", contentIndex: event.contentIndex };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				contentSignature:
					event.partial.content[event.contentIndex]?.type === "thinking"
						? (event.partial.content[event.contentIndex] as { thinkingSignature?: string }).thinkingSignature
						: undefined,
			};
		case "toolcall_start":
			return {
				type: "toolcall_start",
				contentIndex: event.contentIndex,
				id:
					event.partial.content[event.contentIndex]?.type === "toolCall"
						? (event.partial.content[event.contentIndex] as { id: string }).id
						: "",
				toolName:
					event.partial.content[event.contentIndex]?.type === "toolCall"
						? (event.partial.content[event.contentIndex] as { name: string }).name
						: "",
			};
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex };
		case "done":
			return { type: "done", reason: event.reason, usage: event.message.usage };
		case "error":
			return {
				type: "error",
				reason: event.reason,
				errorMessage: event.error.errorMessage,
				usage: event.error.usage,
			};
		default:
			return undefined;
	}
}

export function startServer(configOverride?: Partial<ServerConfig>): HttpServer {
	const config = loadConfig(configOverride);
	const server = createPiServer(configOverride);
	server.listen(config.port, config.host, () => {
		console.log(`pi-server listening on ${config.host}:${config.port}`);
	});
	return server;
}
