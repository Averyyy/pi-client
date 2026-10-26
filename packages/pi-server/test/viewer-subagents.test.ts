import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	function observe(store: ViewerStore, id: string, subagents?: ObserverSubagent[]) {
		const connection = store.connect(id);
		let sequence = 0;
		const update = (body: Partial<ObserverUpdate>) =>
			store.update({ sessionId: id, connectionId: connection.connectionId, sequence: ++sequence, ...body });
		update({ cwd: "D:/project", replace: [], status: "idle", ...(subagents ? { subagents } : {}) });
		return { update, close: connection.close };
	}

	it("uses exact session IDs, task lifecycle, and observer connection state independently", () => {
		const store = new ViewerStore(directory);
		const parent = observe(store, "parent", [relation]);
		expect(store.get("parent")?.subagents).toEqual([]);
		const child = observe(store, "child");
		expect(store.get("parent")?.subagents).toEqual([
			{ id: "child", title: "Inspect source", status: "idle", taskStatus: "running", lifecycle: "active" },
		]);
		child.close();
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ status: "disconnected", lifecycle: "active" });
		for (const [taskStatus, outcome] of [
			["completed", "completed"],
			["steered", "completed"],
			["error", "failed"],
			["stopped", "aborted"],
			["aborted", "aborted"],
		] as const) {
			parent.update({ subagents: [{ ...relation, taskStatus }] });
			expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "completed", outcome, taskStatus });
		}
		parent.update({ subagents: [{ ...relation, taskStatus: "queued" }] });
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "active", taskStatus: "queued" });
		expect(store.get("parent")?.subagents?.[0]).not.toHaveProperty("outcome");
		expect(store.page("D:/project", null).threads.every((thread) => !("subagents" in thread))).toBe(true);
	});

	it("publishes parent metadata updates on child creation, status, disconnect and deletion", () => {
		const store = new ViewerStore(directory);
		observe(store, "parent", [relation]);
		const updates: ViewerUpdate[] = [];
		store.subscribe("parent", (update) => updates.push(update));
		const child = observe(store, "child");
		child.update({ status: "running" });
		child.close();
		store.remove("child");
		expect(updates.map((update) => update.thread.subagents?.[0]?.status)).toEqual([
			"idle",
			"running",
			"disconnected",
			undefined,
		]);
		expect(updates.every((update) => Object.keys(update).length === 1)).toBe(true);
	});

	it("persists lifecycle and clears parent relationships with an explicit empty snapshot", () => {
		const store = new ViewerStore(directory);
		const parent = observe(store, "parent", [{ ...relation, taskStatus: "completed" }]);
		observe(store, "child");
		const restored = new ViewerStore(directory);
		expect(restored.get("parent")?.subagents?.[0]).toMatchObject({
			status: "disconnected",
			lifecycle: "completed",
			outcome: "completed",
		});
		parent.update({ subagents: [] });
		expect(new ViewerStore(directory).get("parent")?.subagents).toEqual([]);
	});

	it("projects archived snapshots across branches and updates archived parent subscribers", () => {
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
		observe(store, "child");
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
		store.refreshSession("parent");
		expect(store.get("parent")?.subagents?.[0]).toMatchObject({ lifecycle: "completed", outcome: "completed" });
		store.remove("child");
		expect(updates.at(-1)?.thread.subagents).toEqual([]);
	});
});
