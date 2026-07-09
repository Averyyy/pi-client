#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const versionPattern = /^\d+\.\d+\.\d+-piclient\.\d+$/;

const buildWorkspaces = ["packages/tui", "packages/ai", "packages/agent", "packages/coding-agent", "packages/pi-server"];

const packageDefs = [
	{
		id: "pi-ai",
		source: "packages/ai",
		name: "@averyyy/pi-ai",
		requiredFiles: ["dist/index.js"],
	},
	{
		id: "pi-tui",
		source: "packages/tui",
		name: "@averyyy/pi-tui",
		requiredFiles: ["dist/index.js"],
	},
	{
		id: "pi-agent-core",
		source: "packages/agent",
		name: "@averyyy/pi-agent-core",
		requiredFiles: ["dist/index.js"],
		mutate: (pkg, version) => {
			setDependency(pkg, "@earendil-works/pi-ai", `npm:@averyyy/pi-ai@${version}`);
		},
	},
	{
		id: "pi-coding-agent",
		source: "packages/coding-agent",
		name: "@averyyy/pi-coding-agent",
		requiredFiles: ["dist/cli.js", "dist/core/pi-server-request.js"],
		removeFiles: ["npm-shrinkwrap.json"],
		mutate: (pkg, version) => {
			setDependency(pkg, "@earendil-works/pi-agent-core", `npm:@averyyy/pi-agent-core@${version}`);
			setDependency(pkg, "@earendil-works/pi-ai", `npm:@averyyy/pi-ai@${version}`);
			setDependency(pkg, "@earendil-works/pi-tui", `npm:@averyyy/pi-tui@${version}`);
		},
	},
	{
		id: "pi-client",
		source: "packages/pi-client",
		name: "@averyyy/pi-client",
		requiredFiles: ["bin/pi-client.js", "README.md"],
		mutate: (pkg, version) => {
			setDependency(pkg, "@earendil-works/pi-coding-agent", `npm:@averyyy/pi-coding-agent@${version}`);
		},
	},
	{
		id: "pi-server",
		source: "packages/pi-server",
		name: "@averyyy/pi-server",
		requiredFiles: ["bin/pi-server.js", "dist/server.js", "README.md"],
		mutate: (pkg, version) => {
			setDependency(pkg, "@earendil-works/pi-agent-core", `npm:@averyyy/pi-agent-core@${version}`);
			setDependency(pkg, "@earendil-works/pi-ai", `npm:@averyyy/pi-ai@${version}`);
		},
	},
];

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version ?? readJson(join(repoRoot, "packages/pi-client/package.json")).version);

if (!versionPattern.test(version)) {
	throw new Error(`Expected version like 0.80.3-piclient.4, got ${version}`);
}

console.log(`Publishing @averyyy Pi packages at ${version}${args.dryRun ? " (dry run)" : ""}`);

if (!args.skipBuild) {
	for (const workspace of buildWorkspaces) {
		run("npm", ["run", "build", "-w", workspace], { cwd: repoRoot });
	}
}

const tempRoot = mkdtempSync(join(tmpdir(), "averyyy-npm-publish-"));

try {
	const preparedPackages = packageDefs.map((def) => preparePackage(tempRoot, def, version));

	for (const pkg of preparedPackages) {
		const published = isPublished(pkg.name, version);
		console.log(published ? `${pkg.name}@${version} already exists; validating only.` : `${pkg.name}@${version} is new; validating.`);
		validatePack(pkg);
		pkg.published = published;
		console.log();
	}

	if (args.dryRun) {
		process.exit(0);
	}

	for (const pkg of preparedPackages) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${version}: already published\n`);
			continue;
		}

		const publishArgs = ["publish", "--access", "public", "--tag", "latest", "--ignore-scripts"];
		if (args.provenance) {
			publishArgs.push("--provenance");
		}
		run("npm", publishArgs, { cwd: pkg.directory });
		console.log();
	}
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}

function parseArgs(argv) {
	const parsed = {
		dryRun: false,
		provenance: false,
		skipBuild: false,
		version: undefined,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			parsed.dryRun = true;
		} else if (arg === "--provenance") {
			parsed.provenance = true;
		} else if (arg === "--skip-build") {
			parsed.skipBuild = true;
		} else if (arg === "--version") {
			parsed.version = argv[++i];
			if (!parsed.version) {
				throw new Error("--version requires a value");
			}
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: node scripts/publish-averyyy-npm.mjs [options]

Options:
  --version <version>  Release version, e.g. 0.80.3-piclient.4
  --dry-run            Validate package contents without publishing
  --skip-build         Reuse existing dist output
  --provenance         Pass --provenance to npm publish`);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return parsed;
}

function normalizeVersion(value) {
	return value.startsWith("v") ? value.slice(1) : value;
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function npmInvocation(args) {
	if (process.platform === "win32") {
		return {
			command: process.execPath,
			args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args],
		};
	}
	return { command: "npm", args };
}

function run(command, args, options = {}) {
	const invocation = command === "npm" ? npmInvocation(args) : { command: commandForPlatform(command), args };
	console.log(`$ ${[invocation.command, ...invocation.args].join(" ")}`);
	const result = spawnSync(invocation.command, invocation.args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(
			output
				? `Command failed: ${invocation.command} ${invocation.args.join(" ")}\n${output}`
				: `Command failed: ${invocation.command} ${invocation.args.join(" ")}`,
		);
	}

	return result;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function setDependency(pkg, name, version) {
	pkg.dependencies = pkg.dependencies ?? {};
	pkg.dependencies[name] = version;
}

function preparePackage(tempRoot, def, version) {
	const source = join(repoRoot, def.source);
	const directory = join(tempRoot, def.id);
	cpSync(source, directory, {
		recursive: true,
		filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
	});

	const packageJsonPath = join(directory, "package.json");
	const packageJson = readJson(packageJsonPath);
	packageJson.name = def.name;
	packageJson.version = version;
	packageJson.repository = {
		type: "git",
		url: "https://github.com/Averyyy/pi-client",
		directory: def.source,
	};
	packageJson.publishConfig = { ...(packageJson.publishConfig ?? {}), access: "public" };
	def.mutate?.(packageJson, version);
	writeJson(packageJsonPath, packageJson);

	for (const file of def.removeFiles ?? []) {
		rmSync(join(directory, file), { force: true });
	}

	for (const file of def.requiredFiles) {
		if (!existsSync(join(directory, file))) {
			throw new Error(`${def.source}/${file} does not exist. Run without --skip-build to build release artifacts.`);
		}
	}

	return { ...def, directory, published: false };
}

function validatePack(pkg) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: pkg.directory });
	const packed = JSON.parse(result.stdout)[0];
	const files = new Set(packed.files.map((file) => file.path));

	for (const file of pkg.requiredFiles) {
		if (!files.has(file)) {
			throw new Error(`${pkg.name} pack output is missing ${file}`);
		}
	}
	if (pkg.id === "pi-coding-agent" && files.has("npm-shrinkwrap.json")) {
		throw new Error("@averyyy/pi-coding-agent pack output must not include the upstream npm-shrinkwrap.json");
	}

	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed`);
}

function isPublished(name, version) {
	const invocation = npmInvocation(["view", `${name}@${version}`, "version", "--json"]);
	const result = spawnSync(invocation.command, invocation.args, {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}
