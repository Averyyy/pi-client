import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	RECEIVE_UPLOAD_MAX_ENTRIES,
	RECEIVE_UPLOAD_MAX_NAME_CHARS,
	RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS,
	receiveUpload,
} from "../src/receive-upload.ts";

const temporaryDirectories: string[] = [];

function makeUploadDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-server-receive-upload-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("receiveUpload", () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects filesystem metadata that exceeds explicit bounds", () => {
		const uploadDir = makeUploadDirectory();
		expect(() =>
			receiveUpload(uploadDir, {
				name: "x".repeat(RECEIVE_UPLOAD_MAX_NAME_CHARS + 1),
				entries: [{ path: "", type: "file", data: "" }],
			}),
		).toThrow("invalid upload name");
		expect(() =>
			receiveUpload(uploadDir, {
				name: "long-path",
				entries: [
					{ path: "", type: "directory" },
					{ path: "x".repeat(RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS + 1), type: "file", data: "" },
				],
			}),
		).toThrow(`entry path segment must not exceed ${RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS} characters`);
		expect(() =>
			receiveUpload(uploadDir, {
				name: "too-many",
				entries: Array.from({ length: RECEIVE_UPLOAD_MAX_ENTRIES + 1 }, (_, index) => ({
					path: index === 0 ? "" : `entry-${index}`,
					type: "directory",
				})),
			}),
		).toThrow(`entries must not exceed ${RECEIVE_UPLOAD_MAX_ENTRIES}`);
	});

	it("replays an identical completed upload without overwriting a different destination", () => {
		const uploadDir = makeUploadDirectory();
		const body = {
			name: "extension",
			entries: [
				{ path: "", type: "directory" },
				{ path: "nested", type: "directory" },
				{ path: "nested/index.ts", type: "file", data: Buffer.from("export default 1;").toString("base64") },
			],
		};

		const first = receiveUpload(uploadDir, body);
		expect(receiveUpload(uploadDir, body)).toEqual(first);

		writeFileSync(join(first.path, "nested", "index.ts"), "changed");
		expect(() => receiveUpload(uploadDir, body)).toThrow("destination already exists with different contents");
	});
});
