import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllSessions, replaceSessionTree, switchSessionLeaf } from "../src/session-store.ts";
import { ViewerHttp } from "../src/viewer-http.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerMessage, ViewerUpdate } from "../src/viewer-types.ts";

const user: ViewerMessage = { id: "round", role: "user", timestamp: 1, content: "Inspect" };
const tool: ViewerMessage = {
	id: "tool",
	role: "toolResult",
	timestamp: 2,
	content: [{ type: "text", text: "结果🙂".repeat(10000) }],
	errorMessage: "Execution failed",
};
const bash: ViewerMessage = { id: "bash", role: "bashExecution", timestamp: 3, content: "shell output" };

describe("viewer committed message details", () => {
	let directory: string;
	beforeEach(() => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-details-"));
	});
	afterEach(() => {
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("defers tool content in snapshots and appends while retaining full persisted content across restart", async () => {
		const store = new ViewerStore(directory);
		const connection = store.connect("thread");
		const updates: ViewerUpdate[] = [];
		store.subscribe("thread", (update) => updates.push(update));
		await store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/project",
			replace: [user, tool],
		});
		await store.update({ sessionId: "thread", connectionId: connection.connectionId, sequence: 2, append: [bash] });
		expect(updates[0]).toMatchObject({
			rounds: [{ messages: [user, { ...tool, content: [], contentDeferred: true }] }],
		});
		expect(updates[1]).toMatchObject({ append: [{ ...bash, content: [], contentDeferred: true }] });
		expect((await store.rounds("thread", null)).rounds[0].messages).toEqual([
			user,
			{ ...tool, content: [], contentDeferred: true },
			{ ...bash, content: [], contentDeferred: true },
		]);
		expect(await store.message("thread", "round", "tool")).toEqual(tool);
		const logDirectory = join(directory, ".viewer", "threads");
		const log = readdirSync(logDirectory).find((name) => name.endsWith(".jsonl"))!;
		expect(
			readFileSync(join(logDirectory, log), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([user, tool, bash]);
		expect(await new ViewerStore(directory).message("thread", "round", "tool")).toEqual(tool);
		expect(Buffer.byteLength(JSON.stringify(await store.rounds("thread", null)))).toBeLessThan(1000);
		expect(await store.message("thread", "other-round", "tool")).toBeUndefined();
		expect(await store.message("thread", "round", "missing")).toBeUndefined();
		await store.update({ sessionId: "thread", connectionId: connection.connectionId, sequence: 3, replace: [user] });
		expect(await store.message("thread", "round", "tool")).toBeUndefined();
		await store.remove("thread");
		expect(await store.message("thread", "round", "round")).toBeUndefined();
	});

	it("retrieves archived details only from their current branch and round, with slim refresh snapshots", async () => {
		const entry = (message: ViewerMessage, parentId: string | null): SessionTreeEntry => ({
			type: "message",
			id: message.id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message:
				message.role === "user"
					? { role: "user", content: String(message.content), timestamp: message.timestamp }
					: {
							role: "toolResult",
							toolCallId: "call",
							toolName: "read",
							content: [{ type: "text", text: "结果🙂".repeat(10000) }],
							isError: true,
							timestamp: message.timestamp,
						},
		});
		replaceSessionTree(
			"archive",
			[entry(user, null), entry(tool, "round"), entry({ ...user, id: "other" }, "round")],
			"tool",
		);
		const store = new ViewerStore(directory);
		const updates: ViewerUpdate[] = [];
		store.subscribe("archive", (update) => updates.push(update));
		await store.refreshSession("archive");
		expect(updates[0]).toMatchObject({
			rounds: [{ messages: [user, { id: "tool", content: [], contentDeferred: true }] }],
		});
		expect((await store.message("archive", "round", "tool"))?.content).toEqual(tool.content);
		expect(await store.message("archive", "other", "tool")).toBeUndefined();
		switchSessionLeaf("archive", "other");
		expect(await store.message("archive", "round", "tool")).toBeUndefined();
	});

	it("requires viewer authentication and returns 404 for missing detail identities", async () => {
		const viewer = new ViewerHttp(
			{ host: "127.0.0.1", port: 0, sessionStoreDir: directory, uploadDir: directory, authToken: "test-details" },
			async () => ({ deletedIds: [], deletedCount: 0, failed: [] }),
		);
		const connection = viewer.store.connect("thread");
		await viewer.store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/project",
			replace: [user, tool],
		});
		const server = createServer((req, res) => {
			void viewer.handle(req, res, new URL(req.url!, `http://${req.headers.host}`));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address");
		const base = `http://127.0.0.1:${address.port}`;
		try {
			const path = "/viewer/api/threads/thread/rounds/round/messages/tool";
			expect((await fetch(base + path)).status).toBe(401);
			const login = await fetch(`${base}/viewer/login`, {
				method: "POST",
				headers: { Origin: base, Authorization: "Bearer test-details" },
			});
			const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0] };
			expect(await (await fetch(base + path, { headers })).json()).toEqual({ message: tool });
			for (const path of [
				"missing/rounds/round/messages/tool",
				"thread/rounds/missing/messages/tool",
				"thread/rounds/round/messages/missing",
			])
				expect((await fetch(`${base}/viewer/api/threads/${path}`, { headers })).status).toBe(404);
		} finally {
			viewer.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
