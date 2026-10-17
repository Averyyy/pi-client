import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const sourceLoader = pathToFileURL(join(pkgRoot, "src", "experimental", "source-resolver.ts")).href;

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
			const extensionPath = join(root, "help-extension.ts");
			writeFileSync(
				extensionPath,
				'export default function (pi) { pi.registerFlag("remote-help-fixture", { type: "boolean", description: "Offline extension help" }); }',
			);
			const stdoutPath = join(root, "stdout");
			const stderrPath = join(root, "stderr");
			const stdoutFd = openSync(stdoutPath, "w");
			const stderrFd = openSync(stderrPath, "w");
			let result: ReturnType<typeof spawnSync>;
			try {
				result = spawnSync(
					process.execPath,
					["--import", sourceLoader, join(pkgRoot, "src", "pi-client-cli.ts"), "-e", extensionPath, "--help"],
					{
						env: {
							...process.env,
							HOME: join(root, "home"),
							PI_CODING_AGENT_DIR: join(root, "agent"),
							PI_OFFLINE: "true",
							PI_SERVER_URL: "http://127.0.0.1:1",
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
			expect(stdout).toContain("--remote-help-fixture");
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

	it("rejects a provider selection without a model in the pi-client entrypoint", () => {
		// #10236: an incomplete provider selection must not run another provider's default model.
		const root = mkdtempSync(join(tmpdir(), "pi-client-provider-"));
		try {
			const result = spawnSync(
				process.execPath,
				["--import", sourceLoader, join(pkgRoot, "src", "pi-client-cli.ts"), "--provider", "anthropic"],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: join(root, "agent"),
						PI_OFFLINE: "true",
						PI_SERVER_URL: "http://127.0.0.1:1",
					},
					encoding: "utf8",
					timeout: 5_000,
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--provider requires --model");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ selection: "without an explicit model", args: [] },
		{ selection: "with an explicit model", args: ["--model", "unavailable/model"] },
	])("reports an unavailable pi-server $selection without a startup stack trace", ({ args }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-unavailable-server-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					sourceLoader,
					join(pkgRoot, "src", "pi-client-cli.ts"),
					"-p",
					"--no-session",
					"-ne",
					"--no-mcp",
					"--no-context-files",
					...args,
					"hello",
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						COMSPEC: process.env.COMSPEC,
						PATHEXT: process.env.PATHEXT,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						HOME: join(root, "home"),
						USERPROFILE: join(root, "home"),
						APPDATA: join(root, "appdata"),
						PI_CODING_AGENT_DIR: join(root, "agent"),
						PI_OFFLINE: "true",
						PI_SERVER_URL: "http://127.0.0.1:0",
					},
					encoding: "utf8",
					input: "",
					timeout: 5_000,
				},
			);

			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("pi-server model catalog:");
			if (args.length > 0) {
				expect(result.stderr).toContain('Cannot resolve model "unavailable/model"');
			}
			expect(result.stderr).not.toMatch(
				/UnhandledPromiseRejection|node:internal|\n\s+at |models\.json|\/login|install/i,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
