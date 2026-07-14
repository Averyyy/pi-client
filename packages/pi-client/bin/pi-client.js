#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiClientSend } from "./send.js";

const args = process.argv.slice(2);
const modulePromise =
	args[0] === "send"
		? runPiClientSend(args.slice(1)).then((code) => {
				process.exitCode = code;
			})
		: args[0] === "update"
		? import("./update.js").then(async ({ runPiClientUpdate }) => {
				process.exitCode = await runPiClientUpdate(args.slice(1));
			})
		: args[0] === "web"
			? import("./web.js").then(async ({ runPiClientWeb }) => {
					process.exitCode = await runPiClientWeb(args.slice(1));
				})
			: runPiClientCli(args);

Promise.resolve(modulePromise).catch((e) => {
	console.error(e);
	process.exit(1);
});

function runPiClientCli(args) {
	const reloadDir = mkdtempSync(join(tmpdir(), "pi-client-reload-"));
	const reloadStatePath = join(reloadDir, "state.json");
	let cliPath = getLocalCliPath();
	let childArgs = args;

	try {
		for (;;) {
			const result = spawnSync(process.execPath, [cliPath, ...childArgs], {
				env: {
					...process.env,
					PI_CODING_AGENT: "true",
					PI_SERVER_MODE: "true",
					PI_CLIENT_RELOAD_STATE_PATH: reloadStatePath,
				},
				stdio: "inherit",
			});
			if (result.error) throw result.error;
			if (result.status !== 75) {
				process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
				return;
			}

			const state = readReloadState(reloadStatePath);
			if (!state) {
				console.error("pi-client reload failed: missing session state from the previous runtime.");
				process.exitCode = 1;
				return;
			}
			rmSync(state.updateMarkerPath, { force: true });
			childArgs = state.sessionDir ? ["--session-dir", state.sessionDir, "--session", state.sessionId] : ["--session", state.sessionId];
			cliPath = getUpdatedGlobalCliPath() ?? getLocalCliPath();
		}
	} finally {
		rmSync(reloadDir, { recursive: true, force: true });
	}
}

function getLocalCliPath() {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "cli.js");
}

function getUpdatedGlobalCliPath() {
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const result = existsSync(npmCli)
		? spawnSync(process.execPath, [npmCli, "root", "-g"], { encoding: "utf-8" })
		: spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
	if (result.status !== 0) return undefined;
	const root = result.stdout.trim();
	const cliPath = join(root, "@averyyy", "pi-client", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	return existsSync(cliPath) ? cliPath : undefined;
}

function readReloadState(path) {
	try {
		const value = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof value.sessionId !== "string" || typeof value.updateMarkerPath !== "string") return undefined;
		if (value.sessionDir !== undefined && typeof value.sessionDir !== "string") return undefined;
		return value;
	} catch {
		return undefined;
	}
}
