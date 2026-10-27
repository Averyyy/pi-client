import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const packageRoot = resolve(__dirname, "..");
const sourceResolverUrl = pathToFileURL(join(packageRoot, "src", "experimental", "source-resolver.ts")).href;
const sessionManagerUrl = pathToFileURL(join(packageRoot, "src", "core", "session-manager.ts")).href;
const cliPath = join(packageRoot, "src", "pi-client-cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pi-client main reload branch restoration", () => {
	it.each([
		{ name: "selects the requested non-last branch", requestedLeaf: true },
		{ name: "resets to an empty leaf", requestedLeaf: false },
	])("$name and consumes the reload environment", ({ requestedLeaf }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-main-reload-"));
		tempDirs.push(root);
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const session = SessionManager.create(projectDir, sessionDir);
		const desiredLeaf = session.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
		session.appendMessage({ role: "user", content: "main branch tail", timestamp: Date.now() });
		session.branch(desiredLeaf);
		session.appendMessage({ role: "user", content: "alternate branch tail", timestamp: Date.now() });
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(session.getLeafId()).not.toBe(desiredLeaf);
		const reloadLeafId = requestedLeaf ? desiredLeaf : "";

		const observationPath = join(root, "reload-observation.json");
		const preloadPath = join(root, "observe-reload.mjs");
		writeFileSync(
			preloadPath,
			`import { appendFileSync } from "node:fs";
import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const writeObservation = (manager, method) => appendFileSync(process.env.PI_RELOAD_OBSERVATION_PATH,
	JSON.stringify({ method, leafId: manager.getLeafId(), reloadEnvPresent: Object.hasOwn(process.env, "PI_CLIENT_RELOAD_LEAF_ID") }) + "\\n");
const branch = SessionManager.prototype.branch;
SessionManager.prototype.branch = function (leafId) { branch.call(this, leafId); writeObservation(this, "branch"); };
const resetLeaf = SessionManager.prototype.resetLeaf;
SessionManager.prototype.resetLeaf = function () { resetLeaf.call(this); writeObservation(this, "resetLeaf"); };
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				"--import",
				sourceResolverUrl,
				"--import",
				pathToFileURL(preloadPath).href,
				cliPath,
				"-p",
				"--session",
				sessionFile!,
				"-ne",
				"--no-mcp",
				"--no-context-files",
				"--offline",
				"hello",
			],
			{
				cwd: projectDir,
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
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_SERVER_MODE: "true",
					PI_SERVER_URL: "http://127.0.0.1:0",
					PI_CLIENT_RELOAD_LEAF_ID: reloadLeafId,
					PI_RELOAD_OBSERVATION_PATH: observationPath,
				},
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("No models available.");
		expect(JSON.parse(readFileSync(observationPath, "utf-8"))).toEqual({
			method: reloadLeafId ? "branch" : "resetLeaf",
			leafId: reloadLeafId || null,
			reloadEnvPresent: false,
		});
	});
});
