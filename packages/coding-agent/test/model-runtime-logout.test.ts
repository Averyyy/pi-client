import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe.each([false, true])("ModelRuntime logout with pi-server mode %s", (remote) => {
	it.each(["", "environment-key"])("updates Hugging Face availability with HF_TOKEN=%s", async (token) => {
		vi.stubEnv("PI_SERVER_MODE", String(remote));
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
		vi.stubEnv("HF_TOKEN", token);
		const fetcher = vi.fn(async () => Response.json({ models: [], available: [], providers: [] }));
		vi.stubGlobal("fetch", fetcher);
		const credentials = AuthStorage.inMemory({ huggingface: { type: "api_key", key: "stored-key" } });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const before = await runtime.getAvailable("huggingface");
		expect(before.length).toBeGreaterThan(0);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "huggingface")).toBe(true);

		await runtime.logout("huggingface");

		expect(await credentials.read("huggingface")).toBeUndefined();
		expect(runtime.hasConfiguredAuth("huggingface")).toBe(Boolean(token));
		expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "huggingface")).toHaveLength(
			token ? before.length : 0,
		);
		expect(await runtime.getAvailable("huggingface")).toHaveLength(token ? before.length : 0);
		expect(await runtime.getAllAvailable("huggingface")).toHaveLength(token ? before.length : 0);
		expect(await runtime.getAvailableOfType("chat", "huggingface")).toHaveLength(token ? before.length : 0);
		expect(runtime.getProviderAuthStatus("huggingface")).toEqual(
			token ? { configured: true, source: "environment", label: "HF_TOKEN" } : { configured: false },
		);
		expect(fetcher).toHaveBeenCalledTimes(remote ? 1 : 0);
	});
});

it("retains server-authenticated models after removing the client's stored credential", async () => {
	vi.stubEnv("PI_SERVER_MODE", "true");
	vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
	vi.stubEnv("HF_TOKEN", "");
	const serverModels = huggingfaceProvider().getModels().slice(0, 1);
	expect(serverModels).toHaveLength(1);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ models: serverModels, available: serverModels, providers: [] })),
	);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ huggingface: { type: "api_key", key: "stored-key" } }),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});

	await runtime.logout("huggingface");

	expect(await runtime.checkAuth("huggingface")).toBeUndefined();
	expect(runtime.hasConfiguredAuth("huggingface")).toBe(true);
	expect(await runtime.getAvailable("huggingface")).toEqual(serverModels);
	expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "huggingface")).toEqual(serverModels);
	expect(fetch).toHaveBeenCalledTimes(1);
});
