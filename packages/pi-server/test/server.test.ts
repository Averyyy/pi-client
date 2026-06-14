import type { Server } from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiServer, resolveStreamOptions, type ServerConfig } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";

interface ServerResponse {
	status?: string;
	sessionId?: string;
	staticContextHash?: string;
	messageCount?: number;
	error?: string;
	deleted?: string;
	dropped?: boolean;
}

describe("pi-server HTTP", () => {
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

	it("responds to health check", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.status).toBe("ok");
	});

	it("rejects requests without auth token when configured", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "test" }),
		});
		expect(res.status).toBe(401);
	});

	it("accepts requests with correct auth token", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "test-auth" }),
		});
		expect(res.status).toBe(200);
	});

	it("initializes session with static context", async () => {
		const res = await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "test-init",
				staticContext: {
					systemPrompt: "You are helpful.",
					tools: [],
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.sessionId).toBe("test-init");
		expect(body.staticContextHash).toBeTruthy();
		expect(body.messageCount).toBe(0);
	});

	it("reassembles chunked requests and dispatches them to the target endpoint", async () => {
		const originalBody = {
			sessionId: "chunked-init",
			staticContext: {
				systemPrompt: "You are helpful. ".repeat(300),
				tools: [],
			},
		};
		const encoded = Buffer.from(JSON.stringify(originalBody), "utf-8").toString("base64");
		const midpoint = Math.ceil(encoded.length / 2);
		const requestId = "request-1";

		const first = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				requestId,
				target: "/api/session/init",
				index: 0,
				total: 2,
				chunk: encoded.slice(0, midpoint),
			}),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ received: true, requestId, index: 0, total: 2 });

		const second = await fetch(`${baseUrl}/api/request/chunk`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				requestId,
				target: "/api/session/init",
				index: 1,
				total: 2,
				chunk: encoded.slice(midpoint),
			}),
		});
		expect(second.status).toBe(200);

		const responseBody = (await second.json()) as ServerResponse;
		expect(responseBody.sessionId).toBe("chunked-init");
		expect(responseBody.messageCount).toBe(0);
		expect(getSession("chunked-init")?.staticContext?.systemPrompt).toBe(originalBody.staticContext.systemPrompt);
	});

	it("syncs a replaced local message history", async () => {
		const messages = [
			{ role: "user" as const, content: "new branch", timestamp: 1000 },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "branch answer" }],
				api: "openai-completions" as const,
				provider: "opencode-go" as const,
				model: "glm-5.1",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 2000,
			},
		];

		const res = await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "sync-history",
				messages,
				staticContext: { systemPrompt: "Synced system prompt" },
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.messageCount).toBe(2);
		expect(getSession("sync-history")?.messages).toEqual(messages);
		expect(getSession("sync-history")?.staticContext?.systemPrompt).toBe("Synced system prompt");
	});

	it("drops only the last assistant error message", async () => {
		const errorMessage = {
			role: "assistant" as const,
			content: [],
			api: "openai-completions" as const,
			provider: "opencode-go" as const,
			model: "glm-5.1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "retryable",
			timestamp: 2000,
		};

		await fetch(`${baseUrl}/api/session/sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "drop-error",
				messages: [{ role: "user", content: "hello", timestamp: 1000 }, errorMessage],
			}),
		});

		const res = await fetch(`${baseUrl}/api/session/drop-last-assistant-error`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "drop-error" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.dropped).toBe(true);
		expect(body.messageCount).toBe(1);
		expect(getSession("drop-error")?.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("does not create a session when dropping a missing assistant error", async () => {
		const res = await fetch(`${baseUrl}/api/session/drop-last-assistant-error`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ sessionId: "missing-drop-error" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.dropped).toBe(false);
		expect(body.messageCount).toBe(0);
		expect(getSession("missing-drop-error")).toBeUndefined();
	});

	it("rejects stream without static context", async () => {
		const res = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "test-no-ctx",
				model: { id: "test", api: "openai-completions", provider: "opencode-go", baseUrl: "https://example.com" },
				delta: [],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ServerResponse;
		expect(body.error).toContain("static context");
	});

	it("returns 404 for unknown routes with auth", async () => {
		const res = await fetch(`${baseUrl}/unknown`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	it("deletes only the requested session, not all sessions", async () => {
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "session-a",
				staticContext: { systemPrompt: "A" },
			}),
		});
		await fetch(`${baseUrl}/api/session/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				sessionId: "session-b",
				staticContext: { systemPrompt: "B" },
			}),
		});

		expect(getSession("session-a")).toBeDefined();
		expect(getSession("session-b")).toBeDefined();

		const res = await fetch(`${baseUrl}/api/session/session-a`, {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServerResponse;
		expect(body.deleted).toBe("session-a");

		expect(getSession("session-a")).toBeUndefined();
		expect(getSession("session-b")).toBeDefined();
	});
});

describe("resolveStreamOptions", () => {
	const baseModel: Model<"openai-completions"> = {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://original.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};

	it("returns original model when no provider overrides are set", () => {
		const config: ServerConfig = {
			host: "127.0.0.1",
			port: 4217,
			authToken: undefined,
		};
		const { model, options } = resolveStreamOptions(config, baseModel, {
			sessionId: "s1",
			model: baseModel,
			delta: [],
		});
		expect(model.baseUrl).toBe("https://original.example.com");
		expect(options.apiKey).toBeUndefined();
	});

	it("ignores server-side provider request config", () => {
		const config = {
			host: "127.0.0.1",
			port: 4217,
			authToken: undefined,
			providerApiKey: "sk-server",
			providerBaseUrl: "https://server-proxy.example.com/v1",
			providerHeaders: { "X-Server": "yes" },
		} as ServerConfig;
		const { model, options } = resolveStreamOptions(config, baseModel, {
			sessionId: "s1",
			model: baseModel,
			delta: [],
			options: { headers: { "X-Client": "yes" } },
		});
		expect(model.baseUrl).toBe("https://original.example.com");
		expect(options.apiKey).toBeUndefined();
		expect(options.headers).toEqual({ "X-Client": "yes" });
	});
});
