import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.ts";
import { ViewerAuth } from "./viewer-auth.ts";
import { projectContent, projectMessage, ViewerStore } from "./viewer-store.ts";
import type { ObserverUpdate, ViewerLive, ViewerMessage, ViewerTool, ViewerUpdate } from "./viewer-types.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function securityHeaders(res: ServerResponse): void {
	res.setHeader("Cache-Control", "no-store");
	res.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
	);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
}

function sameOrigin(req: IncomingMessage): boolean {
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	if (!req.headers.origin) return false;
	try {
		const origin = new URL(req.headers.origin);
		const protocol = "encrypted" in req.socket || req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:";
		return origin.host === req.headers.host && origin.protocol === protocol;
	} catch {
		return false;
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

function messages(value: unknown): ViewerMessage[] {
	if (!Array.isArray(value)) throw new Error("messages must be an array");
	return value.map((message) => projectMessage(object(message)));
}

function live(value: unknown): ViewerLive {
	const state = object(value);
	if (!Array.isArray(state.tools)) throw new Error("live.tools must be an array");
	const tools = state.tools.map((value): ViewerTool => {
		const tool = object(value);
		if (
			typeof tool.id !== "string" ||
			typeof tool.name !== "string" ||
			!["running", "completed", "error"].includes(String(tool.status))
		)
			throw new Error("Invalid live tool");
		const result = tool.result === undefined ? undefined : object(tool.result);
		if (result?.isError !== undefined && typeof result.isError !== "boolean")
			throw new Error("Invalid tool result status");
		return {
			id: tool.id,
			name: tool.name,
			arguments: tool.arguments,
			...(result !== undefined
				? {
						result: {
							content: projectContent(result.content),
							...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
						},
					}
				: {}),
			status: tool.status as ViewerTool["status"],
		};
	});
	return { message: state.message === null ? null : projectMessage(object(state.message)), tools };
}

export class ViewerHttp {
	readonly auth: ViewerAuth;
	readonly store: ViewerStore;
	private readonly streams = new Set<ServerResponse>();

	constructor(config: ServerConfig) {
		this.auth = new ViewerAuth(config.sessionStoreDir, config.authToken);
		this.store = new ViewerStore(config.sessionStoreDir);
	}

	close(): void {
		for (const stream of this.streams) stream.end();
	}

	handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
		if (url.pathname !== "/" && !url.pathname.startsWith("/viewer/")) return false;
		securityHeaders(res);
		if (!this.auth.configured) {
			json(res, 503, { error: "Viewer unavailable" });
			return true;
		}
		if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/viewer/assets/"))) {
			const assets: Record<string, [string, string]> = {
				"/": ["index.html", "text/html; charset=utf-8"],
				"/viewer/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
				"/viewer/assets/app.css": ["app.css", "text/css; charset=utf-8"],
			};
			const asset = assets[url.pathname];
			if (!asset) {
				json(res, 404, { error: "Not found" });
				return true;
			}
			const path = fileURLToPath(new URL(`../dist/viewer/${asset[0]}`, import.meta.url));
			if (!existsSync(path)) {
				json(res, 503, { error: "Viewer assets unavailable" });
				return true;
			}
			res.writeHead(200, { "Content-Type": asset[1] });
			res.end(readFileSync(path));
			return true;
		}
		if (req.method === "POST" && !sameOrigin(req)) {
			json(res, 403, { error: "Origin rejected" });
			return true;
		}
		if (req.method === "POST" && url.pathname === "/viewer/login") {
			const status = this.auth.authenticate(req, true);
			if (status !== 200) {
				json(res, status, {
					error: status === 423 ? "Viewer locked" : "Unauthorized",
					remainingAttempts: this.auth.remainingAttempts,
				});
				return true;
			}
			res.setHeader("Set-Cookie", this.auth.createCookie(req));
			json(res, 200, { authenticated: true });
			return true;
		}
		if (this.auth.locked) {
			json(res, 423, { error: "Viewer locked", remainingAttempts: 0 });
			return true;
		}
		if (!this.auth.hasCookie(req)) {
			json(res, 401, { error: "Unauthorized" });
			return true;
		}
		if (req.method === "POST" && url.pathname === "/viewer/logout") {
			res.setHeader("Set-Cookie", this.auth.clearCookie(req));
			json(res, 200, { authenticated: false });
			return true;
		}
		if (req.method !== "GET") {
			json(res, 405, { error: "Read-only viewer" });
			return true;
		}
		try {
			if (url.pathname === "/viewer/api/projects") json(res, 200, this.store.projects());
			else if (url.pathname === "/viewer/api/threads")
				json(res, 200, this.store.page(url.searchParams.get("project") ?? "", url.searchParams.get("cursor")));
			else if (url.pathname === "/viewer/api/events") {
				const send = this.events(req, res);
				const listener = () => send("catalog", {});
				this.store.catalogListeners.add(listener);
				res.once("close", () => this.store.catalogListeners.delete(listener));
				send("catalog", {});
			} else {
				const match = /^\/viewer\/api\/threads\/([^/]+)(?:\/(rounds|events))?$/.exec(url.pathname);
				const id = match ? decodeURIComponent(match[1]) : "";
				const thread = this.store.get(id);
				if (!thread) {
					json(res, 404, { error: "Thread not found" });
					return true;
				}
				if (match?.[2] === "rounds") json(res, 200, this.store.rounds(id, url.searchParams.get("before")));
				else if (match?.[2] === "events") {
					const send = this.events(req, res);
					const listener = (updatedId: string, update: ViewerUpdate) => {
						if (updatedId === id) send("update", update);
					};
					this.store.listeners.add(listener);
					const removed = (removedId: string) => {
						if (removedId === id) {
							send("deleted", { id });
							res.end();
						}
					};
					this.store.removedListeners.add(removed);
					res.once("close", () => {
						this.store.listeners.delete(listener);
						this.store.removedListeners.delete(removed);
					});
					send("snapshot", { thread, ...this.store.rounds(id, null) });
				} else json(res, 200, { thread });
			}
		} catch (error) {
			if (!res.headersSent)
				json(res, 400, { error: error instanceof Error ? error.message : "Invalid viewer request" });
			else res.end();
		}
		return true;
	}

	connect(req: IncomingMessage, res: ServerResponse, sessionId: string | null): void {
		if (!sessionId) {
			json(res, 400, { error: "sessionId is required" });
			return;
		}
		const connection = this.store.connect(sessionId);
		const send = this.events(req, res, false);
		const removed = (id: string) => {
			if (id === sessionId) {
				send("deleted", { id });
				res.end();
			}
		};
		this.store.removedListeners.add(removed);
		res.once("close", () => {
			this.store.removedListeners.delete(removed);
			connection.close();
		});
		send("connected", { connectionId: connection.connectionId });
	}

	observe(value: unknown, res: ServerResponse): void {
		try {
			const body = object(value);
			if (typeof body.sessionId !== "string" || !body.sessionId || typeof body.connectionId !== "string")
				throw new Error("sessionId and connectionId are required");
			if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
				throw new Error("sequence must be a positive integer");
			if (body.cwd !== undefined && (typeof body.cwd !== "string" || !body.cwd))
				throw new Error("cwd must be a non-empty string");
			if (body.title !== undefined && typeof body.title !== "string") throw new Error("title must be a string");
			if (body.status !== undefined && body.status !== "running" && body.status !== "idle")
				throw new Error("Invalid observer status");
			if (body.replace !== undefined && body.append !== undefined)
				throw new Error("replace and append are exclusive");
			const update: ObserverUpdate = {
				sessionId: body.sessionId,
				connectionId: body.connectionId,
				sequence: body.sequence as number,
				...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}),
				...(body.title !== undefined ? { title: body.title as string } : {}),
				...(body.status !== undefined ? { status: body.status as "running" | "idle" } : {}),
				...(body.replace !== undefined ? { replace: messages(body.replace) } : {}),
				...(body.append !== undefined ? { append: messages(body.append) } : {}),
				...(body.live !== undefined ? { live: live(body.live) } : {}),
			};
			this.store.update(update);
			json(res, 200, { accepted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid observer request";
			if (message === "Observer session deleted") json(res, 410, { error: message, deleted: true });
			else json(res, message === "Observer connection expired" ? 409 : 400, { error: message });
		}
	}

	private events(req: IncomingMessage, res: ServerResponse, cookie = true): (event: string, value: unknown) => void {
		securityHeaders(res);
		res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		res.flushHeaders();
		this.auth.track(res, cookie ? req : undefined);
		this.streams.add(res);
		let blocked = false;
		res.on("drain", () => {
			blocked = false;
		});
		const send = (event: string, value: unknown) => {
			if (res.destroyed || res.writableEnded) return;
			if (blocked) {
				res.end();
				return;
			}
			blocked = !res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
		};
		const heartbeat = setInterval(() => {
			if (this.auth.locked || (cookie && !this.auth.hasCookie(req))) {
				res.end();
				return;
			}
			if (!blocked && !res.writableEnded) blocked = !res.write(": keep-alive\n\n");
		}, 25_000);
		heartbeat.unref();
		res.once("close", () => {
			clearInterval(heartbeat);
			this.streams.delete(res);
		});
		return send;
	}
}
