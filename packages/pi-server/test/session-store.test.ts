import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendAssistantResponse,
	appendCompactionEntry,
	appendMessages,
	appendSessionEntries,
	clearAllSessions,
	deleteSession,
	dropLastAssistantError,
	getActiveMessages,
	getOrCreateSession,
	getSession,
	getSessionBranch,
	hashSessionEntries,
	replaceMessages,
	replaceSessionTree,
	type SessionStaticContext,
	setStaticContext,
	switchSessionLeaf,
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
		expect(session.staticContextHash).toMatch(/^[a-f0-9]{64}$/);
		expect(session.staticContextHash).not.toContain("helpful");
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

	it("replaces messages without changing static context", () => {
		setStaticContext("test-replace", { systemPrompt: "Keep me" });
		replaceMessages("test-replace", [{ role: "user", content: "branch", timestamp: 1000 }]);

		const session = getSession("test-replace")!;
		expect(session.messages).toEqual([{ role: "user", content: "branch", timestamp: 1000 }]);
		expect(session.staticContext?.systemPrompt).toBe("Keep me");
	});

	it("stores a session tree and derives active messages from the selected leaf", () => {
		replaceSessionTree(
			"tree-session",
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "one", timestamp: 1000 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "first answer" }],
						api: "openai-completions",
						provider: "opencode-go",
						model: "glm-5.1",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2000,
					},
				},
				{
					type: "message",
					id: "u2",
					parentId: "a1",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: { role: "user", content: "two", timestamp: 3000 },
				},
			],
			"u2",
		);

		expect(getActiveMessages("tree-session").map((message) => message.content)).toEqual([
			"one",
			[{ type: "text", text: "first answer" }],
			"two",
		]);

		switchSessionLeaf("tree-session", "a1");
		expect(getActiveMessages("tree-session").map((message) => message.content)).toEqual([
			"one",
			[{ type: "text", text: "first answer" }],
		]);
	});

	it("keeps a rolling tree hash across append and leaf switch", () => {
		const first: SessionTreeEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "one", timestamp: 1000 },
		};
		const second: SessionTreeEntry = {
			type: "message",
			id: "u2",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "two", timestamp: 2000 },
		};

		appendSessionEntries("tree-hash", [first], "u1");
		const firstHash = getSession("tree-hash")!.treeHash;
		appendSessionEntries("tree-hash", [second], "u2");
		const appendedHash = getSession("tree-hash")!.treeHash;
		switchSessionLeaf("tree-hash", "u1");

		expect(firstHash).toBe(hashSessionEntries([first]));
		expect(appendedHash).toBe(hashSessionEntries([first, second]));
		expect(getSession("tree-hash")!.treeHash).toBe(appendedHash);
	});

	it("treats matching duplicate tree append entries as idempotent", () => {
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "two", timestamp: 2000 },
			},
		];

		appendSessionEntries("tree-append-idempotent", [entries[0]], "u1");
		const appended = appendSessionEntries("tree-append-idempotent", entries, "u2");
		expect(appended.entries.map((entry) => entry.id)).toEqual(["u1", "u2"]);
		expect(appended.messages.map((message) => message.content)).toEqual(["one", "two"]);
		const revision = appended.revision;

		const retried = appendSessionEntries("tree-append-idempotent", entries, "u2");
		expect(retried.entries.map((entry) => entry.id)).toEqual(["u1", "u2"]);
		expect(retried.revision).toBe(revision);
	});

	it("rejects duplicate tree append entries when the entry body diverges", () => {
		const entry: SessionTreeEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "one", timestamp: 1000 },
		};
		appendSessionEntries("tree-append-divergent", [entry], "u1");

		expect(() =>
			appendSessionEntries(
				"tree-append-divergent",
				[{ ...entry, message: { role: "user", content: "changed", timestamp: 1000 } }],
				"u1",
			),
		).toThrow("entry u1 already exists");
		expect(getSession("tree-append-divergent")?.messages.map((message) => message.content)).toEqual(["one"]);
	});

	it("appends compaction on the active branch without deleting sibling history", () => {
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					api: "openai-completions",
					provider: "opencode-go",
					model: "glm-5.1",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "length",
					timestamp: 2000,
				},
			},
			{
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user", content: "two", timestamp: 3000 },
			},
		];
		replaceSessionTree("tree-compact-branch", entries, "u2");

		const { session, entry } = appendCompactionEntry("tree-compact-branch", {
			summary: "summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
		});

		expect(session.entries.map((storedEntry) => storedEntry.id)).toEqual(["u1", "a1", "u2", entry.id]);
		expect(session.leafId).toBe(entry.id);
		expect(getSessionBranch(session).map((branchEntry) => branchEntry.id)).toEqual(["u1", "u2", entry.id]);
		expect(getActiveMessages("tree-compact-branch").some((message) => message.role === "assistant")).toBe(false);
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

	it("drops the last assistant error only", () => {
		const errorMessage = {
			role: "assistant" as const,
			content: [],
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
			stopReason: "error" as const,
			errorMessage: "retryable",
			timestamp: 2000,
		};

		replaceMessages("test-drop", [{ role: "user", content: "hello", timestamp: 1000 }, errorMessage]);
		expect(dropLastAssistantError("test-drop")).toBe(true);
		expect(getSession("test-drop")?.messages).toEqual([{ role: "user", content: "hello", timestamp: 1000 }]);
		expect(dropLastAssistantError("test-drop")).toBe(false);
	});

	it("does not create a session when dropping a missing assistant error", () => {
		expect(dropLastAssistantError("missing-drop")).toBe(false);
		expect(getSession("missing-drop")).toBeUndefined();
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
