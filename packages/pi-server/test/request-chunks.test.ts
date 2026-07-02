import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
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
});
