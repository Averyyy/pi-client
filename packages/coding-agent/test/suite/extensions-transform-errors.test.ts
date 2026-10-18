import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("extension request transforms", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it.each(["input", "context", "context_with_system", "before_agent_start"] as const)(
		"does not call the provider after %s fails",
		async (eventName) => {
			const failure = new Error(`${eventName} transformation failed`);
			harness = await createHarness({
				settings: { retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						const fail = () => {
							throw failure;
						};
						switch (eventName) {
							case "input":
								pi.on("input", fail);
								break;
							case "context":
								pi.on("context", fail);
								break;
							case "context_with_system":
								pi.on("context_with_system", fail);
								break;
							case "before_agent_start":
								pi.on("before_agent_start", fail);
								break;
						}
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("Provider response")]);
			const errors: string[] = [];
			await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

			const [result] = await Promise.allSettled([harness.session.prompt("hello")]);

			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(errors).toEqual([failure.message]);
			if (result.status === "rejected") {
				expect(result.reason).toBe(failure);
			} else {
				expect(harness.session.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "error",
					errorMessage: failure.message,
				});
			}
		},
	);
});
