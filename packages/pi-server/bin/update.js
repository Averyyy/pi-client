import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GIT_STATUS_TIMEOUT_MS = 30_000;
const GIT_UPDATE_TIMEOUT_MS = 5 * 60_000;
const NPM_UPDATE_TIMEOUT_MS = 20 * 60_000;
const UPDATE_KILL_SIGNAL = "SIGTERM";

function defaultPackageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultRepoRoot() {
	return resolve(defaultPackageRoot(), "..", "..");
}

function readPackageMetadata(packageRoot) {
	return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8"));
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveNpmInvocation(platform, nodePath) {
	if (platform !== "win32") {
		return { command: "npm", argsPrefix: [] };
	}

	if (!isFile(nodePath)) {
		throw new Error(`Node executable not found: ${nodePath}`);
	}

	const npmPackagePath = resolve(dirname(nodePath), "node_modules", "npm", "package.json");
	if (!isFile(npmPackagePath)) {
		throw new Error(`npm package metadata not found: ${npmPackagePath}`);
	}

	let npmPackage;
	try {
		npmPackage = JSON.parse(readFileSync(npmPackagePath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`unable to read npm package metadata ${npmPackagePath}: ${message}`, { cause: error });
	}

	const npmBin = typeof npmPackage.bin === "string" ? npmPackage.bin : npmPackage.bin?.npm;
	if (typeof npmBin !== "string" || npmBin.length === 0) {
		throw new Error(`npm CLI entry missing from package metadata: ${npmPackagePath}`);
	}

	const npmCliPath = resolve(dirname(npmPackagePath), npmBin);
	if (!isFile(npmCliPath)) {
		throw new Error(`npm CLI not found: ${npmCliPath}`);
	}

	return { command: nodePath, argsPrefix: [npmCliPath] };
}

function runStep(runner, command, args, cwd, timeout, stdio = "inherit") {
	try {
		return runner(command, args, {
			cwd,
			stdio,
			encoding: "utf-8",
			timeout,
			killSignal: UPDATE_KILL_SIGNAL,
		});
	} catch (error) {
		return { status: null, error };
	}
}

function reportStepFailure(stderr, displayCommand, result, timeout) {
	if (result.error?.code === "ETIMEDOUT") {
		stderr.write(
			`pi-server update failed: ${displayCommand} timed out after ${timeout} ms and was terminated with ${UPDATE_KILL_SIGNAL}\n`,
		);
		return 1;
	}

	if (result.error) {
		const errorCode = typeof result.error.code === "string" ? ` (${result.error.code})` : "";
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		stderr.write(`pi-server update failed: unable to start ${displayCommand}${errorCode}: ${message}\n`);
		return 1;
	}

	if (result.signal) {
		stderr.write(`pi-server update failed: ${displayCommand} was terminated by signal ${result.signal}\n`);
		return 1;
	}

	if (typeof result.status === "number") {
		stderr.write(`pi-server update failed: ${displayCommand} exited with code ${result.status}\n`);
		return result.status === 0 ? 1 : result.status;
	}

	stderr.write(`pi-server update failed: ${displayCommand} ended without an exit status\n`);
	return 1;
}

function isMissingGitCheckout(result) {
	const text = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
	return !result.error && !result.signal && result.status !== 0 && text.includes("not a git repository");
}

function getNpmInvocation(platform, nodePath, stderr) {
	try {
		return resolveNpmInvocation(platform, nodePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr.write(`pi-server update failed: ${message}\n`);
		return null;
	}
}

async function runNpmGlobalUpdate(runner, npmInvocation, repoRoot, stdout, stderr) {
	stdout.write("Updating npm packages: @averyyy/pi-client@latest @averyyy/pi-server@latest\n");
	const npmArgs = [
		"install",
		"-g",
		"--ignore-scripts",
		"--legacy-peer-deps",
		"@averyyy/pi-client@latest",
		"@averyyy/pi-server@latest",
	];
	const result = runStep(
		runner,
		npmInvocation.command,
		[...npmInvocation.argsPrefix, ...npmArgs],
		repoRoot,
		NPM_UPDATE_TIMEOUT_MS,
	);
	if (result.status !== 0) {
		return reportStepFailure(stderr, `npm ${npmArgs.join(" ")}`, result, NPM_UPDATE_TIMEOUT_MS);
	}
	stdout.write("pi-server update complete\n");
	return 0;
}

export async function runPiServerUpdate(_args = [], options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const repoRoot = options.repoRoot ?? defaultRepoRoot();
	const runner = options.runner ?? spawnSync;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const platform = options.platform ?? process.platform;
	const nodePath = options.nodePath ?? process.execPath;
	const pkg = readPackageMetadata(packageRoot);

	stdout.write(`pi-server ${pkg.version}\n`);
	stdout.write(`Updating checkout: ${repoRoot}\n`);

	const statusArgs = ["status", "--porcelain"];
	const status = runStep(runner, "git", statusArgs, repoRoot, GIT_STATUS_TIMEOUT_MS, "pipe");
	if (status.status !== 0) {
		if (isMissingGitCheckout(status)) {
			const npmInvocation = getNpmInvocation(platform, nodePath, stderr);
			if (!npmInvocation) {
				return 1;
			}
			return runNpmGlobalUpdate(runner, npmInvocation, repoRoot, stdout, stderr);
		}
		return reportStepFailure(stderr, `git ${statusArgs.join(" ")}`, status, GIT_STATUS_TIMEOUT_MS);
	}
	if (String(status.stdout ?? "").trim().length > 0) {
		stderr.write("pi-server update failed: working tree has uncommitted changes\n");
		return 1;
	}

	const npmInvocation = getNpmInvocation(platform, nodePath, stderr);
	if (!npmInvocation) {
		return 1;
	}

	const steps = [
		{
			command: "git",
			args: ["pull", "--ff-only"],
			displayCommand: "git pull --ff-only",
			timeout: GIT_UPDATE_TIMEOUT_MS,
		},
		{
			command: npmInvocation.command,
			args: [...npmInvocation.argsPrefix, "install", "--ignore-scripts"],
			displayCommand: "npm install --ignore-scripts",
			timeout: NPM_UPDATE_TIMEOUT_MS,
		},
		{
			command: npmInvocation.command,
			args: [...npmInvocation.argsPrefix, "run", "install:pi-client"],
			displayCommand: "npm run install:pi-client",
			timeout: NPM_UPDATE_TIMEOUT_MS,
		},
		{
			command: npmInvocation.command,
			args: [...npmInvocation.argsPrefix, "run", "install:pi-server"],
			displayCommand: "npm run install:pi-server",
			timeout: NPM_UPDATE_TIMEOUT_MS,
		},
	];

	for (const step of steps) {
		const result = runStep(runner, step.command, step.args, repoRoot, step.timeout);
		if (result.status !== 0) {
			return reportStepFailure(stderr, step.displayCommand, result, step.timeout);
		}
	}

	stdout.write("pi-server update complete\n");
	return 0;
}
