import {
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const model: Model<"anthropic-messages"> = {
	id: "prepared",
	name: "Prepared",
	provider: "prepared",
	api: "anthropic-messages",
	baseUrl: "https://unused.invalid",
	headers: { "X-Model": "model" },
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

describe("local ModelRuntime prepared stream options", () => {
	afterEach(() => vi.unstubAllEnvs());
	async function fixture() {
		vi.stubEnv("PI_SERVER_MODE", "false");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const resolve = vi.fn(async () => ({
			auth: { apiKey: "local-key", baseUrl: "https://prepared.invalid", headers: { "X-Auth": "auth" } },
			env: { PI_CACHE_RETENTION: "long", PRIVATE: "local" },
		}));
		const calls: ProviderRequestOptions[] = [];
		const dispatch = (m: Model<string>, options?: ProviderRequestOptions) => {
			calls.push(options ?? {});
			const message = { ...fauxAssistantMessage("done"), api: m.api, provider: m.provider, model: m.id };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		runtime.registerNativeProvider(
			createProvider({
				id: model.provider,
				models: [model],
				auth: { apiKey: { name: "Local", resolve } },
				api: {
					stream: (m, _c, o) => dispatch(m, o),
					streamSimple: (m, _c, o) => dispatch(m, o),
					fetchDeferred: (m, _h, o) => dispatch(m, o),
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false, providers: [model.provider] });
		resolve.mockClear();
		return { runtime, resolve, calls };
	}
	it.each(["raw", "simple", "deferred", "virtual"] as const)(
		"prepares local %s after one auth resolution using the physical request model",
		async (kind) => {
			const { runtime, resolve, calls } = await fixture();
			let selected: Model<string> = model;
			if (kind === "virtual") {
				runtime.registerVirtualModel({
					provider: "virtual",
					id: "route",
					name: "Route",
					route: () => ({ model, thinkingLevel: "off" }),
				});
				await runtime.getAllAvailable();
				selected = runtime.getModel("virtual", "route")!;
				resolve.mockClear();
			}
			const onPayload = vi.fn();
			const transform = vi.fn(
				async <T extends ProviderRequestOptions>(options: T, requestModel: Model<string>): Promise<T> => {
					expect(resolve).toHaveBeenCalledTimes(1);
					expect(requestModel).toMatchObject({
						id: model.id,
						provider: model.provider,
						baseUrl: "https://prepared.invalid",
					});
					expect(options).toMatchObject({
						apiKey: "local-key",
						env: { PI_CACHE_RETENTION: kind === "virtual" ? "long" : "short", PRIVATE: "local" },
						headers: {
							"X-Model": "model",
							"X-Auth": "auth",
							...(kind === "virtual" ? {} : { "X-Caller": "caller" }),
							"X-Transform": "yes",
						},
					});
					if (kind === "virtual") expect(options.headers).not.toHaveProperty("X-Caller");
					expect(options.onPayload).toBe(onPayload);
					expect(options).not.toHaveProperty("transformHeaders");
					expect(options).not.toHaveProperty("transformPreparedStreamOptions");
					return { ...options, cacheRetention: "short" };
				},
			);
			const options = {
				env: { PI_CACHE_RETENTION: "short" },
				headers: { "X-Caller": "caller" },
				onPayload,
				transformHeaders: (headers: Record<string, string | null>) => ({ ...headers, "X-Transform": "yes" }),
				transformPreparedStreamOptions: transform,
			};
			const result =
				kind === "raw"
					? await runtime.complete(
							model,
							{ messages: [] },
							{ ...options, toolChoice: { type: "tool", name: "native" } },
						)
					: kind === "deferred"
						? await runtime.fetchDeferred(
								model,
								{ id: "handle", api: model.api, provider: model.provider, modelId: model.id },
								{ ...options, wait: 42 },
							)
						: await runtime.completeSimple(selected, { messages: [] }, options);
			expect(result.stopReason).toBe("stop");
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(transform).toHaveBeenCalledTimes(1);
			expect(calls).toHaveLength(1);
			expect(calls[0]).not.toHaveProperty("transformPreparedStreamOptions");
			expect(calls[0]).toHaveProperty("cacheRetention", "short");
			if (kind === "raw") expect(calls[0]).toHaveProperty("toolChoice", { type: "tool", name: "native" });
			if (kind === "deferred") expect(calls[0]).toHaveProperty("wait", 42);
		},
	);
	it.each(["raw", "simple", "deferred"] as const)(
		"blocks local %s when the prepared transform rejects",
		async (kind) => {
			const { runtime, resolve, calls } = await fixture();
			const options = {
				transformPreparedStreamOptions: async () => {
					throw new Error("Prepared transform rejected");
				},
			};
			const result =
				kind === "raw"
					? await runtime.complete(model, { messages: [] }, options)
					: kind === "simple"
						? await runtime.completeSimple(model, { messages: [] }, options)
						: await runtime.fetchDeferred(
								model,
								{ id: "handle", api: model.api, provider: model.provider, modelId: model.id },
								options,
							);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Prepared transform rejected");
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(calls).toEqual([]);
		},
	);
});
