import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllRequestChunks, receiveRequestChunk } from "../src/request-chunks.ts";

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
		});
		expect(receiveRequestChunk(completingChunk)).toEqual(completed);
	});
});
