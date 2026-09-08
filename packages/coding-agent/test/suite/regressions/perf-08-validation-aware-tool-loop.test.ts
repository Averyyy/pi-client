import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Context, FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../harness.ts";

const bashSchema = Type.Object({ command: Type.String() });

describe("tool results without persistent validation hints", () => {
	it.each(["edit", "write"])("does not add reminders after %s results", async (name) => {
		const parameters = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof parameters, undefined> = {
			name,
			label: name,
			description: "Modify a file",
			parameters,
			execute: async (_id, params) => ({
				content: [{ type: "text", text: `modified ${params.path}` }],
				details: undefined,
			}),
		};
		const harness = await createHarness({ tools: [tool] });
		let messages: Context["messages"] = [];
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(name, { path: "src/app.ts" })], { stopReason: "toolUse" }),
				(context) => {
					messages = structuredClone(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("modify a file");
			expect(messages.filter((message) => message.role === "user").map(getMessageText)).toEqual(["modify a file"]);
			expect(messages.filter((message) => message.role === "toolResult").map(getMessageText)).toEqual([
				"modified src/app.ts",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		{ name: "corrected working directory", commands: ["git status", "cd repo && git status"], failures: [0] },
		{ name: "corrected non-Git arguments", commands: ["check --bad", "check --valid"], failures: [0] },
		{ name: "continuing real failures", commands: ["check", "check", "check"], failures: [0, 1, 2] },
		{ name: "unrelated success", commands: ["check", "echo hello"], failures: [0] },
		{
			name: "multiple subsequent tool turns",
			commands: ["git status", "git -C repo status", "echo hello", "git -C repo diff", "check"],
			failures: [0],
		},
		{ name: "new prompt after unresolved failure", commands: ["check"], failures: [0] },
	])("preserves actual results for $name", async ({ commands, failures }) => {
		let executed = 0;
		const bashTool: AgentTool<typeof bashSchema, undefined> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const index = executed++;
				if (failures.includes(index)) throw new Error(`failure ${index}: ${params.command}`);
				return { content: [{ type: "text", text: `success ${index}: ${params.command}` }], details: undefined };
			},
		};
		const harness = await createHarness({ tools: [bashTool] });
		const requests: Context["messages"][] = [];
		try {
			const responses: FauxResponseStep[] = commands.map((command) => (context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
			});
			responses.push((context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("done");
			});
			harness.setResponses(responses);
			await harness.session.prompt("inspect the problem");
			expect(executed).toBe(commands.length);
			expect(requests).toHaveLength(commands.length + 1);

			// A new prompt keeps durable evidence, without reviving run-local reminders.
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context.messages));
					return fauxAssistantMessage("new task done");
				},
			]);
			await harness.session.prompt("start another task");
			expect(requests).toHaveLength(commands.length + 2);

			for (const [requestIndex, request] of requests.entries()) {
				const userTexts = request.filter((message) => message.role === "user").map(getMessageText);
				expect(userTexts).toEqual(
					requestIndex === commands.length + 1
						? ["inspect the problem", "start another task"]
						: ["inspect the problem"],
				);
				const results = request.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(Math.min(requestIndex, commands.length));
				for (const [index, result] of results.entries()) {
					expect(result.isError).toBe(failures.includes(index));
					expect(getMessageText(result)).toContain(
						`${failures.includes(index) ? "failure" : "success"} ${index}: ${commands[index]}`,
					);
				}
			}
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
