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

	it("updates both projects on a cwd move and leaves unrelated project revisions intact", () => {
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
		store.refreshSession("a");
		const after = store.projects();
		expect(after.revision).not.toBe(before.revision);
		expect(after.projects.map((project) => [project.id, project.threadCount])).toEqual([
			["D:/a", 1],
			["D:/b", 2],
			["D:/c", 1],
		]);
		expect(after.projects.find((project) => project.id === "D:/a")?.revision).not.toBe(revisions.get("D:/a"));
		expect(after.projects.find((project) => project.id === "D:/b")?.revision).not.toBe(revisions.get("D:/b"));
		expect(after.projects.find((project) => project.id === "D:/c")?.revision).toBe(revisions.get("D:/c"));
		expect(before.projects[0].threadCount).toBe(2);
		expect(store.page("D:/b", null).threads.map((thread) => thread.id)).toEqual(["a", "b"]);
		store.refreshSession("a");
		expect(store.projects()).toBe(after);
		expect(catalogEvents).toHaveBeenCalledTimes(1);
		sessions.deleteSession("a2");
		store.remove("a2");
		expect(store.projects().projects.map((project) => project.id)).toEqual(["D:/b", "D:/c"]);
		expect(catalogEvents).toHaveBeenCalledTimes(2);
	});

	it("indexes observer activity and removal without invalidating the catalog for live deltas", () => {
		const store = new ViewerStore(directory);
		store.projects();
		const connection = store.connect("observer");
		store.update({
			sessionId: "observer",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/a",
			replace: [],
			status: "running",
		});
		const running = store.projects();
		expect(running.running.map((thread) => thread.id)).toEqual(["observer"]);
		store.update({
			sessionId: "observer",
			connectionId: connection.connectionId,
			sequence: 2,
			live: { message: { id: "a", role: "assistant", content: "Streaming text", timestamp: 1 }, tools: [] },
		});
		expect(store.projects()).toBe(running);
		connection.close();
		const disconnected = store.projects();
		expect(disconnected.running).toEqual([]);
		expect(disconnected.projects[0].revision).not.toBe(running.projects[0].revision);
		const reconnected = store.connect("observer");
		expect(store.page("D:/a", null).threads[0].status).toBe("unknown");
		store.update({
			sessionId: "observer",
			connectionId: reconnected.connectionId,
			sequence: 1,
			cwd: "D:/b",
			status: "idle",
		});
		expect(store.projects().projects.map((project) => project.id)).toEqual(["D:/b"]);
		store.remove("observer");
		expect(store.projects().projects).toEqual([]);
	});

	it("loads history only for the subscribed thread and sends snapshots even when its summary is unchanged", () => {
		archive("a", "D:/a", 10);
		archive("b", "D:/b", 20);
		const store = new ViewerStore(directory);
		const catalog = store.projects();
		const rounds = vi.spyOn(store, "rounds");
		const listener = vi.fn();
		const unsubscribe = store.subscribe("a", listener);
		store.refreshSession("b");
		expect(rounds).not.toHaveBeenCalled();
		store.refreshSession("a");
		expect(rounds).toHaveBeenCalledExactlyOnceWith("a", null);
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ replace: true, refresh: true }));
		expect(store.projects()).toBe(catalog);
		unsubscribe();
		store.refreshSession("a");
		expect(rounds).toHaveBeenCalledTimes(1);
		expect(new ViewerStore(directory).projects().revision).not.toBe(catalog.revision);
	});
});
