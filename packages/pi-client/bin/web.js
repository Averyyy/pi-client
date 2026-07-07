#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPort = "1838";
const defaultPiServerUrl = "http://127.0.0.1:4217";
const tauCodexPackage = "@averyyy/pi-tau-codex";
const tauCodexInstallTarget = "npm:@averyyy/pi-tau-codex";
const tauCodexGitTarget = "git:github.com/Averyyy/pi-tau-codex";

export async function runPiClientWeb(args = process.argv.slice(2)) {
	const parsed = parseArgs(args);
	if (parsed.help) {
		printHelp();
		return 0;
	}

	if (!hasTauCodexExtensionInstalled(process.env)) {
		printInstallRequired();
		return 1;
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

export function hasTauCodexExtensionInstalled(env = process.env) {
	if (env.TAU_STATIC_DIR) return true;
	const settingsPath = env.PI_CODING_AGENT_SETTINGS_PATH ?? join(
		env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent"),
		"settings.json",
	);
	if (!existsSync(settingsPath)) return false;
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	return packages.some(packageSpecMatchesTauCodex);
}

function packageSpecMatchesTauCodex(spec) {
	if (typeof spec === "string") return specMatchesTauCodex(spec);
	if (!spec || typeof spec !== "object") return false;
	return ["source", "package", "name", "spec"].some((key) => specMatchesTauCodex(spec[key]));
}

function specMatchesTauCodex(spec) {
	return typeof spec === "string" && (
		spec === tauCodexPackage ||
		spec === tauCodexInstallTarget ||
		spec.startsWith(`${tauCodexPackage}@`) ||
		spec.startsWith(`${tauCodexInstallTarget}@`) ||
		spec === tauCodexGitTarget ||
		spec.includes("github.com/Averyyy/pi-tau-codex")
	);
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
  pi-client install npm:@averyyy/pi-tau-codex
  # or: pi install npm:@averyyy/pi-tau-codex
  # dev fallback: pi-client install git:github.com/Averyyy/pi-tau-codex
`);
}

function printInstallRequired() {
	console.error(`请安装 ${tauCodexPackage}:`);
	console.error("  pi-client install npm:@averyyy/pi-tau-codex");
	console.error("  # or: pi install npm:@averyyy/pi-tau-codex");
	console.error("  # dev fallback: pi-client install git:github.com/Averyyy/pi-tau-codex");
}
