import { promises as fs, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions } from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("asynchronous viewer persistence", () => {
	let directory: string;
	let store: ViewerStore;
	beforeEach(() => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-async-"));
		store = new ViewerStore(directory);
	});
	afterEach(async () => {
		await store.flush();
		vi.restoreAllMocks();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("serializes reads with pending appends and preserves committed message order", async () => {
		const connection = store.connect("thread");
		await store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/fixture",
			replace: [{ id: "user", role: "user", content: "question", timestamp: 1 }],
		});
		const blocked = gate();
		const entered = gate();
		const append = fs.appendFile;
		vi.spyOn(fs, "appendFile").mockImplementation(async (path, data, options) => {
			entered.release();
			await blocked.promise;
			await append(path, data, options);
		});
		const first = store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 2,
			append: [{ id: "tool", role: "toolResult", content: "first", timestamp: 2 }],
		});
		const second = store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 3,
			append: [{ id: "answer", role: "assistant", content: "second", timestamp: 3 }],
		});
		await entered.promise;
		let readSettled = false;
		const pendingRead = store.rounds("thread", null).then((result) => {
			readSettled = true;
			return result;
		});
		const pendingMessage = store.message("thread", "user", "tool");
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(readSettled).toBe(false);
		} finally {
			blocked.release();
		}
		await Promise.all([first, second]);
		expect((await pendingRead).rounds[0].messages.map((message) => message.id)).toEqual(["user", "tool", "answer"]);
		expect((await pendingMessage)?.content).toBe("first");
		expect((await new ViewerStore(directory).message("thread", "user", "tool"))?.content).toBe("first");
	});

	it("finishes a pending replacement before deletion without recreating its files", async () => {
		const connection = store.connect("thread");
		await store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/fixture",
			replace: [{ id: "old", role: "user", content: "old", timestamp: 1 }],
		});
		const blocked = gate();
		const entered = gate();
		const write = fs.writeFile;
		vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
			if (String(path).endsWith(".jsonl")) {
				entered.release();
				await blocked.promise;
			}
			await write(path, data, options);
		});
		const replacement = store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 2,
			replace: [{ id: "new", role: "user", content: "new", timestamp: 2 }],
		});
		await entered.promise;
		const pendingRead = store.rounds("thread", null);
		const removal = store.remove("thread");
		blocked.release();
		expect((await pendingRead).rounds[0].id).toBe("new");
		await Promise.all([replacement, removal]);
		await store.flush();
		expect(store.get("thread")).toBeUndefined();
		expect(new ViewerStore(directory).get("thread")).toBeUndefined();
		expect(readdirSync(join(directory, ".viewer", "threads"))).toEqual([]);
		await expect(
			store.update({ sessionId: "thread", connectionId: connection.connectionId, sequence: 3, append: [] }),
		).rejects.toThrow("deleted");
	});

	it("continues inference during slow activity writes and drains them before close completes", async () => {
		const blocked = gate();
		const entered = gate();
		const write = fs.writeFile;
		vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
			if (String(path).includes(".viewer")) {
				entered.release();
				await blocked.promise;
			}
			await write(path, data, options);
		});
		const models = createModels();
		const message = fauxAssistantMessage("ok");
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		const provider = vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		const server = createPiServer({ authToken: "fixture", sessionStoreDir: directory }, models);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const model: Model<"fixture"> = {
			id: "fixture",
			name: "Fixture",
			api: "fixture",
			provider: "fixture",
			baseUrl: "http://fixture.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let closed = false;
		let closing: Promise<void> | undefined;
		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "activity",
					model,
					contextOverlay: [{ role: "user", content: "fixture", timestamp: 1 }],
					staticContext: { systemPrompt: "fixture" },
				}),
			});
			expect(await response.text()).toContain('"type":"done"');
			await entered.promise;
			expect(provider).toHaveBeenCalledTimes(1);
			server.closeAllConnections();
			closing = new Promise<void>((resolve) =>
				server.close(() => {
					closed = true;
					resolve();
				}),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
		} finally {
			blocked.release();
			server.closeAllConnections();
			if (closing) await closing;
			else await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		expect(new ViewerStore(directory).get("activity")?.lastActiveAt).toBeTypeOf("number");
	});

	it.each(["append", "replace"] as const)(
		"keeps the committed log after a failed %s index rename",
		async (operation) => {
			const connection = store.connect("thread");
			await store.update({
				sessionId: "thread",
				connectionId: connection.connectionId,
				sequence: 1,
				cwd: "D:/fixture",
				replace: [{ id: "old", role: "user", content: "committed", timestamp: 1 }],
			});
			vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("index rename failed"));
			await expect(
				store.update({
					sessionId: "thread",
					connectionId: connection.connectionId,
					sequence: 2,
					[operation]: [{ id: "new", role: "assistant", content: "uncommitted", timestamp: 2 }],
				}),
			).rejects.toThrow("index rename failed");
			expect((await store.rounds("thread", null)).rounds[0].messages.map((message) => message.id)).toEqual(["old"]);
			const recovered = new ViewerStore(directory);
			expect((await recovered.rounds("thread", null)).rounds[0].messages.map((message) => message.id)).toEqual([
				"old",
			]);
			expect(
				readdirSync(join(directory, ".viewer", "threads")).filter((file) => file.endsWith(".jsonl")),
			).toHaveLength(1);
		},
	);

	it("sends the committed snapshot before updates queued during its disk read", async () => {
		const connection = store.connect("thread");
		await store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 1,
			cwd: "D:/fixture",
			replace: [{ id: "old", role: "user", content: "committed", timestamp: 1 }],
		});
		const blocked = gate();
		const entered = gate();
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			entered.release();
			await blocked.promise;
			return open(path, flags, mode);
		});
		const events: string[][] = [];
		const subscription = store.subscribeWithSnapshot("thread", (update) => {
			events.push(
				update.replace
					? update.rounds.flatMap((round) => round.messages.map((message) => message.id))
					: (update.append ?? []).map((message) => message.id),
			);
		});
		await entered.promise;
		const update = store.update({
			sessionId: "thread",
			connectionId: connection.connectionId,
			sequence: 2,
			append: [{ id: "new", role: "assistant", content: "answer", timestamp: 2 }],
		});
		try {
			expect(events).toEqual([]);
		} finally {
			blocked.release();
		}
		const unsubscribe = await subscription;
		await update;
		expect(events).toEqual([["old"], ["new"]]);
		unsubscribe();
	});
});
