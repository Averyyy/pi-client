import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	acknowledgePiServerPendingRun,
	acquirePiServerRunStateLease,
	getPiServerRunStatePath,
	hashPiServerIdentity,
	readPiServerPendingRun,
	releasePiServerRunStateLease,
	writePiServerPendingRun,
} from "../src/core/pi-server-run-state.ts";

const temporaryDirectories: string[] = [];

function makeStatePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-server-run-state-"));
	temporaryDirectories.push(directory);
	return getPiServerRunStatePath(join(directory, "session.jsonl"));
}

function runInput(runId = "run-1") {
	return {
		serverHash: hashPiServerIdentity("https://pi.example.test"),
		sessionId: "session-1",
		runId,
		baseTreeHash: "1".repeat(64),
		baseEntryCount: 3,
		baseLeafId: "leaf-1",
		requestHash: "2".repeat(64),
		timestamp: 1000,
	};
}

async function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolveReady, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for lease holder")), 5000);
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			if (!chunk.includes("READY")) return;
			clearTimeout(timeout);
			resolveReady();
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Lease holder exited before readiness with code ${String(code)}`));
		});
	});
}

describe("pi-server run state", () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("durably records one pending run and requires acknowledgement before the next", () => {
		const path = makeStatePath();
		const written = writePiServerPendingRun(path, runInput());

		expect(readPiServerPendingRun(path)).toEqual(written);
		expect(() => writePiServerPendingRun(path, runInput("run-2"))).toThrow("run run-1 must be acknowledged");

		acknowledgePiServerPendingRun(path, "run-1", 2000);
		expect(readPiServerPendingRun(path)).toBeUndefined();
		expect(writePiServerPendingRun(path, runInput("run-2")).runId).toBe("run-2");
		expect(readFileSync(path, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("ignores only a torn final record and rejects corruption in committed history", () => {
		const path = makeStatePath();
		writePiServerPendingRun(path, runInput());
		appendFileSync(path, '{"payload":"torn"', "utf-8");
		expect(readPiServerPendingRun(path)?.runId).toBe("run-1");
		acknowledgePiServerPendingRun(path, "run-1", 2000);
		expect(readPiServerPendingRun(path)).toBeUndefined();

		const content = readFileSync(path, "utf-8");
		const [firstLine] = content.split("\n");
		const corrupted = firstLine.replace(/"sha256":"[a-f0-9]{64}"/, `"sha256":"${"0".repeat(64)}"`);
		const corruptPath = makeStatePath();
		appendFileSync(corruptPath, `${corrupted}\n`, "utf-8");
		expect(() => readPiServerPendingRun(corruptPath)).toThrow("checksum mismatch");
	});

	it("stores only identifiers and digests, not provider request secrets", () => {
		const path = makeStatePath();
		writePiServerPendingRun(path, runInput());
		const encoded = readFileSync(path, "utf-8");

		expect(encoded).not.toContain("TOP_SECRET_PROMPT");
		expect(encoded).not.toContain("sk-secret");
		expect(encoded).not.toContain("https://pi.example.test");
		expect(encoded).toContain(hashPiServerIdentity("https://pi.example.test"));
	});

	it("keeps a pending run until a server acknowledgement is recorded", () => {
		const path = makeStatePath();
		writePiServerPendingRun(path, runInput());

		expect(readPiServerPendingRun(path)?.runId).toBe("run-1");
		expect(() => writePiServerPendingRun(path, runInput("run-2"))).toThrow("run run-1 must be acknowledged");
	});

	it("fails fast when a second lease contends for the same persistent session", () => {
		const path = makeStatePath();
		const first = acquirePiServerRunStateLease(path);
		try {
			expect(() => acquirePiServerRunStateLease(path)).toThrow("another process owns the session");
		} finally {
			releasePiServerRunStateLease(first);
		}

		const replacement = acquirePiServerRunStateLease(path);
		releasePiServerRunStateLease(replacement);
	});

	it("lets another process acquire the lease after the holder crashes", async () => {
		const path = makeStatePath();
		const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/pi-server-run-state.ts")).href;
		const tsxLoader = pathToFileURL(resolve(import.meta.dirname, "../../../node_modules/tsx/dist/loader.mjs")).href;
		const child = spawn(
			process.execPath,
			[
				"--import",
				tsxLoader,
				"--input-type=module",
				"--eval",
				`import { acquirePiServerRunStateLease } from ${JSON.stringify(moduleUrl)};
globalThis.lease = acquirePiServerRunStateLease(${JSON.stringify(path)});
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		try {
			await waitForChildReady(child);
			expect(() => acquirePiServerRunStateLease(path)).toThrow("another process owns the session");
			child.kill();

			let recovered: ReturnType<typeof acquirePiServerRunStateLease> | undefined;
			for (let attempt = 0; attempt < 100 && !recovered; attempt++) {
				try {
					recovered = acquirePiServerRunStateLease(path);
				} catch {
					await new Promise((resolveRetry) => setTimeout(resolveRetry, 10));
				}
			}
			if (!recovered) throw new Error("Expected the lease to become available after child exit");
			releasePiServerRunStateLease(recovered);
		} finally {
			if (child.exitCode === null) {
				child.kill();
			}
		}
	});
});
