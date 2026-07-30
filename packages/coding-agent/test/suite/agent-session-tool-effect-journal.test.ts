import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	beginSessionToolEffect,
	getToolEffectJournalPath,
	readDurableToolEffects,
	ToolEffectUnknownOutcomeError,
	writeSessionToolEffectFinalResult,
	writeSessionToolEffectResult,
} from "../../src/core/tool-effect-journal.ts";
import { createHarness, type Harness } from "./harness.ts";

const temporaryDirectories: string[] = [];
const harnesses: Harness[] = [];

function createPersistentSession(id: string): { directory: string; manager: SessionManager; sessionFile: string } {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-tool-effect-"));
	temporaryDirectories.push(directory);
	const manager = SessionManager.create(directory, directory, { id });
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persistent session file");
	return { directory, manager, sessionFile };
}

function appendToolCallAssistant(manager: SessionManager, toolCallId: string): void {
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "run tool" }], timestamp: 1 });
	manager.appendMessage(
		fauxAssistantMessage([{ ...fauxToolCall("external_write", { value: "done" }), id: toolCallId }], {
			stopReason: "toolUse",
			timestamp: 2,
		}),
	);
	manager.flushSessionFile();
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "external_write",
		content: [{ type: "text", text }],
		details: { text },
		isError: false,
		timestamp,
	};
}

function journalKinds(path: string): string[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { payload: string })
		.map((envelope) => JSON.parse(envelope.payload) as { kind: string })
		.map((record) => record.kind);
}

describe("AgentSession durable tool-effect integration", () => {
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fsyncs intent before hooks and execution, then commits the exact message_end result", async () => {
		const { manager, sessionFile } = createPersistentSession("integrated-tool-effect");
		const journalPath = getToolEffectJournalPath(sessionFile);
		let intentBeforeToolCallHook = false;
		let intentBeforeExecution = false;
		let assistantWasDurableBeforeExecution = false;
		const tool: AgentTool = {
			name: "external_write",
			label: "External write",
			description: "Perform an externally visible write",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				intentBeforeExecution = readDurableToolEffects(journalPath).length === 1;
				assistantWasDurableBeforeExecution = readFileSync(sessionFile, "utf8").includes('"role":"assistant"');
				return {
					content: [{ type: "text", text: "execution result" }],
					details: { phase: "execute" },
				};
			},
		};
		const harness = await createHarness({
			sessionManager: manager,
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						intentBeforeToolCallHook = readDurableToolEffects(journalPath).length === 1;
					});
					pi.on("tool_result", () => ({
						content: [{ type: "text", text: "tool_result hook" }],
						details: { phase: "tool_result" },
					}));
					pi.on("message_end", (event) => {
						if (event.message.role !== "toolResult") return;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "message_end final" }],
								details: { phase: "message_end" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([{ ...fauxToolCall("external_write", { value: "done" }), id: "call-integrated" }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run");

		expect(intentBeforeToolCallHook).toBe(true);
		expect(intentBeforeExecution).toBe(true);
		expect(assistantWasDurableBeforeExecution).toBe(true);
		const effects = readDurableToolEffects(journalPath);
		expect(effects).toHaveLength(1);
		expect(effects[0]?.result).toEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "call-integrated",
				content: [{ type: "text", text: "message_end final" }],
				details: { phase: "message_end" },
			}),
		);
		expect(effects[0]?.committedSessionEntryId).toBeDefined();
		expect(journalKinds(journalPath)).toEqual(["intent", "result", "final", "commit"]);
		const committedEntry = harness.sessionManager.getEntry(effects[0]!.committedSessionEntryId!);
		expect(committedEntry?.type === "message" ? committedEntry.message : undefined).toEqual(effects[0]?.result);
	});

	it("recovers a durable result during AgentSession construction without re-execution", async () => {
		const { manager, sessionFile } = createPersistentSession("constructor-recovery");
		appendToolCallAssistant(manager, "call-recover");
		beginSessionToolEffect(manager, {
			toolCallId: "call-recover",
			toolName: "external_write",
			args: { value: "done" },
		});
		const result = toolResult("call-recover", "durable result", 3);
		writeSessionToolEffectResult(manager, result, { finalizationPending: true });
		writeSessionToolEffectFinalResult(manager, result);

		const harness = await createHarness({ sessionManager: SessionManager.open(sessionFile) });
		harnesses.push(harness);

		expect(harness.session.messages.find((message) => message.role === "toolResult")).toEqual(result);
		expect(readDurableToolEffects(getToolEffectJournalPath(sessionFile))[0]?.committedSessionEntryId).toBeDefined();
	});

	it("fails session construction closed when final transformation outcome is unknown", async () => {
		const { manager, sessionFile } = createPersistentSession("constructor-unknown");
		appendToolCallAssistant(manager, "call-unknown-final");
		beginSessionToolEffect(manager, {
			toolCallId: "call-unknown-final",
			toolName: "external_write",
			args: { value: "done" },
		});
		const result = toolResult("call-unknown-final", "execution result", 4);
		writeSessionToolEffectResult(manager, result, { finalizationPending: true });

		await expect(createHarness({ sessionManager: SessionManager.open(sessionFile) })).rejects.toThrow(
			ToolEffectUnknownOutcomeError,
		);
		expect(
			SessionManager.open(sessionFile)
				.buildSessionContext()
				.messages.some((message) => message.role === "toolResult"),
		).toBe(false);
	});
});
