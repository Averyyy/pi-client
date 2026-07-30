import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

describe("OutputAccumulator", () => {
	it("spools long output with bounded display memory and preserves the exact bytes", async () => {
		const accumulator = new OutputAccumulator({
			maxBytes: 1024,
			maxLines: 20,
			tempFilePrefix: "pi-output-stress",
		});
		const chunk = Buffer.from(`${"x".repeat(64 * 1024 - 1)}\n`, "utf-8");
		const chunkCount = 256;
		const expectedHash = createHash("sha256");

		for (let index = 0; index < chunkCount; index++) {
			accumulator.append(chunk);
			expectedHash.update(chunk);
		}
		accumulator.finish();
		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await accumulator.closeTempFile();

		expect(snapshot.truncation.truncated).toBe(true);
		expect(Buffer.byteLength(snapshot.content, "utf-8")).toBeLessThanOrEqual(1024);
		expect(snapshot.fullOutputPath).toBeDefined();
		if (!snapshot.fullOutputPath) throw new Error("Expected a full output path");
		try {
			const persisted = readFileSync(snapshot.fullOutputPath);
			expect(persisted.byteLength).toBe(chunk.byteLength * chunkCount);
			expect(createHash("sha256").update(persisted).digest("hex")).toBe(expectedHash.digest("hex"));
			if (process.platform !== "win32") {
				expect(statSync(snapshot.fullOutputPath).mode & 0o777).toBe(0o600);
			}
		} finally {
			rmSync(snapshot.fullOutputPath, { force: true });
		}
	});

	it("rejects appending after the durable spool has been closed", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1, maxLines: 1 });
		accumulator.append(Buffer.from("long output", "utf-8"));
		accumulator.finish();
		const path = accumulator.snapshot({ persistIfTruncated: true }).fullOutputPath;
		await accumulator.closeTempFile();

		try {
			expect(() => accumulator.append(Buffer.from("late", "utf-8"))).toThrow(
				"Cannot append to a finished output accumulator",
			);
		} finally {
			if (path) rmSync(path, { force: true });
		}
	});
});
