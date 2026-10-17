import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const serverModel = {
	id: "server-only-model",
	name: "Server only model",
	provider: "server-only-provider",
	api: "openai-completions",
	baseUrl: "https://unused.invalid/v1",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

const catalog = {
	models: [serverModel],
	available: [serverModel],
	providers: [],
};

describe("ModelRuntime pi-server startup catalog", () => {
	beforeEach(() => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
		vi.stubEnv("PI_OFFLINE", "1");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	function stubCatalogFetch(fetcher: typeof fetch) {
		vi.stubGlobal("fetch", vi.fn(fetcher));
	}

	function createRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			...options,
		});
	}

	it.each([
		[
			"timeout",
			"The operation timed out",
			async () => {
				throw new DOMException("The operation timed out", "TimeoutError");
			},
		],
		[
			"refusal",
			"fetch failed",
			async () => {
				throw new TypeError("fetch failed");
			},
		],
		["non-2xx response", "503", async () => new Response("unavailable", { status: 503 })],
	])("returns a runtime after an initial %s", async (_label, expectedError, fetcher) => {
		stubCatalogFetch(fetcher as typeof fetch);

		const runtime = await createRuntime({ allowModelNetwork: true });

		expect(runtime.getError()).toContain(expectedError as string);
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
		await runtime.getAvailable("server-only-provider");
		await runtime.getAllAvailable("server-only-provider");
		await runtime.getAvailableOfType("chat", "server-only-provider");
		await runtime.refresh({ allowNetwork: false });
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it("keeps startup reads and offline refreshes on the current snapshot", async () => {
		stubCatalogFetch(async () => Response.json(catalog));
		const runtime = await createRuntime({ allowModelNetwork: true });

		expect(runtime.getModel("server-only-provider", "server-only-model")).toMatchObject(serverModel);
		expect(await runtime.getAvailable("server-only-provider")).toMatchObject([serverModel]);
		expect(await runtime.getAllAvailable("server-only-provider")).toMatchObject([serverModel]);
		expect(await runtime.getAvailableOfType("chat", "server-only-provider")).toMatchObject([serverModel]);
		expect(await runtime.listCredentials()).toEqual([]);
		await runtime.refresh({ allowNetwork: false });

		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it("recovers from a cold-start outage and keeps the last successful catalog after a later failure", async () => {
		let requests = 0;
		stubCatalogFetch(async () => {
			requests++;
			return requests === 1 || requests === 3
				? new Response("unavailable", { status: 503 })
				: Response.json(catalog);
		});
		const runtime = await createRuntime({ allowModelNetwork: true });
		expect(runtime.getError()).toContain("503");
		expect(runtime.getModel("server-only-provider", "server-only-model")).toBeUndefined();

		await runtime.refresh({ allowNetwork: true });
		expect(runtime.getModel("server-only-provider", "server-only-model")).toMatchObject(serverModel);
		expect(runtime.getError()).toBeUndefined();

		await runtime.refresh({ allowNetwork: true });
		expect(runtime.getModel("server-only-provider", "server-only-model")).toMatchObject(serverModel);
		expect(runtime.getError()).toContain("503");

		await runtime.refresh({ allowNetwork: true });
		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getAvailableSnapshot()).toContainEqual(expect.objectContaining(serverModel));
	});

	it("treats the catalog timeout signal as a recorded startup outage", async () => {
		const controller = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		stubCatalogFetch(async (_input, init) => {
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
			return Response.json(catalog);
		});

		const starting = createRuntime({ allowModelNetwork: true });
		await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
		controller.abort(new DOMException("The operation timed out", "TimeoutError"));
		const runtime = await starting;

		expect(timeoutSpy).toHaveBeenCalledOnce();
		expect(runtime.getError()).toContain("The operation timed out");
		await runtime.getAvailable("server-only-provider");
		await runtime.getAllAvailable("server-only-provider");
		await runtime.getAvailableOfType("chat", "server-only-provider");
		await runtime.refresh({ allowNetwork: false });
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it("honors caller cancellation during startup", async () => {
		stubCatalogFetch(async (_input, init) => {
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
			return Response.json(catalog);
		});
		const controller = new AbortController();
		const reason = new Error("caller cancelled startup");
		controller.abort(reason);

		await expect(createRuntime({ allowModelNetwork: true, signal: controller.signal })).rejects.toBe(reason);
	});

	it("does not fetch when startup catalog refresh is disabled", async () => {
		stubCatalogFetch(async () => Response.json(catalog));
		const runtime = await createRuntime({ refreshOnCreate: false, allowModelNetwork: true });

		await runtime.getAvailable("server-only-provider");
		await runtime.getAllAvailable("server-only-provider");
		await runtime.getAvailableOfType("chat", "server-only-provider");

		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});
});
