import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function textContent(message: { content: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

describe("first-turn session naming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses the current model to name an unnamed session after the first turn", async () => {
		const harness = await createHarness({ autoSessionName: true });
		harnesses.push(harness);
		let titlePrompt = "";
		harness.setResponses([
			fauxAssistantMessage("I can fix that."),
			(context) => {
				const titleMessage = context.messages[0];
				if (!titleMessage) {
					throw new Error("missing title prompt");
				}
				titlePrompt = textContent(titleMessage);
				return fauxAssistantMessage("Fix pi-client web");
			},
		]);

		await harness.session.prompt("pi web is bad. Replace pi-client web with Tau.");

		expect(harness.sessionManager.getSessionName()).toBe("Fix pi-client web");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(titlePrompt).toContain("Name this coding session");
	});

	it("keeps a user-provided session name", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setSessionName("Manual name");
		harness.setResponses([fauxAssistantMessage("I can fix that."), fauxAssistantMessage("Should not be used")]);

		await harness.session.prompt("fix this");

		expect(harness.sessionManager.getSessionName()).toBe("Manual name");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
