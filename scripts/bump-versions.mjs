#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const bump = process.argv[2];
if (!["major", "minor", "patch"].includes(bump)) throw new Error("Usage: bump-versions.mjs <major|minor|patch>");
for (const { directory, name } of getPublicWorkspacePackages()) {
	if (name.startsWith("@averyyy/")) continue;
	const path = join(directory, "package.json");
	const pkg = JSON.parse(readFileSync(path, "utf8"));
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
	if (!match) continue;
	let [major, minor, patch] = match.slice(1).map(Number);
	if (bump === "major") { major++; minor = 0; patch = 0; }
	else if (bump === "minor") { minor++; patch = 0; }
	else patch++;
	pkg.version = `${major}.${minor}.${patch}`;
	writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
	console.log(`${pkg.name}\nv${pkg.version}`);
}
