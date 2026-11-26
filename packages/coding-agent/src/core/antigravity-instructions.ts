// Pi's global AGENTS.md and skill declarations, written as agy's own global rule and skill files.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, isPathWithin, pathsEqual } from "../utils/paths.ts";
import { ANTIGRAVITY_CLIENT_NAME } from "./antigravity-acp.ts";
import type { ResourceLoader } from "./resource-loader.ts";

/**
 * The user's own Pi instructions agy loads natively: the global context file and the skills the
 * model may load. Pi's base prompt, tool rules, and summaries never become agy files.
 */
export interface AntigravityInstructions {
	/** Pi's global context file (`AGENTS.md` in the agent directory), when there is one. */
	agentsFile?: { path: string; content: string };
	/** Model-invocable skills. Paths are in the Pi workspace, where agy's file reads run. */
	skills: { name: string; description: string; filePath: string; baseDir: string }[];
}

/** The instructions of a Pi session's resources: its global context file and model-invocable skills. */
export function readAntigravityInstructions(resources: ResourceLoader, agentDir: string): AntigravityInstructions {
	const agentsFile = resources.getAgentsFiles().agentsFiles.find((file) => pathsEqual(dirname(file.path), agentDir));
	const skills = resources
		.getSkills()
		.skills.filter((skill) => !skill.disableModelInvocation)
		.map(({ name, description, filePath, baseDir }) => ({ name, description, filePath, baseDir }));
	return agentsFile ? { agentsFile: { path: agentsFile.path, content: agentsFile.content }, skills } : { skills };
}

/** Give Pi-managed skill directories client-local aliases usable by ACP file reads and shell commands alike. */
export async function aliasAntigravitySkills(instructions: AntigravityInstructions): Promise<AntigravityInstructions> {
	const home = homedir();
	const agent = join(home, CONFIG_DIR_NAME, "agent");
	const state = join(home, `.${ANTIGRAVITY_CLIENT_NAME}`);
	const directories = new Map<string, string>();
	const skills = instructions.skills.map((skill) => {
		let source: string;
		let alias: string;
		if (isPathWithin(agent, skill.baseDir) && !pathsEqual(agent, skill.baseDir)) {
			const [resource] = relative(agent, skill.baseDir).split(sep);
			source = join(agent, resource);
			alias = pathsEqual(source, join(agent, "skills")) ? join(state, "skills") : join(state, "resources", resource);
		} else {
			const { root } = parse(skill.baseDir);
			const parts = relative(root, skill.baseDir).split(sep);
			const config = parts.findIndex((part) =>
				process.platform === "win32"
					? part.toLowerCase() === CONFIG_DIR_NAME.toLowerCase()
					: part === CONFIG_DIR_NAME,
			);
			if (config === -1) return skill;
			const project = parts.slice(0, config);
			const resource = parts[config + 1] ?? "";
			source = join(root, ...project, parts[config], resource);
			// Reserve @resources beneath each project, including projects nested inside another one.
			const owner = project.map((part) => (part.startsWith("@") ? `@${part}` : part));
			alias = join(state, "projects", encodeURIComponent(root), ...owner, "@resources", resource);
		}
		directories.set(alias, source);
		return {
			...skill,
			baseDir: join(alias, relative(source, skill.baseDir)),
			filePath: join(alias, relative(source, skill.filePath)),
		};
	});
	await Promise.all(Array.from(directories, ([alias, source]) => linkSkillDirectory(source, alias)));
	return { ...instructions, skills };
}

async function linkSkillDirectory(source: string, alias: string): Promise<void> {
	await mkdir(dirname(alias), { recursive: true });
	try {
		await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!pathsEqual(await realpath(alias), await realpath(source)))
			throw new Error(`Skill directory alias is in use: ${alias}`);
	}
}

/**
 * Write the instructions as agy's global rule and skills under `home`, the home directory of the
 * user agy runs as, and remove the skills Pi wrote before that the session no longer has. The files
 * hold only what agy should read; the host ledger records which declarations this client wrote.
 * agy reads these directories when it starts, so the latest Pi session to start agy on a machine sets them.
 */
export async function installAntigravityInstructions(
	instructions: AntigravityInstructions,
	home: string,
	previousLedger: string,
): Promise<void> {
	const ledger = join(home, `.${ANTIGRAVITY_CLIENT_NAME}`, "antigravity-skills.json");
	await Promise.all([
		writeRule(
			instructions.agentsFile,
			join(home, ".gemini", "config", "rules", `${ANTIGRAVITY_CLIENT_NAME}-agents.md`),
		),
		writeSkills(instructions.skills, join(home, ".gemini", "antigravity-cli", "skills"), ledger, previousLedger),
	]);
}

async function writeRule(file: AntigravityInstructions["agentsFile"], path: string): Promise<void> {
	if (!file) return rm(path, { force: true });
	await writeChanged(path, file.content);
}

/** The Agent Skills name rule, which agy requires of a skill folder name. */
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function writeSkills(
	skills: AntigravityInstructions["skills"],
	dir: string,
	ledger: string,
	previousLedger: string,
): Promise<void> {
	// Names become folder names and reach PiServer as wire input; a name outside the rule is skipped.
	const wanted = new Map(
		skills.filter((skill) => SKILL_NAME.test(skill.name)).map((skill) => [skill.name, declareSkill(skill)]),
	);
	const previous = pathsEqual(ledger, previousLedger) ? undefined : await readLedger(previousLedger);
	const written = { ...previous, ...(await readLedger(ledger)) };
	for (const entry of await readEntries(dir)) {
		const content = entry.isDirectory()
			? await readFile(join(dir, entry.name, "SKILL.md"), "utf8").catch(() => undefined)
			: undefined;
		// Pi's folder is unchanged since Pi wrote it, or already holds what Pi would write (a lost ledger).
		const ours =
			content !== undefined && (digest(content) === written[entry.name] || content === wanted.get(entry.name));
		// The user's own agy skill, a link to one, or a declaration the user edited keeps its name.
		if (!ours) wanted.delete(entry.name);
		else if (!wanted.has(entry.name)) await rm(join(dir, entry.name), { recursive: true, force: true });
	}
	await Promise.all([...wanted].map(([name, content]) => writeChanged(join(dir, name, "SKILL.md"), content)));
	await writeChanged(
		ledger,
		JSON.stringify(Object.fromEntries([...wanted].map(([name, content]) => [name, digest(content)]))),
	);
	if (previous && !pathsEqual(canonicalizePath(previousLedger), canonicalizePath(ledger)))
		await rm(previousLedger, { force: true });
}

async function readEntries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Skill name to the digest of the SKILL.md Pi wrote. A missing or torn ledger records nothing. */
async function readLedger(path: string): Promise<Record<string, string> | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** agy lists a skill by its frontmatter; when it uses one, it reads Pi's SKILL.md through the Pi workspace. */
function declareSkill(skill: AntigravityInstructions["skills"][number]): string {
	return [
		"---",
		`name: ${skill.name}`,
		// A JSON string is a valid YAML double-quoted scalar.
		`description: ${JSON.stringify(skill.description)}`,
		"---",
		`Before you use this skill, read its instructions in \`${skill.filePath}\`.`,
		`Resolve relative paths in it against \`${skill.baseDir}\` and use absolute paths in tool calls.`,
		"",
	].join("\n");
}

/** Skip unchanged files, so every agy start does not rewrite them. */
async function writeChanged(path: string, content: string): Promise<void> {
	if ((await readFile(path, "utf8").catch(() => undefined)) === content) return;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}
