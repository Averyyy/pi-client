import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECEIVE_UPLOAD_MAX_DECODED_BYTES } from "../src/receive-upload.ts";
import {
	clearAllRequestChunks,
	getRequestChunkCacheStats,
	REQUEST_CHUNK_MAX_COMPLETED_BYTES,
	REQUEST_CHUNK_MAX_PENDING_BYTES,
	REQUEST_CHUNK_MAX_PENDING_COUNT,
	REQUEST_CHUNK_MAX_PENDING_METADATA_BYTES,
	REQUEST_CHUNK_MAX_REQUEST_ID_CHARS,
	REQUEST_CHUNK_MAX_TOTAL_CHUNKS,
	REQUEST_CHUNK_SEGMENT_ENCODING,
	REQUEST_CHUNK_TOMBSTONE_TTL_MS,
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

function segmentChunkBody(requestId: string, chunkIndex: number, totalChunks: number, rawChunk: Buffer) {
	const chunk = rawChunk.toString("base64");
	return {
		...chunkBody(requestId, chunkIndex, totalChunks, chunk),
		encoding: REQUEST_CHUNK_SEGMENT_ENCODING,
	};
}

function offsetChunkBody(requestId: string, chunkIndex: number, rawBody: Buffer, rawChunkBytes: number) {
	const totalChunks = Math.ceil(rawBody.byteLength / rawChunkBytes);
	const start = chunkIndex * rawChunkBytes;
	return {
		...segmentChunkBody(
			requestId,
			chunkIndex,
			totalChunks,
			rawBody.subarray(start, Math.min(start + rawChunkBytes, rawBody.byteLength)),
		),
		rawTotalBytes: rawBody.byteLength,
		rawChunkBytes,
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
			requestId: "request-1",
			replayed: false,
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

	it("rejects unbounded chunk metadata before allocating pending state", () => {
		const emptyChunk = Buffer.from("", "utf-8").toString("base64");
		const digest = sha256(emptyChunk);
		expect(() =>
			receiveRequestChunk({
				requestId: "x".repeat(REQUEST_CHUNK_MAX_REQUEST_ID_CHARS + 1),
				target: "/api/session/init",
				chunkIndex: 0,
				totalChunks: 1,
				sha256: digest,
				chunk: emptyChunk,
			}),
		).toThrow(`requestId must not exceed ${REQUEST_CHUNK_MAX_REQUEST_ID_CHARS} characters`);
		expect(() =>
			receiveRequestChunk({
				requestId: "too-many-chunks",
				target: "/api/session/init",
				chunkIndex: 0,
				totalChunks: REQUEST_CHUNK_MAX_TOTAL_CHUNKS + 1,
				sha256: digest,
				chunk: emptyChunk,
			}),
		).toThrow(`totalChunks must be an integer from 1 to ${REQUEST_CHUNK_MAX_TOTAL_CHUNKS}`);
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingBytes: 0,
			completedCount: 0,
			completedBytes: 0,
		});
	});

	it("rejects empty chunk floods without allocating pending metadata", () => {
		const emptySha256 = sha256("");
		for (let index = 0; index < 512; index++) {
			expect(() =>
				receiveRequestChunk({
					...chunkBody(`empty-${index}`, index, 1024, ""),
					sha256: emptySha256,
				}),
			).toThrow("chunk must not be empty");
		}
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingBytes: 0,
			pendingMetadataBytes: 0,
		});
	});

	it("checks a protected request's own byte and metadata footprint before evicting unrelated requests", () => {
		const oldEncoded = Buffer.from("{}", "utf-8").toString("base64");
		const oldFirst = chunkBody("protected-old", 0, 2, oldEncoded.slice(0, 2));
		const oldSecond = chunkBody("protected-old", 1, 2, oldEncoded.slice(2));
		const byteOptions = {
			maxPendingBytes: oldEncoded.length,
			maxPendingMetadataBytes: REQUEST_CHUNK_MAX_PENDING_METADATA_BYTES,
			maxPendingCount: REQUEST_CHUNK_MAX_PENDING_COUNT,
		};
		receiveRequestChunk(oldFirst, byteOptions);
		expect(() =>
			receiveRequestChunk(chunkBody("impossible-bytes", 0, 2, "x".repeat(oldEncoded.length + 1)), byteOptions),
		).toThrow("pending bytes limit exceeded");
		expect(receiveRequestChunk(oldSecond, byteOptions)).toMatchObject({ complete: true, bodyJson: "{}" });

		const metadataOptions = {
			maxPendingBytes: REQUEST_CHUNK_MAX_PENDING_BYTES,
			maxPendingMetadataBytes: 2048,
			maxPendingCount: REQUEST_CHUNK_MAX_PENDING_COUNT,
		};
		receiveRequestChunk(chunkBody("protected-metadata", 0, 2, oldEncoded.slice(0, 2)), metadataOptions);
		expect(() =>
			receiveRequestChunk(chunkBody("impossible-metadata", 0, REQUEST_CHUNK_MAX_TOTAL_CHUNKS, "x"), metadataOptions),
		).toThrow("pending metadata limit exceeded");
		expect(
			receiveRequestChunk(chunkBody("protected-metadata", 1, 2, oldEncoded.slice(2)), metadataOptions),
		).toMatchObject({ complete: true, bodyJson: "{}" });
	});

	it("never exceeds the configured pending request count", () => {
		const options = {
			maxPendingBytes: REQUEST_CHUNK_MAX_PENDING_BYTES,
			maxPendingMetadataBytes: REQUEST_CHUNK_MAX_PENDING_METADATA_BYTES,
			maxPendingCount: 2,
		};
		for (const requestId of ["count-a", "count-b", "count-c"]) {
			receiveRequestChunk(chunkBody(requestId, 0, 2, "e3"), options);
			expect(getRequestChunkCacheStats().pendingCount).toBeLessThanOrEqual(2);
		}
		expect(getRequestChunkCacheStats().pendingCount).toBe(2);
	});

	it("requires canonical lowercase chunk checksums", () => {
		const body = chunkBody("uppercase-checksum", 0, 1, "e30=");
		expect(() => receiveRequestChunk({ ...body, sha256: body.sha256.toUpperCase() })).toThrow(
			"sha256 must be a canonical lowercase",
		);
	});

	it("budgets both raw-segment and legacy peaks for the largest supported single-file receive upload", () => {
		const emptyBody = JSON.stringify({
			name: "upload.bin",
			entries: [{ path: "", type: "file", data: "" }],
		});
		const encodedFileBytes = Math.ceil(RECEIVE_UPLOAD_MAX_DECODED_BYTES / 3) * 4;
		const bodyJsonBytes = Buffer.byteLength(emptyBody, "utf-8") + encodedFileBytes;
		const outerEncodedBytes = Math.ceil(bodyJsonBytes / 3) * 4;

		expect(REQUEST_CHUNK_MAX_PENDING_BYTES).toBeGreaterThanOrEqual(bodyJsonBytes);
		expect(REQUEST_CHUNK_MAX_PENDING_BYTES).toBeGreaterThanOrEqual(outerEncodedBytes);
		expect(REQUEST_CHUNK_MAX_COMPLETED_BYTES).toBeGreaterThanOrEqual(bodyJsonBytes);
	});

	it("reassembles independently encoded segments across Unicode byte boundaries", () => {
		const bodyJson = JSON.stringify({ sessionId: "界🙂résumé", note: "长任务持续运行" });
		const rawBody = Buffer.from(bodyJson, "utf-8");
		const emojiStart = rawBody.indexOf(Buffer.from("🙂", "utf-8"));
		expect(emojiStart).toBeGreaterThanOrEqual(0);
		const segments = [
			rawBody.subarray(0, emojiStart + 1),
			rawBody.subarray(emojiStart + 1, emojiStart + 3),
			rawBody.subarray(emojiStart + 3),
		];

		expect(receiveRequestChunk(segmentChunkBody("request-unicode", 1, 3, segments[1]))).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-unicode", chunkIndex: 1, totalChunks: 3 },
		});
		expect(getRequestChunkCacheStats().pendingBytes).toBe(segments[1].byteLength);
		expect(receiveRequestChunk(segmentChunkBody("request-unicode", 0, 3, segments[0]))).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-unicode", chunkIndex: 0, totalChunks: 3 },
		});
		const completingChunk = segmentChunkBody("request-unicode", 2, 3, segments[2]);
		const completed = receiveRequestChunk(completingChunk);
		expect(completed).toEqual({
			complete: true,
			requestId: "request-unicode",
			replayed: false,
			target: "/api/session/init",
			bodyJson,
		});
		expect(receiveRequestChunk(completingChunk)).toEqual({ ...completed, replayed: true });
	});

	it("preallocates one bounded raw buffer and copies offset-layout chunks in place", () => {
		const bodyJson = JSON.stringify({ sessionId: "offset-layout", content: "界🙂résumé".repeat(37) });
		const rawBody = Buffer.from(bodyJson, "utf-8");
		const rawChunkBytes = 17;
		const totalChunks = Math.ceil(rawBody.byteLength / rawChunkBytes);

		receiveRequestChunk(offsetChunkBody("request-offset-layout", totalChunks - 1, rawBody, rawChunkBytes));
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 1,
			pendingBytes: rawBody.byteLength,
			pendingPreallocatedBuffers: 1,
			pendingStoredChunks: 0,
		});
		for (let index = totalChunks - 2; index >= 0; index--) {
			const result = receiveRequestChunk(offsetChunkBody("request-offset-layout", index, rawBody, rawChunkBytes));
			if (index === 0) expect(result).toMatchObject({ complete: true, bodyJson });
		}
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingPreallocatedBuffers: 0,
			pendingStoredChunks: 0,
		});
	});

	it("fuzzes Unicode offset layouts and strict final-segment lengths", () => {
		for (let iteration = 0; iteration < 40; iteration++) {
			const bodyJson = JSON.stringify({
				sessionId: `fuzz-${iteration}`,
				content: `${"界🙂résumé".repeat((iteration % 7) + 1)}-${String.fromCodePoint(0x1f600 + (iteration % 32))}`,
			});
			const rawBody = Buffer.from(bodyJson, "utf-8");
			const rawChunkBytes = (iteration % 19) + 1;
			const totalChunks = Math.ceil(rawBody.byteLength / rawChunkBytes);
			let completed: ReturnType<typeof receiveRequestChunk> | undefined;
			for (let index = totalChunks - 1; index >= 0; index--) {
				completed = receiveRequestChunk(offsetChunkBody(`offset-fuzz-${iteration}`, index, rawBody, rawChunkBytes));
			}
			expect(completed).toMatchObject({ complete: true, bodyJson });
		}

		const rawBody = Buffer.from('{"strict":true}', "utf-8");
		const valid = offsetChunkBody("offset-strict", 0, rawBody, 4);
		expect(() => receiveRequestChunk({ ...valid, totalChunks: valid.totalChunks + 1 })).toThrow(
			"totalChunks does not match",
		);
		expect(() =>
			receiveRequestChunk({
				...valid,
				chunk: Buffer.from("xx", "utf-8").toString("base64"),
				sha256: sha256(Buffer.from("xx", "utf-8").toString("base64")),
			}),
		).toThrow("byte length does not match");
		expect(() => receiveRequestChunk({ ...valid, rawChunkBytes: undefined })).toThrow(
			"rawTotalBytes and rawChunkBytes must be supplied together",
		);
	});

	it("requires canonical padding for independently encoded segments", () => {
		const paddedOneByte = segmentChunkBody("request-padding", 0, 2, Buffer.from("f", "utf-8"));
		const paddedTwoBytes = segmentChunkBody("request-padding", 1, 2, Buffer.from("oo", "utf-8"));
		expect(paddedOneByte.chunk).toBe("Zg==");
		expect(paddedTwoBytes.chunk).toBe("b28=");
		receiveRequestChunk(paddedOneByte);
		expect(receiveRequestChunk(paddedTwoBytes)).toMatchObject({ complete: true, bodyJson: "foo" });

		for (const [requestId, chunk] of [
			["request-padding-missing", "Zg"],
			["request-padding-bits-1", "Zm9="],
			["request-padding-bits-2", "Zh=="],
		] as const) {
			expect(() =>
				receiveRequestChunk({
					...chunkBody(requestId, 0, 1, chunk),
					encoding: REQUEST_CHUNK_SEGMENT_ENCODING,
				}),
			).toThrow("must be canonical padded base64");
		}
	});

	it("rejects unknown encodings and encoding changes across duplicate metadata", () => {
		const unknown = {
			...segmentChunkBody("request-unknown", 0, 1, Buffer.from("x", "utf-8")),
			encoding: "base64-maybe",
		};
		expect(() => receiveRequestChunk(unknown)).toThrow("Unsupported chunk encoding: base64-maybe");

		receiveRequestChunk(chunkBody("request-encoding-pending", 0, 2, "abcd"));
		expect(() =>
			receiveRequestChunk(segmentChunkBody("request-encoding-pending", 0, 2, Buffer.from("x", "utf-8"))),
		).toThrow("Chunk metadata does not match the pending request");

		const legacyBodyJson = JSON.stringify({ sessionId: "legacy-complete" });
		receiveRequestChunk(
			chunkBody("request-encoding-complete", 0, 1, Buffer.from(legacyBodyJson, "utf-8").toString("base64")),
		);
		expect(() =>
			receiveRequestChunk(segmentChunkBody("request-encoding-complete", 0, 1, Buffer.from(legacyBodyJson, "utf-8"))),
		).toThrow("Chunk metadata does not match the completed request");
	});

	it("keeps new-segment duplicates idempotent and rejects divergent content", () => {
		const first = segmentChunkBody("request-segment-duplicate", 0, 2, Buffer.from("first", "utf-8"));
		expect(receiveRequestChunk(first)).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-segment-duplicate", chunkIndex: 0, totalChunks: 2 },
		});
		expect(receiveRequestChunk(first)).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-segment-duplicate", chunkIndex: 0, totalChunks: 2 },
		});
		expect(() =>
			receiveRequestChunk(segmentChunkBody("request-segment-duplicate", 0, 2, Buffer.from("different", "utf-8"))),
		).toThrow("Duplicate chunk index does not match: 0");
	});

	it("assembles new segments without joining an encoded chunk array", () => {
		const bodyJson = JSON.stringify({ sessionId: "no-encoded-join", content: "x".repeat(4096) });
		const rawBody = Buffer.from(bodyJson, "utf-8");
		const firstEnd = Math.floor(rawBody.byteLength / 3);
		const secondEnd = firstEnd * 2;
		receiveRequestChunk(segmentChunkBody("request-no-join", 0, 3, rawBody.subarray(0, firstEnd)));
		receiveRequestChunk(segmentChunkBody("request-no-join", 1, 3, rawBody.subarray(firstEnd, secondEnd)));

		const joinSpy = vi.spyOn(Array.prototype, "join").mockImplementation(() => {
			throw new Error("encoded chunk join must not run");
		});
		let completed: ReturnType<typeof receiveRequestChunk>;
		try {
			completed = receiveRequestChunk(segmentChunkBody("request-no-join", 2, 3, rawBody.subarray(secondEnd)));
		} finally {
			joinSpy.mockRestore();
		}

		expect(completed).toMatchObject({ complete: true, bodyJson });
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
			requestId: "request-ttl",
			replayed: false,
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
		const firstBody = chunkBody("request-completed", 0, 2, firstChunk);
		const completingChunk = chunkBody("request-completed", 1, 2, secondChunk);

		receiveRequestChunk(firstBody);
		const completed = receiveRequestChunk(completingChunk);

		expect(completed).toEqual({
			complete: true,
			requestId: "request-completed",
			replayed: false,
			target: "/api/session/init",
			bodyJson: JSON.stringify({ sessionId: "chunk-complete-cache" }),
		});
		expect(receiveRequestChunk(completingChunk)).toEqual({
			...completed,
			replayed: true,
		});
		expect(receiveRequestChunk(firstBody)).toEqual({
			complete: false,
			ack: { received: true, requestId: "request-completed", chunkIndex: 0, totalChunks: 2 },
		});
		expect(() => receiveRequestChunk(chunkBody("request-completed", 0, 2, `${firstChunk}x`))).toThrow(
			"Duplicate chunk index does not match: 0",
		);
	});

	it("keeps a lightweight completed request-id tombstone for the six-hour recovery window", () => {
		const bodyJson = JSON.stringify({ sessionId: "long-recovery-window" });
		const encoded = Buffer.from(bodyJson, "utf-8").toString("base64");
		const first = chunkBody("request-long-tombstone", 0, 2, encoded.slice(0, 4));
		const completing = chunkBody("request-long-tombstone", 1, 2, encoded.slice(4));
		const completionOptions = { nowMs: 1000, completedTtlMs: 100 };

		receiveRequestChunk(first, completionOptions);
		receiveRequestChunk(completing, completionOptions);
		expect(() =>
			receiveRequestChunk(completing, {
				nowMs: 1101,
				completedTtlMs: 100,
			}),
		).toThrow("Chunk request already completed");
		expect(getRequestChunkCacheStats()).toMatchObject({
			completedCount: 0,
			tombstoneCount: 1,
		});

		expect(
			receiveRequestChunk(completing, {
				nowMs: 1000 + REQUEST_CHUNK_TOMBSTONE_TTL_MS + 1,
				completedTtlMs: 100,
			}),
		).toEqual({
			complete: false,
			ack: {
				received: true,
				requestId: "request-long-tombstone",
				chunkIndex: 1,
				totalChunks: 2,
			},
		});
	});

	it("expires pending and completed caches without another request", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);

		receiveRequestChunk(chunkBody("request-pending-timer", 0, 2, "abcd"), { pendingTtlMs: 100 });
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 1,
			pendingBytes: 4,
			completedCount: 0,
		});

		await vi.advanceTimersByTimeAsync(100);
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingBytes: 0,
			completedCount: 0,
			completedBytes: 0,
		});

		const bodyJson = JSON.stringify({ sessionId: "completed-timer" });
		const encoded = Buffer.from(bodyJson, "utf-8").toString("base64");
		receiveRequestChunk(chunkBody("request-completed-timer", 0, 1, encoded), { completedTtlMs: 100 });
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			completedCount: 1,
		});

		await vi.advanceTimersByTimeAsync(100);
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingBytes: 0,
			completedCount: 0,
			completedBytes: 0,
			tombstoneCount: 1,
		});
	});

	it("evicts the oldest completed request at the completed count limit", () => {
		const bodyJson = JSON.stringify({ sessionId: "count-limit" });
		const encoded = Buffer.from(bodyJson, "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, 4);
		const secondChunk = encoded.slice(4);
		const options = { maxCompletedCount: 1, maxCompletedBytes: 1024 * 1024 };

		receiveRequestChunk(chunkBody("request-count-1", 0, 2, firstChunk), options);
		receiveRequestChunk(chunkBody("request-count-1", 1, 2, secondChunk), options);
		receiveRequestChunk(chunkBody("request-count-2", 0, 2, firstChunk), options);
		const secondCompleted = receiveRequestChunk(chunkBody("request-count-2", 1, 2, secondChunk), options);

		expect(getRequestChunkCacheStats()).toMatchObject({ completedCount: 1 });
		expect(receiveRequestChunk(chunkBody("request-count-2", 1, 2, secondChunk), options)).toEqual({
			...secondCompleted,
			replayed: true,
		});
		expect(() => receiveRequestChunk(chunkBody("request-count-1", 1, 2, secondChunk), options)).toThrow(
			"Chunk request already completed",
		);
	});

	it("does not retain completed request data that exceeds the completed byte limit", () => {
		const bodyJson = JSON.stringify({ sessionId: "byte-limit" });
		const encoded = Buffer.from(bodyJson, "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, 4);
		const secondChunk = encoded.slice(4);
		const options = { maxCompletedCount: 10, maxCompletedBytes: 1 };

		receiveRequestChunk(chunkBody("request-bytes", 0, 2, firstChunk), options);
		const completed = receiveRequestChunk(chunkBody("request-bytes", 1, 2, secondChunk), options);

		expect(completed).toEqual({
			complete: true,
			requestId: "request-bytes",
			replayed: false,
			target: "/api/session/init",
			bodyJson,
		});
		expect(getRequestChunkCacheStats()).toMatchObject({
			pendingCount: 0,
			pendingBytes: 0,
			completedCount: 0,
			completedBytes: 0,
			tombstoneCount: 1,
		});
		expect(() => receiveRequestChunk(chunkBody("request-bytes", 1, 2, secondChunk), options)).toThrow(
			"Chunk request already completed",
		);
	});

	it("retains chunk hashes instead of completed chunk contents", () => {
		const bodyJson = JSON.stringify({ sessionId: "x".repeat(4096) });
		const encoded = Buffer.from(bodyJson, "utf-8").toString("base64");
		const firstChunk = encoded.slice(0, Math.floor(encoded.length / 2));
		const secondChunk = encoded.slice(firstChunk.length);

		receiveRequestChunk(chunkBody("request-hash-only", 0, 2, firstChunk));
		receiveRequestChunk(chunkBody("request-hash-only", 1, 2, secondChunk));

		const stats = getRequestChunkCacheStats();
		expect(stats.completedCount).toBe(1);
		expect(stats.completedBytes).toBeLessThan(
			Buffer.byteLength(bodyJson, "utf-8") + Buffer.byteLength(encoded, "utf-8"),
		);
	});
});
