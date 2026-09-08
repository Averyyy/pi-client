#!/usr/bin/env node
import { createRequire } from "node:module";
import { startServer } from "./server.ts";

interface PackageMetadata {
	version: string;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;
const args = process.argv.slice(2);

const unsupportedArgument = args.find((arg) => arg !== "--help" && arg !== "-h" && arg !== "--version" && arg !== "-v");
if (unsupportedArgument !== undefined) {
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

Options:
  --help, -h       Show this help
  --version, -v    Show the installed version`);
}
