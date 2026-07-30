import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { beginSessionToolEffect, writeSessionToolEffectResult } from "../src/core/tool-effect-journal.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxLoaderUrl = pathToFileURL(resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var), but the
	// spawned CLI sees the physical path via process.cwd(). Session cwd
	// filtering compares paths textually, so the fixture must use physical paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-id-readonly-")));
	tempDirs.push(dir);
	return dir;
}

function findSessionWithId(root: string, sessionId: string): string | undefined {
	if (!existsSync(root)) return undefined;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = findSessionWithId(path, sessionId);
			if (nested) return nested;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

		try {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return path;
		} catch {
			// Ignore malformed session files.
		}
	}
	return undefined;
}

function hasSessionWithId(root: string, sessionId: string): boolean {
	return findSessionWithId(root, sessionId) !== undefined;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; agentDir: string; projectDir: string; sessionDir: string; stderr: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", tsxLoaderUrl, cliPath, ...resolvedArgs], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, agentDir: dirs.agentDir, projectDir: dirs.projectDir, sessionDir: dirs.sessionDir, stderr };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

function writeToolEffectSession(dirs: CliDirs, id: string, durableResult: boolean): void {
	const manager = SessionManager.create(dirs.projectDir, dirs.sessionDir, { id });
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "run tool" }], timestamp: 1 });
	manager.appendMessage(
		fauxAssistantMessage([{ ...fauxToolCall("external_write", { value: "done" }), id: "call-fork" }], {
			stopReason: "toolUse",
			timestamp: 2,
		}),
	);
	manager.flushSessionFile();
	beginSessionToolEffect(manager, {
		toolCallId: "call-fork",
		toolName: "external_write",
		args: { value: "done" },
	});
	if (durableResult) {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-fork",
			toolName: "external_write",
			content: [{ type: "text", text: "external write complete" }],
			details: { value: "done" },
			isError: false,
			timestamp: 3,
		};
		writeSessionToolEffectResult(manager, result);
	}
}

describe("--session-id read-only commands", () => {
	it("does not reserve a session for --help", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-help")).toBe(false);
	});

	it("allows --no-session with --session-id", async () => {
		const result = await runCli(["--no-session", "--session-id", "ephemeral-id", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "ephemeral-id")).toBe(false);
	});

	it("does not reserve a session for --list-models", async () => {
		const result = await runCli(["--session-id", "read-only-models", "--list-models"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-models")).toBe(false);
	});

	it("warns when a missing --session-id creates a new session", async () => {
		const result = await runCli((dirs) => [
			"--session-dir",
			dirs.sessionDir,
			"--session-id",
			"missing-session-id",
			"--model",
			"missing-model",
			"-p",
			"hi",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Warning: No project session found with id 'missing-session-id'; creating a new session with that id.",
		);
	});

	it("does not warn when --session-id opens an existing session", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--session-id",
				"existing-session-id",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-session-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No project session found with id 'existing-session-id'");
	});

	it("rejects an existing fork target session id", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--fork", "source-id", "--session-id", "existing-id", "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "source-id");
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session already exists with id 'existing-id'");
	});

	it("recovers a durable source tool result before forking", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--fork",
				"source-tool-effect",
				"--session-id",
				"recovered-fork",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeToolEffectSession(dirs, "source-tool-effect", true);
			},
		);

		expect(result.code).toBe(1);
		const forkPath = findSessionWithId(result.sessionDir, "recovered-fork");
		if (!forkPath) throw new Error("Expected recovered fork session");
		const forkEntries = readFileSync(forkPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; message?: ToolResultMessage });
		expect(
			forkEntries.some(
				(entry) =>
					entry.type === "message" &&
					entry.message?.role === "toolResult" &&
					entry.message.toolCallId === "call-fork" &&
					entry.message.content.some(
						(content) => content.type === "text" && content.text === "external write complete",
					),
			),
		).toBe(true);
	});

	it("blocks a fork when the source tool outcome is unknown", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--fork",
				"source-unknown-effect",
				"--session-id",
				"blocked-fork",
				"-p",
				"hi",
			],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeToolEffectSession(dirs, "source-unknown-effect", false);
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("outcomes are unknown");
		expect(findSessionWithId(result.sessionDir, "blocked-fork")).toBeUndefined();
	});
});

describe("--session-id validation", () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});
