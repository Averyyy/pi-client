import { performance } from "node:perf_hooks";
import { buildSessionContext, convertToLlm, type SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendAssistantResponse,
	appendCompactionEntry,
	appendMessages,
	appendSessionEntries,
	applyPiServerCompactionEntry,
	applySessionMutation,
	calculateSessionLogicalBytes,
	clearAllSessions,
	configureSessionCapacityLimits,
	deleteSession,
	dropLastAssistantError,
	exportSessionState,
	getActiveMessages,
	getOrCreateSession,
	getSession,
	getSessionBranch,
	getSessionCapacityLimits,
	getSessionCapacityUsage,
	hashSessionEntries,
	markSessionPersisted,
	type PiServerCompactionEntry,
	type PiServerCompactionOperationMetadata,
	preflightSessionCapacityMutation,
	replaceMessages,
	replaceSessionTree,
	resetSessionCapacityLimits,
	restoreSessionState,
	SessionCapacityError,
	type SessionStaticContext,
	setStaticContext,
	switchSessionLeaf,
} from "../src/session-store.ts";

describe("session-store", () => {
	beforeEach(() => {
		clearAllSessions();
		resetSessionCapacityLimits();
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

	it("does not mutate or persist unchanged static context", () => {
		const context: SessionStaticContext = {
			systemPrompt: "stable",
		};
		const session = setStaticContext("test-static-noop", context);
		markSessionPersisted(session);
		const updatedAt = session.updatedAt;
		const revision = session.revision;

		const result = setStaticContext("test-static-noop", {
			systemPrompt: "stable",
		});

		expect(result).toBe(session);
		expect(result.staticContext).not.toBe(context);
		expect(result.staticContext).toEqual(context);
		expect(result.revision).toBe(revision);
		expect(result.updatedAt).toBe(updatedAt);
		expect(result.persistenceChange).toBeUndefined();
	});

	it("owns nested tree and static-context values after accepting them", () => {
		const context: SessionStaticContext = {
			systemPrompt: "stable",
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					} as Tool["parameters"],
				},
			],
		};
		const entry = {
			type: "custom",
			id: "nested",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "ownership",
			data: { nested: { value: "original" } },
		} satisfies SessionTreeEntry;

		const session = setStaticContext("owned-values", context);
		const staticContextHash = session.staticContextHash;
		replaceSessionTree("owned-values", [entry], entry.id);
		const treeHash = session.treeHash;

		context.tools![0].description = "mutated";
		entry.data.nested.value = "mutated";

		expect(session.staticContext?.tools?.[0].description).toBe("Read a file");
		expect(session.staticContextHash).toBe(staticContextHash);
		expect(session.entries[0]).toMatchObject({ data: { nested: { value: "original" } } });
		expect(session.treeHash).toBe(treeHash);

		const exported = exportSessionState(session);
		exported.staticContext!.tools![0].description = "export-mutated";
		if (exported.entries[0].type === "custom") {
			exported.entries[0].data = { nested: { value: "export-mutated" } };
		}
		expect(session.staticContext?.tools?.[0].description).toBe("Read a file");
		expect(session.entries[0]).toMatchObject({ data: { nested: { value: "original" } } });
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

	it("rebuilds the runtime entry index when replacing and restoring a tree", () => {
		const first: SessionTreeEntry = {
			type: "custom",
			id: "first",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "test",
		};
		const second: SessionTreeEntry = {
			type: "custom",
			id: "second",
			parentId: "first",
			timestamp: "2026-01-01T00:00:01.000Z",
			customType: "test",
		};
		const session = replaceSessionTree("tree-index", [first, second], "second");
		expect(session.entryById.get("first")).toBe(session.entries[0]);
		expect(session.entryById.get("second")).toBe(session.entries[1]);

		const persisted = exportSessionState(session);
		expect(persisted).not.toHaveProperty("entryById");
		clearAllSessions();
		const restored = restoreSessionState(persisted);
		expect(restored.entryById.get("first")).toBe(restored.entries[0]);
		expect(restored.entryById.get("second")).toBe(restored.entries[1]);

		const replacement: SessionTreeEntry = {
			type: "custom",
			id: "replacement",
			parentId: null,
			timestamp: "2026-01-01T00:00:02.000Z",
			customType: "test",
		};
		replaceSessionTree("tree-index", [replacement], "replacement");
		expect(restored.entryById.has("first")).toBe(false);
		expect(restored.entryById.get("replacement")).toBe(restored.entries[0]);
	});

	it("rejects duplicate, orphaned, and cyclic full trees before mutating a session", () => {
		const first: SessionTreeEntry = {
			type: "custom",
			id: "first",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "test",
		};
		const session = replaceSessionTree("tree-invalid", [first], "first");
		const revision = session.revision;

		expect(() => replaceSessionTree("tree-invalid", [first, { ...first }], "first")).toThrow(
			"session tree contains duplicate entry first",
		);
		expect(() =>
			replaceSessionTree(
				"tree-invalid",
				[
					{
						...first,
						id: "orphan",
						parentId: "missing",
					},
				],
				"orphan",
			),
		).toThrow("parent entry missing does not exist");
		expect(() =>
			replaceSessionTree(
				"tree-invalid",
				[
					{ ...first, id: "cycle-a", parentId: "cycle-b" },
					{ ...first, id: "cycle-b", parentId: "cycle-a" },
				],
				"cycle-a",
			),
		).toThrow("session tree contains a parent cycle");

		expect(session.entries).toEqual([first]);
		expect(session.leafId).toBe("first");
		expect(session.revision).toBe(revision);
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

	it("treats repeated tree replacement and leaf switching as strict no-ops", () => {
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
		];
		const session = replaceSessionTree("tree-mutation-idempotent", entries, "u1");
		markSessionPersisted(session);
		const revision = session.revision;
		const updatedAt = session.updatedAt;

		expect(replaceSessionTree("tree-mutation-idempotent", structuredClone(entries), "u1")).toBe(session);
		expect(switchSessionLeaf("tree-mutation-idempotent", "u1")).toBe(session);
		expect(session.revision).toBe(revision);
		expect(session.updatedAt).toBe(updatedAt);
		expect(session.persistenceChange).toBeUndefined();
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
		expect(retried.entryById.get("u1")).toBe(retried.entries[0]);
		expect(retried.entryById.get("u2")).toBe(retried.entries[1]);
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

	it("incrementally appends an active linear tail and rebuilds when appending a branch", () => {
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
		appendSessionEntries("tree-incremental-context", [first, second], second.id);

		const branch: SessionTreeEntry = {
			type: "message",
			id: "u3",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: "three", timestamp: 3000 },
		};
		appendSessionEntries("tree-incremental-context", [branch], branch.id);
		expect(getActiveMessages("tree-incremental-context").map((message) => message.content)).toEqual(["one", "three"]);

		const tail: SessionTreeEntry = {
			type: "message",
			id: "u4",
			parentId: "u3",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "user", content: "four", timestamp: 4000 },
		};
		const session = appendSessionEntries("tree-incremental-context", [tail], tail.id);
		expect(session.messages.map((message) => message.content)).toEqual(["one", "three", "four"]);
		expect(session.messages).toEqual(convertToLlm(buildSessionContext(getSessionBranch(session)).messages));
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

		expect(() =>
			appendCompactionEntry("tree-compact-branch", {
				summary: "invalid sibling summary",
				firstKeptEntryId: "a1",
				tokensBefore: 100,
			}),
		).toThrow("firstKeptEntryId a1 does not exist on the active session branch");

		const { session, entry } = appendCompactionEntry("tree-compact-branch", {
			summary: "summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			retainedTail: [],
			details: { source: "provider" },
			usage: {
				input: 40,
				output: 20,
				cacheRead: 10,
				cacheWrite: 5,
				cacheWrite1h: 3,
				reasoning: 7,
				totalTokens: 75,
				cost: { input: 0.4, output: 0.2, cacheRead: 0.1, cacheWrite: 0.05, total: 0.75 },
			},
			fromHook: true,
		});

		expect(session.entries.map((storedEntry) => storedEntry.id)).toEqual(["u1", "a1", "u2", entry.id]);
		expect(session.leafId).toBe(entry.id);
		expect(getSessionBranch(session).map((branchEntry) => branchEntry.id)).toEqual(["u1", "u2", entry.id]);
		expect(Object.hasOwn(entry, "retainedTail")).toBe(true);
		expect(entry.retainedTail).toEqual([]);
		expect(entry.details).toEqual({ source: "provider" });
		expect(entry.usage).toMatchObject({ cacheWrite1h: 3, reasoning: 7 });
		expect(entry.fromHook).toBe(true);
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
		const droppedEntryId = getSession("test-drop")!.leafId!;
		expect(dropLastAssistantError("test-drop")).toBe(true);
		expect(getSession("test-drop")?.messages).toEqual([{ role: "user", content: "hello", timestamp: 1000 }]);
		expect(getSession("test-drop")?.entryById.has(droppedEntryId)).toBe(false);
		expect(dropLastAssistantError("test-drop")).toBe(false);
	});

	it("walks a 100k-entry linear branch within a linear-time budget", () => {
		const entryCount = 100_000;
		const entries = new Array<SessionTreeEntry>(entryCount);
		let parentId: string | null = null;
		for (let index = 0; index < entryCount; index++) {
			const id = `entry-${index}`;
			entries[index] = {
				type: "custom",
				id,
				parentId,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "branch-performance",
			};
			parentId = id;
		}
		const session = replaceSessionTree("tree-deep-linear", entries, parentId);
		const medians: number[] = [];
		for (const leafIndex of [entryCount / 2 - 1, entryCount - 1]) {
			session.leafId = entries[leafIndex].id;
			const samples: number[] = [];
			for (let sample = 0; sample < 3; sample++) {
				const startedAt = performance.now();
				const branch = getSessionBranch(session);
				samples.push(performance.now() - startedAt);
				expect(branch).toHaveLength(leafIndex + 1);
				expect(branch[0].id).toBe("entry-0");
				expect(branch.at(-1)?.id).toBe(entries[leafIndex].id);
			}
			samples.sort((left, right) => left - right);
			medians.push(samples[1]);
		}

		const [halfBranchMs, fullBranchMs] = medians;
		expect(fullBranchMs).toBeLessThan(500);
		expect(fullBranchMs).toBeLessThan(halfBranchMs * 3 + 50);

		const appendStartedAt = performance.now();
		appendSessionEntries(
			"tree-deep-linear",
			[
				{
					type: "custom",
					id: "entry-appended",
					parentId,
					timestamp: "2026-01-01T00:00:01.000Z",
					customType: "branch-performance",
				},
			],
			"entry-appended",
		);
		expect(performance.now() - appendStartedAt).toBeLessThan(500);
	}, 20_000);

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
		expect(getSessionCapacityUsage()).toEqual({ loadedSessions: 0, entryCount: 0, logicalBytes: 0 });
	});
});

describe("session-store capacity admission", () => {
	beforeEach(() => {
		clearAllSessions();
		resetSessionCapacityLimits();
	});

	function customEntry(id: string, parentId: string | null = null, text = id): SessionTreeEntry {
		return {
			type: "custom",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "capacity",
			data: { text },
		};
	}

	it("uses explicit finite defaults for long-session admission", () => {
		expect(getSessionCapacityLimits()).toEqual({
			maxEntriesPerSession: 250_000,
			maxLogicalBytesPerSession: 256 * 1024 * 1024,
			maxAggregateEntries: 500_000,
			maxAggregateLogicalBytes: 512 * 1024 * 1024,
			maxLoadedSessions: 1024,
		});
	});

	it("accepts the exact entry boundary and rejects boundary plus one without mutation", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 1,
			maxAggregateEntries: 1,
		});
		const first = customEntry("first");
		const session = appendSessionEntries("entry-boundary", [first], first.id);
		markSessionPersisted(session);
		const before = structuredClone(exportSessionState(session));
		const beforeUsage = getSessionCapacityUsage();
		const beforeUpdatedAt = session.updatedAt;

		let thrown: unknown;
		try {
			appendSessionEntries("entry-boundary", [customEntry("second", first.id)], "second");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(SessionCapacityError);
		expect(thrown).toMatchObject({
			code: "PI_SERVER_SESSION_CAPACITY_EXCEEDED",
			retryable: false,
			resource: "session_entries",
			sessionId: "entry-boundary",
			current: 1,
			requested: 2,
			limit: 1,
		});
		expect(exportSessionState(session)).toEqual(before);
		expect(session.updatedAt).toBe(beforeUpdatedAt);
		expect(session.persistenceChange).toBeUndefined();
		expect(getSessionCapacityUsage()).toEqual(beforeUsage);
	});

	it("counts exact UTF-8 logical bytes and rejects one byte above the configured limit", () => {
		const context: SessionStaticContext = { systemPrompt: "界🙂" };
		const exactBytes = calculateSessionLogicalBytes(context, []);
		expect(exactBytes).toBe(Buffer.byteLength('{"systemPrompt":"界🙂"}', "utf8"));

		configureSessionCapacityLimits({
			maxLogicalBytesPerSession: exactBytes,
			maxAggregateLogicalBytes: exactBytes,
		});
		const session = setStaticContext("utf8-exact", context);
		expect(session.logicalBytes).toBe(exactBytes);
		expect(getSessionCapacityUsage().logicalBytes).toBe(exactBytes);

		clearAllSessions();
		resetSessionCapacityLimits();
		configureSessionCapacityLimits({
			maxLogicalBytesPerSession: exactBytes - 1,
		});

		let thrown: unknown;
		try {
			setStaticContext("utf8-plus-one", context);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			resource: "session_logical_bytes",
			current: 0,
			requested: exactBytes,
			limit: exactBytes - 1,
		});
		expect(getSession("utf8-plus-one")).toBeUndefined();
		expect(getSessionCapacityUsage()).toEqual({ loadedSessions: 0, entryCount: 0, logicalBytes: 0 });
	});

	it("counts matching duplicate appends as zero growth at capacity", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 1,
			maxAggregateEntries: 1,
		});
		const entry = customEntry("duplicate", null, "重复");
		const session = appendSessionEntries("duplicate-capacity", [entry], entry.id);
		markSessionPersisted(session);
		const logicalBytes = session.logicalBytes;
		const revision = session.revision;

		const projection = preflightSessionCapacityMutation("duplicate-capacity", {
			content: { kind: "append_entries", entries: [structuredClone(entry)], leafId: entry.id },
		});
		const retried = appendSessionEntries("duplicate-capacity", [structuredClone(entry)], entry.id);

		expect(projection).toEqual({ entryCount: 1, logicalBytes });
		expect(retried.logicalBytes).toBe(logicalBytes);
		expect(retried.revision).toBe(revision);
		expect(retried.persistenceChange).toBeUndefined();
		expect(getSessionCapacityUsage()).toMatchObject({ entryCount: 1, logicalBytes });
	});

	it("enforces aggregate capacity and releases it after replacement and deletion", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 2,
			maxAggregateEntries: 2,
		});
		const first = customEntry("a1");
		const second = customEntry("a2", first.id);
		replaceSessionTree("aggregate-a", [first, second], second.id);

		expect(() => appendSessionEntries("aggregate-b", [customEntry("b1")], "b1")).toThrowError(
			expect.objectContaining({
				resource: "aggregate_entries",
				current: 2,
				requested: 3,
				limit: 2,
			}),
		);
		expect(getSession("aggregate-b")).toBeUndefined();

		replaceSessionTree("aggregate-a", [first], first.id);
		appendSessionEntries("aggregate-b", [customEntry("b1")], "b1");
		expect(getSessionCapacityUsage().entryCount).toBe(2);

		expect(deleteSession("aggregate-a")).toBe(true);
		appendSessionEntries("aggregate-c", [customEntry("c1")], "c1");
		expect(getSessionCapacityUsage()).toMatchObject({ loadedSessions: 2, entryCount: 2 });
	});

	it("enforces the aggregate logical-byte boundary and releases bytes on delete", () => {
		const first = customEntry("a", null, "界");
		const second = customEntry("b", null, "界");
		const third = customEntry("c", null, "界");
		const perEntryBytes = calculateSessionLogicalBytes(undefined, [first]);
		expect(calculateSessionLogicalBytes(undefined, [second])).toBe(perEntryBytes);
		expect(calculateSessionLogicalBytes(undefined, [third])).toBe(perEntryBytes);
		configureSessionCapacityLimits({
			maxAggregateLogicalBytes: perEntryBytes * 2,
		});

		appendSessionEntries("bytes-a", [first], first.id);
		appendSessionEntries("bytes-b", [second], second.id);
		expect(getSessionCapacityUsage().logicalBytes).toBe(perEntryBytes * 2);
		expect(() => appendSessionEntries("bytes-c", [third], third.id)).toThrowError(
			expect.objectContaining({
				resource: "aggregate_logical_bytes",
				current: perEntryBytes * 2,
				requested: perEntryBytes * 3,
				limit: perEntryBytes * 2,
			}),
		);
		expect(getSession("bytes-c")).toBeUndefined();

		deleteSession("bytes-a");
		appendSessionEntries("bytes-c", [third], third.id);
		expect(getSessionCapacityUsage().logicalBytes).toBe(perEntryBytes * 2);
	});

	it("enforces loaded-session admission and releases a slot on delete", () => {
		configureSessionCapacityLimits({ maxLoadedSessions: 2 });
		getOrCreateSession("loaded-a");
		getOrCreateSession("loaded-b");

		expect(() => getOrCreateSession("loaded-c")).toThrowError(
			expect.objectContaining({
				resource: "loaded_sessions",
				current: 2,
				requested: 3,
				limit: 2,
			}),
		);
		expect(getSession("loaded-c")).toBeUndefined();

		deleteSession("loaded-a");
		expect(getOrCreateSession("loaded-c").sessionId).toBe("loaded-c");
	});

	it("rejects an oversized restore without replacing the existing session", () => {
		configureSessionCapacityLimits({ maxEntriesPerSession: 1 });
		const existing = replaceSessionTree("restore-capacity", [customEntry("old")], "old");
		markSessionPersisted(existing);
		const before = structuredClone(exportSessionState(existing));
		const persisted = {
			...before,
			entries: [customEntry("new-1"), customEntry("new-2", "new-1")],
			leafId: "new-2",
		};

		expect(() => restoreSessionState(persisted)).toThrowError(
			expect.objectContaining({
				resource: "session_entries",
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(exportSessionState(getSession("restore-capacity")!)).toEqual(before);
		expect(getSessionCapacityUsage().entryCount).toBe(1);
	});

	it("preflights static context and tree replacement as one capacity mutation", () => {
		const context: SessionStaticContext = { systemPrompt: "combined" };
		const entry = customEntry("combined");
		const contextBytes = calculateSessionLogicalBytes(context, []);
		const entryBytes = calculateSessionLogicalBytes(undefined, [entry]);
		const combinedBytes = contextBytes + entryBytes;
		configureSessionCapacityLimits({
			maxLogicalBytesPerSession: combinedBytes - 1,
		});

		expect(() =>
			preflightSessionCapacityMutation("combined-capacity", {
				staticContext: context,
				content: { kind: "replace_entries", entries: [entry], leafId: entry.id },
			}),
		).toThrowError(
			expect.objectContaining({
				resource: "session_logical_bytes",
				current: 0,
				requested: combinedBytes,
				limit: combinedBytes - 1,
			}),
		);
		expect(contextBytes).toBeLessThan(combinedBytes - 1);
		expect(entryBytes).toBeLessThan(combinedBytes - 1);
		expect(getSession("combined-capacity")).toBeUndefined();
		expect(() =>
			applySessionMutation("combined-capacity", {
				staticContext: context,
				content: { kind: "replace_entries", entries: [entry], leafId: entry.id },
			}),
		).toThrowError(
			expect.objectContaining({
				resource: "session_logical_bytes",
				current: 0,
				requested: combinedBytes,
				limit: combinedBytes - 1,
			}),
		);
		expect(getSession("combined-capacity")).toBeUndefined();
		expect(getSessionCapacityUsage().loadedSessions).toBe(0);
	});

	it("atomically admits a final-fit static-context and tree replacement", () => {
		const oldContext: SessionStaticContext = { systemPrompt: "o".repeat(100) };
		const oldEntry = customEntry("old-large", null, "x".repeat(700));
		const session = applySessionMutation("combined-final-fit", {
			staticContext: oldContext,
			content: { kind: "replace_entries", entries: [oldEntry], leafId: oldEntry.id },
		});
		markSessionPersisted(session);
		const newContext: SessionStaticContext = { systemPrompt: "n".repeat(650) };
		const newEntry = customEntry("new-small", null, "y");
		const currentBytes = session.logicalBytes;
		const finalBytes = calculateSessionLogicalBytes(newContext, [newEntry]);
		const transientBytes =
			calculateSessionLogicalBytes(newContext, []) + calculateSessionLogicalBytes(undefined, [oldEntry]);
		const limit = Math.max(currentBytes, finalBytes);
		expect(transientBytes).toBeGreaterThan(limit);
		configureSessionCapacityLimits({
			maxLogicalBytesPerSession: limit,
			maxAggregateLogicalBytes: limit,
		});
		const revision = session.revision;

		const updated = applySessionMutation("combined-final-fit", {
			staticContext: newContext,
			content: { kind: "replace_entries", entries: [newEntry], leafId: newEntry.id },
		});

		expect(updated.staticContext).toEqual(newContext);
		expect(updated.entries).toEqual([newEntry]);
		expect(updated.logicalBytes).toBe(finalBytes);
		expect(updated.revision).toBe(revision + 1);
		expect(updated.persistenceChange).toEqual({ kind: "snapshot" });
	});

	it("leaves static context and tree unchanged when combined shape derivation fails", () => {
		const base = customEntry("combined-atomic-base");
		const session = applySessionMutation("combined-atomic", {
			staticContext: { systemPrompt: "old" },
			content: { kind: "replace_entries", entries: [base], leafId: base.id },
		});
		markSessionPersisted(session);
		const before = structuredClone(exportSessionState(session));
		const cyclic = customEntry("cycle");
		cyclic.parentId = cyclic.id;

		expect(() =>
			applySessionMutation("combined-atomic", {
				staticContext: { systemPrompt: "new" },
				content: { kind: "replace_entries", entries: [cyclic], leafId: cyclic.id },
			}),
		).toThrow("parent cycle");
		expect(exportSessionState(session)).toEqual(before);
		expect(session.persistenceChange).toBeUndefined();
	});

	it("rejects compaction growth atomically and admits it after capacity is raised", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 1,
			maxAggregateEntries: 1,
		});
		const base = customEntry("compact-base");
		const session = appendSessionEntries("compact-capacity", [base], base.id);
		markSessionPersisted(session);
		const before = structuredClone(exportSessionState(session));

		expect(() =>
			appendCompactionEntry("compact-capacity", {
				summary: "summary",
				firstKeptEntryId: base.id,
				tokensBefore: 10,
			}),
		).toThrowError(
			expect.objectContaining({
				resource: "session_entries",
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(exportSessionState(session)).toEqual(before);
		expect(session.persistenceChange).toBeUndefined();

		configureSessionCapacityLimits({
			maxEntriesPerSession: 2,
			maxAggregateEntries: 2,
		});
		appendCompactionEntry("compact-capacity", {
			summary: "summary",
			firstKeptEntryId: base.id,
			tokensBefore: 10,
		});
		expect(session.entries).toHaveLength(2);
		expect(getSessionCapacityUsage().entryCount).toBe(2);
	});

	it("does not let exact compaction replay bypass capacity admission", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 1,
			maxAggregateEntries: 1,
		});
		const base = customEntry("exact-compact-base");
		const session = appendSessionEntries("exact-compact-capacity", [base], base.id);
		markSessionPersisted(session);
		const operation = {
			version: 1,
			operationId: "compact-operation",
			requestHash: "request-hash",
			baseStaticContextHash: session.staticContextHash,
			baseTreeHash: session.treeHash,
			baseEntryCount: session.entries.length,
			baseLeafId: session.leafId,
			baseRevision: session.revision,
		} satisfies PiServerCompactionOperationMetadata;
		const entry = {
			type: "compaction",
			id: "exact-compaction-entry",
			parentId: base.id,
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "summary",
			firstKeptEntryId: base.id,
			tokensBefore: 10,
			piServerCompactOperation: operation,
		} satisfies PiServerCompactionEntry;
		const before = structuredClone(exportSessionState(session));

		expect(() =>
			applyPiServerCompactionEntry("exact-compact-capacity", {
				entry,
				operation,
				updatedTreeHash: hashSessionEntries([base, entry]),
				updatedRevision: session.revision + 1,
			}),
		).toThrowError(
			expect.objectContaining({
				resource: "session_entries",
				current: 1,
				requested: 2,
				limit: 1,
			}),
		);
		expect(exportSessionState(session)).toEqual(before);
		expect(session.persistenceChange).toBeUndefined();
		expect(getSessionCapacityUsage().entryCount).toBe(1);
	});

	it("enforces capacity for legacy append and replace message mutations", () => {
		configureSessionCapacityLimits({
			maxEntriesPerSession: 1,
			maxAggregateEntries: 1,
		});
		const first = { role: "user" as const, content: "one", timestamp: 1000 };
		const second = { role: "user" as const, content: "two", timestamp: 2000 };
		const session = appendMessages("legacy-capacity", [first]);
		markSessionPersisted(session);
		const before = structuredClone(exportSessionState(session));

		expect(() => appendMessages("legacy-capacity", [second])).toThrowError(
			expect.objectContaining({ resource: "session_entries", current: 1, requested: 2, limit: 1 }),
		);
		expect(() => replaceMessages("legacy-capacity", [first, second])).toThrowError(
			expect.objectContaining({ resource: "session_entries", current: 1, requested: 2, limit: 1 }),
		);
		expect(exportSessionState(session)).toEqual(before);
		expect(session.persistenceChange).toBeUndefined();

		replaceMessages("legacy-capacity", []);
		expect(getSessionCapacityUsage().entryCount).toBe(0);
	});

	it("requires finite positive safe-integer limits", () => {
		expect(() => configureSessionCapacityLimits({ maxLoadedSessions: 0 })).toThrow(
			"maxLoadedSessions must be a positive safe integer",
		);
		expect(() => configureSessionCapacityLimits({ maxAggregateEntries: Number.POSITIVE_INFINITY })).toThrow(
			"maxAggregateEntries must be a positive safe integer",
		);
		expect(() => configureSessionCapacityLimits({ maxLogicalBytesPerSession: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			"maxLogicalBytesPerSession must be a positive safe integer",
		);
	});
});
