import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("pi-client runtime reload", () => {
	it("resumes with captured CLI options and update generation while preserving the shared marker", () => {
		const fixture = createReloadFixture();
		try {
			const result = runWrapper(fixture);

			expect(result.status, result.stderr).toBe(0);
			expect(readLog(fixture.runLogPath)).toEqual([{
			source: "local",
			args: ["initial-prompt"],
			updatedAt: fixture.initialUpdatedAt,
		}]);
			expect(readLog(fixture.globalLogPath)).toEqual([{
			source: "global",
			args: [...fixture.retainedArgs, "--session-dir", fixture.sessionDir, "--session", fixture.sessionId],
			leafId: "branch-leaf-3",
			updatedAt: fixture.updatedAt,
			markerExists: true,
			markerUpdatedAt: fixture.updatedAt,
		}]);
			expect(existsSync(fixture.markerPath)).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("a failed global npm lookup keeps the marker and does not rerun the local CLI", () => {
		const fixture = createReloadFixture();
		try {
			const result = runWrapper(fixture, { PI_TEST_NPM_ROOT_FAIL: "true" });

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/Could not locate the updated pi-client runtime: npm root fixture failed/);
			expect(readLog(fixture.runLogPath)).toEqual([{
			source: "local",
			args: ["initial-prompt"],
			updatedAt: fixture.initialUpdatedAt,
		}]);
			expect(existsSync(fixture.markerPath)).toBe(true);
			expect(existsSync(fixture.globalLogPath)).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("surfaces invalid reload state without rerunning the local CLI", () => {
		const fixture = createReloadFixture();
		try {
			const result = runWrapper(fixture, { PI_TEST_INVALID_STATE: "true" });

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/Invalid pi-client reload state: .*pi-client-reload-/);
			expect(readLog(fixture.runLogPath)).toEqual([{
				source: "local",
				args: ["initial-prompt"],
				updatedAt: fixture.initialUpdatedAt,
			}]);
			expect(existsSync(fixture.markerPath)).toBe(true);
			expect(existsSync(fixture.globalLogPath)).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

function createReloadFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-client-reload-test-"));
	const packageRootCopy = join(root, "package");
	const binDir = join(packageRootCopy, "bin");
	const localRuntimeDir = join(packageRootCopy, "node_modules", "@earendil-works", "pi-coding-agent");
	const globalRoot = join(root, "global");
	const globalRuntimeDir = join(globalRoot, "@averyyy", "pi-client", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	const runLogPath = join(root, "runs.jsonl");
	const globalLogPath = join(root, "global.jsonl");
	const markerPath = join(root, "pi-client-update.json");
	const sessionId = "saved-session-17";
	const sessionDir = "C:/saved/sessions";
	const initialUpdatedAt = "2026-10-18T00:00:00.000Z";
	const updatedAt = "2026-10-18T00:00:01.000Z";
	const retainedArgs = ["-e", "C:/fixtures/provider.ts", "--no-mcp", "--system-prompt", "Fixture instructions"];

	mkdirSync(binDir, { recursive: true });
	mkdirSync(localRuntimeDir, { recursive: true });
	mkdirSync(globalRuntimeDir, { recursive: true });
	writeFileSync(markerPath, JSON.stringify({ version: "1.0.0-piclient.2", updatedAt: initialUpdatedAt }));
	copyFileSync(join(packageRoot, "bin", "pi-client.js"), join(binDir, "pi-client.js"));
	copyFileSync(join(packageRoot, "bin", "send.js"), join(binDir, "send.js"));
	copyFileSync(join(packageRoot, "package.json"), join(packageRootCopy, "package.json"));
	writeFileSync(join(localRuntimeDir, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		version: "1.0.0",
		type: "module",
		main: "./index.js",
		exports: { ".": "./index.js", "./pi-server-request": "./request.js" },
	}));
	writeFileSync(join(localRuntimeDir, "index.js"), "export {};\n");
	writeFileSync(join(localRuntimeDir, "request.js"), "export class ChunkRequest {}\n");
	writeFileSync(join(localRuntimeDir, "cli.js"), `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.PI_TEST_RUN_LOG, JSON.stringify({ source: "local", args, updatedAt: process.env.PI_CLIENT_RUNTIME_UPDATED_AT }) + "\\n");
writeFileSync(process.env.PI_TEST_MARKER_PATH, JSON.stringify({ version: "1.0.0-piclient.2", updatedAt: process.env.PI_TEST_UPDATED_AT }));
writeFileSync(process.env.PI_CLIENT_RELOAD_STATE_PATH, JSON.stringify({
	sessionId: process.env.PI_TEST_SESSION_ID,
	sessionDir: process.env.PI_TEST_SESSION_DIR,
	leafId: process.env.PI_TEST_INVALID_STATE ? 17 : "branch-leaf-3",
	args: process.env.PI_TEST_INVALID_STATE ? "invalid" : JSON.parse(process.env.PI_TEST_RETAINED_ARGS),
	updatedAt: process.env.PI_TEST_UPDATED_AT,
}));
process.exitCode = 75;
`);
	writeFileSync(join(globalRuntimeDir, "cli.js"), `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.env.PI_TEST_GLOBAL_LOG, JSON.stringify({
	source: "global",
	args: process.argv.slice(2),
	leafId: process.env.PI_CLIENT_RELOAD_LEAF_ID,
	updatedAt: process.env.PI_CLIENT_RUNTIME_UPDATED_AT,
	markerExists: existsSync(process.env.PI_TEST_MARKER_PATH),
	markerUpdatedAt: JSON.parse(readFileSync(process.env.PI_TEST_MARKER_PATH, "utf-8")).updatedAt,
}) + "\\n");
`);
	const preloadPath = join(root, "preload.mjs");
	writeFileSync(preloadPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
	const executable = String(command).toLowerCase();
	const isNpmRoot = (executable.endsWith("npm") || executable.endsWith("npm.cmd")) && args[0] === "root" && args[1] === "-g"
		|| String(args[0] ?? "").toLowerCase().endsWith("npm-cli.js") && args[1] === "root" && args[2] === "-g";
	if (isNpmRoot) {
		if (process.env.PI_TEST_NPM_ROOT_FAIL) return { status: 1, stdout: "", stderr: "npm root fixture failed" };
		return { status: 0, stdout: process.env.PI_TEST_GLOBAL_ROOT + "\\n", stderr: "" };
	}
	return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
`);
	return {
		root,
		wrapperPath: join(binDir, "pi-client.js"),
		preloadPath,
		globalRoot,
		runLogPath,
		globalLogPath,
		markerPath,
		sessionId,
		sessionDir,
		initialUpdatedAt,
		updatedAt,
		retainedArgs,
	};
}

function runWrapper(fixture, extraEnv = {}) {
	return spawnSync(process.execPath, [fixture.wrapperPath, "initial-prompt"], {
		encoding: "utf-8",
		env: {
			...process.env,
			NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
			PI_TEST_GLOBAL_ROOT: fixture.globalRoot,
			PI_TEST_RUN_LOG: fixture.runLogPath,
			PI_TEST_GLOBAL_LOG: fixture.globalLogPath,
			PI_TEST_MARKER_PATH: fixture.markerPath,
			PI_TEST_SESSION_ID: fixture.sessionId,
			PI_TEST_SESSION_DIR: fixture.sessionDir,
			PI_CODING_AGENT_DIR: fixture.root,
			PI_TEST_UPDATED_AT: fixture.updatedAt,
			PI_TEST_RETAINED_ARGS: JSON.stringify(fixture.retainedArgs),
			PI_CLIENT_RUNTIME_UPDATED_AT: fixture.initialUpdatedAt,
			...extraEnv,
		},
	});
}

function readLog(path) {
	return readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}
