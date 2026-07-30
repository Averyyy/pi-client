import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { beginSessionToolEffect, readDurableToolEffects } from "../src/core/tool-effect-journal.ts";

const nativeCliPath = resolve(__dirname, "../src/cli.ts");
const piClientCliPath = resolve(__dirname, "../src/pi-client-cli.ts");
const tsxLoaderUrl = pathToFileURL(resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs")).href;
const temporaryDirectories: string[] = [];

interface Fixture {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
	sessionFile: string;
	sessionId: string;
	effectId: string;
	toolCallId: string;
	toolName: string;
}

function createFixture(name: string): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-effects-cli-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const sessionId = `tool-effects-${name}`;
	const toolCallId = `call-${name}`;
	const toolName = "external_write";
	const manager = SessionManager.create(projectDir, sessionDir, { id: sessionId });
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "run tool" }], timestamp: 1 });
	manager.appendMessage(
		fauxAssistantMessage(
			[
				{
					...fauxToolCall(toolName, { secretArgument: "DO_NOT_PRINT_ARGUMENT" }),
					id: toolCallId,
				},
			],
			{ stopReason: "toolUse", timestamp: 2 },
		),
	);
	manager.flushSessionFile();
	const intent = beginSessionToolEffect(manager, {
		toolCallId,
		toolName,
		args: { secretArgument: "DO_NOT_PRINT_ARGUMENT" },
	});
	const sessionFile = manager.getSessionFile();
	if (!intent || !sessionFile) throw new Error("Expected a persistent tool effect fixture");
	return {
		agentDir,
		projectDir,
		sessionDir,
		sessionFile,
		sessionId,
		effectId: intent.effectId,
		toolCallId,
		toolName,
	};
}

async function runCli(
	fixture: Fixture,
	entrypoint: string,
	args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", tsxLoaderUrl, entrypoint, ...args], {
			cwd: fixture.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: fixture.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	return { code, stdout, stderr };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("tool-effects CLI", () => {
	it("inspects and marks failed through the pi-client wrapper using exact identifiers", async () => {
		const fixture = createFixture("mark-failed");
		const inspect = await runCli(fixture, piClientCliPath, [
			"tool-effects",
			"inspect",
			"--session",
			fixture.sessionId,
			"--session-dir",
			fixture.sessionDir,
			"--effect-id",
			fixture.effectId,
		]);
		expect(inspect.code).toBe(0);
		expect(inspect.stderr).toBe("");
		expect(inspect.stdout).toContain(`sessionPath: ${fixture.sessionFile}`);
		expect(inspect.stdout).toContain(`effectId: ${fixture.effectId}`);
		expect(inspect.stdout).toContain(`toolCallId: ${fixture.toolCallId}`);
		expect(inspect.stdout).toContain(`toolName: ${fixture.toolName}`);
		expect(inspect.stdout).toContain("phase: execution_unknown");
		expect(inspect.stdout).not.toContain("DO_NOT_PRINT_ARGUMENT");

		const actionArgs = [
			"tool-effects",
			"mark-failed",
			"--session",
			fixture.sessionFile,
			"--effect-id",
			fixture.effectId,
		];
		const resolved = await runCli(fixture, piClientCliPath, actionArgs);
		expect(resolved.code).toBe(0);
		expect(resolved.stderr).toBe("");
		expect(resolved.stdout).toContain("resolution: recorded");
		expect(resolved.stdout).toContain("The tool was not re-executed");

		const retried = await runCli(fixture, piClientCliPath, actionArgs);
		expect(retried.code).toBe(0);
		expect(retried.stdout).toContain("resolution: already-recorded");
		const reopened = SessionManager.open(fixture.sessionFile, fixture.sessionDir);
		const results = reopened
			.buildSessionContext()
			.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
	});

	it("accepts an exact result file through the native CLI without displaying its content", async () => {
		const fixture = createFixture("accept-result");
		const resultFile = join(fixture.projectDir, "accepted-result.json");
		const accepted: ToolResultMessage = {
			role: "toolResult",
			toolCallId: fixture.toolCallId,
			toolName: fixture.toolName,
			content: [{ type: "text", text: "PRIVATE_RESULT_CONTENT" }],
			details: { source: "operator" },
			isError: false,
			timestamp: 10,
		};
		writeFileSync(resultFile, JSON.stringify(accepted), "utf8");

		const resolved = await runCli(fixture, nativeCliPath, [
			"tool-effects",
			"accept-result",
			"--session",
			fixture.sessionFile,
			"--effect-id",
			fixture.effectId,
			resultFile,
		]);
		expect(resolved.code).toBe(0);
		expect(resolved.stderr).toBe("");
		expect(resolved.stdout).toContain("resolution: recorded");
		expect(resolved.stdout).not.toContain("PRIVATE_RESULT_CONTENT");

		const reopened = SessionManager.open(fixture.sessionFile, fixture.sessionDir);
		expect(reopened.buildSessionContext().messages.at(-1)).toEqual(accepted);
		expect(readDurableToolEffects(`${fixture.sessionFile}.tool-effects.jsonl`)[0]).toEqual(
			expect.objectContaining({
				result: accepted,
				committedSessionEntryId: reopened.getLeafId(),
			}),
		);
	});

	it("rejects a non-exact session id and a mismatched accepted result before appending", async () => {
		const fixture = createFixture("reject");
		const partial = await runCli(fixture, piClientCliPath, [
			"tool-effects",
			"inspect",
			"--session",
			fixture.sessionId.slice(0, -1),
			"--session-dir",
			fixture.sessionDir,
			"--effect-id",
			fixture.effectId,
		]);
		expect(partial.code).toBe(1);
		expect(partial.stderr).toContain("No session found with exact id");

		const resultFile = join(fixture.projectDir, "mismatched-result.json");
		writeFileSync(
			resultFile,
			JSON.stringify({
				role: "toolResult",
				toolCallId: "different-call",
				toolName: fixture.toolName,
				content: [{ type: "text", text: "wrong" }],
				isError: false,
				timestamp: 10,
			}),
			"utf8",
		);
		const mismatched = await runCli(fixture, piClientCliPath, [
			"tool-effects",
			"accept-result",
			"--session",
			fixture.sessionFile,
			"--effect-id",
			fixture.effectId,
			resultFile,
		]);
		expect(mismatched.code).toBe(1);
		expect(mismatched.stderr).toContain("identity does not match");
		const reopened = SessionManager.open(fixture.sessionFile, fixture.sessionDir);
		expect(reopened.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});
