import { describe, expect, it, vi } from "vitest";
import { createModels, createProvider } from "../src/models.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model, ProviderRequestOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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

describe("authenticated stream option preparation", () => {
	it.each(["raw", "simple", "deferred"] as const)(
		"prepares %s once after auth without losing native options",
		async (kind) => {
			const resolve = vi.fn(async () => ({
				auth: { apiKey: "server-secret", baseUrl: "https://resolved.invalid", headers: { "X-Auth": "auth" } },
				env: { PI_CACHE_RETENTION: "long", SERVER_ONLY: "private" },
			}));
			const calls: ProviderRequestOptions[] = [];
			const respond = (_model: Model<string>, options?: ProviderRequestOptions) => {
				calls.push(options ?? {});
				const stream = new AssistantMessageEventStream();
				const message = fauxAssistantMessage("done");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: { apiKey: { name: "Fixture", resolve } },
					api: {
						stream: (m, _c, o) => respond(m, o),
						streamSimple: (m, _c, o) => respond(m, o),
						fetchDeferred: (m, _h, o) => respond(m, o),
					},
				}),
			);
			const onPayload = vi.fn();
			const transformHeaders = vi.fn((headers) => ({ ...headers, "X-Transformed": "yes" }));
			const prepare = vi.fn(
				async <T extends ProviderRequestOptions>(options: T, preparedModel: Model<string>): Promise<T> => {
					expect(resolve).toHaveBeenCalledTimes(1);
					expect(preparedModel.baseUrl).toBe("https://resolved.invalid");
					expect(options).toMatchObject({
						apiKey: "server-secret",
						env: { PI_CACHE_RETENTION: "short", SERVER_ONLY: "private" },
						headers: { "X-Model": "model", "X-Auth": "auth", "X-Caller": "caller", "X-Transformed": "yes" },
					});
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
				transformHeaders,
				transformPreparedStreamOptions: prepare,
			};
			const context = { messages: [] };
			const result =
				kind === "raw"
					? await models.complete(model, context, {
							...options,
							toolChoice: { type: "tool", name: "native" },
							thinkingEnabled: true,
							thinkingBudgetTokens: 1024,
						})
					: kind === "simple"
						? await models.completeSimple(model, context, { ...options, reasoning: "high" })
						: await models.fetchDeferred(
								model,
								{ id: "handle", provider: model.provider, modelId: model.id, api: model.api },
								{ ...options, wait: 42 },
							);
			expect(result.stopReason).toBe("stop");
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(transformHeaders).toHaveBeenCalledTimes(1);
			expect(calls).toHaveLength(1);
			expect(calls[0]).not.toHaveProperty("transformPreparedStreamOptions");
			expect(calls[0]).toHaveProperty("cacheRetention", "short");
			if (kind === "raw")
				expect(calls[0]).toMatchObject({
					toolChoice: { type: "tool", name: "native" },
					thinkingEnabled: true,
					thinkingBudgetTokens: 1024,
				});
			if (kind === "simple") expect(calls[0]).toHaveProperty("reasoning", "high");
			if (kind === "deferred") expect(calls[0]).toHaveProperty("wait", 42);
		},
	);

	it.each(["raw", "simple", "deferred"] as const)(
		"blocks %s provider dispatch when preparation rejects",
		async (kind) => {
			const dispatch = vi.fn(() => {
				throw new Error("Provider must not run");
			});
			const resolve = vi.fn(async () => ({ auth: {} }));
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: { apiKey: { name: "Fixture", resolve } },
					api: { stream: dispatch, streamSimple: dispatch, fetchDeferred: dispatch },
				}),
			);
			const options = {
				transformPreparedStreamOptions: async () => {
					throw new Error("Preparation rejected");
				},
			};
			const result =
				kind === "raw"
					? await models.complete(model, { messages: [] }, options)
					: kind === "simple"
						? await models.completeSimple(model, { messages: [] }, options)
						: await models.fetchDeferred(
								model,
								{ id: "handle", provider: model.provider, modelId: model.id, api: model.api },
								options,
							);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Preparation rejected");
			expect(dispatch).not.toHaveBeenCalled();
			expect(resolve).toHaveBeenCalledTimes(1);
		},
	);
});
