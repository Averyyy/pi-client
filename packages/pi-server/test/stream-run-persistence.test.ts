import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	STREAM_RUN_RESTART_ERROR_EVENT,
	STREAM_RUN_RESTART_ERROR_MESSAGE,
	StreamRunConflictError,
	StreamRunCorruptionError,
	type StreamRunEventFrame,
	StreamRunPersistence,
	type StreamRunPersistenceOptions,
	StreamRunPersistenceTimeoutError,
	StreamRunQuotaError,
	StreamRunStateError,
	StreamRunStoreLockedError,
} from "../src/stream-run-persistence.ts";

const JOURNAL_HEADER_BYTES = 8;
const FRAME_HEADER_BYTES = 82;

function requestMac(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function collectEvents(
	store: StreamRunPersistence,
	sessionId: string,
	runId: string,
	fromSeq = 0,
): Promise<StreamRunEventFrame[]> {
	const events: StreamRunEventFrame[] = [];
	for await (const event of store.iterateEvents(sessionId, runId, fromSeq)) {
		events.push(event);
	}
	return events;
}

async function onlyRunDirectory(rootDir: string): Promise<string> {
	const entries = await readdir(rootDir, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
	expect(directories).toHaveLength(1);
	return join(rootDir, directories[0].name);
}

async function readAllFiles(directory: string): Promise<Buffer> {
	const contents: Buffer[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			contents.push(await readAllFiles(path));
		} else {
			contents.push(await readFile(path));
		}
	}
	return Buffer.concat(contents);
}

describe("StreamRunPersistence", () => {
	let tempDir: string;
	let stores: StreamRunPersistence[];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-server-stream-runs-"));
		stores = [];
	});

	afterEach(async () => {
		await Promise.allSettled(stores.map((store) => store.close()));
		await rm(tempDir, { recursive: true, force: true });
	});

	async function createStore(options: Partial<StreamRunPersistenceOptions> = {}): Promise<StreamRunPersistence> {
		const store = new StreamRunPersistence({
			rootDir: tempDir,
			acknowledgedTtlMs: Number.POSITIVE_INFINITY,
			...options,
		});
		await store.initialize();
		stores.push(store);
		return store;
	}

	it("serializes concurrent appends, replays from a sequence, and preserves a terminal run across restart", async () => {
		const store = await createStore();
		const mac = requestMac("request-one");
		await store.begin({ sessionId: "session-one", runId: "run-one", requestMac: mac });

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.appendEvent({
					sessionId: "session-one",
					runId: "run-one",
					event: `event-${index}`,
				}),
			),
		);
		const settled = await store.settle({
			sessionId: "session-one",
			runId: "run-one",
			status: "completed",
			event: "done",
			result: { role: "assistant", content: "complete" },
			expectedSeq: 20,
		});

		expect(settled).toMatchObject({ status: "completed", nextSeq: 21 });
		expect((await collectEvents(store, "session-one", "run-one", 17)).map((frame) => frame.seq)).toEqual([
			17, 18, 19, 20,
		]);

		await store.close();
		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			terminalTtlMs: Number.POSITIVE_INFINITY,
			acknowledgedTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(reopened);
		const recovery = await reopened.initialize();
		expect(recovery.recoveredRunning).toEqual([]);
		expect(recovery.repairedTerminalMetadata).toEqual([]);
		expect(await reopened.get("session-one", "run-one")).toMatchObject({
			status: "completed",
			nextSeq: 21,
			terminal: { event: "done", result: { role: "assistant", content: "complete" } },
		});
		expect(await reopened.begin({ sessionId: "session-one", runId: "run-one", requestMac: mac })).toMatchObject({
			status: "completed",
		});
		await expect(
			reopened.begin({
				sessionId: "session-one",
				runId: "run-one",
				requestMac: requestMac("different-request"),
			}),
		).rejects.toBeInstanceOf(StreamRunConflictError);

		const idempotentTerminal = await reopened.settle({
			sessionId: "session-one",
			runId: "run-one",
			status: "completed",
			event: "done",
			result: { role: "assistant", content: "complete" },
			expectedSeq: 20,
		});
		expect(idempotentTerminal.nextSeq).toBe(21);
	});

	it("fails closed when one filesystem step makes no progress and never retries the unknown write", async () => {
		let stallWrites = false;
		let writeAttempts = 0;
		const fatalErrors: StreamRunPersistenceTimeoutError[] = [];
		const store = await createStore({
			ioNoProgressTimeoutMs: 20,
			faultInjector: (point) => {
				if (point !== "journal_before_write" || !stallWrites) return;
				writeAttempts++;
				return new Promise<void>((resolve) => setTimeout(resolve, 40));
			},
			onFatalError: (error) => fatalErrors.push(error),
		});
		await store.begin({
			sessionId: "stalled-write",
			runId: "stalled-run",
			requestMac: requestMac("stalled-write"),
		});
		stallWrites = true;

		await expect(
			store.appendEvent({
				sessionId: "stalled-write",
				runId: "stalled-run",
				event: "must-not-be-retried",
			}),
		).rejects.toBeInstanceOf(StreamRunPersistenceTimeoutError);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(writeAttempts).toBe(1);
		expect(fatalErrors).toHaveLength(1);
		await expect(store.get("stalled-write", "stalled-run")).rejects.toBe(fatalErrors[0]);
		expect(writeAttempts).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	});

	it("appends a bounded batch with continuous sequence and hash-chain recovery", async () => {
		const store = await createStore();
		await store.begin({
			sessionId: "session-batch",
			runId: "run-batch",
			requestMac: requestMac("batch"),
		});

		const batch = await store.appendEvents({
			sessionId: "session-batch",
			runId: "run-batch",
			events: ["start", "delta-one", "delta-two"],
			expectedSeq: 0,
		});
		expect(batch).toEqual([
			{ kind: "event", seq: 0, event: "start" },
			{ kind: "event", seq: 1, event: "delta-one" },
			{ kind: "event", seq: 2, event: "delta-two" },
		]);
		await expect(
			store.appendEvents({
				sessionId: "session-batch",
				runId: "run-batch",
				events: ["wrong-sequence"],
				expectedSeq: 2,
			}),
		).rejects.toBeInstanceOf(StreamRunConflictError);
		await store.appendEvent({
			sessionId: "session-batch",
			runId: "run-batch",
			event: "single",
			expectedSeq: 3,
		});
		await store.settle({
			sessionId: "session-batch",
			runId: "run-batch",
			status: "completed",
			event: "done",
			expectedSeq: 4,
		});

		await store.close();
		const reopened = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(reopened);
		await reopened.initialize();
		expect(await collectEvents(reopened, "session-batch", "run-batch", 1)).toEqual([
			{ kind: "event", seq: 1, event: "delta-one" },
			{ kind: "event", seq: 2, event: "delta-two" },
			{ kind: "event", seq: 3, event: "single" },
			expect.objectContaining({ kind: "terminal", seq: 4, event: "done", status: "completed" }),
		]);
	});

	it("turns startup running records into durable failed terminals without a provider retry path", async () => {
		let now = 100;
		const first = await createStore({ now: () => now });
		const mac = requestMac("interrupted-request");
		await first.begin({ sessionId: "session-restart", runId: "run-restart", requestMac: mac });
		await first.appendEvent({
			sessionId: "session-restart",
			runId: "run-restart",
			event: "partial",
		});

		now = 200;
		await first.close();
		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			now: () => now,
			terminalTtlMs: Number.POSITIVE_INFINITY,
			acknowledgedTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(reopened);
		const recovery = await reopened.initialize();

		expect(recovery.recoveredRunning).toHaveLength(1);
		expect(recovery.recoveredRunning[0]).toMatchObject({
			status: "failed",
			terminal: {
				event: STREAM_RUN_RESTART_ERROR_EVENT,
				errorMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
				settledAt: 200,
			},
		});
		expect(await collectEvents(reopened, "session-restart", "run-restart")).toEqual([
			{ kind: "event", seq: 0, event: "partial" },
			{
				kind: "terminal",
				seq: 1,
				event: STREAM_RUN_RESTART_ERROR_EVENT,
				status: "failed",
				errorMessage: STREAM_RUN_RESTART_ERROR_MESSAGE,
				settledAt: 200,
			},
		]);
		expect(
			await reopened.begin({
				sessionId: "session-restart",
				runId: "run-restart",
				requestMac: mac,
			}),
		).toMatchObject({ status: "failed", nextSeq: 2 });
	});

	it("truncates an incomplete tail frame and then durably fails the interrupted run", async () => {
		const first = await createStore();
		await first.begin({
			sessionId: "session-tail",
			runId: "run-tail",
			requestMac: requestMac("tail"),
		});
		await first.appendEvent({ sessionId: "session-tail", runId: "run-tail", event: "preserved" });
		await first.appendEvent({ sessionId: "session-tail", runId: "run-tail", event: "torn-event" });
		const eventsPath = join(await onlyRunDirectory(tempDir), "events.bin");
		const before = await stat(eventsPath);
		await truncate(eventsPath, before.size - 5);

		await first.close();
		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			terminalTtlMs: Number.POSITIVE_INFINITY,
			acknowledgedTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(reopened);
		const recovery = await reopened.initialize();

		expect(recovery.truncatedTails).toEqual([{ sessionId: "session-tail", runId: "run-tail" }]);
		expect(recovery.recoveredRunning).toHaveLength(1);
		const frames = await collectEvents(reopened, "session-tail", "run-tail");
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual({ kind: "event", seq: 0, event: "preserved" });
		expect(frames[1]).toMatchObject({ kind: "terminal", seq: 1, status: "failed" });
		expect(JSON.stringify(frames)).not.toContain("torn-event");
	});

	it("fails startup explicitly when a complete middle frame is corrupted", async () => {
		const first = await createStore();
		await first.begin({
			sessionId: "session-corrupt",
			runId: "run-corrupt",
			requestMac: requestMac("corrupt"),
		});
		await first.appendEvent({ sessionId: "session-corrupt", runId: "run-corrupt", event: "first" });
		await first.appendEvent({ sessionId: "session-corrupt", runId: "run-corrupt", event: "second" });
		const eventsPath = join(await onlyRunDirectory(tempDir), "events.bin");
		const encoded = await readFile(eventsPath);
		encoded[JOURNAL_HEADER_BYTES + FRAME_HEADER_BYTES] ^= 0xff;
		await writeFile(eventsPath, encoded);

		await first.close();
		const reopened = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(reopened);
		await expect(reopened.initialize()).rejects.toBeInstanceOf(StreamRunCorruptionError);
	});

	it("repairs terminal metadata from the durable terminal frame", async () => {
		const first = await createStore();
		await first.begin({
			sessionId: "session-meta",
			runId: "run-meta",
			requestMac: requestMac("metadata"),
		});
		await first.settle({
			sessionId: "session-meta",
			runId: "run-meta",
			status: "completed",
			event: "terminal-event",
			result: { answer: 42 },
		});
		const runDirectory = await onlyRunDirectory(tempDir);
		const metadataFiles = (await readdir(runDirectory)).filter((name) => name.startsWith("meta-")).sort();
		expect(metadataFiles).toHaveLength(2);
		await unlink(join(runDirectory, metadataFiles[1]));

		await first.close();
		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			terminalTtlMs: Number.POSITIVE_INFINITY,
			acknowledgedTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(reopened);
		const recovery = await reopened.initialize();

		expect(recovery.repairedTerminalMetadata).toHaveLength(1);
		expect(await reopened.get("session-meta", "run-meta")).toMatchObject({
			status: "completed",
			terminal: { event: "terminal-event", result: { answer: 42 } },
		});
		expect((await readdir(runDirectory)).filter((name) => name.startsWith("meta-")).sort()).toHaveLength(2);
	});

	it("rejects unacknowledged terminal TTLs and prunes only acknowledged runs", async () => {
		let now = 0;
		expect(
			() =>
				new StreamRunPersistence({
					rootDir: join(tempDir, "invalid-ttl"),
					terminalTtlMs: 100,
				}),
		).toThrow("terminalTtlMs must be Infinity");
		const store = await createStore({
			now: () => now,
			acknowledgedTtlMs: 20,
		});
		await store.begin({ sessionId: "session-ack", runId: "run-ack", requestMac: requestMac("ack") });
		await store.settle({
			sessionId: "session-ack",
			runId: "run-ack",
			status: "completed",
			event: "done",
		});
		now = 50;
		const acknowledged = await store.acknowledge("session-ack", "run-ack");
		expect(acknowledged.acknowledgedAt).toBe(50);
		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			now: () => now,
			acknowledgedTtlMs: 20,
		});
		await store.close();
		stores.push(reopened);
		await reopened.initialize();
		expect(await reopened.get("session-ack", "run-ack")).toMatchObject({ acknowledgedAt: 50 });
		now = 69;
		expect(await reopened.prune()).toEqual([]);
		now = 70;
		expect(await reopened.prune()).toEqual([
			expect.objectContaining({ sessionId: "session-ack", runId: "run-ack", reason: "ttl" }),
		]);
		expect(await reopened.get("session-ack", "run-ack")).toBeUndefined();

		await reopened.begin({
			sessionId: "session-delete",
			runId: "run-delete",
			requestMac: requestMac("delete"),
		});
		await expect(reopened.delete("session-delete", "run-delete")).rejects.toBeInstanceOf(StreamRunStateError);
		await reopened.settle({
			sessionId: "session-delete",
			runId: "run-delete",
			status: "completed",
			event: "done",
		});
		expect(await reopened.delete("session-delete", "run-delete")).toBe(true);
		expect(await reopened.delete("session-delete", "run-delete")).toBe(false);
	});

	it("rolls back only a pristine durable begin", async () => {
		const store = await createStore();
		const pristineInput = {
			sessionId: "session-rollback",
			runId: "pristine-run",
			requestMac: requestMac("pristine"),
		};
		await store.begin(pristineInput);
		await store.rollbackUnstartedBegin(pristineInput);
		expect(await store.get(pristineInput.sessionId, pristineInput.runId)).toBeUndefined();

		const startedInput = {
			sessionId: "session-rollback",
			runId: "started-run",
			requestMac: requestMac("started"),
		};
		await store.begin(startedInput);
		await store.appendEvent({
			sessionId: startedInput.sessionId,
			runId: startedInput.runId,
			event: "provider-event",
		});
		await expect(store.rollbackUnstartedBegin(startedInput)).rejects.toBeInstanceOf(StreamRunStateError);
		expect(await store.get(startedInput.sessionId, startedInput.runId)).toMatchObject({
			status: "running",
			nextSeq: 1,
		});
	});

	it("reserves per-run space for a terminal frame", async () => {
		const store = await createStore({
			maxFrameBytes: 1024,
			maxRunBytes: 2800,
			maxTotalBytes: 10_000,
			terminalReserveBytes: 700,
		});
		await store.begin({
			sessionId: "session-run-quota",
			runId: "run-quota",
			requestMac: requestMac("run-quota"),
		});
		await store.appendEvent({
			sessionId: "session-run-quota",
			runId: "run-quota",
			event: "x".repeat(800),
		});
		await expect(
			store.appendEvent({
				sessionId: "session-run-quota",
				runId: "run-quota",
				event: "y".repeat(400),
			}),
		).rejects.toBeInstanceOf(StreamRunQuotaError);
		await expect(
			store.settle({
				sessionId: "session-run-quota",
				runId: "run-quota",
				status: "failed",
				event: "terminal",
				errorMessage: "journal quota reached",
			}),
		).resolves.toMatchObject({ status: "failed" });
	});

	it("retains running and unacknowledged terminal records until an acknowledged record is evictable", async () => {
		let now = 0;
		const countLimited = await createStore({ maxRuns: 1, now: () => now });
		await countLimited.begin({
			sessionId: "session-count",
			runId: "run-one",
			requestMac: requestMac("count-one"),
		});
		await expect(
			countLimited.begin({
				sessionId: "session-count-two",
				runId: "run-two",
				requestMac: requestMac("count-two"),
			}),
		).rejects.toBeInstanceOf(StreamRunQuotaError);
		await countLimited.settle({
			sessionId: "session-count",
			runId: "run-one",
			status: "completed",
			event: "done",
		});
		now = 365 * 24 * 60 * 60 * 1000;
		expect(await countLimited.prune()).toEqual([]);
		await expect(
			countLimited.begin({
				sessionId: "session-count-two",
				runId: "run-two",
				requestMac: requestMac("count-two"),
			}),
		).rejects.toBeInstanceOf(StreamRunQuotaError);
		const unacknowledged = await countLimited.get("session-count", "run-one");
		expect(unacknowledged).toMatchObject({ status: "completed" });
		expect(unacknowledged?.acknowledgedAt).toBeUndefined();
		await countLimited.acknowledge("session-count", "run-one");
		await expect(
			countLimited.begin({
				sessionId: "session-count-two",
				runId: "run-two",
				requestMac: requestMac("count-two"),
			}),
		).resolves.toMatchObject({ status: "running" });
		expect(await countLimited.get("session-count", "run-one")).toBeUndefined();

		const byteRoot = await mkdtemp(join(tmpdir(), "pi-server-stream-byte-quota-"));
		try {
			const byteLimited = new StreamRunPersistence({
				rootDir: byteRoot,
				maxTotalBytes: 1600,
				terminalReserveBytes: 512,
				terminalTtlMs: Number.POSITIVE_INFINITY,
				acknowledgedTtlMs: Number.POSITIVE_INFINITY,
			});
			await byteLimited.initialize();
			stores.push(byteLimited);
			await byteLimited.begin({
				sessionId: "session-bytes",
				runId: "run-one",
				requestMac: requestMac("bytes-one"),
			});
			await expect(
				byteLimited.begin({
					sessionId: "session-bytes-two",
					runId: "run-two",
					requestMac: requestMac("bytes-two"),
				}),
			).rejects.toBeInstanceOf(StreamRunQuotaError);
			expect(await byteLimited.get("session-bytes", "run-one")).toMatchObject({ status: "running" });
			await byteLimited.close();
		} finally {
			await rm(byteRoot, { recursive: true, force: true });
		}
	});

	it("fails startup quota enforcement without deleting unacknowledged terminal runs", async () => {
		const first = await createStore({ maxRuns: 2 });
		for (const runId of ["run-one", "run-two"]) {
			await first.begin({
				sessionId: `session-startup-quota-${runId}`,
				runId,
				requestMac: requestMac(runId),
			});
			await first.settle({
				sessionId: `session-startup-quota-${runId}`,
				runId,
				status: "completed",
				event: `done-${runId}`,
			});
		}

		await first.close();
		const constrained = new StreamRunPersistence({
			rootDir: tempDir,
			maxRuns: 1,
			terminalTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(constrained);
		await expect(constrained.initialize()).rejects.toBeInstanceOf(StreamRunQuotaError);

		const verified = new StreamRunPersistence({
			rootDir: tempDir,
			maxRuns: 2,
			terminalTtlMs: Number.POSITIVE_INFINITY,
		});
		stores.push(verified);
		await verified.initialize();
		expect((await verified.list()).map((run) => run.runId).sort()).toEqual(["run-one", "run-two"]);
	});

	it("persists only the caller-provided request MAC, not request bodies or credentials", async () => {
		const store = await createStore();
		const requestSecret = "request-body-secret-4a7c";
		const credentialSecret = "authorization-secret-91de";
		const inputWithExtraSecrets = {
			sessionId: "session-secret",
			runId: "run-secret",
			requestMac: requestMac("secret-request"),
			requestBody: { prompt: requestSecret },
			authorization: `Bearer ${credentialSecret}`,
		};

		await store.begin(inputWithExtraSecrets);
		await store.appendEvent({ sessionId: "session-secret", runId: "run-secret", event: "safe event" });
		await store.settle({
			sessionId: "session-secret",
			runId: "run-secret",
			status: "completed",
			event: "done",
			result: { content: "safe result" },
		});

		const persisted = (await readAllFiles(tempDir)).toString("utf-8");
		expect(persisted).not.toContain(requestSecret);
		expect(persisted).not.toContain(credentialSecret);
		expect(persisted).toContain(inputWithExtraSecrets.requestMac);
	});

	it("requires a SHA-256 request MAC and bounds batch count and bytes before allocation", async () => {
		const store = await createStore({ maxBatchEvents: 2, maxBatchBytes: 8 });
		await expect(store.begin({ sessionId: "strict-mac", runId: "bad", requestMac: "not-a-digest" })).rejects.toThrow(
			"lowercase 64-character SHA-256",
		);
		await store.begin({
			sessionId: "bounded-batch",
			runId: "bounded",
			requestMac: requestMac("bounded"),
		});
		await expect(
			store.appendEvents({
				sessionId: "bounded-batch",
				runId: "bounded",
				events: ["one", "two", "three"],
			}),
		).rejects.toThrow("maxBatchEvents");
		await expect(
			store.appendEvents({
				sessionId: "bounded-batch",
				runId: "bounded",
				events: ["12345", "6789"],
			}),
		).rejects.toThrow("maxBatchBytes");
		expect(await store.get("bounded-batch", "bounded")).toMatchObject({ nextSeq: 0 });
	});

	it("linearizes concurrent begins and permits the next run only after acknowledgement", async () => {
		const store = await createStore();
		const attempts = await Promise.allSettled([
			store.begin({
				sessionId: "single-flight-session",
				runId: "run-a",
				requestMac: requestMac("run-a"),
			}),
			store.begin({
				sessionId: "single-flight-session",
				runId: "run-b",
				requestMac: requestMac("run-b"),
			}),
		]);
		expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: expect.any(StreamRunConflictError) });

		const winningRunId = attempts[0].status === "fulfilled" ? "run-a" : "run-b";
		const losingRunId = winningRunId === "run-a" ? "run-b" : "run-a";
		await store.settle({
			sessionId: "single-flight-session",
			runId: winningRunId,
			status: "completed",
			event: "done",
		});
		await expect(
			store.begin({
				sessionId: "single-flight-session",
				runId: losingRunId,
				requestMac: requestMac(losingRunId),
			}),
		).rejects.toBeInstanceOf(StreamRunConflictError);
		await store.acknowledge("single-flight-session", winningRunId);
		await expect(
			store.begin({
				sessionId: "single-flight-session",
				runId: losingRunId,
				requestMac: requestMac(losingRunId),
			}),
		).resolves.toMatchObject({ status: "running" });
	});

	it("holds an exclusive cross-process store lock and releases it on close", async () => {
		const store = await createStore();
		const second = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(second);
		await expect(second.initialize()).rejects.toBeInstanceOf(StreamRunStoreLockedError);

		const loaderPath = pathToFileURL(
			join(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "loader.mjs"),
		).href;
		const sourceUrl = pathToFileURL(join(process.cwd(), "src", "stream-run-persistence.ts")).href;
		const childScript = `
			import { StreamRunPersistence } from ${JSON.stringify(sourceUrl)};
			const store = new StreamRunPersistence({ rootDir: ${JSON.stringify(tempDir)} });
			try {
				await store.initialize();
				process.stdout.write("UNEXPECTED_LOCK_SUCCESS");
				await store.close();
			} catch (error) {
				process.stdout.write(error?.name ?? String(error));
			}
		`;
		const childOutput = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild) => {
			const child = spawn(process.execPath, ["--import", loaderPath, "--input-type=module", "--eval", childScript], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf-8");
			child.stderr.setEncoding("utf-8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("close", (code) => resolveChild({ code, stdout, stderr }));
		});
		expect(childOutput).toEqual({
			code: 0,
			stdout: "StreamRunStoreLockedError",
			stderr: "",
		});

		await store.close();
		const afterClose = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(afterClose);
		await expect(afterClose.initialize()).resolves.toBeDefined();
	});

	it("lets SQLite release the exclusive lock automatically after the owner process exits", async () => {
		const loaderPath = pathToFileURL(
			join(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "loader.mjs"),
		).href;
		const sourceUrl = pathToFileURL(join(process.cwd(), "src", "stream-run-persistence.ts")).href;
		const childScript = `
			import { StreamRunPersistence } from ${JSON.stringify(sourceUrl)};
			const store = new StreamRunPersistence({ rootDir: ${JSON.stringify(tempDir)} });
			await store.initialize();
			process.stdout.write("LOCK_HELD\\n");
			setInterval(() => {}, 1000);
		`;
		const child = spawn(process.execPath, ["--import", loaderPath, "--input-type=module", "--eval", childScript], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		let stderr = "";
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		try {
			await new Promise<void>((resolveReady, rejectReady) => {
				const timeout = setTimeout(() => rejectReady(new Error(`child lock timeout: ${stderr}`)), 5000);
				child.stdout.once("data", (chunk: string) => {
					clearTimeout(timeout);
					if (!chunk.includes("LOCK_HELD")) {
						rejectReady(new Error(`unexpected child output: ${chunk}`));
						return;
					}
					resolveReady();
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					rejectReady(new Error(`child exited before locking (${code}): ${stderr}`));
				});
			});

			const contender = new StreamRunPersistence({ rootDir: tempDir });
			stores.push(contender);
			await expect(contender.initialize()).rejects.toBeInstanceOf(StreamRunStoreLockedError);
		} finally {
			child.kill();
			await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
		}

		const recovered = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(recovered);
		await expect(recovered.initialize()).resolves.toBeDefined();
	});

	it("rolls back every journal write and fsync fault without poisoning later appends", async () => {
		let activeFault: string | undefined;
		const store = await createStore({
			faultInjector: (point) => {
				if (point !== activeFault) return;
				activeFault = undefined;
				throw new Error(`fault:${point}`);
			},
		});
		await store.begin({
			sessionId: "append-faults",
			runId: "fault-run",
			requestMac: requestMac("append-faults"),
		});

		for (const point of [
			"journal_before_write",
			"journal_after_partial_write",
			"journal_before_sync",
			"journal_after_sync",
		] as const) {
			activeFault = point;
			await expect(
				store.appendEvent({
					sessionId: "append-faults",
					runId: "fault-run",
					event: `failed-${point}`,
				}),
			).rejects.toThrow(`fault:${point}`);
			const beforeRetry = await store.get("append-faults", "fault-run");
			await store.appendEvent({
				sessionId: "append-faults",
				runId: "fault-run",
				event: `committed-${point}`,
				expectedSeq: beforeRetry?.nextSeq,
			});
		}
		await store.settle({
			sessionId: "append-faults",
			runId: "fault-run",
			status: "completed",
			event: "done",
			expectedSeq: 4,
		});
		await store.close();

		const reopened = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(reopened);
		await reopened.initialize();
		const replayed = await collectEvents(reopened, "append-faults", "fault-run");
		expect(replayed).toHaveLength(5);
		expect(JSON.stringify(replayed)).not.toContain("failed-journal");
	});

	it("recovers online from terminal metadata failure and retries Windows EPERM rename with a bound", async () => {
		let failMetadata = false;
		let renameFailuresRemaining = 0;
		let renameAttempts = 0;
		const store = await createStore({
			faultInjector: (point) => {
				if (point === "metadata_before_sync" && failMetadata) {
					throw new Error("metadata sync fault");
				}
				if (point === "metadata_before_rename" && renameFailuresRemaining > 0) {
					renameFailuresRemaining--;
					renameAttempts++;
					const error = new Error("simulated EPERM") as Error & { code: string };
					error.code = "EPERM";
					throw error;
				}
				if (point === "metadata_before_rename") renameAttempts++;
			},
		});
		await store.begin({
			sessionId: "metadata-recovery",
			runId: "metadata-run",
			requestMac: requestMac("metadata-recovery"),
		});
		failMetadata = true;
		await expect(
			store.settle({
				sessionId: "metadata-recovery",
				runId: "metadata-run",
				status: "completed",
				event: "done",
				result: { answer: 42 },
			}),
		).rejects.toThrow("metadata sync fault");
		expect(await store.get("metadata-recovery", "metadata-run")).toMatchObject({
			status: "completed",
			terminal: { result: { answer: 42 } },
		});

		failMetadata = false;
		renameFailuresRemaining = 2;
		renameAttempts = 0;
		await expect(
			store.settle({
				sessionId: "metadata-recovery",
				runId: "metadata-run",
				status: "completed",
				event: "done",
				result: { answer: 42 },
			}),
		).resolves.toMatchObject({ status: "completed" });
		expect(renameAttempts).toBe(3);
	});

	it("retries transient Windows run-directory removal failures without deleting outside the store", async () => {
		const outsideSentinel = `${tempDir}-outside-sentinel`;
		await writeFile(outsideSentinel, "preserved");
		try {
			const transientCodes = ["EPERM", "EBUSY", "EACCES"];
			let removeAttempts = 0;
			const store = await createStore({
				faultInjector: (point) => {
					if (point !== "delete_before_remove") return;
					const code = transientCodes[removeAttempts];
					removeAttempts++;
					if (!code) return;
					const error = new Error(`simulated ${code}`) as Error & { code: string };
					error.code = code;
					throw error;
				},
			});
			await store.begin({
				sessionId: "remove-retry",
				runId: "remove-retry-run",
				requestMac: requestMac("remove-retry"),
			});
			await store.settle({
				sessionId: "remove-retry",
				runId: "remove-retry-run",
				status: "completed",
				event: "done",
			});

			await expect(store.delete("remove-retry", "remove-retry-run")).resolves.toBe(true);
			expect(removeAttempts).toBe(4);
			expect(await readFile(outsideSentinel, "utf-8")).toBe("preserved");
			expect(await readdir(tempDir)).not.toEqual([]);
		} finally {
			await rm(outsideSentinel, { force: true });
		}
	});

	it("bounds run-directory removal retries and preserves state after failure", async () => {
		let failureCode: string | undefined = "EPERM";
		let removeAttempts = 0;
		const store = await createStore({
			faultInjector: (point) => {
				if (point !== "delete_before_remove") return;
				removeAttempts++;
				if (!failureCode) return;
				const error = new Error(`simulated ${failureCode}`) as Error & { code: string };
				error.code = failureCode;
				throw error;
			},
		});
		await store.begin({
			sessionId: "remove-failure",
			runId: "remove-failure-run",
			requestMac: requestMac("remove-failure"),
		});
		await store.settle({
			sessionId: "remove-failure",
			runId: "remove-failure-run",
			status: "completed",
			event: "done",
		});
		const runDirectory = await onlyRunDirectory(tempDir);

		await expect(store.delete("remove-failure", "remove-failure-run")).rejects.toMatchObject({ code: "EPERM" });
		expect(removeAttempts).toBe(5);
		expect((await stat(runDirectory)).isDirectory()).toBe(true);
		expect(await store.get("remove-failure", "remove-failure-run")).toMatchObject({ status: "completed" });

		failureCode = "EIO";
		removeAttempts = 0;
		await expect(store.delete("remove-failure", "remove-failure-run")).rejects.toMatchObject({ code: "EIO" });
		expect(removeAttempts).toBe(1);
		expect(await store.get("remove-failure", "remove-failure-run")).toMatchObject({ status: "completed" });

		failureCode = undefined;
		removeAttempts = 0;
		await expect(store.delete("remove-failure", "remove-failure-run")).resolves.toBe(true);
		expect(removeAttempts).toBe(1);
		expect(await store.get("remove-failure", "remove-failure-run")).toBeUndefined();
	});

	it("keeps list and initial recovery lightweight while terminal results remain immutable", async () => {
		const store = await createStore();
		await store.begin({
			sessionId: "lightweight-state",
			runId: "lightweight-run",
			requestMac: requestMac("lightweight"),
		});
		await store.settle({
			sessionId: "lightweight-state",
			runId: "lightweight-run",
			status: "completed",
			event: "done",
			result: { nested: { value: 1 } },
		});
		expect((await store.list())[0]).not.toHaveProperty("terminal");
		const detailed = await store.get("lightweight-state", "lightweight-run");
		const nested = (detailed?.terminal?.result as { nested: { value: number } }).nested;
		expect(() => {
			nested.value = 2;
		}).toThrow();

		await store.close();
		const reopened = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(reopened);
		const recovery = await reopened.initialize();
		expect(recovery.runs[0]).not.toHaveProperty("terminal");
		expect(await reopened.get("lightweight-state", "lightweight-run")).toMatchObject({
			terminal: { result: { nested: { value: 1 } } },
		});
	});

	it("closes abandoned readers during flush so deletion cannot remain permanently busy", async () => {
		const store = await createStore();
		await store.begin({
			sessionId: "reader-close",
			runId: "reader-run",
			requestMac: requestMac("reader-close"),
		});
		await store.appendEvents({
			sessionId: "reader-close",
			runId: "reader-run",
			events: ["one", "two"],
		});
		await store.settle({
			sessionId: "reader-close",
			runId: "reader-run",
			status: "completed",
			event: "done",
		});
		const iterator = store.iterateEvents("reader-close", "reader-run");
		expect(await iterator.next()).toMatchObject({ done: false, value: { seq: 0 } });
		await store.flush();
		await expect(store.delete("reader-close", "reader-run")).resolves.toBe(true);
		await iterator.return(undefined);
	});

	it("persists a journal beyond 64 MiB and a terminal frame beyond 16 MiB across restart by default", async () => {
		const store = await createStore();
		const sessionId = "long-default-run";
		const runId = "large-journal";
		await store.begin({
			sessionId,
			runId,
			requestMac: requestMac("large-journal-defaults"),
		});
		const oneMiBEvent = "e".repeat(1024 * 1024);
		const events = Array.from({ length: 65 }, () => oneMiBEvent);
		await store.appendEvents({
			sessionId,
			runId,
			events,
		});
		const largeTerminalEvent = `data: ${JSON.stringify({
			type: "done",
			padding: "t".repeat(17 * 1024 * 1024),
		})}\n\n`;
		const settled = await store.settle({
			sessionId,
			runId,
			status: "completed",
			event: largeTerminalEvent,
			result: { role: "assistant", content: "complete" },
		});
		expect(settled.journalBytes).toBeGreaterThan(64 * 1024 * 1024);
		expect(Buffer.byteLength(settled.terminal?.event ?? "", "utf-8")).toBeGreaterThan(16 * 1024 * 1024);

		await store.close();
		const reopened = new StreamRunPersistence({ rootDir: tempDir });
		stores.push(reopened);
		await reopened.initialize();
		expect(await reopened.get(sessionId, runId)).toMatchObject({
			status: "completed",
			nextSeq: events.length + 1,
		});
		const replay = await collectEvents(reopened, sessionId, runId, events.length);
		expect(replay).toHaveLength(1);
		expect(replay[0]).toMatchObject({
			kind: "terminal",
			seq: events.length,
			status: "completed",
			event: largeTerminalEvent,
		});
	});

	it("replays a sparse tail after more than 100k events and 16 MiB across restart", async () => {
		const store = await createStore({
			maxBatchEvents: 4096,
			maxBatchBytes: 2 * 1024 * 1024,
			maxFrameBytes: 2 * 1024 * 1024,
			maxRunBytes: 32 * 1024 * 1024,
			maxTotalBytes: 64 * 1024 * 1024,
			terminalReserveBytes: 4096,
		});
		await store.begin({
			sessionId: "large-journal",
			runId: "large-run",
			requestMac: requestMac("large-journal"),
		});
		const eventCount = 100_100;
		for (let offset = 0; offset < eventCount; offset += 4096) {
			const count = Math.min(4096, eventCount - offset);
			await store.appendEvents({
				sessionId: "large-journal",
				runId: "large-run",
				events: Array.from({ length: count }, (_, index) => `event-${offset + index}-${"x".repeat(80)}`),
				expectedSeq: offset,
			});
		}
		const settled = await store.settle({
			sessionId: "large-journal",
			runId: "large-run",
			status: "completed",
			event: "done",
			expectedSeq: eventCount,
		});
		expect(settled.journalBytes).toBeGreaterThan(16 * 1024 * 1024);
		await store.close();

		const reopened = new StreamRunPersistence({
			rootDir: tempDir,
			maxBatchEvents: 4096,
			maxBatchBytes: 2 * 1024 * 1024,
			maxFrameBytes: 2 * 1024 * 1024,
			maxRunBytes: 32 * 1024 * 1024,
			maxTotalBytes: 64 * 1024 * 1024,
			terminalReserveBytes: 4096,
		});
		stores.push(reopened);
		await reopened.initialize();
		const startedAt = performance.now();
		const tail = await collectEvents(reopened, "large-journal", "large-run", eventCount - 10);
		const elapsedMs = performance.now() - startedAt;
		expect(tail.map((frame) => frame.seq)).toEqual([
			...Array.from({ length: 10 }, (_, index) => eventCount - 10 + index),
			eventCount,
		]);
		expect(elapsedMs).toBeLessThan(5000);
	}, 30_000);
});
