import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendSessionEntries, clearAllSessions, replaceSessionTree } from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ObserverSubagent, ObserverUpdate, ViewerUpdate } from "../src/viewer-types.ts";

const relation: ObserverSubagent = {
	agentId: "worker",
	sessionId: "child",
	title: "Inspect source",
	taskStatus: "running",
};

describe("viewer subagent relationships", () => {
	let directory: string;
	beforeEach(() => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-subagents-"));
	});
	afterEach(() => {
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	async function observe(store: ViewerStore, id: string, subagents?: ObserverSubagent[]) {
		const observerId = `publisher-${id}`;
		let sequence = 0;
		const update = async (body: Partial<ObserverUpdate>) =>
			await store.update({ sessionId: id, observerId, create: sequence === 0, sequence: ++sequence, ...body });
		await update({ cwd: "D:/project", replace: [], status: "idle", ...(subagents ? { subagents } : {}) });
		return { update };
	}

	it("pages only root conversations while retaining child history and parent links", async () => {
		const store = new ViewerStore(directory);
		for (let index = 0; index < 7; index++) {
			const id = `root-${index}`;
			await observe(store, id, [{ ...relation, sessionId: `child-${index}` }]);
			const child = await observe(store, `child-${index}`);
			await child.update({
				status: "running",
				append: [{ id: "question", role: "user", content: "Inspect source", timestamp: 1 }],
			});
		}
		expect(store.projects().projects).toMatchObject([{ id: "D:/project", threadCount: 7 }]);
		expect(store.projects().running).toEqual([]);
		const first = store.page("D:/project", null);
		expect(first.threads.map((thread) => thread.id)).toEqual(["root-0", "root-1", "root-2", "root-3", "root-4"]);
		const second = store.page("D:/project", first.nextCursor);
		expect(second.threads.map((thread) => thread.id)).toEqual(["root-5", "root-6"]);
		expect(second.nextCursor).toBeNull();
		expect(store.get("root-0")?.subagents?.[0]).toMatchObject({ id: "child-0", status: "running" });
		expect(store.get("child-0")?.id).toBe("child-0");
		expect((await store.rounds("child-0", null)).rounds[0].messages[0].content).toBe("Inspect source");
		expect(store.projectThreadIds("D:/project")).toHaveLength(14);
	});

	it("updates catalog membership when exact relationships arrive, clear, or lose their last parent", async () => {
		const store = new ViewerStore(directory);
		const child = await observe(store, "child");
		await child.update({ status: "running" });
		const parent = await observe(store, "parent");
		const other = await observe(store, "other");
		const before = store.projects();
		const catalog = vi.fn();
		store.catalogListeners.add(catalog);
		await parent.update({ subagents: [relation] });
		expect(store.projects().projects[0].threadCount).toBe(2);
		expect(store.projects().running).toEqual([]);
		expect(store.projects().revision).not.toBe(before.revision);
		expect(catalog).toHaveBeenCalledTimes(1);
		const hidden = store.projects();
		await child.update({ status: "idle" });
		await parent.update({ subagents: [{ ...relation, taskStatus: "completed" }] });
		expect(store.projects()).toBe(hidden);
		await other.update({ subagents: [relation] });
		await parent.update({ subagents: [] });
		expect(store.projects()).toBe(hidden);
		await store.remove("other");
		expect(store.page("D:/project", null).threads.map((thread) => thread.id)).toEqual(["child", "parent"]);
		expect(store.projects().projects[0].threadCount).toBe(2);
		expect(catalog).toHaveBeenCalledTimes(3);
	});

	it("uses exact session IDs, task lifecycle, and reported execution state independently", async () => {
		const store = new ViewerStore(directory);
		const parent = await observe(store, "parent", [relation]);
		expect(store.get("parent")?.subagents).toEqual([]);
		const child = await observe(store, "child");
		expect(store.get("parent")?.subagents).toEqual([
			{ id: "child", title: "Inspect source", status: "idle", taskStatus: "running", lifecycle: "active" },
		]);
		await child.update({ status: "idle" });
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ status: "idle", lifecycle: "active" });
		for (const [taskStatus, outcome] of [
			["completed", "completed"],
			["steered", "completed"],
			["error", "failed"],
			["stopped", "aborted"],
			["aborted", "aborted"],
		] as const) {
			await parent.update({ subagents: [{ ...relation, taskStatus }] });
			expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "completed", outcome, taskStatus });
		}
		await parent.update({ subagents: [{ ...relation, taskStatus: "queued" }] });
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "active", taskStatus: "queued" });
		expect(store.get("parent")?.subagents?.[0]).not.toHaveProperty("outcome");
		expect(store.page("D:/project", null).threads.every((thread) => !("subagents" in thread))).toBe(true);
	});

	it("publishes parent metadata updates on child creation, status and deletion", async () => {
		const store = new ViewerStore(directory);
		await observe(store, "parent", [relation]);
		const updates: ViewerUpdate[] = [];
		store.subscribe("parent", (update) => updates.push(update));
		const child = await observe(store, "child");
		await child.update({ status: "running" });
		await child.update({ status: "idle" });
		await store.remove("child");
		expect(updates.map((update) => update.thread.subagents?.[0]?.status)).toEqual([
			"idle",
			"running",
			"idle",
			undefined,
		]);
		expect(updates.every((update) => Object.keys(update).length === 1)).toBe(true);
	});

	it("persists lifecycle and clears parent relationships with an explicit empty snapshot", async () => {
		const store = new ViewerStore(directory);
		const parent = await observe(store, "parent", [{ ...relation, taskStatus: "completed" }]);
		await observe(store, "child");
		const restored = new ViewerStore(directory);
		expect(restored.page("D:/project", null).threads.map((thread) => thread.id)).toEqual(["parent"]);
		expect(restored.projects().projects[0].threadCount).toBe(1);
		expect(restored.get("parent")?.subagents?.[0]).toMatchObject({
			status: "idle",
			lifecycle: "completed",
			outcome: "completed",
		});
		await parent.update({ subagents: [] });
		const cleared = new ViewerStore(directory);
		expect(cleared.get("parent")?.subagents).toEqual([]);
		expect(cleared.page("D:/project", null).threads.map((thread) => thread.id)).toEqual(["child", "parent"]);
	});

	it("projects archived snapshots across branches and updates archived parent subscribers", async () => {
		replaceSessionTree(
			"parent",
			[
				{
					type: "custom",
					id: "relationship",
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "pi-server-subagent",
					data: { subagents: [relation] },
				},
			],
			"relationship",
		);
		const store = new ViewerStore(directory);
		expect(store.get("parent")?.subagents).toEqual([]);
		const updates: ViewerUpdate[] = [];
		store.subscribe("parent", (update) => updates.push(update));
		await observe(store, "child");
		expect(updates[0].thread.subagents?.[0]).toMatchObject({ id: "child", lifecycle: "active" });
		appendSessionEntries(
			"parent",
			[
				{
					type: "custom",
					id: "completed",
					parentId: "relationship",
					timestamp: new Date().toISOString(),
					customType: "pi-server-subagent",
					data: { subagents: [{ ...relation, taskStatus: "completed" }] },
				},
			],
			"relationship",
		);
		await store.refreshSession("parent");
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "completed", outcome: "completed" });
		await store.remove("child");
		expect(updates.at(-1)?.thread.subagents).toEqual([]);
	});

	it("indexes archived relationships before catalog pages and refreshes them without opening the parent", async () => {
		replaceSessionTree("child", [], null);
		replaceSessionTree(
			"parent",
			[
				{
					type: "custom",
					id: "relationship",
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "pi-server-subagent",
					data: { subagents: [relation] },
				},
			],
			"relationship",
		);
		const store = new ViewerStore(directory);
		expect(store.page("unassigned", null).threads.map((thread) => thread.id)).toEqual(["parent"]);
		expect(store.projects().projects[0].threadCount).toBe(1);
		appendSessionEntries(
			"parent",
			[
				{
					type: "custom",
					id: "cleared",
					parentId: "relationship",
					timestamp: new Date().toISOString(),
					customType: "pi-server-subagent",
					data: { subagents: [] },
				},
			],
			"cleared",
		);
		await store.refreshSession("parent");
		expect(store.page("unassigned", null).threads.map((thread) => thread.id)).toEqual(["child", "parent"]);
		expect(store.projects().projects[0].threadCount).toBe(2);
	});
});
