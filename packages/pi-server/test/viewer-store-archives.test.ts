import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import { loadPersistedSessions, savePersistedSession } from "../src/session-persistence.ts";
import {
	appendSessionEntries,
	clearAllSessions,
	getSession,
	replaceSessionTree,
	setStaticContext,
} from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerUpdate } from "../src/viewer-types.ts";

function user(id: string, parentId: string | null = null, content = id): SessionTreeEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-24T03:00:00.000Z",
		message: { role: "user", content, timestamp: 1000 },
	};
}

describe("server session archives in the viewer", () => {
	let directory: string;

	beforeEach(() => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-archives-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("loads remote projects and conversation history from snapshots and WAL without an observer", () => {
		setStaticContext("remote", { systemPrompt: "Pi instructions\nCurrent working directory: D:\\qhk\\old" });
		savePersistedSession(directory, replaceSessionTree("remote", [user("u", null, "Read the project")], "u"));
		savePersistedSession(
			directory,
			appendSessionEntries(
				"remote",
				[
					{
						type: "message",
						id: "a",
						parentId: "u",
						timestamp: "2026-10-24T03:00:01.000Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Reading files" }],
							api: "openai-responses",
							provider: "test",
							model: "test",
							stopReason: "toolUse",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: 2000,
						},
					},
					{
						type: "message",
						id: "tool",
						parentId: "a",
						timestamp: "2026-10-24T03:00:02.000Z",
						message: {
							role: "toolResult",
							toolCallId: "call",
							toolName: "read",
							content: [{ type: "text", text: "Remote file contents" }],
							isError: false,
							timestamp: 3000,
						},
					},
					{
						type: "session_info",
						id: "name",
						parentId: "tool",
						timestamp: "2026-10-24T03:00:03.000Z",
						name: "Remote project conversation",
					},
				],
				"name",
			),
		);
		savePersistedSession(
			directory,
			setStaticContext("remote", { systemPrompt: "Pi instructions\nCurrent working directory: D:\\qhk\\jev\n" }),
		);
		expect(readdirSync(directory).some((file) => file.endsWith(".wal"))).toBe(true);
		clearAllSessions();
		loadPersistedSessions(directory);
		const original = structuredClone(getSession("remote"));
		const store = new ViewerStore(directory);
		expect(store.projects().projects).toEqual([
			{ id: "D:/qhk/jev", path: "D:/qhk/jev", name: "jev", threadCount: 1 },
		]);
		expect(store.page("D:/qhk/jev", null).threads[0]).toMatchObject({
			id: "remote",
			title: "Remote project conversation",
		});
		expect(store.get("remote")).toMatchObject({
			cwd: "D:/qhk/jev",
			projectId: "D:/qhk/jev",
			status: "unknown",
			legacy: true,
		});
		expect(store.rounds("remote", null).rounds[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(store.rounds("remote", null).rounds[0].messages[2].content).toEqual([
			{ type: "text", text: "Remote file contents" },
		]);
		expect(getSession("remote")).toEqual(original);
		expect(existsSync(join(directory, ".viewer"))).toBe(false);
	});

	it("replays structured cwd sections across later partial system updates and keeps system text out of history", () => {
		setStaticContext("structured", { systemPrompt: "Old prompt\nCurrent working directory: D:/stale" });
		const session = replaceSessionTree(
			"structured",
			[
				{
					type: "message",
					id: "system",
					parentId: null,
					timestamp: "2026-10-24T03:00:00.000Z",
					message: {
						role: "system",
						content: "Private system instructions",
						sections: { cwd: "<cwd>\nD:/qhk/jev\n</cwd>" },
						timestamp: 0,
					},
				},
				user("question", "system", "Inspect remote files"),
				{
					type: "message",
					id: "ssh",
					parentId: "question",
					timestamp: "2026-10-24T03:00:01.000Z",
					message: {
						role: "system",
						content: "Private SSH instructions",
						sections: { ssh: "<ssh>\nremote\n</ssh>" },
						timestamp: 1,
					},
				},
			],
			"ssh",
		);
		savePersistedSession(directory, session);
		clearAllSessions();
		loadPersistedSessions(directory);
		const store = new ViewerStore(directory);
		expect(store.get("structured")).toMatchObject({ cwd: "D:/qhk/jev", title: "Inspect remote files" });
		expect(store.rounds("structured", null).rounds).toEqual([
			{
				id: "question",
				messages: [
					{
						id: "question",
						role: "user",
						content: "Inspect remote files",
						timestamp: Date.parse("2026-10-24T03:00:00.000Z"),
					},
				],
			},
		]);
		expect(getSession("structured")?.entries).toHaveLength(3);
	});

	it.each([
		["Instructions\nCurrent working directory: D:/qhk/jev", "D:/qhk/jev"],
		["Instructions\r\nCurrent working directory: D:\\qhk\\jev\r\n", "D:/qhk/jev"],
		[
			"<project_context>\nCurrent working directory: C:/spoofed\n</project_context>\nCurrent working directory: D:/qhk/jev\n",
			"D:/qhk/jev",
		],
		["Instructions\n\n<cwd>\nD:/qhk/jev\n</cwd>\n", "D:/qhk/jev"],
		["Instructions\n\n<cwd>\nD:/qhk/jev\n</cwd>\n\n<ssh>\nRemote transport\n</ssh>\n", "D:/qhk/jev"],
		["Instructions\n\n<cwd>\nD:/first\n</cwd>\n\n<cwd>\nD:/second\n</cwd>", null],
		["Instructions\n\n<cwd>\nD:/first\n</cwd>\n\n<cwd>\nD:/first\n</cwd>", null],
		["Instructions\n\n<cwd>\nD:/first\n</cwd>\nCurrent working directory: D:/second", "D:/second"],
		["Markdown example:\n```xml\n<example>\n```\nCurrent working directory: D:/qhk/jev", "D:/qhk/jev"],
		["Instructions\n<example>\nUnclosed XML example\nCurrent working directory: D:/qhk/jev\n", "D:/qhk/jev"],
		["Instructions\nInline text </example>\n</section>\nCurrent working directory: D:/qhk/jev\n", "D:/qhk/jev"],
		["<project_context>\nCurrent working directory: C:/spoofed\n</project_context>", null],
		["<project_context>\n<cwd>\nC:/spoofed\n</cwd>\n</project_context>", null],
		["Instructions\nWorking directory: C:/not-a-field", null],
	])("reads only the standard cwd field in %s", (systemPrompt, cwd) => {
		setStaticContext("prompt", { systemPrompt });
		replaceSessionTree("prompt", [user("u", null, "Current working directory: C:/user-text")], "u");
		const store = new ViewerStore(directory);
		expect(store.get("prompt")).toMatchObject({ cwd, projectId: cwd ?? "unassigned" });
	});

	it("reads the generated top-level cwd before custom sections and excludes cwd blocks inside project instructions", () => {
		const systemPrompt = buildSystemPrompt({
			customPrompt: "Pi instructions",
			cwd: "D:\\qhk\\jev",
			contextFiles: [
				{
					path: "D:/qhk/jev/AGENTS.md",
					content: "Example metadata:\n\n<cwd>\nC:/embedded\n</cwd>\n\nCurrent working directory: C:/embedded",
				},
			],
			sections: { ssh: "Remote transport", notes: "<cwd>\nC:/custom-content\n</cwd>" },
		});
		setStaticContext("generated", { systemPrompt });
		const store = new ViewerStore(directory);
		expect(store.get("generated")).toMatchObject({ cwd: "D:/qhk/jev", projectId: "D:/qhk/jev" });
	});

	it("groups slash variants together and gives the server cwd priority over an observer", () => {
		setStaticContext("server", { systemPrompt: "Instructions\nCurrent working directory: D:\\qhk\\jev" });
		replaceSessionTree("server", [user("u", null, "Server conversation")], "u");
		setStaticContext("second", { systemPrompt: "Instructions\nCurrent working directory: D:/qhk/jev" });
		const store = new ViewerStore(directory);
		const connection = store.connect("server");
		store.update({
			sessionId: "server",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "C:/local-observer",
			title: "Observer title",
			replace: [],
		});
		expect(store.get("server")).toMatchObject({ cwd: "D:/qhk/jev", title: "Server conversation" });
		expect(store.rounds("server", null).rounds[0].messages[0].content).toBe("Server conversation");
		const updates: ViewerUpdate[] = [];
		store.listeners.add((_id, update) => updates.push(update));
		store.update({
			sessionId: "server",
			connectionId: connection.connectionId,
			sequence: 2,
			append: [{ id: "observer", role: "user", content: "Observer history", timestamp: 1000 }],
		});
		expect(updates[0]).toMatchObject({ replace: true, rounds: [{ id: "observer" }] });
		store.refreshSession("server");
		expect(updates[1]).toMatchObject({ replace: true, rounds: [{ id: "observer" }] });
		expect(store.rounds("server", null).rounds[0].messages[0].content).toBe("Observer history");
		expect(store.projects().projects).toEqual([
			{ id: "D:/qhk/jev", path: "D:/qhk/jev", name: "jev", threadCount: 2 },
		]);
	});

	it("publishes persisted session replacements and avoids loading history without thread listeners", () => {
		setStaticContext("refresh", { systemPrompt: "Instructions\nCurrent working directory: D:/qhk/jev" });
		replaceSessionTree("refresh", [user("u", null, "First question")], "u");
		const store = new ViewerStore(directory);
		const rounds = vi.spyOn(store, "rounds");
		const catalog = vi.fn();
		store.catalogListeners.add(catalog);
		store.refreshSession("refresh");
		expect(catalog).toHaveBeenCalledTimes(1);
		expect(rounds).not.toHaveBeenCalled();
		const updates: ViewerUpdate[] = [];
		store.listeners.add((_id, update) => updates.push(update));
		appendSessionEntries("refresh", [user("next", "u", "Next question")], "next");
		savePersistedSession(directory, getSession("refresh")!);
		store.refreshSession("refresh");
		expect(catalog).toHaveBeenCalledTimes(2);
		expect(rounds).toHaveBeenCalledTimes(1);
		expect(updates[0]).toMatchObject({
			thread: { id: "refresh", cwd: "D:/qhk/jev", title: "First question" },
			replace: true,
			rounds: [{ id: "u" }, { id: "next" }],
		});
	});

	it("pages complete conversation rounds after loading only a server snapshot", () => {
		setStaticContext("history", { systemPrompt: "Instructions\nCurrent working directory: D:/qhk/history" });
		const entries = Array.from({ length: 7 }, (_, index) => user(`u${index}`, index ? `u${index - 1}` : null));
		savePersistedSession(directory, replaceSessionTree("history", entries, "u6"));
		clearAllSessions();
		loadPersistedSessions(directory);
		const store = new ViewerStore(directory);
		const recent = store.rounds("history", null);
		expect(recent.rounds.map((round) => round.id)).toEqual(["u2", "u3", "u4", "u5", "u6"]);
		expect(recent.nextCursor).toBe("u2");
		expect(store.rounds("history", recent.nextCursor)).toMatchObject({
			rounds: [{ id: "u0" }, { id: "u1" }],
			nextCursor: null,
		});
	});

	it("caches metadata until the session revision changes", () => {
		const session = setStaticContext("cached", {
			systemPrompt: "Instructions\nCurrent working directory: D:/qhk/old",
		});
		replaceSessionTree("cached", [user("u", null, "First title")], "u");
		const prompt = session.staticContext!.systemPrompt;
		const readPrompt = vi.fn(() => prompt);
		Object.defineProperty(session.staticContext, "systemPrompt", { configurable: true, get: readPrompt });
		const store = new ViewerStore(directory);
		store.projects();
		store.page("D:/qhk/old", null);
		store.get("cached");
		store.refreshSession("cached");
		store.projects();
		expect(readPrompt).toHaveBeenCalledTimes(1);
		setStaticContext("cached", { systemPrompt: "Instructions\nCurrent working directory: D:/qhk/new" });
		appendSessionEntries(
			"cached",
			[{ type: "session_info", id: "name", parentId: "u", timestamp: "2026-10-24T03:00:01.000Z", name: "Renamed" }],
			"name",
		);
		expect(store.get("cached")).toMatchObject({ cwd: "D:/qhk/new", title: "Renamed" });
		expect(store.projects().projects[0].id).toBe("D:/qhk/new");
	});
});
