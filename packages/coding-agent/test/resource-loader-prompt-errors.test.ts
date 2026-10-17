import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("resource loader prompt files", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-prompt-files-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(["SYSTEM.md", "APPEND_SYSTEM.md"])("surfaces read failures from discovered %s", async (filename) => {
		mkdirSync(join(cwd, ".pi", filename));
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });

		await expect(loader.reload()).rejects.toMatchObject({ code: "EISDIR" });
		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getAppendSystemPrompt()).toEqual([]);
	});

	it.each(["system", "append"] as const)("surfaces read failures from an explicit %s prompt path", async (kind) => {
		const promptPath = join(root, "prompt");
		mkdirSync(promptPath);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			...(kind === "system" ? { systemPrompt: promptPath } : { appendSystemPrompt: [promptPath] }),
		});

		await expect(loader.reload()).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("loads file-backed prompts and keeps literal strings", async () => {
		const promptPath = join(root, "prompt.md");
		writeFileSync(promptPath, "File instructions");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			systemPrompt: promptPath,
			appendSystemPrompt: [promptPath, "Literal instructions"],
		});

		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("File instructions");
		expect(loader.getAppendSystemPrompt()).toEqual(["File instructions", "Literal instructions"]);
	});
});
