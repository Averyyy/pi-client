import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getNativeClipboard } from "../src/native-platform.ts";

test("macOS clipboard file paths pass through the native module API", async (t) => {
	const require = createRequire(import.meta.url);
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const modulePath = fileURLToPath(
		new URL(`../native/darwin/prebuilds/darwin-${process.arch}/darwin-platform.node`, import.meta.url),
	);
	const previous = require.cache[modulePath];
	t.after(() => {
		Object.defineProperty(process, "platform", platform);
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	});
	const paths = ["/Users/fixture/My Photos/日本語.png", "/Users/fixture/second.txt"];
	let files: string[] | null = paths;
	const failure = new Error("native file URL read failed");
	let failed = false;
	const helper = {
		getText: async () => null,
		getImage: async () => null,
		getFilePaths: async () => {
			if (failed) throw failure;
			return files;
		},
	};
	const module = new Module(modulePath);
	module.exports = helper;
	require.cache[modulePath] = module;
	Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
	const clipboard = getNativeClipboard();
	assert.equal(clipboard, helper);
	assert.deepEqual(await clipboard?.getFilePaths?.(), paths);
	files = null;
	assert.equal(await clipboard?.getFilePaths?.(), null);
	failed = true;
	await assert.rejects(() => clipboard!.getFilePaths!(), failure);
});
