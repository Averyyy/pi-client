import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiServer, type ServerConfig } from "../src/server.ts";
import {
	appendMessages,
	clearAllSessions,
	getOrCreateSession,
	type SessionStaticContext,
	setStaticContext,
} from "../src/session-store.ts";

interface ServerResponse {
	status?: string;
	sessionId?: string;
	staticContextHash?: string;
	messageCount?: number;
	error?: string;
	deleted?: string;
}

describe("pi-server integration", () => {
	let server: Server;
	let baseUrl: string;

	beforeEach(() => {
		clearAllSessions();
		server = createPiServer({ authToken: "test-token" } as Partial<ServerConfig>);
		server.listen(0);
		const addr = server.address();
		if (typeof addr === "object" && addr !== null) {
			baseUrl = `http://127.0.0.1:${addr.port}`;
		} else {
			throw new Error("Failed to get server address");
		}
	});

	afterEach(() => {
		return new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	it("stores and retrieves session state with delta messages", () => {
		const sessionId = "delta-test";
		getOrCreateSession(sessionId);

		const ctx: SessionStaticContext = {
			systemPrompt: "You are helpful.",
			tools: [],
		};
		setStaticContext(sessionId, ctx);

		appendMessages(sessionId, [{ role: "user", content: "Hello", timestamp: 1000 }]);

		const session = getOrCreateSession(sessionId);
		expect(session.messages.length).toBe(1);
		expect(session.messages[0].role).toBe("user");

		appendMessages(sessionId, [
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi!" }],
				api: "openai-completions",
				provider: "opencode-go",
				model: "glm-5.1",
				usage: {
					input: 5,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 7,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2000,
			},
		]);

		const updated = getOrCreateSession(sessionId);
		expect(updated.messages.length).toBe(2);
	});

	it("session init endpoint creates session with static context", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "http-test",
				staticContext: {
					systemPrompt: "You are a coding assistant.",
					tools: [{ name: "read", description: "Read a file", parameters: {} }],
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.sessionId).toBe("http-test");
		expect(body.staticContextHash).toBeTruthy();
	});

	it("rejects stream without prior static context", async () => {
		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "no-ctx-stream",
				model: {
					id: "test-model",
					api: "openai-completions",
					provider: "opencode-go",
					baseUrl: "https://example.com",
					name: "Test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				delta: [{ role: "user", content: "hello", timestamp: 1000 }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ServerResponse;
		expect(body.error).toContain("static context");
	});

	it("accepts stream with inline static context", async () => {
		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "inline-ctx-stream",
				model: {
					id: "test-model",
					api: "openai-completions",
					provider: "opencode-go",
					baseUrl: "https://example.com",
					name: "Test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				delta: [{ role: "user", content: "hello", timestamp: 1000 }],
				staticContext: {
					systemPrompt: "You are helpful.",
					tools: [],
				},
			}),
		});
		expect(res.status).toBe(200);
	});

	it("rejects unauthenticated requests when auth token is configured", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "unauth" }),
		});
		expect(res.status).toBe(401);
	});

	it("health check works without auth", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown routes with auth", async () => {
		const res = await fetch(`${baseUrl}/unknown`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});
});
