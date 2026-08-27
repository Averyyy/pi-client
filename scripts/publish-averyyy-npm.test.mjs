import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publishScript = fileURLToPath(new URL("./publish-averyyy-npm.mjs", import.meta.url));

test("builds local workspace dependencies before Averyyy publish targets", () => {
	const result = spawnSync(process.execPath, [publishScript, "--self-test"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /self-test ok/);
});
