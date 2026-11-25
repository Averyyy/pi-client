import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityWorkspace } from "../src/core/antigravity-workspace.ts";

describe("AntigravityWorkspace", () => {
	let cwd: string;
	let workspace: AntigravityWorkspace;
	const signal = new AbortController().signal;
	const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-antigravity-workspace-"));
		workspace = new AntigravityWorkspace(cwd);
	});

	afterEach(() => {
		workspace.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads 1-based line ranges and writes files under the agy session root into the Pi workspace", async () => {
		writeFileSync(join(cwd, "notes.txt"), "one\ntwo\nthree\nfour");
		const read = (path: string, root: string, params = {}) =>
			workspace.handle({ method: "fs/read_text_file", params: { path, ...params }, root }, signal);
		expect(await read(join(cwd, "notes.txt"), cwd)).toEqual({ content: "one\ntwo\nthree\nfour" });
		expect(await read("/srv/agy/notes.txt", "/srv/agy", { line: 2, limit: 2 })).toEqual({ content: "two\nthree" });
		expect(await read("C:\\agy\\work\\notes.txt", "C:\\agy\\work\\", { line: 4 })).toEqual({ content: "four" });
		await workspace.handle(
			{
				method: "fs/write_text_file",
				params: { path: "/srv/agy/out/result.txt", content: "written" },
				root: "/srv/agy",
			},
			signal,
		);
		expect(readFileSync(join(cwd, "out", "result.txt"), "utf8")).toBe("written");
	});

	it("keeps the newest output bytes of a terminal at a character boundary and reports its exit", async () => {
		const { terminalId } = (await workspace.handle(
			{
				method: "terminal/create",
				params: { ...node("process.stdout.write('ab😀cd'); process.exit(3)"), outputByteLimit: 5 },
				root: cwd,
			},
			signal,
		)) as { terminalId: string };
		const request = (method: string) => workspace.handle({ method, params: { terminalId }, root: cwd }, signal);
		expect(await request("terminal/wait_for_exit")).toEqual({ exitCode: 3, signal: null });
		// Five bytes would split the four-byte emoji, so only "cd" remains.
		expect(await request("terminal/output")).toEqual({
			output: "cd",
			truncated: true,
			exitStatus: { exitCode: 3, signal: null },
		});
		await request("terminal/release");
		await expect(request("terminal/output")).rejects.toThrow(`Unknown terminal ${terminalId}`);
	});

	it("runs commands in the mapped working directory and kills a running terminal", async () => {
		const { terminalId } = (await workspace.handle(
			{
				method: "terminal/create",
				params: { ...node("console.log(process.cwd()); setInterval(() => {}, 1000)"), cwd: "/srv/agy" },
				root: "/srv/agy",
			},
			signal,
		)) as { terminalId: string };
		const request = (method: string) => workspace.handle({ method, params: { terminalId }, root: cwd }, signal);
		await expect.poll(async () => ((await request("terminal/output")) as { output: string }).output).toContain(cwd);
		await request("terminal/kill");
		expect(await request("terminal/wait_for_exit")).toEqual({ exitCode: null, signal: "SIGTERM" });
	});
});
