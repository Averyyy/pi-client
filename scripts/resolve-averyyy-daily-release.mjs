#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const githubRepo = process.env.GITHUB_REPOSITORY ?? "Averyyy/pi-client";
const versionPattern = /^\d+\.\d+\.\d+-piclient\.\d+$/;

const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
	selfTest();
	process.exit(0);
}

const outputs = args.event === "schedule" ? resolveScheduledRelease() : resolveRequestedRelease(args.releaseVersion);
writeOutputs(outputs);

function parseArgs(argv) {
	const parsed = {
		event: process.env.GITHUB_EVENT_NAME ?? "",
		releaseVersion: process.env.RELEASE_VERSION ?? "",
		output: process.env.GITHUB_OUTPUT,
		selfTest: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--event") {
			parsed.event = requiredValue(argv[++i], arg);
		} else if (arg === "--release-version") {
			parsed.releaseVersion = requiredValue(argv[++i], arg);
		} else if (arg === "--output") {
			parsed.output = requiredValue(argv[++i], arg);
		} else if (arg === "--self-test") {
			parsed.selfTest = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return parsed;
}

function requiredValue(value, flag) {
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function resolveRequestedRelease(value) {
	const version = normalizeVersion(value);
	assertForkVersion(version);
	return {
		should_publish: "true",
		create_release: "false",
		release_version: version,
		release_tag: `v${version}`,
		latest_release_tag: "",
	};
}

function resolveScheduledRelease() {
	run("git", ["fetch", "--tags", "--force", "origin"], { cwd: repoRoot });

	const latestReleaseTag = run("gh", ["release", "list", "--repo", githubRepo, "--exclude-drafts", "--limit", "1", "--json", "tagName", "--jq", ".[0].tagName // \"\""], {
		cwd: repoRoot,
		capture: true,
	}).stdout.trim();

	if (latestReleaseTag) {
		run("git", ["rev-parse", "--verify", `refs/tags/${latestReleaseTag}`], { cwd: repoRoot, capture: true });
		const firstNewCommit = run("git", ["log", "--format=%H", "--max-count=1", `${latestReleaseTag}..HEAD`], { cwd: repoRoot, capture: true }).stdout.trim();
		if (!firstNewCommit) {
			return {
				should_publish: "false",
				create_release: "false",
				release_version: "",
				release_tag: "",
				latest_release_tag: latestReleaseTag,
			};
		}
	}

	const clientPackageJson = readJson(join(repoRoot, "packages/pi-client/package.json"));
	const upstreamPackageJson = readJson(join(repoRoot, "packages/ai/package.json"));
	const baseVersion = basePiVersion(upstreamPackageJson);
	const tags = run("git", ["tag", "--list", `v${baseVersion}-piclient.*`], { cwd: repoRoot, capture: true })
		.stdout.trim()
		.split("\n")
		.filter(Boolean);
	const version = nextForkVersion(baseVersion, tags, clientPackageJson.version);

	return {
		should_publish: "true",
		create_release: "true",
		release_version: version,
		release_tag: `v${version}`,
		latest_release_tag: latestReleaseTag,
	};
}

function normalizeVersion(value) {
	return value.startsWith("v") ? value.slice(1) : value;
}

function assertForkVersion(version) {
	if (!versionPattern.test(version)) {
		throw new Error(`Expected version like 0.80.3-piclient.4, got ${version}`);
	}
}

function basePiVersion(packageJson) {
	const baseVersion = packageJson.version.replace(/-piclient\.\d+$/, "");
	if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
		throw new Error(`Expected base Pi version like 0.80.3, got ${baseVersion}`);
	}
	return baseVersion;
}

function nextForkVersion(baseVersion, tags, currentVersion) {
	const prefix = `v${baseVersion}-piclient.`;
	let suffix = currentVersion.startsWith(`${baseVersion}-piclient.`) ? Number(currentVersion.slice(`${baseVersion}-piclient.`.length)) : 0;

	for (const tag of tags) {
		if (!tag.startsWith(prefix)) continue;
		const tagSuffix = Number(tag.slice(prefix.length));
		if (Number.isInteger(tagSuffix) && tagSuffix > suffix) {
			suffix = tagSuffix;
		}
	}

	const version = `${baseVersion}-piclient.${suffix + 1}`;
	assertForkVersion(version);
	return version;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeOutputs(outputs) {
	for (const [key, value] of Object.entries(outputs)) {
		console.log(`${key}=${value}`);
	}

	if (!args.output) return;
	appendFileSync(args.output, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${commandArgs.join(" ")}\n${output}` : `Command failed: ${command} ${commandArgs.join(" ")}`);
	}

	return result;
}

function selfTest() {
	assertEqual(normalizeVersion("v0.80.3-piclient.5"), "0.80.3-piclient.5");
	assertEqual(basePiVersion({ version: "0.80.3-piclient.3", piClient: { basePiVersion: "0.80.3" } }), "0.80.3");
	assertEqual(nextForkVersion("0.80.3", ["v0.80.3-piclient.4", "v0.80.3-piclient.5", "v0.80.2-piclient.9"], "0.80.3-piclient.3"), "0.80.3-piclient.6");
	assertEqual(nextForkVersion("0.81.0", [], "0.81.0-piclient.0"), "0.81.0-piclient.1");
	console.log("self-test ok");
}

function assertEqual(actual, expected) {
	if (actual !== expected) {
		throw new Error(`Expected ${expected}, got ${actual}`);
	}
}
