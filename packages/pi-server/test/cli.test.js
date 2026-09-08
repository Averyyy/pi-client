import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const repoRoot = resolve(pkgRoot, "../..");
const wrapperPath = join(pkgRoot, "bin", "pi-server.js");
const sourcePath = join(pkgRoot, "src", "cli.ts");
const tsxLoaderPath = pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
const packageVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")).version;

function runCli(script, args, environment) {
	const commandArgs = script === sourcePath ? ["--import", tsxLoaderPath, script, ...args] : [script, ...args];
	return spawnSync(process.execPath, commandArgs, {
		env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json"), ...environment },
		encoding: "utf-8",
		timeout: 2_000,
	});
}

async function withOccupiedPort(callback) {
	const occupied = createServer();
	await new Promise((resolve, reject) => {
		occupied.once("error", reject);
		occupied.listen(0, "127.0.0.1", resolve);
	});
	const address = occupied.address();
	if (!address || typeof address === "string") throw new Error("Failed to allocate an occupied test port");
	try {
		return await callback(address.port);
	} finally {
		await new Promise((resolve) => occupied.close(resolve));
	}
}

function makeEnvironment(root, port) {
	return {
		HOME: join(root, "home"),
		PI_SERVER_PORT: String(port),
		PI_SERVER_SESSION_STORE_DIR: join(root, "sessions"),
		PI_SERVER_CONFIG: join(root, "missing-config.json"),
	};
}

describe("pi-server CLI introspection", () => {
	it.each([
		[wrapperPath, ["--help"]],
		[wrapperPath, ["--version"]],
		[sourcePath, ["--help"]],
		[sourcePath, ["--version"]],
	])("handles %s %s without binding or loading server configuration", async (script, args) => {
		const root = mkdtempSync(join(tmpdir(), "pi-server-cli-"));
		try {
			await withOccupiedPort((port) => {
				const result = runCli(script, args, makeEnvironment(root, port));
				expect(result.status).toBe(0);
				if (args[0] === "--help") {
					expect(result.stdout).toContain("Usage:");
					expect(result.stdout).toContain("pi-server");
				} else {
					expect(result.stdout.trim()).toBe(packageVersion);
				}
				expect(result.stdout).not.toContain("listening");
				expect(result.stderr).toBe("");
				expect(result.error).toBeUndefined();
				expect(existsSync(join(root, "sessions"))).toBe(false);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([wrapperPath, sourcePath])("rejects unknown options without starting the server: %s", async (script) => {
		const root = mkdtempSync(join(tmpdir(), "pi-server-cli-"));
		try {
			await withOccupiedPort((port) => {
				const result = runCli(script, ["--unknown-review-flag"], makeEnvironment(root, port));
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("--unknown-review-flag");
				expect(result.stderr).toContain("--help");
				expect(result.stdout).not.toContain("listening");
				expect(result.error).toBeUndefined();
				expect(existsSync(join(root, "sessions"))).toBe(false);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
