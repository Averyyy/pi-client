import { readFileSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { assertValidSessionId, SessionManager } from "../core/session-manager.ts";
import {
	acceptToolEffectResult,
	inspectToolEffect,
	markToolEffectFailed,
	type ToolEffectResolutionResult,
	type ToolEffectResolutionTarget,
} from "../core/tool-effect-journal.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";

type ToolEffectsAction = "inspect" | "mark-failed" | "accept-result";

interface ToolEffectsCommand {
	action: ToolEffectsAction;
	session: string;
	effectId: string;
	sessionDir?: string;
	resultFile?: string;
}

export interface ToolEffectsCommandOptions {
	cwd: string;
	defaultSessionDir?: string;
}

function printToolEffectsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} tool-effects`)} - explicitly resolve an interrupted tool effect

${chalk.bold("Usage:")}
  ${APP_NAME} tool-effects inspect --session <path|exact-id> --effect-id <sha256>
  ${APP_NAME} tool-effects mark-failed --session <path|exact-id> --effect-id <sha256>
  ${APP_NAME} tool-effects accept-result --session <path|exact-id> --effect-id <sha256> <json-file>

${chalk.bold("Options:")}
  --session <path|exact-id>  Exact session path or complete session ID
  --effect-id <sha256>      Exact effect ID reported by the recovery error
  --session-dir <dir>       Override the session lookup directory
  --help, -h                Show this help

mark-failed records an error result without re-executing the tool. External side effects may already have occurred.
accept-result requires a complete ToolResultMessage JSON object whose toolCallId and toolName match the effect.
Neither command displays stored tool arguments or accepted result content.`);
}

function requireOptionValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function setOnce(current: string | undefined, value: string, option: string): string {
	if (current !== undefined) {
		throw new Error(`${option} may only be specified once`);
	}
	return value;
}

function parseToolEffectsCommand(args: string[]): ToolEffectsCommand | "help" {
	if (args.includes("--help") || args.includes("-h")) return "help";
	const action = args[1];
	if (action !== "inspect" && action !== "mark-failed" && action !== "accept-result") {
		throw new Error("tool-effects requires one action: inspect, mark-failed, or accept-result");
	}

	let session: string | undefined;
	let effectId: string | undefined;
	let sessionDir: string | undefined;
	const positional: string[] = [];
	for (let index = 2; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--session") {
			session = setOnce(session, requireOptionValue(args, index, argument), argument);
			index++;
			continue;
		}
		if (argument === "--effect-id") {
			effectId = setOnce(effectId, requireOptionValue(args, index, argument), argument);
			index++;
			continue;
		}
		if (argument === "--session-dir") {
			sessionDir = setOnce(sessionDir, requireOptionValue(args, index, argument), argument);
			index++;
			continue;
		}
		if (argument.startsWith("-")) {
			throw new Error(`Unknown tool-effects option: ${argument}`);
		}
		positional.push(argument);
	}

	if (!session) throw new Error("tool-effects requires --session <path|exact-id>");
	if (!effectId) throw new Error("tool-effects requires --effect-id <sha256>");
	if (action === "accept-result") {
		if (positional.length !== 1) {
			throw new Error("tool-effects accept-result requires exactly one JSON file");
		}
	} else if (positional.length > 0) {
		throw new Error(`tool-effects ${action} does not accept positional arguments`);
	}
	return {
		action,
		session,
		effectId,
		sessionDir,
		resultFile: positional[0],
	};
}

async function openExactSession(
	sessionArgument: string,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	if (sessionArgument.includes("/") || sessionArgument.includes("\\") || sessionArgument.endsWith(".jsonl")) {
		return SessionManager.open(resolvePath(sessionArgument, cwd), sessionDir);
	}

	assertValidSessionId(sessionArgument);
	const matches = [
		...(await SessionManager.list(cwd, sessionDir)),
		...(await SessionManager.listAll(sessionDir)),
	].filter((session) => session.id === sessionArgument);
	const uniquePaths = [...new Set(matches.map((session) => normalizePath(session.path)))];
	if (uniquePaths.length === 0) {
		throw new Error(`No session found with exact id '${sessionArgument}'`);
	}
	if (uniquePaths.length > 1) {
		throw new Error(`Multiple sessions have exact id '${sessionArgument}'; use an exact session path`);
	}
	return SessionManager.open(uniquePaths[0], sessionDir);
}

function printTarget(target: ToolEffectResolutionTarget): void {
	console.log(`sessionPath: ${target.sessionPath}`);
	console.log(`sessionId: ${target.sessionId}`);
	console.log(`journalPath: ${target.journalPath}`);
	console.log(`effectId: ${target.effectId}`);
	console.log(`toolCallId: ${target.toolCallId}`);
	console.log(`toolName: ${target.toolName}`);
	console.log(`phase: ${target.phase}`);
}

function printResolution(result: ToolEffectResolutionResult): void {
	printTarget(result.target);
	console.log(`sessionEntryId: ${result.sessionEntryId}`);
	console.log(`resolution: ${result.alreadyResolved ? "already-recorded" : "recorded"}`);
}

export async function handleToolEffectsCommand(args: string[], options: ToolEffectsCommandOptions): Promise<boolean> {
	if (args[0] !== "tool-effects") return false;
	try {
		const command = parseToolEffectsCommand(args);
		if (command === "help") {
			printToolEffectsHelp();
			return true;
		}
		const sessionDir = command.sessionDir ? resolvePath(command.sessionDir, options.cwd) : options.defaultSessionDir;
		const session = await openExactSession(command.session, options.cwd, sessionDir);
		if (command.action === "inspect") {
			printTarget(inspectToolEffect(session, command.effectId));
			return true;
		}
		if (command.action === "mark-failed") {
			printResolution(markToolEffectFailed(session, command.effectId));
			console.log("The tool was not re-executed; external side effects may already have occurred.");
			return true;
		}
		if (!command.resultFile) {
			throw new Error("tool-effects accept-result requires a JSON file");
		}
		const resultPath = resolvePath(command.resultFile, options.cwd);
		let result: unknown;
		try {
			result = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
		} catch (error) {
			throw new Error(`Could not read accepted result JSON from ${resultPath}`, { cause: error });
		}
		printResolution(acceptToolEffectResult(session, command.effectId, result));
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
