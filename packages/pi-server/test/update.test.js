import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-server update", () => {
	it("updates the fork checkout and reinstalls both global binaries", async () => {
		const { runPiServerUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			fetch: async () => new Response("", { status: 200 }),
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(exitCode).toBe(0);
		expect(output.join("")).toContain(`pi-server ${pkg.version}`);
		expect(calls).toEqual([
			{ command: "git", args: ["status", "--porcelain"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "git", args: ["config", "--get", "remote.origin.url"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "npm", args: ["config", "get", "registry"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "git", args: ["pull", "--ff-only"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["install", "--ignore-scripts"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-client"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-server"], cwd: "/repo/pi-client", stdio: "inherit" },
		]);
	});

	it("updates npm global installs from latest packages", async () => {
		const { runPiServerUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { status: 128, stderr: "fatal: not a git repository\n" };
			}
			if (command === "npm" && args.join(" ") === "config get registry") {
				return { status: 0, stdout: "https://registry.npmjs.org/\n" };
			}
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiServerUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/usr/local/lib/node_modules",
			runner,
			fetch: async () => new Response("", { status: 200 }),
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("Updating npm packages");
		expect(calls).toEqual([
			{ command: "git", args: ["status", "--porcelain"], cwd: "/usr/local/lib/node_modules", stdio: "pipe" },
			{ command: "npm", args: ["config", "get", "registry"], cwd: "/usr/local/lib/node_modules", stdio: "pipe" },
			{
				command: "npm",
				args: [
					"install",
					"-g",
					"--ignore-scripts",
					"@averyyy/pi-client@latest",
					"@averyyy/pi-server@latest",
				],
				cwd: "/usr/local/lib/node_modules",
				stdio: "inherit",
			},
		]);
	});
});
