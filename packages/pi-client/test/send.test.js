import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUploadBody } from "../bin/send.js";

describe("pi-client send", () => {
	it("encodes a file", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-client-send-"));
		const source = join(directory, "file.txt");
		writeFileSync(source, "hello");
		try {
			expect(createUploadBody(source)).toEqual({
				name: "file.txt",
				entries: [{ path: "", type: "file", data: Buffer.from("hello").toString("base64") }],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("encodes a folder with stable relative paths", () => {
		const source = mkdtempSync(join(tmpdir(), "pi-client-send-"));
		mkdirSync(join(source, "nested"));
		writeFileSync(join(source, "nested", "file.txt"), "hello");
		try {
			expect(createUploadBody(source)).toEqual({
				name: basename(source),
				entries: [
					{ path: "", type: "directory" },
					{ path: "nested", type: "directory" },
					{ path: "nested/file.txt", type: "file", data: Buffer.from("hello").toString("base64") },
				],
			});
		} finally {
			rmSync(source, { recursive: true, force: true });
		}
	});
});
