#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const modulePromise =
	args[0] === "update"
		? import("./update.js").then(({ runPiClientUpdate }) => {
				process.exitCode = runPiClientUpdate(args.slice(1));
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
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const result = spawnSync(process.execPath, [join(dirname(entry), "cli.js"), ...args], {
		env: {
			...process.env,
			PI_CODING_AGENT: "true",
			PI_SERVER_MODE: "true",
		},
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
}
