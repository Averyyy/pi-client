import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-client update", () => {
	it("declares the upstream Pi version this fork is based on", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piClient).toEqual({
			basePiVersion: "0.79.3",
			basePiCommit: "6f29450",
		});
	});

	it("routes pi-client update through the local update helper", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");

		expect(binContent).toContain('args[0] === "update"');
		expect(binContent).toContain('import("./update.js")');
	});

	it("updates the fork checkout and reinstalls both global binaries", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: "" };
		};

		const exitCode = runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("based on pi 0.79.3");
		expect(output.join("")).toContain("upstream 6f29450");
		expect(calls).toEqual([
			{ command: "git", args: ["status", "--porcelain"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "git", args: ["pull", "--ff-only"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["install", "--ignore-scripts"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-client"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-server"], cwd: "/repo/pi-client", stdio: "inherit" },
		]);
	});

	it("refuses to update a dirty checkout", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const errors = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: " M README.md\n" };
		};

		const exitCode = runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			stdout: { write: () => {} },
			stderr: { write: (value) => errors.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(calls).toHaveLength(1);
		expect(errors.join("")).toContain("working tree has uncommitted changes");
	});
});
