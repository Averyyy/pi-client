import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearAllRequestChunks,
	REQUEST_CHUNK_COMPLETED_TTL_MS,
	REQUEST_CHUNK_MAX_COMPLETED_BYTES,
	REQUEST_CHUNK_MAX_PENDING_BYTES,
	REQUEST_CHUNK_PENDING_TTL_MS,
	type RequestVersion,
	receiveRequestChunk,
} from "../src/request-chunks.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function chunkBody(requestId: string, chunkIndex: number, totalChunks: number, chunk: string) {
	return {
		requestId,
		target: "/api/session/init",
		chunkIndex,
		totalChunks,
		sha256: sha256(chunk),
		chunk,
	};
}

describe("request chunks", () => {
	beforeEach(() => {
		clearAllRequestChunks();
	});

	afterEach(() => {
		clearAllRequestChunks();
		vi.useRealTimers();
	});

	it("allows up to one GiB of pending encoded request chunks", () => {
		expect(REQUEST_CHUNK_MAX_PENDING_BYTES).toBe(1024 * 1024 * 1024);
		expect(REQUEST_CHUNK_MAX_COMPLETED_BYTES).toBe(1024 * 1024 * 1024);
	});

	it("expires pending and completed requests while idle and releases the cleanup timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const encoded = Buffer.from(JSON.stringify({ text: "idle" })).toString("base64");
		const pendingFirst = chunkBody("pending-idle", 0, 2, encoded.slice(0, 4));
		const pendingLast = chunkBody("pending-idle", 1, 2, encoded.slice(4));
		const completedFirst = chunkBody("completed-idle", 0, 2, encoded.slice(0, 4));
		const completedLast = chunkBody("completed-idle", 1, 2, encoded.slice(4));
		receiveRequestChunk(pendingFirst);
		receiveRequestChunk(completedFirst);
		receiveRequestChunk(completedLast);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(REQUEST_CHUNK_COMPLETED_TTL_MS);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(REQUEST_CHUNK_PENDING_TTL_MS - REQUEST_CHUNK_COMPLETED_TTL_MS);
		expect(vi.getTimerCount()).toBe(0);
		expect(receiveRequestChunk(pendingLast)).toMatchObject({ complete: false });
		expect(receiveRequestChunk(completedLast)).toMatchObject({ complete: false });
	});

	it("clears cached requests, byte accounting and cleanup timers", () => {
		vi.useFakeTimers();
		const encoded = Buffer.from(JSON.stringify({ text: "clear" })).toString("base64");
		const first = chunkBody("clear-pending", 0, 2, encoded.slice(0, 4));
		receiveRequestChunk(first, { maxPendingBytes: first.chunk.length });
		receiveRequestChunk(chunkBody("clear-completed", 0, 1, encoded));
		expect(vi.getTimerCount()).toBe(1);
		clearAllRequestChunks();
		expect(vi.getTimerCount()).toBe(0);
		const last = chunkBody("clear-pending", 1, 2, encoded.slice(4));
		expect(receiveRequestChunk(last, { maxPendingBytes: last.chunk.length })).toMatchObject({ complete: false });
		const replacementJson = JSON.stringify({ text: "replacement" });
		const replacement = Buffer.from(replacementJson).toString("base64");
		expect(
			receiveRequestChunk(chunkBody("clear-completed", 0, 1, replacement), {
				maxCompletedBytes: Buffer.byteLength(replacementJson) + 64,
			}),
		).toMatchObject({ complete: true });
		clearAllRequestChunks();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("expires a completed request at its TTL without receiving another chunk", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const encoded = Buffer.from(JSON.stringify({ text: "complete" })).toString("base64");
		const first = chunkBody("completed-ttl", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("completed-ttl", 1, 2, encoded.slice(4));
		receiveRequestChunk(first);
		receiveRequestChunk(last);
		vi.advanceTimersByTime(REQUEST_CHUNK_COMPLETED_TTL_MS - 1);
		expect(receiveRequestChunk(last)).toMatchObject({ complete: true });
		vi.advanceTimersByTime(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(receiveRequestChunk(last)).toMatchObject({ complete: false });
	});

	it("extends the pending expiry when an identical chunk is retried", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const encoded = Buffer.from(JSON.stringify({ text: "pending" })).toString("base64");
		const first = chunkBody("pending-refresh", 0, 2, encoded.slice(0, 4));
		receiveRequestChunk(first, { pendingTtlMs: 100 });
		vi.advanceTimersByTime(50);
		receiveRequestChunk(first, { pendingTtlMs: 100 });
		vi.advanceTimersByTime(50);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(50);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("budgets completed UTF-8 bodies and checksums without retaining encoded chunks", () => {
		const bodyJson = JSON.stringify({ text: "中文" });
		const encoded = Buffer.from(bodyJson).toString("base64");
		const first = chunkBody("completed-budget", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("completed-budget", 1, 2, encoded.slice(4));
		const retainedBytes = Buffer.byteLength(bodyJson) + 2 * 64;
		receiveRequestChunk(first, { maxCompletedBytes: retainedBytes });
		const completed = receiveRequestChunk(last, { maxCompletedBytes: retainedBytes });
		expect(receiveRequestChunk(last, { maxCompletedBytes: retainedBytes })).toEqual(completed);

		clearAllRequestChunks();
		receiveRequestChunk(first, { maxCompletedBytes: retainedBytes - 1 });
		expect(() => receiveRequestChunk(last, { maxCompletedBytes: retainedBytes - 1 })).toThrow(
			"Request chunk completed bytes limit exceeded",
		);
	});

	it("evicts the oldest completed request to stay within the completed byte budget", () => {
		const bodyJson = JSON.stringify({ text: "cached" });
		const encoded = Buffer.from(bodyJson).toString("base64");
		const maxCompletedBytes = Buffer.byteLength(bodyJson) + 2 * 64;
		for (const id of ["old-completed", "new-completed"]) {
			receiveRequestChunk(chunkBody(id, 0, 2, encoded.slice(0, 4)), { maxCompletedBytes });
			receiveRequestChunk(chunkBody(id, 1, 2, encoded.slice(4)), { maxCompletedBytes });
		}
		expect(
			receiveRequestChunk(chunkBody("new-completed", 1, 2, encoded.slice(4)), { maxCompletedBytes }),
		).toMatchObject({ complete: true });
		expect(
			receiveRequestChunk(chunkBody("old-completed", 1, 2, encoded.slice(4)), { maxCompletedBytes }),
		).toMatchObject({ complete: false });
	});

	it("retains completed retries when a new request exceeds the entire completed budget", () => {
		const bodyJson = JSON.stringify({ text: "cached" });
		const encoded = Buffer.from(bodyJson).toString("base64");
		const first = chunkBody("cached-request", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("cached-request", 1, 2, encoded.slice(4));
		const maxCompletedBytes = Buffer.byteLength(bodyJson) + 2 * 64;
		receiveRequestChunk(first, { maxCompletedBytes });
		const completed = receiveRequestChunk(last, { maxCompletedBytes });
		const oversized = Buffer.from(JSON.stringify({ text: "x".repeat(maxCompletedBytes) })).toString("base64");
		expect(() => receiveRequestChunk(chunkBody("oversized-request", 0, 1, oversized), { maxCompletedBytes })).toThrow(
			"Request chunk completed bytes limit exceeded",
		);
		expect(receiveRequestChunk(last, { maxCompletedBytes })).toEqual(completed);
	});

	it("completes and retries a request larger than 64 MiB of encoded chunks", () => {
		const bodyJson = JSON.stringify({ text: "x".repeat(49 * 1024 * 1024) });
		const encoded = Buffer.from(bodyJson).toString("base64");
		expect(Buffer.byteLength(encoded)).toBeGreaterThan(64 * 1024 * 1024);
		const first = chunkBody("large-request", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("large-request", 1, 2, encoded.slice(4));
		receiveRequestChunk(first);
		const completed = receiveRequestChunk(last);
		expect(completed.complete).toBe(true);
		if (!completed.complete) throw new Error("Request did not complete");
		expect(completed.bodyJson).toBe(bodyJson);
		expect(receiveRequestChunk(last)).toEqual(completed);
	});

	it("accepts identical duplicate chunks as idempotent no-ops", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "chunk-idempotent" }), "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, 4);
		const secondChunk = encoded.slice(4);
		const firstBody = chunkBody("request-1", 0, 2, firstChunk);

		expect(receiveRequestChunk(firstBody)).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-1", chunkIndex: 0, totalChunks: 2 },
		});
		expect(receiveRequestChunk(firstBody)).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-1", chunkIndex: 0, totalChunks: 2 },
		});
		expect(receiveRequestChunk(chunkBody("request-1", 1, 2, secondChunk))).toEqual({
			complete: true,
			target: "/api/session/init",
			bodyJson: JSON.stringify({ sessionId: "chunk-idempotent" }),
			requestVersion: { version: 0 },
		});
	});

	it("rejects checksum mismatches", () => {
		expect(() =>
			receiveRequestChunk({
				...chunkBody("request-2", 0, 1, "abcd"),
				sha256: "0".repeat(64),
			}),
		).toThrow("Chunk checksum mismatch: 0");
	});

	it("rejects divergent duplicate chunk indexes", () => {
		receiveRequestChunk(chunkBody("request-3", 0, 2, "abcd"));

		expect(() => receiveRequestChunk(chunkBody("request-3", 0, 2, "wxyz"))).toThrow(
			"Duplicate chunk index does not match: 0",
		);
	});

	it("drops stale pending chunks before accepting new chunks", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "chunk-ttl" }), "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, 4);
		const secondChunk = encoded.slice(4);

		receiveRequestChunk(chunkBody("request-ttl", 0, 2, firstChunk), { nowMs: 1000, pendingTtlMs: 100 });

		expect(
			receiveRequestChunk(chunkBody("request-ttl", 1, 2, secondChunk), { nowMs: 1101, pendingTtlMs: 100 }),
		).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-ttl", chunkIndex: 1, totalChunks: 2 },
		});
		expect(
			receiveRequestChunk(chunkBody("request-ttl", 0, 2, firstChunk), { nowMs: 1102, pendingTtlMs: 100 }),
		).toEqual({
			complete: true,
			target: "/api/session/init",
			bodyJson: JSON.stringify({ sessionId: "chunk-ttl" }),
			requestVersion: { version: 0 },
		});
	});

	it("cleans old pending requests to stay under the pending byte limit", () => {
		receiveRequestChunk(chunkBody("request-old", 0, 2, "abcd"), { maxPendingBytes: 4 });

		expect(receiveRequestChunk(chunkBody("request-new", 0, 2, "wxyz"), { maxPendingBytes: 4 })).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-new", chunkIndex: 0, totalChunks: 2 },
		});
		expect(receiveRequestChunk(chunkBody("request-old", 1, 2, "efgh"), { maxPendingBytes: 8 })).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-old", chunkIndex: 1, totalChunks: 2 },
		});
	});

	it("returns the cached completed body when the completing chunk is retried", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "chunk-complete-cache" }), "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, 4);
		const secondChunk = encoded.slice(4);
		const completingChunk = chunkBody("request-completed", 1, 2, secondChunk);

		receiveRequestChunk(chunkBody("request-completed", 0, 2, firstChunk));
		const completed = receiveRequestChunk(completingChunk);

		expect(completed).toEqual({
			complete: true,
			target: "/api/session/init",
			bodyJson: JSON.stringify({ sessionId: "chunk-complete-cache" }),
			requestVersion: { version: 0 },
		});
		expect(receiveRequestChunk(completingChunk)).toEqual(completed);
	});

	it("checks every duplicate chunk after completion", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "completed-duplicates" })).toString("base64");
		const first = chunkBody("completed-duplicates", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("completed-duplicates", 1, 2, encoded.slice(4));
		receiveRequestChunk(first);
		const completed = receiveRequestChunk(last);

		expect(receiveRequestChunk(first)).toMatchObject({ complete: false });
		expect(receiveRequestChunk(last)).toEqual(completed);
		expect(() => receiveRequestChunk(chunkBody("completed-duplicates", 0, 2, "e30="))).toThrow(
			"Duplicate chunk index does not match: 0",
		);
		expect(() => receiveRequestChunk({ ...last, target: "/api/stream" })).toThrow(
			"Chunk metadata does not match the completed request",
		);
	});

	it("keeps the earliest request version through out-of-order parsing, duplicates and completed retries", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "versioned" })).toString("base64");
		const first = chunkBody("versioned", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("versioned", 1, 2, encoded.slice(4));
		const early: RequestVersion = { version: 3, deletion: { sessionId: "deleted", next: { version: 9 } } };
		receiveRequestChunk(first, { requestVersion: { version: 8 } });
		receiveRequestChunk(first, { requestVersion: early });
		const completed = receiveRequestChunk(last, { requestVersion: { version: 10 } });
		expect(completed).toMatchObject({ complete: true, requestVersion: early });
		expect(Reflect.get(completed, "requestVersion")).toBe(early);
		const replay = receiveRequestChunk(last, { requestVersion: { version: 20 } });
		expect(Reflect.get(replay, "requestVersion")).toBe(early);
	});

	it("preserves the retained checkpoint for duplicate chunks with the same version", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "same-version" })).toString("base64");
		const first = chunkBody("same-version", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("same-version", 1, 2, encoded.slice(4));
		const checkpoint: RequestVersion = { version: 3 };
		receiveRequestChunk(first, { requestVersion: checkpoint });
		checkpoint.deletion = { sessionId: "deleted", next: { version: 4 } };
		receiveRequestChunk(first, { requestVersion: { version: 3 } });
		const completed = receiveRequestChunk(last, { requestVersion: { version: 3 } });
		expect(Reflect.get(completed, "requestVersion")).toBe(checkpoint);
		expect(Reflect.get(receiveRequestChunk(last, { requestVersion: { version: 3 } }), "requestVersion")).toBe(
			checkpoint,
		);
	});

	it("retains an earlier checkpoint parsed after completion for subsequent replays", () => {
		const encoded = Buffer.from(JSON.stringify({ sessionId: "completed-checkpoint" })).toString("base64");
		const first = chunkBody("completed-checkpoint", 0, 2, encoded.slice(0, 4));
		const last = chunkBody("completed-checkpoint", 1, 2, encoded.slice(4));
		receiveRequestChunk(first, { requestVersion: { version: 8 } });
		receiveRequestChunk(last, { requestVersion: { version: 10 } });
		const early: RequestVersion = { version: 3, deletion: { sessionId: "deleted", next: { version: 9 } } };
		expect(receiveRequestChunk(first, { requestVersion: early })).toMatchObject({ complete: false });
		const replay = receiveRequestChunk(last, { requestVersion: { version: 20 } });
		expect(replay).toMatchObject({ complete: true });
		expect(Reflect.get(replay, "requestVersion")).toBe(early);
	});
});
