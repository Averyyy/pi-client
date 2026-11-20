/**
 * Request-time rewrite of pi's built-in system prompt prose for the Antigravity backend.
 *
 * Google's Antigravity backend rejects requests whose system instruction carries pi's default
 * wording with a bare `429 RESOURCE_EXHAUSTED`, while the account still has quota. Each exact
 * string below is replaced by wording that keeps the same instruction without naming the
 * harness. Paths, tool names and schemas, user rules, project context, skill entries, extension
 * sections, and unknown text pass through unchanged, and only the serialized request is
 * affected, never the transcript.
 *
 * The replacement wording mirrors the MIT-licensed `specode/pi-antigravity` extension.
 */

import type { Message, SystemMessage } from "../types.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getCurrentSystemMessage } from "../utils/transcript.ts";

const PI_OPENING =
	"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

const ANTIGRAVITY_OPENING = [
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.",
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.",
	"The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.",
].join("\n");

/** Whole-line replacements, applied only inside the named built-in section. */
const LINE_REPLACEMENTS: Readonly<Record<string, ReadonlyMap<string, string>>> = {
	tools: new Map([
		["- read: Read file contents", "- read: View the contents of a file"],
		["- bash: Execute bash commands (ls, grep, find, etc.)", "- bash: Run shell commands in the workspace"],
		[
			"- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			"- edit: Apply exact text replacements to an existing file; several separate replacements can be made in one call",
		],
		["- write: Create or overwrite files", "- write: Create a file or replace its entire contents"],
		[
			"- grep: Search file contents for patterns (respects .gitignore)",
			"- grep: Search file contents for a pattern; ignored files are skipped",
		],
		[
			"- find: Find files by glob pattern (respects .gitignore)",
			"- find: Locate files by glob pattern; ignored files are skipped",
		],
		["- ls: List directory contents", "- ls: List the entries in a directory"],
		["- powershell: Execute PowerShell commands", "- powershell: Run PowerShell commands in the workspace"],
		["Additional tools may be available.", "Other tools may also be available."],
	]),
	rules: new Map([
		["- Use read to examine files instead of cat or sed.", "- Prefer read over cat or sed when viewing files."],
		[
			"- You can inspect PI_* environment variables for current model and session details.",
			"- Details about the current model and session are available as environment variables; list them with env.",
		],
		[
			"- Use edit for targeted changes. Batch changes to one file in a single call.",
			"- Use edit for focused changes, grouping all changes to the same file into one call.",
		],
		[
			"- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
			"- Every edits[].oldText has to match the original file exactly and only once. Keep each match short and separate from the others; combine nearby changes instead of copying large unchanged regions.",
		],
		["- Use write only for new files or complete rewrites.", "- Reserve write for new files or full rewrites."],
		["- Use bash for file operations like ls, rg, find", "- Use bash for file operations such as ls, rg, and find"],
		[
			"- Use bash or PowerShell for file operations like listing, searching, and finding files",
			"- Use bash or PowerShell to list, search, and locate files",
		],
		[
			"- Use PowerShell for file operations like listing, searching, and finding files",
			"- Use PowerShell to list, search, and locate files",
		],
		["- Be concise in your responses", "- Keep responses concise"],
		["- Show file paths clearly when working with files", "- State file paths clearly when referring to files"],
	]),
	project_context: new Map([
		["Project-specific instructions and guidelines:", "Instructions provided for this workspace:"],
	]),
	skills: new Map([
		[
			"The following skills provide specialized instructions for specific tasks.",
			"Skills below contain specialized instructions for particular tasks.",
		],
		[
			"Use the read tool to load a skill's file when the task matches its description.",
			"When a task matches a skill's description, load that skill's file with the read tool.",
		],
		[
			"Use bash to load a skill's file when the task matches its description.",
			"When a task matches a skill's description, load that skill's file with bash.",
		],
		[
			"Load a skill's file when the task matches its description.",
			"When a task matches a skill's description, load that skill's file.",
		],
		[
			"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
			"Relative paths inside a skill are relative to its directory (the folder containing SKILL.md); use absolute paths in tool calls.",
		],
	]),
};

const DOCS_HEADER =
	"Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):";
const DOCS_RESOLVE =
	"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory";
const DOCS_TOPICS =
	"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)";
const DOCS_BEFORE =
	"- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DOCS_SECTION = new RegExp(
	`^<docs>\\n${escapeRegExp(DOCS_HEADER)}\\n` +
		"- Main documentation: ([^\\n]+)\\n- Additional docs: ([^\\n]+)\\n- Examples: ([^\\n]+) \\(extensions, custom tools, SDK\\)\\n" +
		`${escapeRegExp(DOCS_RESOLVE)}\\n${escapeRegExp(DOCS_TOPICS)}\\n${escapeRegExp(DOCS_BEFORE)}\\n</docs>$`,
);

/**
 * Render the current transcript system prompt with pi's built-in prose adapted for Antigravity.
 * Returns an empty string when the transcript has no system message.
 */
export function adaptAntigravitySystemPrompt(messages: readonly Message[]): string {
	const current = getCurrentSystemMessage(messages);
	if (!current) return "";
	const sections = current.sections
		? Object.fromEntries(
				Object.entries(current.sections).map(([name, text]) => [
					name,
					text === null ? null : adaptSection(name, text),
				]),
			)
		: undefined;
	const adapted: SystemMessage = sections === undefined ? current : { ...current, sections };
	// Rendered prompts (session naming, forced prompts) carry no sections, so the rendered
	// text is adapted again; the rewrites are exact and leave already-adapted text alone.
	return adaptRenderedText(getSystemMessageText(adapted));
}

/** Apply every built-in rewrite to a prompt rendered to text. */
function adaptRenderedText(prompt: string): string {
	return rewriteOpening(adaptBuiltinLines(adaptDocsBlock(prompt)));
}

function adaptSection(name: string, section: string): string {
	if (name === "preamble") return section === PI_OPENING ? ANTIGRAVITY_OPENING : section;
	if (name === "docs") return adaptDocs(section);
	const replacements = LINE_REPLACEMENTS[name];
	return replacements ? adaptLines(section, replacements) : section;
}

/** Keep the three documentation locations; the topic index becomes a directory listing hint. */
function adaptDocs(section: string): string {
	const match = DOCS_SECTION.exec(section);
	if (!match) return section;
	const [, readme, docs, examples] = match;
	return [
		"<docs>",
		"Agent harness reference (consult only when the user asks about the harness itself: its SDK, extensions, themes, skills, or terminal UI):",
		`- Overview: ${readme}`,
		`- Guides: ${docs}`,
		`- Examples: ${examples}`,
		"- Resolve docs/... under Guides and examples/... under Examples, not the working directory.",
		"- To find the guide for a topic, list the Guides directory and open the matching file.",
		"- Before changing harness configuration or extensions, read the relevant guides and examples in full, including cross-references.",
		"</docs>",
	].join("\n");
}

function adaptLines(section: string, replacements: ReadonlyMap<string, string>): string {
	return section
		.split("\n")
		.map((line) => replacements.get(line) ?? line)
		.join("\n");
}

function adaptBuiltinLines(text: string): string {
	let adapted = text;
	for (const replacements of Object.values(LINE_REPLACEMENTS)) adapted = adaptLines(adapted, replacements);
	return adapted;
}

/** Rewrite the tagged docs section wherever it sits in a rendered prompt. */
function adaptDocsBlock(text: string): string {
	const start = text.indexOf("<docs>\n");
	if (start === -1) return text;
	const end = text.indexOf("\n</docs>", start);
	if (end === -1) return text;
	const blockEnd = end + "\n</docs>".length;
	const original = text.slice(start, blockEnd);
	const adapted = adaptDocs(original);
	return adapted === original ? text : text.slice(0, start) + adapted + text.slice(blockEnd);
}

/** Replace only the exact default leading sentence, leaving any other prompt untouched. */
function rewriteOpening(prompt: string): string {
	if (!prompt.startsWith(PI_OPENING)) return prompt;
	const suffix = prompt.slice(PI_OPENING.length);
	if (suffix !== "" && !/^\s/.test(suffix)) return prompt;
	return ANTIGRAVITY_OPENING + suffix;
}
