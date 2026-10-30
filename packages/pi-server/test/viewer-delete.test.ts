import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllRequestChunks, type RequestChunkBody } from "../src/request-chunks.ts";
import { createPiServer } from "../src/server.ts";
import * as persistence from "../src/session-persistence.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";
import type { ViewerCatalog, ViewerDeleteResult, ViewerThread } from "../src/viewer-types.ts";

function chunks(
	sessionId: string,
	target = "/api/session/init",
	fields: Record<string, unknown> = {},
): RequestChunkBody[] {
	const encoded = Buffer.from(JSON.stringify({ sessionId, ...fields })).toString("base64");
	const requestId = randomUUID();
	return [encoded.slice(0, 4), encoded.slice(4)].map((chunk, chunkIndex) => ({
		requestId,
		target,
		chunkIndex,
		totalChunks: 2,
		sha256: createHash("sha256").update(chunk).digest("hex"),
		chunk,
	}));
}

describe("viewer server deletion", () => {
	let directory: string;
	let server: Server;
	let base: string;
	let cookie: string;
	const bearer = { Authorization: "Bearer deletion-fixture", "Content-Type": "application/json" };
	let controllers: AbortController[];

	async function start(): Promise<void> {
		server = createPiServer({ sessionStoreDir: directory, authToken: "deletion-fixture" });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address");
		base = `http://127.0.0.1:${address.port}`;
		const login = await fetch(`${base}/viewer/login`, { method: "POST", headers: { ...bearer, Origin: base } });
		expect(login.status).toBe(200);
		cookie = login.headers.get("set-cookie")!.split(";")[0];
	}

	async function stop(): Promise<void> {
		for (const controller of controllers) controller.abort();
		controllers = [];
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${base}${path}`, { method: "POST", headers: bearer, body: JSON.stringify(body) });
	}

	async function seed(id: string, cwd = "D:/project"): Promise<void> {
		expect(
			(
				await post("/api/session/init", {
					sessionId: id,
					staticContext: { systemPrompt: `Pi\nCurrent working directory: ${cwd}` },
				})
			).status,
		).toBe(200);
		expect(
			(
				await post("/api/session/append", {
					sessionId: id,
					messages: [{ role: "user", content: `Question ${id}`, timestamp: 1 }],
				})
			).status,
		).toBe(200);
	}

	async function viewer(path: string): Promise<Response> {
		return fetch(`${base}/viewer/api/${path}`, { headers: { Cookie: cookie } });
	}

	async function remove(path: string): Promise<Response> {
		return fetch(`${base}/viewer/api/${path}`, { method: "DELETE", headers: { Cookie: cookie, Origin: base } });
	}

	async function hold(path: string, body: unknown): Promise<{ finish: () => void; result: Promise<number> }> {
		const text = JSON.stringify(body);
		const received = new Promise<void>((resolve) => server.once("request", () => resolve()));
		let finish = () => {};
		const result = new Promise<number>((resolve, reject) => {
			const req = request(
				`${base}${path}`,
				{ method: "POST", headers: { ...bearer, "Content-Length": Buffer.byteLength(text) } },
				(res) => {
					res.resume();
					res.once("end", () => resolve(res.statusCode!));
				},
			);
			req.once("error", reject);
			req.write(text.slice(0, 1));
			finish = () => req.end(text.slice(1));
		});
		await received;
		return { finish, result };
	}

	beforeEach(async () => {
		clearAllSessions();
		clearAllRequestChunks();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-delete-"));
		controllers = [];
		await start();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetApiProviders();
		await stop();
		clearAllSessions();
		clearAllRequestChunks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("requires the viewer cookie and same origin without authorizing ordinary APIs", async () => {
		await seed("secure");
		const endpoint = `${base}/viewer/api/threads/secure`;
		expect((await fetch(endpoint, { method: "DELETE", headers: { Origin: base } })).status).toBe(401);
		expect((await fetch(endpoint, { method: "DELETE", headers: { ...bearer, Origin: base } })).status).toBe(401);
		expect((await fetch(endpoint, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(403);
		expect(
			(await fetch(endpoint, { method: "DELETE", headers: { Cookie: cookie, Origin: "https://foreign.invalid" } }))
				.status,
		).toBe(403);
		expect(
			(
				await fetch(endpoint, {
					method: "DELETE",
					headers: { Cookie: cookie, Origin: base, "Sec-Fetch-Site": "cross-site" },
				})
			).status,
		).toBe(403);
		expect(
			(await fetch(`${base}/api/session/secure`, { method: "DELETE", headers: { Cookie: cookie, Origin: base } }))
				.status,
		).toBe(401);
		expect((await viewer("threads/secure")).status).toBe(200);
		expect((await remove("threads/%invalid")).status).toBe(400);
		expect((await remove("threads/secure/rounds")).status).toBe(404);
		expect(
			(await fetch(`${base}/viewer/api/projects`, { method: "POST", headers: { Cookie: cookie, Origin: base } }))
				.status,
		).toBe(405);
	});

	it("deletes snapshot, WAL, observer history, streams and catalog without restoring them on restart", async () => {
		await seed("thread");
		const controller = new AbortController();
		controllers.push(controller);
		const observer = await fetch(`${base}/api/observer/connect?sessionId=thread`, {
			headers: bearer,
			signal: controller.signal,
		});
		const observerReader = observer.body!.getReader();
		const connected = new TextDecoder().decode((await observerReader.read()).value);
		const connectionId = (JSON.parse(/^data: (.+)$/m.exec(connected)![1]) as { connectionId: string }).connectionId;
		expect(
			(
				await post("/api/observer", {
					sessionId: "thread",
					connectionId,
					sequence: 1,
					cwd: "D:/project",
					replace: [{ id: "u", role: "user", content: "Observer question", timestamp: 1 }],
				})
			).status,
		).toBe(200);
		const response = await fetch(`${base}/viewer/api/threads/thread/events`, {
			headers: { Cookie: cookie },
			signal: controller.signal,
		});
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
		const persisted = join(directory, `${createHash("sha256").update("thread").digest("hex")}.json`);
		expect(existsSync(persisted)).toBe(true);
		expect(existsSync(`${persisted}.wal`)).toBe(true);
		const deleted = await remove("threads/thread");
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ deletedIds: ["thread"], deletedCount: 1, failed: [] });
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: deleted\ndata: {"id":"thread"}');
		expect((await reader.read()).done).toBe(true);
		expect(new TextDecoder().decode((await observerReader.read()).value)).toContain("event: deleted");
		expect((await post("/api/observer", { sessionId: "thread", connectionId, sequence: 2, append: [] })).status).toBe(
			410,
		);
		expect(existsSync(persisted)).toBe(false);
		expect(existsSync(`${persisted}.wal`)).toBe(false);
		expect((await viewer("threads/thread/rounds?before=u")).status).toBe(404);
		expect(((await (await viewer("projects")).json()) as ViewerCatalog).projects).toEqual([]);
		await stop();
		clearAllSessions();
		await start();
		expect((await viewer("threads/thread")).status).toBe(404);
		expect(((await (await viewer("projects")).json()) as ViewerCatalog).projects).toEqual([]);
	});

	it("deletes every project session, including unloaded pages, while retaining other projects", async () => {
		for (let index = 0; index < 7; index++) await seed(`a-${index}`);
		await seed("other", "D:/other");
		const first = (await (await viewer(`threads?project=${encodeURIComponent("D:/project")}`)).json()) as {
			threads: ViewerThread[];
			nextCursor: string;
		};
		expect(first.threads).toHaveLength(5);
		expect(first.nextCursor).toBeTruthy();
		const deleted = await remove(`projects/${encodeURIComponent("D:/project")}`);
		expect(deleted.status).toBe(200);
		const result = (await deleted.json()) as ViewerDeleteResult;
		expect(result.deletedIds.sort()).toEqual(Array.from({ length: 7 }, (_, index) => `a-${index}`));
		expect(result.deletedCount).toBe(7);
		expect(result.failed).toEqual([]);
		expect(
			await (
				await viewer(
					`threads?project=${encodeURIComponent("D:/project")}&cursor=${encodeURIComponent(first.nextCursor)}`,
				)
			).json(),
		).toEqual({ threads: [], nextCursor: null });
		expect((await remove(`projects/${encodeURIComponent("D:/project")}`)).status).toBe(404);
		await stop();
		clearAllSessions();
		await start();
		expect(
			((await (await viewer("projects")).json()) as ViewerCatalog).projects.map((project) => project.id),
		).toEqual(["D:/other"]);
		expect((await viewer("threads/other")).status).toBe(200);
	});

	it("reports storage failures per session and leaves failed sessions available for retry", async () => {
		await seed("good");
		await seed("failed");
		const original = persistence.deletePersistedSession;
		const disk = vi.spyOn(persistence, "deletePersistedSession").mockImplementation((dir, id) => {
			if (id === "failed") throw new Error("Storage denied");
			original(dir, id);
		});
		const response = await remove(`projects/${encodeURIComponent("D:/project")}`);
		expect(response.status).toBe(207);
		expect(await response.json()).toEqual({
			deletedIds: ["good"],
			deletedCount: 1,
			failed: [{ id: "failed", error: "Storage denied" }],
		});
		expect((await viewer("threads/good")).status).toBe(404);
		expect((await viewer("threads/failed")).status).toBe(200);
		expect(((await (await viewer("projects")).json()) as ViewerCatalog).projects[0].threadCount).toBe(1);
		disk.mockRestore();
		expect((await remove("threads/failed")).status).toBe(200);
	});

	it("rejects a pre-deletion held POST and permits a subsequent explicit request", async () => {
		await seed("late");
		const held = await hold("/api/session/init", { sessionId: "late" });
		expect((await remove("threads/late")).status).toBe(200);
		held.finish();
		expect(await held.result).toBe(410);
		expect(getSession("late")).toBeUndefined();
		expect((await post("/api/session/init", { sessionId: "late" })).status).toBe(200);
		expect(getSession("late")).toBeDefined();
	});

	it("permits a held request for another session after deletion", async () => {
		await seed("deleted-a");
		await seed("held-b");
		const held = await hold("/api/session/append", {
			sessionId: "held-b",
			messages: [{ role: "user", content: "Still active", timestamp: 2 }],
		});
		expect((await remove("threads/deleted-a")).status).toBe(200);
		held.finish();
		expect(await held.result).toBe(200);
		expect(getSession("held-b")!.messages.at(-1)).toMatchObject({ content: "Still active" });
	});

	it("rejects old held requests and chunk uploads after explicit recreation", async () => {
		await seed("recreated");
		const held = await hold("/api/session/init", { sessionId: "recreated" });
		const pending = chunks("recreated");
		const completed = chunks("recreated");
		expect((await post("/api/request/chunk", pending[0])).status).toBe(200);
		expect((await post("/api/request/chunk", completed[0])).status).toBe(200);
		expect((await post("/api/request/chunk", completed[1])).status).toBe(200);
		expect((await remove("threads/recreated")).status).toBe(200);
		await seed("recreated");
		held.finish();
		expect(await held.result).toBe(410);
		expect((await post("/api/request/chunk", pending[1])).status).toBe(410);
		expect((await post("/api/request/chunk", completed[1])).status).toBe(410);
		const fresh = chunks("recreated");
		expect((await post("/api/request/chunk", fresh[0])).status).toBe(200);
		expect((await post("/api/request/chunk", fresh[1])).status).toBe(200);
		expect(getSession("recreated")!.messages).toHaveLength(1);
	});

	it("rejects delayed observer updates after deletion and rejects old connections after explicit recreation", async () => {
		await seed("observer-lifetime");
		async function connect(): Promise<string> {
			const controller = new AbortController();
			controllers.push(controller);
			const response = await fetch(`${base}/api/observer/connect?sessionId=observer-lifetime`, {
				headers: bearer,
				signal: controller.signal,
			});
			const first = await response.body!.getReader().read();
			return (
				JSON.parse(/^data: (.+)$/m.exec(new TextDecoder().decode(first.value))![1]) as { connectionId: string }
			).connectionId;
		}
		const connectionId = await connect();
		const update = { connectionId, sequence: 1, cwd: "D:/project", replace: [] };
		expect((await post("/api/observer", { sessionId: "observer-lifetime", ...update })).status).toBe(200);
		const held = await hold("/api/observer", { sessionId: "observer-lifetime", ...update, sequence: 2 });
		const pending = chunks("observer-lifetime", "/api/observer", { ...update, sequence: 3 });
		expect((await post("/api/request/chunk", pending[0])).status).toBe(200);
		expect((await remove("threads/observer-lifetime")).status).toBe(200);
		held.finish();
		expect(await held.result).toBe(410);
		expect((await post("/api/request/chunk", pending[1])).status).toBe(410);
		expect((await post("/api/observer", { sessionId: "observer-lifetime", ...update, sequence: 4 })).status).toBe(
			410,
		);
		expect(getSession("observer-lifetime")).toBeUndefined();
		expect((await viewer("threads/observer-lifetime")).status).toBe(404);

		await seed("observer-lifetime");
		expect((await post("/api/observer", { sessionId: "observer-lifetime", ...update, sequence: 5 })).status).toBe(
			409,
		);
		const replacement = await connect();
		expect(
			(await post("/api/observer", { sessionId: "observer-lifetime", ...update, connectionId: replacement })).status,
		).toBe(200);
		const reconnected = await connect();
		expect(
			(
				await post("/api/observer", {
					sessionId: "observer-lifetime",
					...update,
					connectionId: replacement,
					sequence: 2,
				})
			).status,
		).toBe(409);
		expect(
			(await post("/api/observer", { sessionId: "observer-lifetime", ...update, connectionId: reconnected })).status,
		).toBe(200);
	});

	it("rejects uploads begun before deletion and completed-chunk retries after deletion", async () => {
		await seed("chunked");
		const pending = chunks("chunked");
		expect((await post("/api/request/chunk", pending[0])).status).toBe(200);
		const held = await hold("/api/request/chunk", pending[1]);
		expect((await remove("threads/chunked")).status).toBe(200);
		held.finish();
		expect(await held.result).toBe(410);
		expect((await post("/api/request/chunk", pending[1])).status).toBe(410);
		expect(getSession("chunked")).toBeUndefined();
		const fresh = chunks("chunked");
		await post("/api/request/chunk", fresh[0]);
		expect((await post("/api/request/chunk", fresh[1])).status).toBe(200);
		expect((await remove("threads/chunked")).status).toBe(200);
		expect((await post("/api/request/chunk", fresh[1])).status).toBe(410);
		expect(getSession("chunked")).toBeUndefined();
	});

	it("marks the full project before cancellation and waits for every provider cleanup", async () => {
		const model: Model<"viewer-delete-gate"> = {
			id: "gate",
			name: "gate",
			api: "viewer-delete-gate",
			provider: "viewer-delete-gate",
			baseUrl: "http://fixture.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "aborted",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const releases: (() => void)[] = [];
		const aborted: Promise<void>[] = [];
		const provide = (_model: Model<"viewer-delete-gate">, _context: unknown, options?: SimpleStreamOptions) => {
			const canceled = new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			aborted.push(canceled);
			const cleanup = new Promise<void>((resolve) => releases.push(resolve));
			const stream = createAssistantMessageEventStream();
			stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
				yield { type: "start", partial: message };
				await canceled;
				await cleanup;
				yield { type: "error", reason: "aborted", error: message };
			};
			return stream;
		};
		registerApiProvider({ api: model.api, stream: provide, streamSimple: provide });
		for (const id of ["active-a", "active-b"]) {
			await seed(id);
			const stream = await post("/api/stream", { sessionId: id, runId: "run", model });
			expect(stream.status).toBe(200);
			await stream.body!.getReader().read();
		}
		expect(aborted).toHaveLength(2);
		let settled = false;
		const deletion = remove(`projects/${encodeURIComponent("D:/project")}`).then((response) => {
			settled = true;
			return response;
		});
		await Promise.all(aborted);
		expect(settled).toBe(false);
		const during = await hold("/api/session/init", { sessionId: "active-a" });
		for (const id of ["active-a", "active-b"]) {
			expect((await post("/api/session/init", { sessionId: id })).status).toBe(410);
			expect((await fetch(`${base}/api/observer/connect?sessionId=${id}`, { headers: bearer })).status).toBe(410);
		}
		for (const release of releases) release();
		expect((await deletion).status).toBe(200);
		during.finish();
		expect(await during.result).toBe(410);
		for (const id of ["active-a", "active-b"]) {
			expect(getSession(id)).toBeUndefined();
			expect((await fetch(`${base}/api/session/${id}/runs/run`, { headers: bearer })).status).toBe(404);
		}
	});
});
