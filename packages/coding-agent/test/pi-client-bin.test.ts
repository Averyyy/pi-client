import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const repoRoot = resolve(pkgRoot, "../..");

describe("coding-agent bins", () => {
	it("package.json exposes only pi bin, not pi-client", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin.pi).toBe("dist/bundle/cli.js");
		expect(pkg.bin["pi-client"]).toBeUndefined();
	});

	it("pi-client cli delegates to the original main entry so extensions and skills still load normally", () => {
		const source = readFileSync(join(pkgRoot, "src", "pi-client-cli.ts"), "utf-8");

		expect(source).toContain('import { main } from "./main.ts";');
		expect(source).toContain("main(process.argv.slice(2));");
		expect(source).toContain('process.env.PI_SERVER_MODE = "true";');
		expect(source).not.toContain("PI_CODING_AGENT_DIR");
		expect(source).not.toContain("CONFIG_DIR_NAME");
	});

	it("source pi-client entry renders fork help without installing anything", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-help-"));
		try {
			const stdoutPath = join(root, "stdout");
			const stderrPath = join(root, "stderr");
			const stdoutFd = openSync(stdoutPath, "w");
			const stderrFd = openSync(stderrPath, "w");
			let result: ReturnType<typeof spawnSync>;
			try {
				result = spawnSync(
					process.execPath,
					[
						"--import",
						pathToFileURL(resolve(repoRoot, "node_modules/tsx/dist/loader.mjs")).href,
						join(pkgRoot, "src", "pi-client-cli.ts"),
						"--help",
					],
					{
						env: {
							...process.env,
							HOME: join(root, "home"),
							PI_CODING_AGENT_DIR: join(root, "agent"),
							PI_OFFLINE: "true",
							TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json"),
						},
						stdio: ["ignore", stdoutFd, stderrFd],
						timeout: 5_000,
					},
				);
			} finally {
				closeSync(stdoutFd);
				closeSync(stderrFd);
			}
			const stdout = readFileSync(stdoutPath, "utf-8");
			const stderr = readFileSync(stderrPath, "utf-8");

			expect(result.status).toBe(0);
			expect(stdout).toContain("pi-client - AI coding assistant");
			expect(stdout).toContain("pi-client web");
			expect(stdout).toContain("pi-client send <path>");
			expect(stdout).toContain("PI_SERVER_URL");
			expect(stdout).toContain("PI_SERVER_AUTH_TOKEN");
			expect(stdout).toContain("PI_CLIENT_MAX_REQUEST_KB");
			expect(stdout).toContain("/reload");
			expect(`${stdout}\n${stderr}`).not.toMatch(/npm (install|update)|Installing|Updating/);
			expect(existsSync(join(root, "agent", "node_modules"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the upstream pi config directory so existing extensions and skills are shared", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piConfig?.configDir).toBe(".pi");
		expect(pkg.piConfig?.name).toBeUndefined();
	});
});
