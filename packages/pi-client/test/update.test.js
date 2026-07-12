import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-client update", () => {
	it("declares the upstream Pi version this fork is based on", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piClient).toEqual({
		basePiVersion: "0.80.6",
		basePiCommit: "8479bd84",
		});
	});

	it("routes pi-client update through the local update helper", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");

		expect(binContent).toContain('args[0] === "update"');
		expect(binContent).toContain('import("./update.js")');
	});

	it("updates global packages without modifying the active checkout", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const markerDir = mkdtempSync(join(tmpdir(), "pi-client-update-"));
		const updateMarkerPath = join(markerDir, "pi-client-update.json");
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			updateMarkerPath,
			runner,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("based on pi 0.80.6");
		expect(output.join("")).toContain("Run /reload in each session");
		expect(calls).toEqual([
			{
				command: "npm",
				args: [
					"install",
					"-g",
					"--ignore-scripts",
					"--legacy-peer-deps",
					"--force",
					"@averyyy/pi-client@latest",
					"@averyyy/pi-server@latest",
				],
				cwd: process.cwd(),
				stdio: "inherit",
			},
		]);
		expect(JSON.parse(readFileSync(updateMarkerPath, "utf-8"))).toMatchObject({ version: "latest" });
		rmSync(markerDir, { recursive: true, force: true });
	});

	it("does not create a reload marker when the global install fails", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const markerDir = mkdtempSync(join(tmpdir(), "pi-client-update-"));
		const updateMarkerPath = join(markerDir, "pi-client-update.json");
		const runner = (command, args, options) => {
			return { status: 1, stderr: "npm failed", command, args, options };
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			updateMarkerPath,
			runner,
			stdout: { write: () => {} },
			stderr: { write: () => {} },
		});

		expect(exitCode).toBe(1);
		expect(() => readFileSync(updateMarkerPath, "utf-8")).toThrow();
		rmSync(markerDir, { recursive: true, force: true });
	});
});
