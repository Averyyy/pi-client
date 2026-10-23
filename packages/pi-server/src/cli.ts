#!/usr/bin/env node
import { createRequire } from "node:module";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { unlockViewer } from "./viewer-auth.ts";

interface PackageMetadata {
	version: string;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;
const args = process.argv.slice(2);

const unsupportedArgument = args.find((arg) => arg !== "--help" && arg !== "-h" && arg !== "--version" && arg !== "-v");
if (args.length === 2 && args[0] === "viewer" && args[1] === "unlock") {
	unlockViewer(loadConfig().sessionStoreDir);
	console.log("Viewer unlocked");
} else if (unsupportedArgument !== undefined) {
	console.error(`Unknown option "${unsupportedArgument}". Use "pi-server --help" for usage.`);
	process.exitCode = 1;
} else if (args.includes("--help") || args.includes("-h")) {
	printHelp();
} else if (args.includes("--version") || args.includes("-v")) {
	console.log(packageMetadata.version);
} else {
	startServer();
}

function printHelp(): void {
	console.log(`pi-server - HTTP proxy for pi-client

Usage:
  pi-server
  pi-server viewer unlock

Options:
  --help, -h       Show this help
  --version, -v    Show the installed version`);
}
