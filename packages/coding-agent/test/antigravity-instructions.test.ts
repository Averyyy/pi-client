import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AntigravityInstructions,
	installAntigravityInstructions,
	readAntigravityInstructions,
} from "../src/core/antigravity-instructions.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createTestResourceLoader } from "./utilities.ts";

let home: string;
const rule = () => join(home, ".gemini", "config", "rules", "avery-ui-agents.md");
const skills = () => join(home, ".gemini", "antigravity-cli", "skills");
const skillFile = (name: string) => join(skills(), name, "SKILL.md");
const ledger = () => join(home, ".pi", "agent", "antigravity-skills.json");
const install = (instructions: AntigravityInstructions) => installAntigravityInstructions(instructions, home, ledger());

function piSkill(name: string, description = `Use ${name}`): AntigravityInstructions["skills"][number] {
	return { name, description, filePath: `/pi/skills/${name}/SKILL.md`, baseDir: `/pi/skills/${name}` };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-antigravity-instructions-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("installAntigravityInstructions", () => {
	it("writes the global AGENTS.md as an agy rule and each skill as a declaration, with nothing else in them", async () => {
		await install({
			agentsFile: { path: "/pi/agent/AGENTS.md", content: "Answer in English." },
			skills: [piSkill("review", 'Review "diffs"\nand tests')],
		});
		expect(readFileSync(rule(), "utf8")).toBe("Answer in English.");
		expect(readFileSync(skillFile("review"), "utf8")).toBe(
			[
				"---",
				"name: review",
				'description: "Review \\"diffs\\"\\nand tests"',
				"---",
				"Before you use this skill, read its instructions in `/pi/skills/review/SKILL.md`.",
				"Resolve relative paths in it against `/pi/skills/review` and use absolute paths in tool calls.",
				"",
			].join("\n"),
		);
	});

	it("mirrors the latest session: removes Pi's stale rule and skills and keeps the user's own", async () => {
		mkdirSync(join(skills(), "mine"), { recursive: true });
		writeFileSync(skillFile("mine"), "---\nname: mine\ndescription: agy's own\n---\n");
		mkdirSync(join(skills(), "review"), { recursive: true });
		writeFileSync(skillFile("review"), "---\nname: review\ndescription: the user's agy review\n---\n");
		const linked = join(home, "linked-skill");
		mkdirSync(linked);
		writeFileSync(join(linked, "SKILL.md"), "---\nname: linked\ndescription: linked\n---\n");
		symlinkSync(linked, join(skills(), "linked"), "dir");
		await install({
			agentsFile: { path: "/pi/agent/AGENTS.md", content: "rules" },
			skills: [piSkill("old"), piSkill("review"), piSkill("linked"), piSkill("kept"), piSkill("edited")],
		});
		// A declaration Pi wrote and the user then changed becomes the user's.
		writeFileSync(skillFile("edited"), "---\nname: edited\ndescription: mine now\n---\n");
		await install({ skills: [piSkill("kept", "Use kept, changed")] });
		expect(existsSync(rule())).toBe(false);
		expect(readdirSync(skills()).sort()).toEqual(["edited", "kept", "linked", "mine", "review"]);
		expect(readFileSync(skillFile("kept"), "utf8")).toContain('description: "Use kept, changed"');
		// Pi never writes into a skill folder or link it did not create.
		expect(readFileSync(skillFile("review"), "utf8")).toContain("the user's agy review");
		expect(readFileSync(join(linked, "SKILL.md"), "utf8")).toContain("description: linked");
		expect(readFileSync(skillFile("mine"), "utf8")).toContain("agy's own");
		expect(readFileSync(skillFile("edited"), "utf8")).toContain("mine now");
		expect(Object.keys(JSON.parse(readFileSync(ledger(), "utf8")))).toEqual(["kept"]);
	});

	it("takes back its own declarations after the ledger is lost, and removes them later", async () => {
		await install({ skills: [piSkill("review")] });
		rmSync(ledger());
		await install({ skills: [piSkill("review")] });
		await install({ skills: [] });
		expect(readdirSync(skills())).toEqual([]);
	});

	it("skips names agy cannot use as a skill folder, which also keeps writes inside the skills directory", async () => {
		await install({ skills: [piSkill("../escape"), piSkill("Upper"), piSkill("a".repeat(65)), piSkill("ok-name")] });
		expect(readdirSync(skills())).toEqual(["ok-name"]);
		expect(existsSync(join(home, ".gemini", "antigravity-cli", "escape"))).toBe(false);
	});
});

describe("readAntigravityInstructions", () => {
	it("takes only the global context file and the skills the model may load", () => {
		const skill = (name: string, disableModelInvocation: boolean): Skill => ({
			name,
			description: `Use ${name}`,
			filePath: `/pi/agent/skills/${name}/SKILL.md`,
			baseDir: `/pi/agent/skills/${name}`,
			sourceInfo: createSyntheticSourceInfo(`/pi/agent/skills/${name}/SKILL.md`, { source: "user" }),
			disableModelInvocation,
		});
		const resources = {
			...createTestResourceLoader(),
			getAgentsFiles: () => ({
				agentsFiles: [
					{ path: "/pi/agent/AGENTS.md", content: "global" },
					{ path: "/work/project/AGENTS.md", content: "project" },
				],
			}),
			getSkills: () => ({ skills: [skill("visible", false), skill("manual", true)], diagnostics: [] }),
		};
		expect(readAntigravityInstructions(resources, "/pi/agent")).toEqual({
			agentsFile: { path: "/pi/agent/AGENTS.md", content: "global" },
			skills: [
				{
					name: "visible",
					description: "Use visible",
					filePath: "/pi/agent/skills/visible/SKILL.md",
					baseDir: "/pi/agent/skills/visible",
				},
			],
		});
		expect(readAntigravityInstructions(resources, "/elsewhere")).toEqual({ skills: expect.any(Array) });
	});
});
