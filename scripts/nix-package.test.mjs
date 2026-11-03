import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const nixPackage = readFileSync(new URL("nix/package.nix", root), "utf8");
const installLock = JSON.parse(readFileSync(new URL("packages/coding-agent/install-lock/package-lock.json", root), "utf8"));
const workspaceLock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const sourceOverrides = new Map(
	[...nixPackage.matchAll(/^\s+"([^"]+)" = workspacePackages \+ "\/([^"]+)\.tgz";$/gm)].map((match) => [match[1], match[2]]),
);
const packedWorkspaces = new Map(
	[...nixPackage.matchAll(/^\s+pack_package (\S+) (\S+)$/gm)].map((match) => [match[2], match[1]]),
);

test("Nix workspace test dependencies resolve the pinned Vitest without registry metadata", () => {
	for (const [workspace, entry] of Object.entries(workspaceLock.packages)) {
		if (!workspace || !entry.name || workspace.includes("node_modules")) continue;
		const manifest = JSON.parse(readFileSync(new URL(`${workspace}/package.json`, root), "utf8"));
		if (!manifest.devDependencies?.vitest) continue;
		// A stale nested version shadows the root pin and forces offline npm to fetch metadata.
		const resolved = workspaceLock.packages[`${workspace}/node_modules/vitest`] ?? workspaceLock.packages["node_modules/vitest"];
		assert.equal(resolved?.version, manifest.devDependencies.vitest, `${workspace} has a stale Vitest resolution`);
	}
});

test("Nix overrides every runtime registry package without integrity", () => {
	for (const [modulePath, entry] of Object.entries(installLock.packages)) {
		if (!entry.integrity && /^https?:\/\//.test(entry.resolved ?? "")) {
			assert.ok(sourceOverrides.has(modulePath), `${modulePath} needs a local Nix source override`);
		}
	}
});

test("Nix source overrides point to packed workspaces with the matching package name", () => {
	for (const [modulePath, tarball] of sourceOverrides) {
		const workspace = packedWorkspaces.get(tarball);
		assert.ok(workspace, `${modulePath} points to unpacked ${tarball}.tgz`);
		const manifest = JSON.parse(readFileSync(new URL(`${workspace}/package.json`, root), "utf8"));
		assert.equal(modulePath, `node_modules/${manifest.name}`);
		assert.ok(installLock.packages[modulePath], `${modulePath} is absent from the runtime install lock`);
	}
});
