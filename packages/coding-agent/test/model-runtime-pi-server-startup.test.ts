import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const clientModel: Model<"openai-completions"> = {
	id: "client-model",
	name: "Client model",
	provider: "client-provider",
	api: "openai-completions",
	baseUrl: "https://client.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};
const unconfiguredModel = { ...clientModel, provider: "huggingface", id: "server-configured-model" };

describe("ModelRuntime client-owned catalog in pi-server mode", () => {
	beforeEach(() => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockReturnValue(
			[clientModel, unconfiguredModel].map((model) =>
				createProvider({
					id: model.provider,
					models: [model],
					fetchModels: async () => [model],
					api: {
						stream: () => {
							throw new Error("Local inference is forbidden");
						},
						streamSimple: () => {
							throw new Error("Local inference is forbidden");
						},
					},
					auth: {
						apiKey: {
							name: "Client key",
							resolve: async ({ credential }) =>
								credential?.key ? { auth: { apiKey: credential.key } } : undefined,
						},
					},
				}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	function createRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory({ "client-provider": { type: "api_key", key: "client-key" } }),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			...options,
		});
	}

	it("honors caller cancellation during startup and refresh", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled startup");
		controller.abort(reason);
		await expect(createRuntime({ signal: controller.signal })).rejects.toBe(reason);
		const runtime = await createRuntime();
		expect(await runtime.refresh({ signal: controller.signal })).toEqual({ aborted: true, errors: new Map() });
		expect(runtime.getAvailableSnapshot()).toEqual([clientModel]);
	});

	it("keeps static client models when startup refresh is disabled", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const runtime = await createRuntime({ refreshOnCreate: false, allowModelNetwork: true });
		expect(runtime.getModels(clientModel.provider)).toEqual([clientModel]);
		expect(await runtime.getAllAvailable(clientModel.provider)).toEqual([clientModel]);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});
});
