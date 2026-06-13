import { beforeEach, describe, expect, it } from "vitest";
import {
	appendAssistantResponse,
	appendMessages,
	clearAllSessions,
	deleteSession,
	getOrCreateSession,
	getSession,
	type SessionStaticContext,
	setStaticContext,
} from "../src/session-store.ts";

describe("session-store", () => {
	beforeEach(() => {
		clearAllSessions();
	});

	it("creates a new session on first access", () => {
		const session = getOrCreateSession("test-1");
		expect(session.sessionId).toBe("test-1");
		expect(session.messages).toEqual([]);
		expect(session.staticContext).toBeUndefined();
	});

	it("returns existing session on subsequent access", () => {
		const _session1 = getOrCreateSession("test-1");
		appendMessages("test-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
		const session2 = getOrCreateSession("test-1");
		expect(session2.messages.length).toBe(1);
	});

	it("sets and updates static context", () => {
		const ctx: SessionStaticContext = {
			systemPrompt: "You are a helpful assistant.",
			tools: [{ name: "read", description: "Read a file", parameters: {} as any }],
		};
		setStaticContext("test-1", ctx);
		const session = getSession("test-1")!;
		expect(session.staticContext?.systemPrompt).toBe("You are a helpful assistant.");
		expect(session.staticContextHash).toBeTruthy();
	});

	it("detects static context changes via hash", () => {
		const ctx1: SessionStaticContext = { systemPrompt: "v1" };
		setStaticContext("test-1", ctx1);
		const hash1 = getSession("test-1")!.staticContextHash;

		const ctx2: SessionStaticContext = { systemPrompt: "v2" };
		setStaticContext("test-1", ctx2);
		const hash2 = getSession("test-1")!.staticContextHash;

		expect(hash1).not.toBe(hash2);
	});

	it("detects tool parameter changes in static context hash", () => {
		const ctx1: SessionStaticContext = {
			systemPrompt: "You are helpful.",
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } as any }],
		};
		setStaticContext("test-params-1", ctx1);
		const hash1 = getSession("test-params-1")!.staticContextHash;

		const ctx2: SessionStaticContext = {
			systemPrompt: "You are helpful.",
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } } as any,
				},
			],
		};
		setStaticContext("test-params-2", ctx2);
		const hash2 = getSession("test-params-2")!.staticContextHash;

		expect(hash1).not.toBe(hash2);
	});

	it("appends delta messages", () => {
		getOrCreateSession("test-1");
		appendMessages("test-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
		const session = getSession("test-1")!;
		expect(session.messages.length).toBe(1);
		expect(session.messages[0].role).toBe("user");
	});

	it("appends assistant response", () => {
		getOrCreateSession("test-1");
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Hi there!" }],
			api: "openai-completions" as const,
			provider: "opencode-go" as const,
			model: "glm-5.1",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2000,
		};
		appendAssistantResponse("test-1", assistantMsg);
		const session = getSession("test-1")!;
		expect(session.messages.length).toBe(1);
		expect(session.messages[0].role).toBe("assistant");
	});

	it("deletes a session", () => {
		getOrCreateSession("test-1");
		expect(getSession("test-1")).toBeDefined();
		deleteSession("test-1");
		expect(getSession("test-1")).toBeUndefined();
	});

	it("clears all sessions", () => {
		getOrCreateSession("test-1");
		getOrCreateSession("test-2");
		clearAllSessions();
		expect(getSession("test-1")).toBeUndefined();
		expect(getSession("test-2")).toBeUndefined();
	});
});
