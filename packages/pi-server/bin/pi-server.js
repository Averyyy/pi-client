#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiServerUpdate } from "./update.js";

const args = process.argv.slice(2);
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
const modulePromise =
	args[0] === "update"
		? runPiServerUpdate(args.slice(1)).then((code) => {
				process.exitCode = code;
			})
		: args.length > 0
			? runSelfCommand(args)
		: runPiServer(args);

Promise.resolve(modulePromise).catch((e) => {
	console.error(e);
	process.exit(1);
});

function runPiServer(args) {
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const result = spawnSync(process.execPath, [join(packageRoot, "dist", "cli.js"), ...args], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}

function runSelfCommand(args) {
	const unsupportedArgument = args.find((arg) => arg !== "--help" && arg !== "-h" && arg !== "--version" && arg !== "-v");
	if (unsupportedArgument !== undefined) {
		console.error(`Unknown option "${unsupportedArgument}". Use "pi-server --help" for usage.`);
		process.exitCode = 1;
		return;
	}
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`pi-server - HTTP proxy for pi-client

Usage:
  pi-server

Options:
  --help, -h       Show this help
  --version, -v    Show the installed version`);
		return;
	}
	console.log(packageVersion);
}
