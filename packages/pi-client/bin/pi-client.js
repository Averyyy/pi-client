#!/usr/bin/env node
const args = process.argv.slice(2);
const modulePromise =
	args[0] === "update"
		? import("./update.js").then(({ runPiClientUpdate }) => {
				process.exitCode = runPiClientUpdate(args.slice(1));
			})
		: import("@earendil-works/pi-coding-agent/pi-client-cli");

modulePromise.catch((e) => {
	console.error(e);
	process.exit(1);
});
