import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	appendSessionEntries,
	clearAllSessions,
	deleteSession,
	getSession,
	restoreSessionState,
	setStaticContext,
	switchSessionLeaf,
} from "../src/session-store.ts";
import { ViewerHttp } from "../src/viewer-http.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerMessage } from "../src/viewer-types.ts";

function entry(id: string, timestamp: number, parentId: string | null = null): SessionTreeEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: "Question", timestamp: 100000 - timestamp },
	};
}

function archive(id: string, cwd: string, entries: SessionTreeEntry[], updatedAt: number): void {
	restoreSessionState({
		sessionId: id,
		staticContext: { systemPrompt: `Instructions\nCurrent working directory: ${cwd}` },
		entries,
		leafId: entries.at(-1)?.id ?? null,
		revision: 1,
		createdAt: 1,
		updatedAt,
	});
}

describe("viewer activity timestamps", () => {
	let directory: string;

	beforeEach(() => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-activity-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("sorts projects and paginated threads by recorded activity with empty sessions last", async () => {
		for (let index = 0; index < 7; index++)
			archive(`a${index}`, "D:/a", [entry(`u${index}`, index * 10)], 1000 - index * 10);
		archive(
			"empty-a",
			"D:/a",
			[
				{
					type: "session_info",
					id: "title",
					parentId: null,
					timestamp: new Date(100000).toISOString(),
					name: "Empty",
				},
			],
			100000,
		);
		archive("empty-b", "D:/a", [], 200000);
		archive("b", "D:/b", [entry("b-user", 40)], 900000);
		archive("empty-project", "D:/empty", [], 999999);
		const store = new ViewerStore(directory);
		expect(store.projects().projects.map(({ id, lastActiveAt }) => [id, lastActiveAt])).toEqual([
			["D:/a", 60],
			["D:/b", 40],
			["D:/empty", null],
		]);
		const first = store.page("D:/a", null);
		expect(first.threads.map(({ id }) => id)).toEqual(["a6", "a5", "a4", "a3", "a2"]);
		expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({
			id: "a2",
			lastActiveAt: 20,
		});
		deleteSession("a2");
		await store.remove("a2");
		expect(store.page("D:/a", first.nextCursor).threads.map(({ id }) => id)).toEqual([
			"a1",
			"a0",
			"empty-a",
			"empty-b",
		]);
		for (const id of ["a6", "a5", "a4"]) {
			deleteSession(id);
			await store.remove(id);
		}
		expect(store.projects().projects.map(({ id, lastActiveAt }) => [id, lastActiveAt])).toEqual([
			["D:/b", 40],
			["D:/a", 30],
			["D:/empty", null],
		]);
	});

	it("continues pagination after a deleted null-activity cursor", async () => {
		for (let index = 0; index < 7; index++) archive(`empty-${index}`, "D:/empty", [], index);
		const store = new ViewerStore(directory);
		const first = store.page("D:/empty", null);
		expect(first.threads.map(({ id }) => id)).toEqual(["empty-0", "empty-1", "empty-2", "empty-3", "empty-4"]);
		expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({
			id: "empty-4",
			lastActiveAt: null,
		});
		deleteSession("empty-4");
		await store.remove("empty-4");
		expect(store.page("D:/empty", first.nextCursor).threads.map(({ id }) => id)).toEqual(["empty-5", "empty-6"]);
	});

	it("keeps activity across branch switches and ignores metadata and hidden messages", async () => {
		archive("thread", "D:/a", [entry("old", 10), entry("recent", 50, "old")], 1000);
		const store = new ViewerStore(directory);
		const original = store.projects();
		switchSessionLeaf("thread", "old");
		await store.refreshSession("thread");
		expect(store.get("thread")?.lastActiveAt).toBe(50);
		expect(store.projects()).toBe(original);
		const metadata: SessionTreeEntry[] = [
			{
				type: "model_change",
				id: "model",
				parentId: "old",
				timestamp: new Date(200).toISOString(),
				provider: "test",
				modelId: "test",
			},
			{
				type: "thinking_level_change",
				id: "thinking",
				parentId: "model",
				timestamp: new Date(300).toISOString(),
				thinkingLevel: "high",
			},
			{
				type: "custom",
				id: "usage",
				parentId: "thinking",
				timestamp: new Date(400).toISOString(),
				customType: "usage",
				data: {},
			},
			{
				type: "custom_message",
				id: "hidden",
				parentId: "usage",
				timestamp: new Date(500).toISOString(),
				customType: "hidden",
				content: "Hidden",
				display: false,
			},
			{
				type: "message",
				id: "hidden-message",
				parentId: "hidden",
				timestamp: new Date(600).toISOString(),
				message: { role: "custom", customType: "hidden", content: "Hidden", display: false, timestamp: 600 },
			},
			{
				type: "message",
				id: "system",
				parentId: "hidden-message",
				timestamp: new Date(700).toISOString(),
				message: { role: "system", content: "Instructions", timestamp: 700 },
			},
		];
		appendSessionEntries("thread", metadata, "system");
		await store.refreshSession("thread");
		expect(store.projects()).toBe(original);
		appendSessionEntries(
			"thread",
			[
				{
					type: "session_info",
					id: "title",
					parentId: "system",
					timestamp: new Date(800).toISOString(),
					name: "Renamed",
				},
			],
			"title",
		);
		setStaticContext("thread", { systemPrompt: "Instructions\nCurrent working directory: D:/moved" });
		await store.refreshSession("thread");
		expect(store.get("thread")).toMatchObject({ title: "Renamed", cwd: "D:/moved", lastActiveAt: 50 });
		appendSessionEntries("thread", [entry("new", 900, "title")], "new");
		await store.refreshSession("thread");
		expect(store.projects().projects[0].lastActiveAt).toBe(900);
	});

	it.each(["custom_message", "compaction", "branch_summary"] as const)("counts %s entries as activity", (type) => {
		const base = { id: "activity", parentId: "u", timestamp: new Date(80).toISOString() };
		const activity: SessionTreeEntry =
			type === "custom_message"
				? { ...base, type, customType: "notice", content: "Visible", display: true }
				: type === "compaction"
					? { ...base, type, summary: "Summary", firstKeptEntryId: "u", tokensBefore: 100 }
					: { ...base, type, summary: "Summary", fromId: "u" };
		archive("thread", "D:/a", [entry("u", 20), activity], 1000);
		expect(new ViewerStore(directory).get("thread")?.lastActiveAt).toBe(80);
	});

	it("records server activity without an observer and preserves archive history", async () => {
		archive("thread", "D:/a", [entry("u", 900000)], 999999);
		const original = structuredClone(getSession("thread"));
		const store = new ViewerStore(directory);
		const rounds = vi.spyOn(store, "rounds");
		store.projects();
		vi.spyOn(Date, "now").mockReturnValue(100);
		store.recordActivity("thread");
		expect(store.get("thread")).toMatchObject({ lastActiveAt: 100, legacy: true });
		await store.flush();
		expect(store.projects().projects[0].lastActiveAt).toBe(100);
		expect(rounds).not.toHaveBeenCalled();
		expect(getSession("thread")).toEqual(original);
		expect((await store.rounds("thread", null)).rounds[0].messages[0].id).toBe("u");
		expect(new ViewerStore(directory).get("thread")?.lastActiveAt).toBe(100);
	});

	it("keeps observer projections, metadata and reconnects from advancing server activity", async () => {
		const store = new ViewerStore(directory);
		const first = store.connect("observer");
		const messages: ViewerMessage[] = [{ id: "u", role: "user", content: "Question", timestamp: 900000 }];
		await store.update({
			sessionId: "observer",
			connectionId: first.connectionId,
			sequence: 1,
			cwd: "D:/a",
			replace: messages,
			status: "idle",
		});
		expect(store.get("observer")?.lastActiveAt).toBeNull();
		vi.spyOn(Date, "now").mockReturnValue(100);
		store.recordActivity("observer");
		first.close();
		const reconnected = store.connect("observer");
		await store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 1,
			cwd: "D:/a",
			replace: messages,
			status: "idle",
		});
		const catalog = store.projects();
		await store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 2,
			replace: messages,
		});
		expect(store.projects()).toBe(catalog);
		await store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 3,
			title: "Renamed",
			cwd: "D:/b",
		});
		expect(store.get("observer")).toMatchObject({ title: "Renamed", cwd: "D:/b", lastActiveAt: 100 });
		await store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 4,
			append: [{ id: "a", role: "assistant", content: "Answer", timestamp: 990000 }],
		});
		expect(store.get("observer")?.lastActiveAt).toBe(100);
		expect(new ViewerStore(directory).get("observer")?.lastActiveAt).toBe(100);
	});

	it.each([false, true])(
		"migrates stored observer activity from historical records once with previous activity field %s",
		async (hasActivity) => {
			archive("observer", "D:/a", [entry("archive", 80)], 9999999);
			const store = new ViewerStore(directory);
			const { connectionId } = store.connect("observer");
			const messages: ViewerMessage[] = [
				{ id: "u", role: "user", content: "Question", timestamp: 90 },
				{ id: "a", role: "assistant", content: "Answer", timestamp: 30 },
			];
			await store.update({ sessionId: "observer", connectionId, sequence: 1, cwd: "D:/a", replace: messages });
			const metadataDir = join(directory, ".viewer", "threads");
			const metadataPath = join(metadataDir, readdirSync(metadataDir).find((path) => path.endsWith(".json"))!);
			const legacy = JSON.parse(readFileSync(metadataPath, "utf8")) as {
				serverLastActiveAt?: number | null;
				thread: { lastActiveAt?: number | null; updatedAt?: number };
			};
			delete legacy.serverLastActiveAt;
			if (hasActivity) legacy.thread.lastActiveAt = 999999;
			else delete legacy.thread.lastActiveAt;
			legacy.thread.updatedAt = 9999999;
			writeFileSync(metadataPath, JSON.stringify(legacy));
			const migrated = new ViewerStore(directory);
			expect(migrated.get("observer")?.lastActiveAt).toBe(90);
			expect((await migrated.rounds("observer", null)).rounds[0].messages).toEqual(messages);
			const saved = readFileSync(metadataPath, "utf8");
			expect(JSON.parse(saved)).toMatchObject({ serverLastActiveAt: 90, thread: { lastActiveAt: 90 } });
			expect(saved).not.toContain("updatedAt");
			expect(new ViewerStore(directory).get("observer")?.lastActiveAt).toBe(90);
			expect(readFileSync(metadataPath, "utf8")).toBe(saved);
			vi.spyOn(Date, "now").mockReturnValue(10);
			migrated.recordActivity("observer");
			await migrated.flush();
			expect(new ViewerStore(directory).get("observer")?.lastActiveAt).toBe(10);
		},
	);

	it("ignores observer activity fields at the HTTP boundary", async () => {
		const http = new ViewerHttp(loadConfig({ sessionStoreDir: directory, authToken: "test" }), async () => ({
			deletedIds: [],
			deletedCount: 0,
			failed: [],
		}));
		const { connectionId } = http.store.connect("thread");
		vi.spyOn(Date, "now").mockReturnValue(100);
		http.store.recordActivity("thread");
		for (const [index, lastActiveAt] of ["10", true, {}, NaN, Infinity, null, 9999999].entries()) {
			const writeHead = vi.fn();
			await http.observe(
				{
					sessionId: "thread",
					connectionId,
					sequence: index + 1,
					cwd: "D:/a",
					replace: [{ id: "u", role: "user", content: "Question", timestamp: 9999999 }],
					lastActiveAt,
				},
				{ writeHead, end: vi.fn() } as unknown as ServerResponse,
			);
			expect(writeHead).toHaveBeenCalledWith(200, expect.anything());
			expect(http.store.get("thread")?.lastActiveAt).toBe(100);
		}
	});
});
