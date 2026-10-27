import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { archiveReleaseSource } from "./check-model-catalog-compat.mjs";

function fixture(manifest = { name: "@earendil-works/pi-ai", version: "1.4.0" }) {
	const calls = [];
	const execute = (command, args, cwd) => {
		calls.push({ command, args, cwd });
		if (args[0] === "rev-parse") return "0123456789012345678901234567890123456789\n";
		if (args[0] === "show") return JSON.stringify(manifest);
		return "";
	};
	return { calls, execute };
}

test("resolves upstream release source independently of missing or conflicting fork tags", () => {
	const { calls, execute } = fixture();
	const temporaryDir = join("temporary", "compat");
	assert.equal(archiveReleaseSource("1.4.0", temporaryDir, execute), join(temporaryDir, "release.tar"));
	assert.deepEqual(calls[1], {
		command: "git",
		args: ["fetch", "--depth=1", "--no-tags", "https://github.com/earendil-works/pi.git", "refs/tags/v1.4.0"],
		cwd: join(temporaryDir, "source.git"),
	});
	assert.equal(calls.at(-1).args.at(-1), "0123456789012345678901234567890123456789");
	assert.equal(calls.at(-1).args[0], "archive");
});

test("fails closed when the upstream release tag cannot be fetched", () => {
	assert.throws(() => archiveReleaseSource("1.4.0", "temporary", (_command, args) => {
		if (args[0] === "fetch") throw new Error("missing upstream tag");
		return "";
	}), /missing upstream tag/);
});

test("rejects a tag with the wrong package identity or release version", () => {
	for (const manifest of [
		{ name: "@averyyy/pi-ai", version: "1.4.0" },
		{ name: "@earendil-works/pi-ai", version: "1.3.0" },
	]) {
		const { calls, execute } = fixture(manifest);
		assert.throws(() => archiveReleaseSource("1.4.0", "temporary", execute), /does not contain/);
		assert.ok(calls.every(({ args }) => args[0] !== "archive"));
	}
});

test("rejects invalid stable release references before executing commands", () => {
	for (const release of ["", "--all", "1.4.0-piclient.10", "1.4.0\nmain"]) {
		const { calls, execute } = fixture();
		assert.throws(() => archiveReleaseSource(release, "temporary", execute), /Invalid stable pi release/);
		assert.equal(calls.length, 0);
	}
});
