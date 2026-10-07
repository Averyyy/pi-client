import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkNixVersion } from "./check-nix-version.mjs";

for (const tag of [undefined, "v1.0.4", "v1.0.4-piclient.1", "v1.0.4-piclient.12"]) {
	test(`accepts the source runtime version for ${tag ?? "an untagged build"}`, () => {
		assert.doesNotThrow(() => checkNixVersion("1.0.4", "1.0.4", tag));
	});
}

for (const version of ["", "1.0.3", "1.0.4-piclient.1", "1.0.4\nextra output"]) {
	test(`rejects runtime version ${JSON.stringify(version)} even with a matching fork tag`, () => {
		assert.throws(() => checkNixVersion(version, "1.0.4", "v1.0.4-piclient.1"), /runtime version/);
	});
}

for (const tag of ["", "v1.0.3", "v1.0.3-piclient.1", "1.0.4-piclient.1", "v1.0.4-other.1", "v1.0.4-piclient", "v1.0.4-piclient.x", "v1.0.4-piclient.01", "v1.0.4-piclient.1-extra"]) {
	test(`rejects an unrelated or malformed release tag ${JSON.stringify(tag)}`, () => {
		assert.throws(() => checkNixVersion("1.0.4", "1.0.4", tag), /Release tag/);
	});
}

test("the CLI checks the coding-agent source manifest", () => {
	const { version } = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
	const script = fileURLToPath(new URL("./check-nix-version.mjs", import.meta.url));
	const success = spawnSync(process.execPath, [script, version, `v${version}-piclient.1`], { encoding: "utf8" });
	assert.equal(success.status, 0, success.stderr);
	const failure = spawnSync(process.execPath, [script, `${version}-piclient.1`, `v${version}-piclient.1`], { encoding: "utf8" });
	assert.notEqual(failure.status, 0);
	assert.match(failure.stderr, /runtime version/);
});
