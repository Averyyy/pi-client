import { describe, expect, it } from "vitest";
import { hashRemoteProviderExecution, PI_AI_RUNTIME_VERSION } from "../src/provider-execution-node.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

describe("remote provider execution fingerprint", () => {
	it("binds the pi-ai runtime, model identity, API, and executor route", () => {
		const builtinApi = hashRemoteProviderExecution(model, {
			kind: "builtin_api",
			id: "openai-completions",
		});
		const builtinProvider = hashRemoteProviderExecution(model, {
			kind: "builtin_provider",
			id: "test-provider",
		});
		const otherModel = hashRemoteProviderExecution(
			{ ...model, id: "other-model" },
			{
				kind: "builtin_api",
				id: "openai-completions",
			},
		);

		expect(PI_AI_RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
		expect(builtinApi).toMatch(/^[a-f0-9]{64}$/u);
		expect(builtinProvider).not.toBe(builtinApi);
		expect(otherModel).not.toBe(builtinApi);
	});
});
