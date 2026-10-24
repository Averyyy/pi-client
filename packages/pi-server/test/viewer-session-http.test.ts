import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../src/server.ts";
import * as persistence from "../src/session-persistence.ts";
import { clearAllSessions } from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerCatalog, ViewerProject, ViewerRound, ViewerThread, ViewerUpdate } from "../src/viewer-types.ts";

class Events {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private text = "";

	constructor(response: Response) {
		if (!response.body) throw new Error("Missing event stream");
		this.reader = response.body.getReader();
	}

	async next(): Promise<{ event: string; data: Record<string, unknown> } | null> {
		while (!this.text.includes("\n\n")) {
			const chunk = await this.reader.read();
			if (chunk.done) return null;
			this.text += this.decoder.decode(chunk.value, { stream: true });
		}
		const end = this.text.indexOf("\n\n");
		const frame = this.text.slice(0, end);
		this.text = this.text.slice(end + 2);
		const event = /^event: (.+)$/m.exec(frame)?.[1];
		const data = /^data: (.+)$/m.exec(frame)?.[1];
		return event && data ? { event, data: JSON.parse(data) as Record<string, unknown> } : this.next();
	}
}

function user(id: string, parentId: string | null): Extract<SessionTreeEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-24T03:00:00.000Z",
		message: { role: "user", content: `Remote ${id}`, timestamp: 1000 },
	};
}

describe("viewer updates from persisted remote HTTP sessions", () => {
	let directory: string;
	let server: Server;
	let base: string;
	let cookie: string;
	let controllers: AbortController[];
	const bearer = { Authorization: "Bearer remote-viewer-secret", "Content-Type": "application/json" };

	async function start(): Promise<void> {
		server = createPiServer({ sessionStoreDir: directory, authToken: "remote-viewer-secret" }, createModels());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address");
		base = `http://127.0.0.1:${address.port}`;
		const login = await fetch(`${base}/viewer/login`, { method: "POST", headers: { ...bearer, Origin: base } });
		expect(login.status).toBe(200);
		const header = login.headers.get("set-cookie");
		if (!header) throw new Error("Missing viewer cookie");
		cookie = header.split(";")[0];
	}

	async function stop(): Promise<void> {
		for (const controller of controllers) controller.abort();
		controllers = [];
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${base}/api/session/${path}`, { method: "POST", headers: bearer, body: JSON.stringify(body) });
	}

	async function viewer(path: string): Promise<Response> {
		return fetch(`${base}/viewer/api/${path}`, { headers: { Cookie: cookie } });
	}

	async function events(path: string): Promise<Events> {
		const controller = new AbortController();
		controllers.push(controller);
		const response = await fetch(`${base}/viewer/api/${path}`, {
			headers: { Cookie: cookie },
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		return new Events(response);
	}

	beforeEach(async () => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-session-http-"));
		controllers = [];
		await start();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await stop();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("uses the same catalog revision for GET and initial SSE and invalidates only changed projects", async () => {
		const first = {
			sessionId: "a",
			staticContext: { systemPrompt: "Instructions\nCurrent working directory: D:/a" },
		};
		expect((await post("init", first)).status).toBe(200);
		const initial = (await (await viewer("projects")).json()) as ViewerCatalog;
		const catalog = await events("events");
		expect(await catalog.next()).toEqual({ event: "catalog", data: { revision: initial.revision } });
		expect((await post("init", first)).status).toBe(200);
		expect(((await (await viewer("projects")).json()) as ViewerCatalog).revision).toBe(initial.revision);
		expect(
			(
				await post("init", {
					sessionId: "b",
					staticContext: { systemPrompt: "Instructions\nCurrent working directory: D:/b" },
				})
			).status,
		).toBe(200);
		const updated = (await (await viewer("projects")).json()) as ViewerCatalog;
		expect(updated.revision).not.toBe(initial.revision);
		expect(await catalog.next()).toEqual({ event: "catalog", data: { revision: updated.revision } });
		expect(updated.projects.find((project) => project.id === "D:/a")?.revision).toBe(initial.projects[0].revision);
	});

	it("publishes catalog and branch snapshots for init, sync, append and switch without an observer", async () => {
		const catalog = await events("events");
		expect((await catalog.next())?.event).toBe("catalog");
		expect(
			(
				await post("init", {
					sessionId: "remote",
					staticContext: { systemPrompt: "Pi instructions\nCurrent working directory: D:/remote" },
				})
			).status,
		).toBe(200);
		expect((await catalog.next())?.event).toBe("catalog");
		const initial = (await (await viewer("threads/remote")).json()) as { thread: ViewerThread };
		expect(initial.thread).toMatchObject({ id: "remote", cwd: "D:/remote", status: "unknown" });
		const history = await events("threads/remote/events");
		expect((await history.next())?.event).toBe("snapshot");
		const entries = Array.from({ length: 7 }, (_, index) => user(`u${index}`, index ? `u${index - 1}` : null));
		const synced = await post("tree/sync", { sessionId: "remote", entries, leafId: "u6" });
		expect(synced.status).toBe(200);
		const syncState = (await synced.json()) as { revision: number; entryCount: number; leafId: string };
		expect(syncState).toMatchObject({ entryCount: 7, leafId: "u6" });
		expect((await catalog.next())?.event).toBe("catalog");
		const snapshot = await history.next();
		expect(snapshot?.event).toBe("snapshot");
		expect(snapshot?.data.replace).toBe(true);
		expect((snapshot?.data.rounds as ViewerRound[]).map((round) => round.id)).toEqual(["u2", "u3", "u4", "u5", "u6"]);
		const before = String(snapshot?.data.nextCursor);
		const appended = await post("tree/append", { sessionId: "remote", entries: [user("u7", "u6")], leafId: "u7" });
		expect(appended.status).toBe(200);
		expect(await appended.json()).toMatchObject({ revision: syncState.revision + 1, entryCount: 8, leafId: "u7" });
		expect((await catalog.next())?.event).toBe("catalog");
		expect((await history.next())?.data.replace).toBe(true);
		const oldPage = (await (await viewer(`threads/remote/rounds?before=${encodeURIComponent(before)}`)).json()) as {
			rounds: ViewerRound[];
		};
		expect(oldPage.rounds.map((round) => round.id)).toEqual(["u0", "u1"]);
		expect(
			(await post("tree/append", { sessionId: "remote", entries: [user("branch", null)], leafId: "branch" })).status,
		).toBe(200);
		await catalog.next();
		await history.next();
		expect((await viewer(`threads/remote/rounds?before=${encodeURIComponent(before)}`)).status).toBe(400);
		expect((await post("tree/switch", { sessionId: "remote", leafId: "u7" })).status).toBe(200);
		expect((await catalog.next())?.event).toBe("catalog");
		const switched = await history.next();
		expect(switched?.data.replace).toBe(true);
		expect((switched?.data.rounds as ViewerRound[]).map((round) => round.id)).toEqual(["u3", "u4", "u5", "u6", "u7"]);
		expect(
			(
				await post("update", {
					sessionId: "remote",
					staticContext: { systemPrompt: "Pi instructions\nCurrent working directory: D:/changed" },
				})
			).status,
		).toBe(200);
		expect((await catalog.next())?.event).toBe("catalog");
		expect((await history.next())?.data.thread).toMatchObject({ cwd: "D:/changed" });
		const projects = (await (await viewer("projects")).json()) as { projects: ViewerProject[] };
		expect(projects.projects).toMatchObject([
			{ id: "D:/changed", path: "D:/changed", name: "changed", threadCount: 1 },
		]);
		await stop();
		clearAllSessions();
		await start();
		const restored = (await (await viewer("threads/remote")).json()) as { thread: ViewerThread };
		expect(restored.thread).toMatchObject({ cwd: "D:/changed", status: "unknown" });
		const rounds = (await (await viewer("threads/remote/rounds")).json()) as { rounds: ViewerRound[] };
		expect(rounds.rounds.map((round) => round.id)).toEqual(["u3", "u4", "u5", "u6", "u7"]);
	});

	it("skips unchanged persisted history and publishes revisions with unchanged catalog summaries", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const refresh = vi.spyOn(ViewerStore.prototype, "refreshSession");
		const rounds = vi.spyOn(ViewerStore.prototype, "rounds");
		expect((await post("init", { sessionId: "dedup" })).status).toBe(200);
		expect(refresh).toHaveBeenCalledExactlyOnceWith("dedup");
		const store = refresh.mock.contexts[0] as ViewerStore;
		expect(store.projects().projects[0]).toMatchObject({ id: "unassigned", threadCount: 1 });
		const staticContext = { systemPrompt: "Instructions\nCurrent working directory: D:/dedup" };
		expect((await post("update", { sessionId: "dedup", staticContext })).status).toBe(200);
		const entries = Array.from(
			{ length: 5 },
			(_, index): SessionTreeEntry => ({
				...user(`u${index}`, index ? `u${index - 1}` : null),
				message: { role: "user", content: "x".repeat(1024 * 1024), timestamp: 1000 },
			}),
		);
		const synced = await post("tree/sync", { sessionId: "dedup", entries, leafId: "u4" });
		expect(synced.status).toBe(200);
		const initial = (await synced.json()) as { revision: number };
		expect(rounds).not.toHaveBeenCalled();
		const catalog = store.projects();
		const updates: ViewerUpdate[] = [];
		const unsubscribe = store.subscribe("dedup", (update) => updates.push(update));
		refresh.mockClear();
		for (const [path, body] of [
			["init", { sessionId: "dedup", staticContext }],
			["tree/append", { sessionId: "dedup", entries: [entries[4]], leafId: "u4" }],
		] as const) {
			const response = await post(path, body);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ revision: initial.revision });
		}
		const repeatedBytes = updates.reduce((bytes, update) => bytes + Buffer.byteLength(JSON.stringify(update)), 0);
		expect(repeatedBytes).toBe(0);
		expect(refresh).not.toHaveBeenCalled();
		expect(rounds).not.toHaveBeenCalled();
		const branch = { ...user("branch", "u0"), message: { role: "user", content: "Branch", timestamp: 1000 } };
		expect((await post("tree/append", { sessionId: "dedup", entries: [branch], leafId: "branch" })).status).toBe(200);
		expect(store.projects()).toBe(catalog);
		expect(updates.at(-1)).toMatchObject({ refresh: true, rounds: [{ id: "u0" }, { id: "branch" }] });
		expect((await post("tree/switch", { sessionId: "dedup", leafId: "u4" })).status).toBe(200);
		expect(store.projects()).toBe(catalog);
		expect(updates.at(-1)).toMatchObject({
			rounds: [{ id: "u0" }, { id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }],
		});
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(rounds).toHaveBeenCalledTimes(2);
		unsubscribe();
	});

	it("keeps observer history and live updates independent of unchanged archive requests", async () => {
		const refresh = vi.spyOn(ViewerStore.prototype, "refreshSession");
		const entry = user("archive", null);
		expect((await post("tree/sync", { sessionId: "observed", entries: [entry], leafId: entry.id })).status).toBe(200);
		const store = refresh.mock.contexts[0] as ViewerStore;
		const connection = store.connect("observed");
		const updates: ViewerUpdate[] = [];
		const unsubscribe = store.subscribe("observed", (update) => updates.push(update));
		const first = { id: "observer", role: "user", content: "Observer history", timestamp: 1000 };
		store.update({
			sessionId: "observed",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/observer",
			replace: [first],
		});
		refresh.mockClear();
		expect((await post("init", { sessionId: "observed" })).status).toBe(200);
		const second = { id: "next", role: "user", content: "Next observer round", timestamp: 2000 };
		store.update({ sessionId: "observed", connectionId: connection.connectionId, sequence: 2, append: [second] });
		expect((await post("tree/append", { sessionId: "observed", entries: [entry], leafId: entry.id })).status).toBe(
			200,
		);
		const live = { message: { id: "live", role: "assistant", content: "Streaming", timestamp: 3000 }, tools: [] };
		store.update({ sessionId: "observed", connectionId: connection.connectionId, sequence: 3, live });
		store.update({
			sessionId: "observed",
			connectionId: connection.connectionId,
			sequence: 4,
			replace: [second],
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(updates).toHaveLength(4);
		expect(updates[0]).toMatchObject({ replace: true, rounds: [{ id: "observer" }] });
		expect(updates[1]).toMatchObject({ append: [second] });
		expect(updates[2]).toMatchObject({ thread: { live } });
		expect(updates[3]).toMatchObject({ replace: true, rounds: [{ id: "next" }] });
		unsubscribe();
		connection.close();
	});

	it("reports a viewer projection failure while preserving the successful persisted session result", async () => {
		const refresh = vi.spyOn(ViewerStore.prototype, "refreshSession").mockImplementationOnce(() => {
			throw new Error("Viewer projection unavailable");
		});
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await post("sync", {
			sessionId: "projection-failure",
			messages: [{ role: "user", content: "Persisted remote content", timestamp: 1000 }],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ messageCount: 1, entryCount: 1 });
		expect(refresh).toHaveBeenCalledWith("projection-failure");
		expect(diagnostic).toHaveBeenCalledWith(
			"Failed to refresh viewer session projection-failure:",
			expect.objectContaining({ message: "Viewer projection unavailable" }),
		);
		await stop();
		clearAllSessions();
		await start();
		const rounds = (await (await viewer("threads/projection-failure/rounds")).json()) as { rounds: ViewerRound[] };
		expect(rounds.rounds[0].messages[0].content).toBe("Persisted remote content");
	});

	it("does not notify the viewer when session persistence fails", async () => {
		const refresh = vi.spyOn(ViewerStore.prototype, "refreshSession");
		vi.spyOn(persistence, "savePersistedSession").mockImplementationOnce(() => {
			throw new Error("Session storage unavailable");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await post("init", { sessionId: "storage-failure" })).status).toBe(500);
		expect(refresh).not.toHaveBeenCalled();
	});
});
