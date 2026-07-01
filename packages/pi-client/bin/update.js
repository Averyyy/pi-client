import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function defaultPackageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultRepoRoot() {
	return resolve(defaultPackageRoot(), "..", "..");
}

function readPackageMetadata(packageRoot) {
	return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8"));
}

function runStep(runner, command, args, cwd, stdio = "inherit") {
	return runner(command, args, { cwd, stdio, encoding: "utf-8" });
}

export function runPiClientUpdate(_args = [], options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const repoRoot = options.repoRoot ?? defaultRepoRoot();
	const runner = options.runner ?? spawnSync;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const pkg = readPackageMetadata(packageRoot);
	const baseVersion = pkg.piClient?.basePiVersion ?? "unknown";
	const baseCommit = pkg.piClient?.basePiCommit ?? "unknown";

	stdout.write(`pi-client ${pkg.version} (based on pi ${baseVersion}, upstream ${baseCommit})\n`);
	stdout.write(`Updating checkout: ${repoRoot}\n`);

	const status = runStep(runner, "git", ["status", "--porcelain"], repoRoot, "pipe");
	if (status.status !== 0) {
		stderr.write("pi-client update failed: unable to inspect git status\n");
		return status.status ?? 1;
	}
	if (String(status.stdout ?? "").trim().length > 0) {
		stderr.write("pi-client update failed: working tree has uncommitted changes\n");
		return 1;
	}

	const steps = [
		["git", ["pull", "--ff-only"]],
		["npm", ["install", "--ignore-scripts"]],
		["npm", ["run", "install:pi-client"]],
		["npm", ["run", "install:pi-server"]],
	];

	for (const [command, args] of steps) {
		const result = runStep(runner, command, args, repoRoot);
		if (result.status !== 0) {
			stderr.write(`pi-client update failed: ${command} ${args.join(" ")}\n`);
			return result.status ?? 1;
		}
	}

	stdout.write("pi-client update complete\n");
	return 0;
}
