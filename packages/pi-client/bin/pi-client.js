#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiClientSend } from "./send.js";

const args = process.argv.slice(2);
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
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
	let reloadLeafId;
	let runtimeUpdatedAt = readRuntimeUpdateGeneration();

	try {
		for (;;) {
			const result = spawnSync(process.execPath, [cliPath, ...childArgs], {
				env: {
					...process.env,
					PI_CODING_AGENT: "true",
					PI_SERVER_MODE: "true",
					PI_CLIENT_VERSION: packageVersion,
					PI_CLIENT_RELOAD_STATE_PATH: reloadStatePath,
					PI_CLIENT_RELOAD_LEAF_ID: reloadLeafId,
					PI_CLIENT_RUNTIME_UPDATED_AT: runtimeUpdatedAt,
				},
				stdio: "inherit",
			});
			if (result.error) throw result.error;
			if (result.status !== 75) {
				process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
				return;
			}

			const state = readReloadState(reloadStatePath);
			cliPath = getUpdatedGlobalCliPath();
			reloadLeafId = state.leafId ?? "";
			runtimeUpdatedAt = state.updatedAt;
			childArgs = [...state.args, ...(state.sessionDir ? ["--session-dir", state.sessionDir] : []), "--session", state.sessionId];
		}
	} finally {
		rmSync(reloadDir, { recursive: true, force: true });
	}
}

function getLocalCliPath() {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "cli.js");
}

function readRuntimeUpdateGeneration() {
	const markerPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-client-update.json");
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
		if (typeof marker?.updatedAt !== "string") throw new Error(`Invalid pi-client update marker: ${markerPath}`);
		return marker.updatedAt;
	} catch (error) {
		if (error.code !== "ENOENT") console.error(`Could not read pi-client update marker: ${error.message}`);
		return "";
	}
}

function getUpdatedGlobalCliPath() {
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const result = process.platform === "win32"
		? spawnSync(process.execPath, [npmCli, "root", "-g"], { encoding: "utf-8" })
		: spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Could not locate the updated pi-client runtime: ${result.stderr.trim()}`);
	}
	const root = result.stdout.trim();
	return join(root, "@averyyy", "pi-client", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
}

function readReloadState(path) {
	const value = JSON.parse(readFileSync(path, "utf-8"));
	if (
		typeof value?.sessionId !== "string" ||
		typeof value?.updatedAt !== "string" ||
		!Array.isArray(value.args) ||
		!value.args.every((arg) => typeof arg === "string") ||
		(value.leafId !== null && typeof value.leafId !== "string") ||
		(value.sessionDir !== undefined && typeof value.sessionDir !== "string")
	) {
		throw new Error(`Invalid pi-client reload state: ${path}`);
	}
	return value;
}
