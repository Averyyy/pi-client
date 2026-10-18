import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

afterEach(() => vi.restoreAllMocks());

describe("execCommand", () => {
	it("propagates spawn errors", async () => {
		await expect(execCommand(join(tmpdir(), "missing-executable"), [], process.cwd())).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("returns the child's nonzero exit code and output", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
			process.cwd(),
		);

		expect(result).toEqual({ stdout: "out", stderr: "err", code: 7, killed: false });
	});

	it.skipIf(process.platform === "win32")("returns a nonzero code when the child exits from a signal", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], process.cwd());

		expect(result.code).toBe(1);
		expect(result.killed).toBe(false);
	});

	it("clears the force-kill timer when cancellation stops the child", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		const controller = new AbortController();
		const startedAt = performance.now();
		const pending = execCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);

		const result = await pending;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(1);
		expect(performance.now() - startedAt).toBeLessThan(2000);
		const escalationIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
		expect(escalationIndex).toBeGreaterThanOrEqual(0);
		const escalationTimer = setTimeoutSpy.mock.results[escalationIndex]?.value;
		expect(escalationTimer).toBeDefined();
		expect(clearTimeoutSpy).toHaveBeenCalledWith(escalationTimer);
	});
});
