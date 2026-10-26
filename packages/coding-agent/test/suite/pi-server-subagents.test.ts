import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { PiServerSubagents, resolvePiServerSubagents } from "../../src/core/pi-server-subagents.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("pi-server subagent bridge", () => {
	const harnesses: Harness[] = [];
	const bridges: PiServerSubagents[] = [];

	afterEach(() => {
		for (const bridge of bridges.splice(0)) bridge.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllGlobals();
	});

	it("resolves an exact child UUID after creation and persists authoritative task completion", async () => {
		const events = createEventBus();
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getEventBus: () => events },
		});
		harnesses.push(harness);
		const record: {
			type: string;
			description: string;
			status: "running" | "completed";
			session?: { sessionId: string };
		} = { type: "Explore", description: "Inspect transport", status: "running" };
		vi.stubGlobal(Symbol.for("pi-subagents:manager"), {
			getRecord: (id: string) => (id === "task-identity" ? record : undefined),
		});
		const changed = vi.fn();
		const bridge = new PiServerSubagents(harness.session, changed);
		bridges.push(bridge);
		events.emit("subagents:started", { id: "task-identity" });
		expect(bridge.snapshot()).toEqual([]);
		record.session = { sessionId: "actual-child-uuid" };
		resolvePiServerSubagents();
		expect(bridge.snapshot()).toEqual([
			{
				agentId: "task-identity",
				sessionId: "actual-child-uuid",
				title: "Inspect transport",
				taskStatus: "running",
			},
		]);
		record.status = "completed";
		expect(bridge.snapshot()[0]?.taskStatus).toBe("running");
		events.emit("subagents:completed", { id: "task-identity" });
		expect(bridge.snapshot()[0]?.taskStatus).toBe("completed");
		expect(changed).toHaveBeenCalledTimes(2);
		events.emit("subagents:completed", { id: "task-identity" });
		expect(changed).toHaveBeenCalledTimes(2);
		const persisted = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(persisted).toHaveLength(2);
		expect(persisted.at(-1)).toMatchObject({
			customType: "pi-server-subagent",
			data: { subagents: bridge.snapshot() },
		});
		bridge.dispose();
		const restored = new PiServerSubagents(harness.session, vi.fn());
		bridges.push(restored);
		expect(restored.snapshot()).toEqual(bridge.snapshot());
		record.status = "running";
		events.emit("subagents:started", { id: "task-identity" });
		expect(restored.snapshot()[0]?.taskStatus).toBe("running");
	});

	it("replaces a settled task when a new task resumes the same child session", async () => {
		const events = createEventBus();
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getEventBus: () => events },
		});
		harnesses.push(harness);
		const previous = {
			type: "Explore",
			description: "Inspect transport",
			status: "completed",
			session: { sessionId: "child-session" },
		};
		const resumed = { ...previous, status: "running" };
		vi.stubGlobal(Symbol.for("pi-subagents:manager"), {
			getRecord: (id: string) => (id === "previous-task" ? previous : resumed),
		});
		const bridge = new PiServerSubagents(harness.session, vi.fn());
		bridges.push(bridge);
		events.emit("subagents:completed", { id: "previous-task" });
		expect(bridge.snapshot()).toHaveLength(1);
		events.emit("subagents:started", { id: "resumed-task" });
		expect(bridge.snapshot()).toEqual([
			{
				agentId: "resumed-task",
				sessionId: "child-session",
				title: "Inspect transport",
				taskStatus: "running",
			},
		]);
		resumed.status = "completed";
		events.emit("subagents:completed", { id: "resumed-task" });
		expect(bridge.snapshot()).toHaveLength(1);
		expect(bridge.snapshot()[0]).toMatchObject({ agentId: "resumed-task", taskStatus: "completed" });
		bridge.dispose();
		const restored = new PiServerSubagents(harness.session, vi.fn());
		bridges.push(restored);
		expect(restored.snapshot()).toEqual(bridge.snapshot());
	});

	it("clears pending identities on session replacement and unsubscribes on disposal", async () => {
		const events = createEventBus();
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getEventBus: () => events },
		});
		harnesses.push(harness);
		const record = {
			type: "Explore",
			description: "Task",
			status: "running",
			session: undefined as { sessionId: string } | undefined,
		};
		vi.stubGlobal(Symbol.for("pi-subagents:manager"), { getRecord: () => record });
		const changed = vi.fn();
		const bridge = new PiServerSubagents(harness.session, changed);
		bridges.push(bridge);
		events.emit("subagents:started", { id: "old-task" });
		harness.sessionManager.newSession();
		record.session = { sessionId: "old-child" };
		resolvePiServerSubagents();
		expect(bridge.snapshot()).toEqual([]);
		expect(changed).not.toHaveBeenCalled();
		bridge.dispose();
		events.emit("subagents:created", { id: "new-task" });
		expect(bridge.snapshot()).toEqual([]);
	});
});
