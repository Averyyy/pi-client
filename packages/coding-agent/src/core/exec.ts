/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";
import { rewritePiCliSpawn } from "./pi-client-cli-adapter.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const invocation = rewritePiCliSpawn(command, args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let killed = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let escalationId: NodeJS.Timeout | undefined;
	const killProcess = () => {
		if (killed) return;
		killed = true;
		proc.kill("SIGTERM");
		escalationId = setTimeout(() => proc.kill("SIGKILL"), 5000);
	};

	if (options?.signal) {
		if (options.signal.aborted) killProcess();
		else options.signal.addEventListener("abort", killProcess, { once: true });
	}
	if (options?.timeout && options.timeout > 0) timeoutId = setTimeout(killProcess, options.timeout);

	proc.stdout?.on("data", (data) => {
		stdout += data.toString();
	});
	proc.stderr?.on("data", (data) => {
		stderr += data.toString();
	});

	try {
		// Wait for process termination without hanging on inherited stdio handles.
		const code = await waitForChildProcess(proc);
		return { stdout, stderr, code: code ?? 1, killed };
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (escalationId) clearTimeout(escalationId);
		options?.signal?.removeEventListener("abort", killProcess);
	}
}
