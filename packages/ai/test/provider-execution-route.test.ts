import { afterEach, describe, expect, it } from "vitest";
import {
	getCompatProviderExecutionRoute,
	getModels,
	registerApiProvider,
	resetApiProviders,
	unregisterApiProviders,
} from "../src/compat.ts";
import type { Model } from "../src/types.ts";

afterEach(() => {
	resetApiProviders();
});

describe("compat provider execution route", () => {
	it("identifies builtin provider and builtin API execution", () => {
		const builtin = getModels("anthropic")[0];
		if (!builtin) throw new Error("Expected an Anthropic builtin model");
		expect(getCompatProviderExecutionRoute(builtin)).toEqual({
			kind: "builtin_provider",
			id: "anthropic",
		});

		const overlay: Model<"openai-completions"> = {
			id: "overlay-model",
			name: "Overlay Model",
			api: "openai-completions",
			provider: "overlay-provider",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		};
		expect(getCompatProviderExecutionRoute(overlay)).toEqual({
			kind: "builtin_api",
			id: "openai-completions",
		});
	});

	it("distinguishes custom and missing API executors", () => {
		const builtin = getModels("anthropic")[0];
		if (!builtin) throw new Error("Expected an Anthropic builtin model");
		registerApiProvider(
			{
				api: "anthropic-messages",
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			},
			"provider-route-test",
		);
		expect(getCompatProviderExecutionRoute(builtin)).toEqual({
			kind: "custom_api",
			id: "anthropic-messages",
		});

		unregisterApiProviders("provider-route-test");
		expect(getCompatProviderExecutionRoute(builtin)).toEqual({
			kind: "missing_api",
			id: "anthropic-messages",
		});
	});
});
