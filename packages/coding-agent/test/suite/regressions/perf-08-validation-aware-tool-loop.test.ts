import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../harness.ts";

const editSchema = Type.Object({ path: Type.String() });
const bashSchema = Type.Object({ command: Type.String() });

type EditParams = Static<typeof editSchema>;
type BashParams = Static<typeof bashSchema>;

describe("validation-aware tool loop", () => {
	function editTool(): AgentTool<typeof editSchema, undefined> {
		return {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: editSchema,
			execute: async (_toolCallId, params: EditParams) => ({
				content: [{ type: "text", text: `edited ${params.path}` }],
				details: undefined,
			}),
		};
	}

	it("injects recent modifications and failed validation before the next provider request", async () => {
		const bashTool: AgentTool<typeof bashSchema, undefined> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, params: BashParams) => {
				throw new Error(`${params.command}\nsrc/app.ts(1,1): error TS2322\nCommand exited with code 2`);
			},
		};
		const harness = await createHarness({ tools: [editTool(), bashTool] });

		try {
			let nextRequestUserTexts: string[] = [];
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("edit", { path: "src/app.ts" }), fauxToolCall("bash", { command: "npm run check" })],
					{ stopReason: "toolUse" },
				),
				(context) => {
					nextRequestUserTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => getMessageText(message));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("fix it");

			const hint = nextRequestUserTexts.find((text) => text.includes("<validation-hint>"));
			expect(hint).toContain("Recent modified files:");
			expect(hint).toContain("- src/app.ts");
			expect(hint).toContain("Recent failed command:");
			expect(hint).toContain("npm run check");
			expect(hint).toContain("Failure summary:");
			expect(hint).toContain("error TS2322");
			expect(hint).toContain("Suggested next validation command:\nnpm run check");
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("does not keep asking for validation after a successful bash run", async () => {
		const bashTool: AgentTool<typeof bashSchema, undefined> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, params: BashParams) => ({
				content: [{ type: "text", text: `${params.command} passed` }],
				details: undefined,
			}),
		};
		const harness = await createHarness({ tools: [editTool(), bashTool] });

		try {
			let nextRequestUserTexts: string[] = [];
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("edit", { path: "src/app.ts" }), fauxToolCall("bash", { command: "npm run check" })],
					{ stopReason: "toolUse" },
				),
				(context) => {
					nextRequestUserTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => getMessageText(message));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("fix it");

			expect(nextRequestUserTexts.some((text) => text.includes("<validation-hint>"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
