import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildRuntimeReloadArgs } from "../src/main.ts";

describe("runtime reload arguments", () => {
	it("retains invocation settings and resolved resources without replaying initial input or model selection", () => {
		const parsed = parseArgs([
			"--provider",
			"original",
			"--model",
			"original/model",
			"--thinking",
			"high",
			"--session",
			"old-session",
			"--session-dir",
			"old-dir",
			"--name",
			"Old name",
			"--api-key",
			"test-key",
			"--system-prompt",
			"Literal system prompt",
			"--append-system-prompt",
			"Append one",
			"--append-system-prompt",
			"Append two",
			"--models",
			"scope/*",
			"--tools",
			"read,write",
			"--exclude-tools",
			"bash",
			"--no-tools",
			"--no-builtin-tools",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--use-theme",
			"dark",
			"--mode",
			"text",
			"--verbose",
			"--tui-mode",
			"regular",
			"--no-approve",
			"--offline",
			"--fixture-boolean",
			"--fixture-string=@value-with-dash",
			"@consumed.md",
			"Initial prompt",
		]);
		const paths = {
			extensions: ["C:/absolute/extension.ts", "builtin:llama"],
			skills: ["C:/absolute/SKILL.md"],
			promptTemplates: ["C:/absolute/prompt.md"],
			themes: ["C:/absolute/theme.json"],
		};

		const resumed = parseArgs(buildRuntimeReloadArgs(parsed, paths));

		expect(resumed).toMatchObject({
			...paths,
			apiKey: "test-key",
			systemPrompt: "Literal system prompt",
			appendSystemPrompt: ["Append one", "Append two"],
			models: ["scope/*"],
			tools: ["read", "write"],
			excludeTools: ["bash"],
			noTools: true,
			noBuiltinTools: true,
			noExtensions: true,
			noMcp: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			useTheme: "dark",
			mode: "text",
			verbose: true,
			tuiMode: "regular",
			projectTrustOverride: false,
			offline: true,
			messages: [],
			fileArgs: [],
			diagnostics: [],
		});
		expect(resumed.unknownFlags).toEqual(
			new Map<string, boolean | string>([
				["fixture-boolean", true],
				["fixture-string", "@value-with-dash"],
			]),
		);
		for (const field of ["provider", "model", "thinking", "session", "sessionDir", "name"] as const) {
			expect(resumed[field]).toBeUndefined();
		}
	});
});
