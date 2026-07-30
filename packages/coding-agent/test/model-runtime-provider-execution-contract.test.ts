import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
	getCompatProviderExecutionRoute,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { assertPiServerProviderExecution } from "../src/core/pi-server-provider-execution.ts";
import {
	hashProviderExecutionContract,
	type ProviderExecutionContractDescriptor,
} from "../src/core/provider-execution-contract.ts";

function requireModel(runtime: ModelRuntime, providerId: string, modelId?: string): Model<Api> {
	const model = modelId ? runtime.getModel(providerId, modelId) : runtime.getModels(providerId)[0];
	if (!model) throw new Error(`Missing test model for ${providerId}/${modelId ?? "<first>"}`);
	return model;
}

function extensionModel(id: string, api: Api) {
	return {
		id,
		name: id,
		api,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("ModelRuntime provider execution contracts", () => {
	it("classifies builtin providers with a stable canonical fingerprint", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = requireModel(runtime, "anthropic");
		const contract = runtime.getProviderExecutionContract(model);

		expect(contract.descriptor).toEqual({
			version: 1,
			mode: "builtin",
			providerId: "anthropic",
			modelId: model.id,
			api: model.api,
			executor: { kind: "builtin_provider", id: "anthropic" },
			overlays: { modelsJson: false, extensionConfig: false },
			piServerCompatible: true,
		});
		expect(contract.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
		expect(runtime.getProviderExecutionContract(model).fingerprint).toBe(contract.fingerprint);

		const reordered: ProviderExecutionContractDescriptor = {
			piServerCompatible: true,
			overlays: { extensionConfig: false, modelsJson: false },
			executor: { id: "anthropic", kind: "builtin_provider" },
			api: model.api,
			modelId: model.id,
			providerId: "anthropic",
			mode: "builtin",
			version: 1,
		};
		expect(hashProviderExecutionContract(reordered)).toBe(contract.fingerprint);
	});

	it("matches the pi-server compat route for every builtin model", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		for (const model of runtime.getModels()) {
			const contract = runtime.getProviderExecutionContract(model);
			expect(contract.descriptor.piServerCompatible, `${model.provider}/${model.id}`).toBe(true);
			expect(getCompatProviderExecutionRoute(model), `${model.provider}/${model.id}`).toEqual(
				contract.descriptor.executor,
			);
		}
	});

	it("rejects a direct pi-ai API override that bypasses ModelRuntime registration", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = requireModel(runtime, "anthropic");
		const sourceId = "provider-execution-contract-test";
		registerApiProvider(
			{
				api: model.api,
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			},
			sourceId,
		);
		try {
			expect(() => assertPiServerProviderExecution(runtime, model)).toThrow(
				"active pi-ai compat route is custom_api",
			);
		} finally {
			unregisterApiProviders(sourceId);
		}
	});

	it("classifies models.json and extension-only providers as serializable overlays without secrets", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-provider-contract-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"json-overlay": {
						baseUrl: "https://json.example.test/v1",
						apiKey: "json-secret-key",
						headers: { Authorization: "json-secret-header" },
						api: "openai-completions",
						models: [extensionModel("json-model", "openai-completions")],
					},
				},
			}),
		);
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				allowModelNetwork: false,
			});
			const jsonContract = runtime.getProviderExecutionContract(requireModel(runtime, "json-overlay", "json-model"));
			expect(jsonContract.descriptor).toMatchObject({
				mode: "serializable_overlay",
				executor: { kind: "builtin_api", id: "openai-completions" },
				overlays: { modelsJson: true, extensionConfig: false },
				piServerCompatible: true,
			});

			runtime.registerProvider("extension-overlay", {
				baseUrl: "https://extension.example.test/v1",
				apiKey: "extension-secret-key",
				headers: { Authorization: "extension-secret-header" },
				api: "openai-completions",
				models: [extensionModel("extension-model", "openai-completions")],
			});
			const extensionContract = runtime.getProviderExecutionContract(
				requireModel(runtime, "extension-overlay", "extension-model"),
			);
			expect(extensionContract.descriptor).toMatchObject({
				mode: "serializable_overlay",
				executor: { kind: "builtin_api", id: "openai-completions" },
				overlays: { modelsJson: false, extensionConfig: true },
				piServerCompatible: true,
			});

			const serialized = JSON.stringify([jsonContract.descriptor, extensionContract.descriptor]);
			expect(serialized).not.toContain("apiKey");
			expect(serialized).not.toContain("headers");
			expect(serialized).not.toContain("secret");
			expect(JSON.parse(JSON.stringify(extensionContract.descriptor))).toEqual(extensionContract.descriptor);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("treats ProviderConfig.streamSimple as custom only for its declared API, including builtin collisions", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const builtinModel = requireModel(runtime, "anthropic");
		const builtinFingerprint = runtime.getProviderExecutionContract(builtinModel).fingerprint;

		runtime.registerProvider("anthropic", {
			api: builtinModel.api,
			streamSimple: () => {
				throw new Error("unused");
			},
		});
		const customContract = runtime.getProviderExecutionContract(requireModel(runtime, "anthropic", builtinModel.id));
		expect(customContract.descriptor).toMatchObject({
			mode: "provider_config_stream_simple",
			executor: { kind: "provider_config_stream_simple", id: "anthropic" },
			piServerCompatible: false,
		});
		expect(customContract.fingerprint).not.toBe(builtinFingerprint);

		runtime.registerProvider("anthropic", { api: "openai-completions" });
		const reRegisteredContract = runtime.getProviderExecutionContract(
			requireModel(runtime, "anthropic", builtinModel.id),
		);
		expect(reRegisteredContract.descriptor).toMatchObject({
			mode: "serializable_overlay",
			executor: { kind: "builtin_provider", id: "anthropic" },
			piServerCompatible: true,
		});
		expect(reRegisteredContract.fingerprint).not.toBe(customContract.fingerprint);

		runtime.unregisterProvider("anthropic");
		const restoredContract = runtime.getProviderExecutionContract(
			requireModel(runtime, "anthropic", builtinModel.id),
		);
		expect(restoredContract.descriptor).toMatchObject({
			mode: "builtin",
			executor: { kind: "builtin_provider", id: "anthropic" },
			piServerCompatible: true,
		});
		expect(restoredContract.fingerprint).toBe(builtinFingerprint);
	});

	it("classifies native registrations ahead of colliding builtins and restores the builtin on unregister", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const builtinProvider = runtime.getProvider("anthropic");
		if (!builtinProvider) throw new Error("Missing anthropic provider");
		const nativeProvider: Provider = {
			...builtinProvider,
			name: "Native Anthropic Override",
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};

		runtime.registerNativeProvider(nativeProvider);
		const nativeModel = requireModel(runtime, "anthropic");
		expect(runtime.getProviderExecutionContract(nativeModel).descriptor).toMatchObject({
			mode: "native_provider",
			executor: { kind: "native_provider", id: "anthropic" },
			piServerCompatible: false,
		});

		runtime.unregisterProvider("anthropic");
		expect(
			runtime.getProviderExecutionContract(requireModel(runtime, "anthropic", nativeModel.id)).descriptor,
		).toMatchObject({
			mode: "builtin",
			executor: { kind: "builtin_provider", id: "anthropic" },
			piServerCompatible: true,
		});
	});

	it("routes models on other APIs past ProviderConfig.streamSimple to the builtin API implementation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("multi-api-extension", {
			baseUrl: "https://multi.example.test/v1",
			apiKey: "secret",
			api: "anthropic-messages",
			streamSimple: () => {
				throw new Error("unused");
			},
			models: [
				extensionModel("same-api", "anthropic-messages"),
				extensionModel("different-api", "openai-completions"),
			],
		});

		expect(
			runtime.getProviderExecutionContract(requireModel(runtime, "multi-api-extension", "same-api")).descriptor,
		).toMatchObject({
			mode: "provider_config_stream_simple",
			piServerCompatible: false,
		});
		expect(
			runtime.getProviderExecutionContract(requireModel(runtime, "multi-api-extension", "different-api")).descriptor,
		).toMatchObject({
			mode: "serializable_overlay",
			executor: { kind: "builtin_api", id: "openai-completions" },
			piServerCompatible: true,
		});
	});
});
