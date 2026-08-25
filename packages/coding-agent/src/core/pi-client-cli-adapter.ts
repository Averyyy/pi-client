/**
 * Map upstream `pi ...` CLI invocations onto `pi-client` when running in
 * PI_SERVER_MODE. Extensions such as pi-subagent typically spawn `pi` by name.
 */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

export const PI_CLIENT_CLI_SHIM_DIR_ENV = "PI_CLIENT_CLI_SHIM_DIR";
const PI_CLIENT_BIN = "pi-client";
const PI_COMMAND_RE = /(^|[\n;&|])(\s*)pi(?:\.exe)?(?=[\s;|&]|$)/g;

let installedShimDir: string | undefined;

export function isPiClientMode(): boolean {
	return process.env.PI_SERVER_MODE === "true";
}

export function getCliBinName(): string {
	return isPiClientMode() ? PI_CLIENT_BIN : "pi";
}

export function getPiClientCliShimDir(): string | undefined {
	return installedShimDir ?? process.env[PI_CLIENT_CLI_SHIM_DIR_ENV];
}

export function rewritePiCliCommand(command: string): string {
	if (!isPiClientMode()) return command;
	return command.replace(PI_COMMAND_RE, `$1$2${PI_CLIENT_BIN}`);
}

export function rewritePiCliSpawn(command: string, args: string[]): { command: string; args: string[] } {
	if (!isPiClientMode()) return { command, args };
	const name = basename(command).toLowerCase();
	if (name !== "pi" && name !== "pi.exe" && name !== "pi.cmd") return { command, args };
	const invocation = resolvePiClientInvocation();
	return { command: invocation.command, args: [...invocation.prefixArgs, ...args] };
}

export function installPiClientCliAdapter(): void {
	if (!isPiClientMode() || installedShimDir) return;

	const invocation = resolvePiClientInvocation();
	const dir = mkdtempSync(join(tmpdir(), "pi-client-cli-"));
	writeShim(dir, invocation);
	installedShimDir = dir;
	process.env[PI_CLIENT_CLI_SHIM_DIR_ENV] = dir;

	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath
		.split(delimiter)
		.filter(Boolean)
		.filter((entry) => entry !== dir);
	process.env[pathKey] = [dir, ...pathEntries].join(delimiter);
}

function resolvePiClientInvocation(): { command: string; prefixArgs: string[] } {
	const script = process.argv[1];
	if (script && isPiCliScript(script) && existsSync(script)) {
		return { command: process.execPath, prefixArgs: [script] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, prefixArgs: [] };
	}
	return { command: PI_CLIENT_BIN, prefixArgs: [] };
}

function isPiCliScript(script: string): boolean {
	if (script.startsWith("/$bunfs/root/")) return false;
	const name = basename(script).toLowerCase();
	return (
		name === "pi" ||
		name === "pi.exe" ||
		name === "pi-client" ||
		name === "pi-client.js" ||
		name === "pi-client-cli.js" ||
		name === "pi-client-cli.ts" ||
		name === "cli.js" ||
		name === "cli.ts"
	);
}

function writeShim(dir: string, invocation: { command: string; prefixArgs: string[] }): void {
	const unixPath = join(dir, "pi");
	const quoted = [invocation.command, ...invocation.prefixArgs].map(shQuote).join(" ");
	writeFileSync(unixPath, `#!/bin/sh\nexec ${quoted} "$@"\n`, { encoding: "utf-8", mode: 0o755 });
	if (process.platform !== "win32") chmodSync(unixPath, 0o755);

	const cmdPath = join(dir, "pi.cmd");
	const winArgs = [invocation.command, ...invocation.prefixArgs].map(cmdQuote).join(" ");
	writeFileSync(cmdPath, `@echo off\r\n${winArgs} %*\r\n`, { encoding: "utf-8" });
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
