#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const modulePromise =
	args[0] === "update"
		? import("./update.js").then(async ({ runPiServerUpdate }) => {
				process.exitCode = await runPiServerUpdate(args.slice(1));
			})
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
