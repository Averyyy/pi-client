import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";

function archive(id: string, project: string, updatedAt: number): void {
	sessions.restoreSessionState({
		sessionId: id,
		staticContext: { systemPrompt: `Instructions\nCurrent working directory: ${project}` },
		entries: [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: new Date(updatedAt).toISOString(),
				message: { role: "user", content: `Question ${id}`, timestamp: updatedAt },
			},
		],
		leafId: "user",
		revision: 1,
		createdAt: 1,
		updatedAt,
	});
}

describe("viewer catalog indexes", () => {
	let directory: string;

	beforeEach(() => {
		sessions.clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-catalog-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		sessions.clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("enumerates once and reuses the catalog while paging only the requested project", () => {
		for (let index = 0; index < 12; index++) archive(`a-${String(index).padStart(2, "0")}`, "D:/a", 100);
		archive("b", "D:/b", 200);
		const list = vi.spyOn(sessions, "listSessions");
		const get = vi.spyOn(sessions, "getSession");
		const store = new ViewerStore(directory);
		const catalog = store.projects();
		const initialReads = get.mock.calls.length;
		expect(catalog.projects).toHaveLength(2);
		for (let index = 0; index < 10; index++) {
			expect(store.projects()).toBe(catalog);
			const first = store.page("D:/a", null);
			expect(first.threads.map((thread) => thread.id)).toEqual(["a-00", "a-01", "a-02", "a-03", "a-04"]);
			const second = store.page("D:/a", first.nextCursor);
			expect(second.threads.map((thread) => thread.id)).toEqual(["a-05", "a-06", "a-07", "a-08", "a-09"]);
			const last = store.page("D:/a", second.nextCursor);
			expect(last.threads.map((thread) => thread.id)).toEqual(["a-10", "a-11"]);
			expect(last.nextCursor).toBeNull();
			expect(store.page("missing", null)).toEqual({ threads: [], nextCursor: null });
		}
		expect(list).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledTimes(initialReads);
	});

	it("updates both projects on a cwd move and leaves unrelated project revisions intact", async () => {
		archive("a", "D:/a", 10);
		archive("a2", "D:/a", 20);
		archive("b", "D:/b", 30);
		archive("c", "D:/c", 40);
		const store = new ViewerStore(directory);
		const before = store.projects();
		const revisions = new Map(before.projects.map((project) => [project.id, project.revision]));
		const catalogEvents = vi.fn();
		store.catalogListeners.add(catalogEvents);
		vi.spyOn(Date, "now").mockReturnValue(100);
		sessions.setStaticContext("a", { systemPrompt: "Instructions\nCurrent working directory: D:/b" });
		await store.refreshSession("a");
		const after = store.projects();
		expect(after.revision).not.toBe(before.revision);
		expect(after.projects.map((project) => [project.id, project.threadCount])).toEqual([
			["D:/c", 1],
			["D:/b", 2],
			["D:/a", 1],
		]);
		expect(after.projects.find((project) => project.id === "D:/a")?.revision).not.toBe(revisions.get("D:/a"));
		expect(after.projects.find((project) => project.id === "D:/b")?.revision).not.toBe(revisions.get("D:/b"));
		expect(after.projects.find((project) => project.id === "D:/c")?.revision).toBe(revisions.get("D:/c"));
		expect(before.projects.find((project) => project.id === "D:/a")?.threadCount).toBe(2);
		expect(store.page("D:/b", null).threads.map((thread) => thread.id)).toEqual(["b", "a"]);
		await store.refreshSession("a");
		expect(store.projects()).toBe(after);
		expect(catalogEvents).toHaveBeenCalledTimes(1);
		sessions.deleteSession("a2");
		await store.remove("a2");
		expect(store.projects().projects.map((project) => project.id)).toEqual(["D:/c", "D:/b"]);
		expect(catalogEvents).toHaveBeenCalledTimes(2);
	});

	it("orders projects by their newest thread and recomputes the head after deletion", async () => {
		archive("a-old", "D:/a", 10);
		archive("a-new", "D:/a", 50);
		archive("b", "D:/b", 30);
		archive("c", "D:/c", 30);
		const list = vi.spyOn(sessions, "listSessions");
		const store = new ViewerStore(directory);
		expect(store.projects().projects.map(({ id, lastActiveAt }) => [id, lastActiveAt])).toEqual([
			["D:/a", 50],
			["D:/b", 30],
			["D:/c", 30],
		]);
		expect(store.projectThreadIds("D:/a")).toEqual(["a-new", "a-old"]);
		sessions.deleteSession("a-new");
		await store.remove("a-new");
		expect(store.projects().projects.map(({ id, lastActiveAt }) => [id, lastActiveAt])).toEqual([
			["D:/b", 30],
			["D:/c", 30],
			["D:/a", 10],
		]);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("indexes observer activity and removal without invalidating the catalog for live deltas", async () => {
		const store = new ViewerStore(directory);
		store.projects();
		const connection = store.connect("observer");
		await store.update({
			sessionId: "observer",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/a",
			replace: [],
			status: "running",
		});
		const running = store.projects();
		expect(running.running.map((thread) => thread.id)).toEqual(["observer"]);
		await store.update({
			sessionId: "observer",
			connectionId: connection.connectionId,
			sequence: 2,
			live: { message: { id: "a", role: "assistant", content: "Streaming text", timestamp: 1 }, tools: [] },
		});
		expect(store.projects()).toBe(running);
		connection.close();
		await store.flush();
		const disconnected = store.projects();
		expect(disconnected.running).toEqual([]);
		expect(disconnected.projects[0].revision).not.toBe(running.projects[0].revision);
		const reconnected = store.connect("observer");
		await store.flush();
		expect(store.page("D:/a", null).threads[0].status).toBe("unknown");
		await store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 1,
			cwd: "D:/b",
			status: "idle",
		});
		expect(store.projects().projects.map((project) => project.id)).toEqual(["D:/b"]);
		await store.remove("observer");
		expect(store.projects().projects).toEqual([]);
	});

	it("publishes snapshots only to subscribed threads even when their summaries are unchanged", async () => {
		archive("a", "D:/a", 10);
		archive("b", "D:/b", 20);
		const store = new ViewerStore(directory);
		const catalog = store.projects();
		const listener = vi.fn();
		const unsubscribe = store.subscribe("a", listener);
		await store.refreshSession("b");
		expect(listener).not.toHaveBeenCalled();
		await store.refreshSession("a");
		expect(listener).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				thread: expect.objectContaining({ id: "a" }),
				replace: true,
				refresh: true,
				rounds: [{ id: "user", messages: expect.any(Array) }],
			}),
		);
		expect(store.projects()).toBe(catalog);
		unsubscribe();
		await store.refreshSession("a");
		expect(listener).toHaveBeenCalledTimes(1);
		expect(new ViewerStore(directory).projects().revision).not.toBe(catalog.revision);
	});
});
