import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";
import { unlockViewer } from "../src/viewer-auth.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ThreadSummary, ViewerMessage, ViewerProject, ViewerRound, ViewerThread } from "../src/viewer-types.ts";

class Events {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private text = "";
	private decoder = new TextDecoder();
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

function message(id: string, role = "user"): ViewerMessage {
	return { id, role, content: `内容 ${id}`, timestamp: 1000 };
}

describe("server thread viewer", () => {
	let directory: string;
	let server: Server;
	let base: string;
	let controllers: AbortController[];
	const bearer = { Authorization: "Bearer viewer-secret" };

	async function start(): Promise<void> {
		server = createPiServer({ sessionStoreDir: directory, authToken: "viewer-secret" }, createModels());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address");
		base = `http://127.0.0.1:${address.port}`;
	}
	async function stop(): Promise<void> {
		for (const controller of controllers) controller.abort();
		controllers = [];
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	async function login(token = "viewer-secret"): Promise<Response> {
		return fetch(`${base}/viewer/login`, {
			method: "POST",
			headers: { Origin: base, Authorization: `Bearer ${token}` },
		});
	}
	async function cookie(): Promise<string> {
		const response = await login();
		expect(response.status).toBe(200);
		const header = response.headers.get("set-cookie");
		if (!header) throw new Error("Missing viewer cookie");
		return header.split(";")[0];
	}
	async function connect(
		id: string,
	): Promise<{ connectionId: string; sequence: number; abort: () => void; events: Events }> {
		const controller = new AbortController();
		controllers.push(controller);
		const response = await fetch(`${base}/api/observer/connect?sessionId=${encodeURIComponent(id)}`, {
			headers: bearer,
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		const events = new Events(response);
		const event = await events.next();
		expect(event?.event).toBe("connected");
		return { connectionId: String(event?.data.connectionId), sequence: 0, abort: () => controller.abort(), events };
	}
	async function observe(
		id: string,
		connection: { connectionId: string; sequence: number },
		update: Record<string, unknown>,
	): Promise<Response> {
		return fetch(`${base}/api/observer`, {
			method: "POST",
			headers: { ...bearer, "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: id,
				connectionId: connection.connectionId,
				sequence: ++connection.sequence,
				...update,
			}),
		});
	}
	async function viewer(path: string, authCookie: string): Promise<Response> {
		return fetch(`${base}/viewer/api/${path}`, { headers: { Cookie: authCookie } });
	}

	beforeEach(async () => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-"));
		controllers = [];
		await start();
	});
	afterEach(async () => {
		await stop();
		rmSync(directory, { recursive: true, force: true });
	});

	it("scopes viewer cookies to viewer routes and rejects foreign browser mutations", async () => {
		const response = await login();
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=43200");
		expect(setCookie).not.toContain("viewer-secret");
		const authCookie = setCookie.split(";")[0];
		const projects = await viewer("projects", authCookie);
		expect(projects.status).toBe(200);
		expect(projects.headers.get("cache-control")).toBe("no-store");
		expect(projects.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(projects.headers.get("access-control-allow-origin")).toBeNull();
		expect((await fetch(`${base}/viewer/api/projects`, { headers: bearer })).status).toBe(401);
		expect(
			(
				await fetch(`${base}/api/session/init`, {
					method: "POST",
					headers: { Cookie: authCookie },
					body: JSON.stringify({ sessionId: "forbidden" }),
				})
			).status,
		).toBe(401);
		expect(getSession("forbidden")).toBeUndefined();
		expect(
			(await fetch(`${base}/viewer/api/threads`, { method: "POST", headers: { Cookie: authCookie, Origin: base } }))
				.status,
		).toBe(405);
		expect(
			(
				await fetch(`${base}/viewer/logout`, {
					method: "POST",
					headers: { Cookie: authCookie, Origin: "https://other.invalid" },
				})
			).status,
		).toBe(403);
		expect((await fetch(`${base}/viewer/login`, { method: "POST", headers: bearer })).status).toBe(403);
		const secure = await fetch(`${base}/viewer/login`, {
			method: "POST",
			headers: { ...bearer, Origin: base.replace("http:", "https:"), "X-Forwarded-Proto": "https" },
		});
		expect(secure.headers.get("set-cookie")).toContain("; Secure");
		const controller = new AbortController();
		controllers.push(controller);
		const events = new Events(
			await fetch(`${base}/viewer/api/events`, { headers: { Cookie: authCookie }, signal: controller.signal }),
		);
		expect((await events.next())?.event).toBe("catalog");
		expect(
			(await fetch(`${base}/viewer/logout`, { method: "POST", headers: { Cookie: authCookie, Origin: base } }))
				.status,
		).toBe(200);
		expect(await events.next()).toBeNull();
		expect((await viewer("projects", authCookie)).status).toBe(401);
	});

	it("shares a durable ten-failure budget across login and old APIs and hot unlocks locally", async () => {
		const authCookie = await cookie();
		const controller = new AbortController();
		controllers.push(controller);
		const events = new Events(
			await fetch(`${base}/viewer/api/events`, { headers: { Cookie: authCookie }, signal: controller.signal }),
		);
		expect((await events.next())?.event).toBe("catalog");
		for (let i = 0; i < 4; i++) expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
		const failures = await Promise.all(
			Array.from({ length: 9 }, (_, index) =>
				index % 2 === 0
					? login(`wrong-${index}`)
					: fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer wrong-${index}` } }),
			),
		);
		expect(failures.every((response) => response.status === 401)).toBe(true);
		expect((await fetch(`${base}/api/sessions`, { headers: bearer })).status).toBe(200);
		const locked = await login("");
		expect(locked.status).toBe(423);
		expect(await locked.json()).toMatchObject({ remainingAttempts: 0 });
		expect(await events.next()).toBeNull();
		expect((await viewer("projects", authCookie)).status).toBe(423);
		expect((await login()).status).toBe(423);
		expect((await fetch(`${base}/api/sessions`, { headers: bearer })).status).toBe(423);
		expect((await fetch(`${base}/health`)).status).toBe(200);
		expect(readFileSync(join(directory, ".viewer", "auth.json"), "utf8")).not.toContain("viewer-secret");
		await stop();
		await start();
		expect((await login()).status).toBe(423);
		await unlockViewer(directory);
		expect((await login()).status).toBe(200);
		expect((await viewer("projects", authCookie)).status).toBe(401);
		await stop();
		await start();
		expect((await login()).status).toBe(200);
	});

	it("resets failed attempts only after a successful viewer login", async () => {
		expect((await login("wrong")).status).toBe(401);
		expect((await login()).status).toBe(200);
		const failed = await login("wrong");
		expect(await failed.json()).toMatchObject({ remainingAttempts: 9 });
	});

	it("closes observer and browser event streams before the HTTP server closes", async () => {
		const authCookie = await cookie();
		await connect("closing");
		const controller = new AbortController();
		controllers.push(controller);
		const events = new Events(
			await fetch(`${base}/viewer/api/events`, { headers: { Cookie: authCookie }, signal: controller.signal }),
		);
		expect((await events.next())?.event).toBe("catalog");
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(await events.next()).toBeNull();
		await start();
	});

	it("pages projects by five threads and histories by five complete major turns", async () => {
		const authCookie = await cookie();
		for (let i = 0; i < 7; i++) {
			const connection = await connect(`thread-${i}`);
			expect(
				(
					await observe(`thread-${i}`, connection, {
						cwd: "C:\\project",
						title: `Thread ${i}`,
						replace: [],
						status: i === 0 ? "running" : "idle",
					})
				).status,
			).toBe(200);
		}
		const catalog = (await (await viewer("projects", authCookie)).json()) as {
			projects: ViewerProject[];
			running: ThreadSummary[];
		};
		expect(catalog.projects).toMatchObject([
			{ id: "C:/project", path: "C:/project", name: "project", threadCount: 7 },
		]);
		expect(catalog.running.map((thread) => thread.id)).toEqual(["thread-0"]);
		const first = (await (
			await viewer(`threads?project=${encodeURIComponent("C:/project")}`, authCookie)
		).json()) as { threads: ThreadSummary[]; nextCursor: string };
		expect(first.threads).toHaveLength(5);
		const second = (await (
			await viewer(`threads?project=${encodeURIComponent("C:/project")}&cursor=${first.nextCursor}`, authCookie)
		).json()) as { threads: ThreadSummary[]; nextCursor: null };
		expect(second.threads).toHaveLength(2);
		expect(new Set([...first.threads, ...second.threads].map((thread) => thread.id)).size).toBe(7);
		const connection = await connect("history");
		const history = Array.from({ length: 8 }, (_, index) => [
			message(`u${index}`),
			message(`a${index}`, "assistant"),
			message(`t${index}`, "toolResult"),
		]).flat();
		expect(
			(await observe("history", connection, { cwd: "C:\\project", replace: history, status: "idle" })).status,
		).toBe(200);
		const recent = (await (await viewer("threads/history/rounds", authCookie)).json()) as {
			rounds: ViewerRound[];
			nextCursor: string;
		};
		expect(recent.rounds.map((round) => round.id)).toEqual(["u3", "u4", "u5", "u6", "u7"]);
		expect(recent.rounds.every((round) => round.messages.length === 3)).toBe(true);
		await observe("history", connection, { append: [message("u8")] });
		const older = (await (await viewer(`threads/history/rounds?before=${recent.nextCursor}`, authCookie)).json()) as {
			rounds: ViewerRound[];
			nextCursor: null;
		};
		expect(older.rounds.map((round) => round.id)).toEqual(["u0", "u1", "u2"]);
		expect(older.nextCursor).toBeNull();
		await observe("history", connection, { replace: [message("branch-user")] });
		expect((await viewer(`threads/history/rounds?before=${recent.nextCursor}`, authCookie)).status).toBe(400);
	});

	it("streams explicit activity, thinking and tools without modifying durable provider trees", async () => {
		const authCookie = await cookie();
		await fetch(`${base}/api/session/sync`, {
			method: "POST",
			headers: { ...bearer, "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "live",
				messages: [{ role: "user", content: "provider tree", timestamp: 1000 }],
			}),
		});
		const durable = structuredClone(getSession("live"));
		const connection = await connect("live");
		await observe("live", connection, { cwd: "/work/live", replace: [message("u")], status: "idle" });
		const controller = new AbortController();
		controllers.push(controller);
		const events = new Events(
			await fetch(`${base}/viewer/api/threads/live/events`, {
				headers: { Cookie: authCookie },
				signal: controller.signal,
			}),
		);
		const snapshot = await events.next();
		expect(snapshot?.event).toBe("snapshot");
		expect((snapshot?.data.rounds as ViewerRound[])[0].id).toBe("u");
		await observe("live", connection, {
			status: "running",
			live: {
				message: {
					id: "a",
					role: "assistant",
					timestamp: 1000,
					phase: "commentary",
					content: [
						{ type: "thinking", thinking: "Current reasoning" },
						{ type: "text", text: "Inspecting", phase: "commentary" },
					],
				},
				tools: [{ id: "call", name: "read", arguments: { path: "x" }, status: "running" }],
			},
		});
		const update = await events.next();
		expect(update?.event).toBe("update");
		expect((update?.data.thread as ViewerThread).status).toBe("running");
		expect((update?.data.thread as ViewerThread).live.tools[0].status).toBe("running");
		expect(update?.data.append).toBeUndefined();
		await observe("live", connection, {
			live: {
				message: null,
				tools: [
					{
						id: "call",
						name: "read",
						arguments: { path: "x" },
						status: "completed",
						result: {
							content: [
								{ type: "text", text: "actual file contents" },
								{ type: "image", data: "opaque image", mimeType: "image/png" },
							],
						},
					},
				],
			},
		});
		const completed = await events.next();
		expect((completed?.data.thread as ViewerThread).live.tools[0].result?.content).toEqual([
			{ type: "text", text: "actual file contents" },
			{ type: "attachment", label: "image" },
		]);
		expect(getSession("live")).toEqual(durable);
		connection.abort();
		const disconnected = await events.next();
		expect((disconnected?.data.thread as ViewerThread).status).toBe("disconnected");
		const resumed = await connect("live");
		expect((await observe("live", connection, { status: "idle" })).status).toBe(409);
		await observe("live", resumed, { replace: [message("resumed")], status: "idle" });
		expect((await events.next())?.data.thread).toMatchObject({ status: "unknown" });
		const replaced = await events.next();
		expect(replaced?.data.replace).toBe(true);
		expect((replaced?.data.rounds as ViewerRound[])[0].id).toBe("resumed");
		const rounds = (await (await viewer("threads/live/rounds", authCookie)).json()) as { rounds: ViewerRound[] };
		expect(rounds.rounds[0].id).toBe("resumed");
		expect(getSession("live")).toEqual(durable);
	});

	it("deletes the viewer projection through the existing authenticated session delete API", async () => {
		const authCookie = await cookie();
		const connection = await connect("deleted");
		await observe("deleted", connection, { cwd: "/work", replace: [message("private-history")], status: "idle" });
		const controller = new AbortController();
		controllers.push(controller);
		const events = new Events(
			await fetch(`${base}/viewer/api/threads/deleted/events`, {
				headers: { Cookie: authCookie },
				signal: controller.signal,
			}),
		);
		expect((await events.next())?.event).toBe("snapshot");
		expect((await fetch(`${base}/api/session/deleted`, { method: "DELETE", headers: bearer })).status).toBe(200);
		const deleted = await observe("deleted", connection, { append: [message("late")] });
		expect(deleted.status).toBe(410);
		expect(await deleted.json()).toEqual({ error: "Observer session deleted", deleted: true });
		expect((await events.next())?.event).toBe("deleted");
		expect(await events.next()).toBeNull();
		expect(await connection.events.next()).toEqual({ event: "deleted", data: { id: "deleted" } });
		expect(await connection.events.next()).toBeNull();
		expect((await viewer("threads/deleted", authCookie)).status).toBe(404);
		const expired = await observe(
			"deleted",
			{ connectionId: "unrelated-expired-connection", sequence: 0 },
			{ append: [message("unrelated")] },
		);
		expect(expired.status).toBe(409);
		expect(readdirSync(join(directory, ".viewer", "threads"))).toEqual([]);
		const reopened = await connect("deleted");
		expect(
			(await observe("deleted", reopened, { cwd: "/work", replace: [message("reopened")], status: "idle" })).status,
		).toBe(200);
	});

	it("preserves legacy archives as unassigned with no inferred activity or cwd", async () => {
		const authCookie = await cookie();
		await fetch(`${base}/api/session/sync`, {
			method: "POST",
			headers: { ...bearer, "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "old",
				messages: [{ role: "user", content: "Current working directory: C:/not-metadata", timestamp: 1000 }],
			}),
		});
		const response = (await (await viewer("threads/old", authCookie)).json()) as { thread: ViewerThread };
		expect(response.thread).toMatchObject({ status: "unknown", cwd: null, projectId: "unassigned", legacy: true });
		expect(response.thread.title).toBe("Current working directory: C:/not-metadata");
		const rounds = (await (await viewer("threads/old/rounds", authCookie)).json()) as { rounds: ViewerRound[] };
		expect(rounds.rounds[0].messages[0].content).toBe("Current working directory: C:/not-metadata");
		await fetch(`${base}/api/session/append`, {
			method: "POST",
			headers: { ...bearer, "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: "old",
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Checking",
								textSignature: JSON.stringify({ v: 1, id: "c", phase: "commentary" }),
							},
							{
								type: "text",
								text: "Answer",
								textSignature: JSON.stringify({ v: 1, id: "f", phase: "final_answer" }),
							},
						],
						timestamp: 2000,
					},
				],
			}),
		});
		const phased = (await (await viewer("threads/old/rounds", authCookie)).json()) as { rounds: ViewerRound[] };
		expect(phased.rounds[0].messages[1]).toMatchObject({
			phase: "final_answer",
			content: [
				{ type: "text", phase: "commentary" },
				{ type: "text", phase: "final_answer" },
			],
		});
	});
});

describe("viewer projection persistence", () => {
	it("replays updates once and recovers only committed log offsets after restart and replacement", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-viewer-store-"));
		try {
			const store = new ViewerStore(directory);
			const { connectionId } = store.connect("thread/../../id");
			await store.update({
				sessionId: "thread/../../id",
				connectionId,
				sequence: 1,
				cwd: "/work",
				replace: [message("original")],
				status: "idle",
			});
			await store.update({
				sessionId: "thread/../../id",
				connectionId,
				sequence: 2,
				append: [message("tail", "assistant")],
			});
			await store.update({
				sessionId: "thread/../../id",
				connectionId,
				sequence: 2,
				append: [message("tail", "assistant")],
			});
			expect((await store.rounds("thread/../../id", null)).rounds[0].messages).toHaveLength(2);
			const metadataDir = join(directory, ".viewer", "threads");
			const metadataPath = join(
				metadataDir,
				readdirSync(metadataDir).find((path) => path.endsWith(".json")) ?? "missing",
			);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { logId: string; length: number };
			appendFileSync(join(metadataDir, `${metadata.logId}.jsonl`), `${JSON.stringify(message("uncommitted"))}\n`);
			const restarted = new ViewerStore(directory);
			expect(restarted.get("thread/../../id")?.status).toBe("disconnected");
			const next = restarted.connect("thread/../../id");
			await restarted.update({
				sessionId: "thread/../../id",
				connectionId: next.connectionId,
				sequence: 1,
				append: [message("committed", "assistant")],
			});
			expect((await restarted.rounds("thread/../../id", null)).rounds[0].messages.map((entry) => entry.id)).toEqual([
				"original",
				"tail",
				"committed",
			]);
			await restarted.update({
				sessionId: "thread/../../id",
				connectionId: next.connectionId,
				sequence: 2,
				replace: [message("replacement")],
			});
			const final = new ViewerStore(directory);
			expect((await final.rounds("thread/../../id", null)).rounds[0].id).toBe("replacement");
			expect(readFileSync(metadataPath, "utf8")).not.toContain(`"logId":"${metadata.logId}"`);
			expect(readdirSync(metadataDir).filter((path) => path.endsWith(".jsonl"))).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps live deltas off disk and catalog invalidation while publishing their exact state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-viewer-live-"));
		try {
			const store = new ViewerStore(directory);
			const { connectionId } = store.connect("thread");
			let catalogs = 0;
			let updates = 0;
			store.catalogListeners.add(() => {
				catalogs++;
			});
			store.subscribe("thread", () => {
				updates++;
			});
			await store.update({
				sessionId: "thread",
				connectionId,
				sequence: 1,
				cwd: "/work",
				title: "Title",
				replace: [],
				status: "running",
			});
			const metadataDir = join(directory, ".viewer", "threads");
			const path = join(metadataDir, readdirSync(metadataDir).find((path) => path.endsWith(".json")) ?? "missing");
			const initial = readFileSync(path, "utf8");
			await store.update({
				sessionId: "thread",
				connectionId,
				sequence: 2,
				cwd: "/work",
				title: "Title",
				status: "running",
				live: { message: message("thinking", "assistant"), tools: [] },
			});
			expect(readFileSync(path, "utf8")).toBe(initial);
			expect(catalogs).toBe(1);
			expect(updates).toBe(2);
			expect(store.get("thread")?.live.message?.id).toBe("thinking");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
