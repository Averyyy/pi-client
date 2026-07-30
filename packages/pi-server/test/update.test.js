import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPiServerUpdate } from "../bin/update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const temporaryDirectories = [];

function createWindowsNodeInstall(includeNpmCli = true) {
	const root = mkdtempSync(join(tmpdir(), "pi-server-update-"));
	temporaryDirectories.push(root);

	const nodePath = join(root, "node.exe");
	const npmPackagePath = join(root, "node_modules", "npm", "package.json");
	const npmCliPath = join(root, "node_modules", "npm", "bin", "npm-cli.js");
	mkdirSync(dirname(npmCliPath), { recursive: true });
	writeFileSync(nodePath, "");
	writeFileSync(npmPackagePath, JSON.stringify({ bin: { npm: "bin/npm-cli.js" } }));
	if (includeNpmCli) {
		writeFileSync(npmCliPath, "");
	}

	return { nodePath, npmCliPath };
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("pi-server update", () => {
	it("updates the fork checkout and reinstalls both global binaries", async () => {
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({
				command,
				args,
				cwd: options.cwd,
				stdio: options.stdio,
				timeout: options.timeout,
				killSignal: options.killSignal,
			});
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			platform: "linux",
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(exitCode).toBe(0);
		expect(output.join("")).toContain(`pi-server ${pkg.version}`);
		expect(calls).toEqual([
			{
				command: "git",
				args: ["status", "--porcelain"],
				cwd: "/repo/pi-client",
				stdio: "pipe",
				timeout: 30_000,
				killSignal: "SIGTERM",
			},
			{
				command: "git",
				args: ["pull", "--ff-only"],
				cwd: "/repo/pi-client",
				stdio: "inherit",
				timeout: 300_000,
				killSignal: "SIGTERM",
			},
			{
				command: "npm",
				args: ["install", "--ignore-scripts"],
				cwd: "/repo/pi-client",
				stdio: "inherit",
				timeout: 1_200_000,
				killSignal: "SIGTERM",
			},
			{
				command: "npm",
				args: ["run", "install:pi-client"],
				cwd: "/repo/pi-client",
				stdio: "inherit",
				timeout: 1_200_000,
				killSignal: "SIGTERM",
			},
			{
				command: "npm",
				args: ["run", "install:pi-server"],
				cwd: "/repo/pi-client",
				stdio: "inherit",
				timeout: 1_200_000,
				killSignal: "SIGTERM",
			},
		]);
	});

	it("updates Windows npm global installs through process.execPath and the validated npm CLI", async () => {
		const { nodePath, npmCliPath } = createWindowsNodeInstall();
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({
				command,
				args,
				cwd: options.cwd,
				stdio: options.stdio,
				timeout: options.timeout,
				killSignal: options.killSignal,
			});
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { status: 128, stderr: "fatal: not a git repository\n" };
			}
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/usr/local/lib/node_modules",
			platform: "win32",
			nodePath,
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("Updating npm packages");
		expect(calls).toEqual([
			{
				command: "git",
				args: ["status", "--porcelain"],
				cwd: "/usr/local/lib/node_modules",
				stdio: "pipe",
				timeout: 30_000,
				killSignal: "SIGTERM",
			},
			{
				command: nodePath,
				args: [
					npmCliPath,
					"install",
					"-g",
					"--ignore-scripts",
					"--legacy-peer-deps",
					"@averyyy/pi-client@latest",
					"@averyyy/pi-server@latest",
				],
				cwd: "/usr/local/lib/node_modules",
				stdio: "inherit",
				timeout: 1_200_000,
				killSignal: "SIGTERM",
			},
		]);
	});

	it("fails before updating when the Windows npm CLI is missing", async () => {
		const { nodePath, npmCliPath } = createWindowsNodeInstall(false);
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, timeout: options.timeout, killSignal: options.killSignal });
			return { status: 128, stderr: "fatal: not a git repository\n" };
		};

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/global/packages",
			platform: "win32",
			nodePath,
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(output.join("")).toContain(`pi-server update failed: npm CLI not found: ${npmCliPath}`);
		expect(calls).toEqual([
			{
				command: "git",
				args: ["status", "--porcelain"],
				timeout: 30_000,
				killSignal: "SIGTERM",
			},
		]);
	});

	it("reports and terminates a timed-out update step", async () => {
		const output = [];
		const timeoutError = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
		const runner = (_command, _args, options) => ({
			status: null,
			signal: options.killSignal,
			error: timeoutError,
		});

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			platform: "linux",
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(output.join("")).toContain(
			"pi-server update failed: git status --porcelain timed out after 30000 ms and was terminated with SIGTERM",
		);
	});

	it("reports a subprocess launch failure with its error code", async () => {
		const output = [];
		const launchError = Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" });
		const runner = () => ({ status: null, error: launchError });

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			platform: "linux",
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(output.join("")).toContain(
			"pi-server update failed: unable to start git status --porcelain (ENOENT): spawnSync git ENOENT",
		);
	});

	it("reports subprocess termination by signal", async () => {
		const output = [];
		const runner = () => ({ status: null, signal: "SIGKILL" });

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			platform: "linux",
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(output.join("")).toContain(
			"pi-server update failed: git status --porcelain was terminated by signal SIGKILL",
		);
	});
});
