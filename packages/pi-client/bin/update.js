import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function defaultPackageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readPackageMetadata(packageRoot) {
	return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8"));
}

function runStep(runner, command, args, cwd, stdio = "inherit") {
	return runner(command, args, { cwd, stdio, encoding: "utf-8" });
}

function defaultUpdateMarkerPath() {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-client-update.json");
}

function writeUpdateMarker(path) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: "latest", updatedAt: new Date().toISOString() })}\n`);
}

function runNpmGlobalUpdate(runner, cwd, stdout, stderr, updateMarkerPath) {
	stdout.write("Updating npm packages: @averyyy/pi-client@latest @averyyy/pi-server@latest\n");
	const result = runStep(
		runner,
		"npm",
		[
			"install",
			"-g",
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--force",
			"@averyyy/pi-client@latest",
			"@averyyy/pi-server@latest",
		],
		cwd,
	);
	if (result.status !== 0) {
		stderr.write(
			"pi-client update failed: npm install -g --ignore-scripts --legacy-peer-deps --force @averyyy/pi-client@latest @averyyy/pi-server@latest\n",
		);
		return result.status ?? 1;
	}
	writeUpdateMarker(updateMarkerPath);
	stdout.write("Updated package files without stopping active pi-client sessions. Run /reload in each session to switch runtimes.\n");
	stdout.write("pi-client update complete\n");
	return 0;
}

export async function runPiClientUpdate(_args = [], options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const runner = options.runner ?? spawnSync;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const updateMarkerPath = options.updateMarkerPath ?? defaultUpdateMarkerPath();
	const pkg = readPackageMetadata(packageRoot);
	const baseVersion = pkg.piClient?.basePiVersion ?? "unknown";
	const baseCommit = pkg.piClient?.basePiCommit ?? "unknown";

	stdout.write(`pi-client ${pkg.version} (based on pi ${baseVersion}, upstream ${baseCommit})\n`);
	return runNpmGlobalUpdate(runner, process.cwd(), stdout, stderr, updateMarkerPath);
}
