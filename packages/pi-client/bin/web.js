#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPort = "1838";
const defaultPiServerUrl = "http://127.0.0.1:4217";

export async function runPiClientWeb(args = process.argv.slice(2)) {
	const parsed = parseArgs(args);
	if (parsed.help) {
		printHelp();
		return 0;
	}

	process.title = "pi-client web";
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const port = parsed.port;
	const host = process.env.TAU_HOST ?? "127.0.0.1";
	const child = spawn(process.execPath, [join(dirname(entry), "cli.js"), ...parsed.clientArgs], {
		env: piClientWebEnv(process.env, { port, host }),
		stdio: "inherit",
	});

	console.log(`pi-client web uses Tau at http://${host}:${port}`);
	console.log("If Tau is not installed, run: pi install npm:tau-mirror or pi-client install npm:tau-mirror");

	return await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	});
}

export function piClientWebEnv(env = process.env, options) {
	return {
		...env,
		PI_CODING_AGENT: "true",
		PI_SERVER_MODE: "true",
		PI_SERVER_URL: env.PI_SERVER_URL ?? defaultPiServerUrl,
		TAU_HOST: options.host,
		TAU_MIRROR_PORT: options.port,
	};
}

function parseArgs(args) {
	let port = process.env.TAU_MIRROR_PORT ?? defaultPort;
	const clientArgs = [];

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { help: true, port, clientArgs };
		if (arg === "--") {
			clientArgs.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--port" || arg === "-p") {
			port = requireValue(args, (i += 1), arg);
			continue;
		}
		if (arg.startsWith("--port=")) {
			port = arg.slice("--port=".length);
			continue;
		}
		throw new Error(`Unknown pi-client web argument: ${arg}`);
	}

	validatePort(port);
	return { help: false, port, clientArgs };
}

function requireValue(args, index, name) {
	const value = args[index];
	if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
	return value;
}

function validatePort(port) {
	const parsed = Number(port);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`--port must be an integer from 1 to 65535: ${port}`);
	}
}

function printHelp() {
	console.log(`Usage: pi-client web [--port <port>] [-- <pi-client args...>]

Start pi-client in Tau mirror mode.

Options:
  -p, --port <port>  Tau port to listen on (default: ${defaultPort})
  -h, --help         Show this help

Environment:
  PI_SERVER_URL          pi-server URL used by pi-client sessions
  PI_SERVER_AUTH_TOKEN   pi-server auth token
  TAU_HOST               Tau bind host (default: 127.0.0.1)
  TAU_MIRROR_PORT        Tau port (default: ${defaultPort})

Tau must be installed in the shared Pi agent settings:
  pi install npm:tau-mirror
  # or: pi-client install npm:tau-mirror
`);
}
