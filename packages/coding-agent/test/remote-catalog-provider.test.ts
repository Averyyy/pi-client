import {
	type AnyModel,
	createModels,
	createProvider,
	type ImageModel,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	type PersonalizeCatalog,
	REMOTE_CATALOG_MODEL_TYPES,
	withPersonalizedCatalog,
	withRemoteCatalog,
} from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function builtinProvider(): Provider {
	return createProvider({
		id: "test-provider",
		auth: {
			apiKey: {
				name: "Test",
				check: async () => ({ type: "api_key" }),
				resolve: async () => ({ auth: {} }),
			},
		},
		models: [model("static")],
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(builtinProvider(), "https://pi.dev", localGeneratedAt);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("remote catalog provider", () => {
	it.each([false, true])(
		"applies catalog timestamps according to server mode %s during refresh and cache restore",
		async (serverMode) => {
			vi.stubEnv("PI_SERVER_MODE", String(serverMode));
			const localGeneratedAt = Date.parse("2026-10-30T07:58:53.845Z");
			const catalog = [model("gpt-6.1-terra"), { ...model("static"), contextWindow: 500 }];
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
				Response.json(catalog, {
					headers: { "last-modified": "Thu, 29 Oct 2026 13:12:00 GMT" },
				}),
			);
			const modelsStore = new InMemoryModelsStore();
			const models = createModels({ modelsStore });
			models.setProvider(testProvider(localGeneratedAt));
			expect((await models.refresh()).errors.size).toBe(0);
			expect(models.getAllModels().map((entry) => entry.id)).toEqual(
				serverMode ? ["static", "gpt-6.1-terra"] : ["static"],
			);
			expect((await models.getAllAvailable()).map((entry) => entry.id)).toEqual(
				serverMode ? ["static", "gpt-6.1-terra"] : ["static"],
			);
			expect(models.getModel("test-provider", "static")?.contextWindow).toBe(serverMode ? 500 : 1000);
			const restored = createModels({ modelsStore });
			restored.setProvider(testProvider(localGeneratedAt));
			await restored.refresh({ allowNetwork: false });
			expect(restored.getAllModels()).toEqual(models.getAllModels());
			expect(fetchSpy).toHaveBeenCalledOnce();
			if (serverMode) {
				fetchSpy.mockResolvedValueOnce(new Response(null, { status: 304 }));
				expect((await restored.refresh()).errors.size).toBe(0);
				expect(restored.getAllModels()).toEqual(models.getAllModels());
				fetchSpy.mockResolvedValueOnce(Response.json([]));
				expect((await restored.refresh()).errors.size).toBe(0);
				expect(restored.getAllModels()).toEqual([model("static")]);
				expect((await modelsStore.read("test-provider"))?.models).toEqual([]);
			}
		},
	);
	it.each(["stored", "environment", "configuration"])(
		"refreshes configured public catalogs using %s auth without resolving inference credentials",
		async (source) => {
			vi.stubEnv("PI_SERVER_MODE", "true");
			vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
			vi.stubEnv("PI_SERVER_AUTH_TOKEN", "server-token");
			if (source === "environment") vi.stubEnv("CATALOG_TEST_KEY", "environment-key");
			const resolve = vi.fn(async () => {
				throw new Error("Inference auth must not resolve");
			});
			const base = withRemoteCatalog({
				...builtinProvider(),
				auth: {
					apiKey: {
						name: "Test",
						check: async ({ ctx, credential }) =>
							credential?.key || (await ctx.env("CATALOG_TEST_KEY")) ? { type: "api_key" } : undefined,
						resolve,
					},
				},
			});
			const credentials = new InMemoryCredentialStore();
			if (source === "stored")
				await credentials.modify(base.id, async () => ({ type: "api_key", key: "client-key" }));
			const config = await ModelConfig.load(undefined);
			const provider = composeModelProvider(
				base.id,
				base,
				config,
				source === "configuration" ? { apiKey: "configured-key" } : undefined,
			);
			const models = createModels({ credentials });
			models.setProvider(provider);
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => Response.json([model("public")]));
			expect((await models.refresh()).errors.size).toBe(0);
			expect(models.getModel(base.id, "public")).toBeDefined();
			expect((await models.getAvailable(base.id)).map((entry) => entry.id)).toEqual(["static", "public"]);
			expect(resolve).not.toHaveBeenCalled();
			expect(fetchSpy).toHaveBeenCalledOnce();
			expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
				"Content-Type": "application/json",
				Authorization: "Bearer server-token",
			});
		},
	);

	it.each([404, 501, 502])("reports server status %s and retains the stored catalog", async (status) => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		const store = new InMemoryModelsStore();
		const cached = { models: [model("cached")], lastModified: 0, checkedAt: 0, etag: '"cached"' };
		await store.write("test-provider", cached);
		const provider = testProvider();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ error: "upstream failed" }, { status }));
		const controller = new AbortController();
		await expect(refreshProvider(provider, store, { signal: controller.signal })).rejects.toThrow(String(status));
		expect(await store.read(provider.id)).toEqual(cached);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ "if-none-match": '"cached"' });
		expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	it("reads the server on each network refresh and forwards forced refreshes", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([model("public")]));
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(new URL(String(fetchSpy.mock.calls[2]?.[0])).searchParams.get("force")).toBe("true");
	});

	it.each([false, true])(
		"restores cached models without requesting an unconfigured provider (server mode: %s)",
		async (serverMode) => {
			vi.stubEnv("PI_SERVER_MODE", String(serverMode));
			const resolve = vi.fn(async () => undefined);
			const check = vi.fn(async () => undefined);
			const provider = withRemoteCatalog({
				...builtinProvider(),
				auth: { apiKey: { name: "Test", check, resolve } },
			});
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify([model("public")])));
			const modelsStore = new InMemoryModelsStore();
			await modelsStore.write(provider.id, { models: [model("cached")], lastModified: 0 });
			const models = createModels({ modelsStore });
			models.setProvider(provider);

			expect((await models.refresh()).errors.size).toBe(0);
			expect(models.getModel(provider.id, "cached")).toBeDefined();
			expect(check).toHaveBeenCalledOnce();
			expect(resolve).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(await models.getAvailable(provider.id)).toEqual([]);
			expect(await models.getAuth(provider.id)).toBeUndefined();
		},
	);

	it("refreshes a public catalog without refreshing expired OAuth", async () => {
		const refresh = vi.fn(async () => {
			throw new Error("refresh_token_reused");
		});
		const provider = withRemoteCatalog({
			...builtinProvider(),
			auth: {
				oauth: {
					name: "Test OAuth",
					login: async () => {
						throw new Error("unused");
					},
					refresh,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.id, async () => ({
			type: "oauth",
			access: "expired",
			refresh: "expired",
			expires: 0,
		}));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("public")])));
		const models = createModels({ credentials });
		models.setProvider(provider);

		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModel(provider.id, "public")).toBeDefined();
		expect(refresh).not.toHaveBeenCalled();
		await expect(models.getAuth(provider.id)).rejects.toThrow();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("inherits public catalog auth only when an extension has no account catalog hooks", async () => {
		const resolve = vi.fn(async () => undefined);
		const base = withRemoteCatalog({
			...builtinProvider(),
			auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve } },
		});
		const config = await ModelConfig.load(undefined);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify([model("public")])));
		const inherited = composeModelProvider(base.id, base, config, { name: "Overlay" });
		const models = createModels();
		models.setProvider(inherited);
		await models.refresh();
		expect(inherited.modelCatalogAuth).toBe("none");
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(resolve).not.toHaveBeenCalled();

		const refreshModels = vi.fn(async (_context: RefreshModelsContext) => []);
		const extensions: ProviderConfigInput[] = [
			{ refreshModels },
			{
				oauth: {
					name: "Extension OAuth",
					login: async () => {
						throw new Error("unused");
					},
					refreshToken: async (credential) => credential,
					getApiKey: (credential) => credential.access,
					modifyModels: (models) => models,
				},
			},
		];
		for (const extension of extensions) {
			const provider = composeModelProvider(base.id, base, config, extension);
			models.setProvider(provider);
			expect(provider.modelCatalogAuth).toBe("provider");
			await models.refresh();
		}
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(refreshModels).toHaveBeenCalledOnce();
		expect(refreshModels.mock.calls[0]?.[0].allowNetwork).toBe(false);
	});
	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
		const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(requested.pathname).toBe("/api/models/providers/test-provider");
		expect(requested.searchParams.get("types")).toBe(REMOTE_CATALOG_MODEL_TYPES.join(","));
	});

	it.each([false, true])("overlays all model types (server mode: %s)", async (serverMode) => {
		vi.stubEnv("PI_SERVER_MODE", String(serverMode));
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						chat: { ...model("chat"), type: "chat" },
						flux: {
							type: "image",
							id: "flux",
							name: "FLUX",
							api: "openrouter-images",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							output: ["image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						jev: {
							type: "classifier",
							id: "jev",
							name: "Jev",
							api: "typesafe-system-one",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 64000,
						},
						clip: { ...model("clip"), type: "video" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);

		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(models.getAllModels("test-provider").map((entry) => entry.id)).toEqual(["static", "chat", "flux", "jev"]);
		expect(models.getModelOfType("image", "test-provider", "flux")?.type).toBe("image");
		expect(models.getModelOfType("classifier", "test-provider", "jev")?.type).toBe("classifier");
		expect(models.getModel("test-provider", "flux")).toBeUndefined();
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["chat", "flux", "jev"]);
		expect(fetchSpy).toHaveBeenCalledOnce();
		const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(url.origin).toBe(serverMode ? "http://pi-server.test" : "https://pi.dev");
		expect(url.pathname).toBe(
			serverMode ? "/api/model-catalog/providers/test-provider" : "/api/models/providers/test-provider",
		);
		if (serverMode) expect(url.searchParams.get("pi-version")).toBe(VERSION);
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		const cached = await store.read(provider.id);
		await store.write(provider.id, { ...cached!, checkedAt: 0 });
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.checkedAt).toBe(0);

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});

describe("personalized catalog provider", () => {
	it.each([false, true])("personalizes the catalog using server mode %s timestamp semantics", async (serverMode) => {
		vi.stubEnv("PI_SERVER_MODE", String(serverMode));
		const catalog = [model("public"), { ...model("static"), contextWindow: 500 }];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json(catalog, {
				headers: { "last-modified": "Thu, 29 Oct 2026 13:12:00 GMT" },
			}),
		);
		const personalize = vi.fn(async (models: readonly AnyModel[]) => models);
		const provider = withPersonalizedCatalog(
			builtinProvider(),
			personalize,
			undefined,
			Date.parse("2026-10-30T07:58:53.845Z"),
		);
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(serverMode ? ["static", "public"] : ["static"]);
		expect(provider.getModels()[0].contextWindow).toBe(serverMode ? 500 : 1000);
		expect(personalize.mock.calls[0]?.[0]).toEqual(provider.getModels());
		const restored = withPersonalizedCatalog(
			builtinProvider(),
			personalize,
			undefined,
			Date.parse("2026-10-30T07:58:53.845Z"),
		);
		await refreshProvider(restored, store, { allowNetwork: false });
		expect(restored.getModels()).toEqual(provider.getModels());
		expect(personalize).toHaveBeenCalledOnce();
	});
	it("gets the public base from pi-server before client personalization", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", "http://pi-server.test");
		const personalize = vi.fn(async (catalog: readonly AnyModel[], context: RefreshModelsContext) => {
			expect(context.credential).toEqual({ type: "api_key" });
			return catalog.filter((entry) => entry.id === "public");
		});
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([model("public")]));
		await refreshProvider(provider, new InMemoryModelsStore());
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["public"]);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			`http://pi-server.test/api/model-catalog/providers/test-provider?pi-version=${VERSION}`,
		);
		expect(personalize).toHaveBeenCalledOnce();
	});
	it("requires provider authentication before network discovery", async () => {
		const resolve = vi.fn(async () => undefined);
		const personalize = vi.fn(async () => [model("allowed")]);
		const provider = withPersonalizedCatalog(
			{ ...testProvider(), auth: { apiKey: { name: "Test", resolve } } },
			personalize,
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const models = createModels();
		models.setProvider(provider);
		await models.refresh();
		expect(provider.modelCatalogAuth).toBe("provider");
		expect(resolve).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(personalize).not.toHaveBeenCalled();
	});
	const imageModel: ImageModel<"openrouter-images"> = {
		type: "image",
		id: "image",
		name: "image",
		api: "openrouter-images",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	it("keeps the saved list and saves nothing when personalization fails", async () => {
		// Saving the catalog without personalization would replace the key's list with every model.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write("test-provider", saved);
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("user models request failed");
		};
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);

		await expect(refreshProvider(provider, store)).rejects.toThrow("user models request failed");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["allowed"]);
		expect(await store.read(provider.id)).toEqual(saved);
	});

	it("restores a saved list as is, and falls back to the built-in models only when it is empty", async () => {
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("not used offline");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);

		// pi versions before per-key lists stored the plain pi.dev catalog here, and saved an empty list
		// after a missing pi.dev catalog or a failed first request. Only such an entry can be empty.
		await store.write(provider.id, { models: [], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		// A key that may use no chat models keeps its image models and shows no chat models.
		await store.write(provider.id, { models: [imageModel], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["image"]);
	});
});
