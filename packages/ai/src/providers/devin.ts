import { DEVIN_BASE_URL } from "../api/devin-constants.ts";
import { lazyApi } from "../api/lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadDevinOAuth, loadDevinRuntime } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const devinApi = () => lazyApi(loadDevinRuntime);

/**
 * Known model definitions used until an account catalog has been discovered.
 * Live Devin discovery remains authoritative and replaces this small fallback.
 */
const fallbackModels: Model<"devin">[] = [
	{
		id: "claude-opus-5-max",
		name: "Claude Opus 5 Max",
		provider: "devin",
		api: "devin",
		baseUrl: DEVIN_BASE_URL,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: "claude-opus-5-max",
		},
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		id: "swe-2-high",
		name: "SWE-2 High",
		provider: "devin",
		api: "devin",
		baseUrl: DEVIN_BASE_URL,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "swe-2-high",
			xhigh: null,
			max: null,
		},
		input: ["text", "image"],
		contextWindow: 262_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "swe-2-max",
		name: "SWE-2 Max",
		provider: "devin",
		api: "devin",
		baseUrl: DEVIN_BASE_URL,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: "swe-2-max",
		},
		input: ["text", "image"],
		contextWindow: 262_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "swe-2-medium",
		name: "SWE-2 Medium",
		provider: "devin",
		api: "devin",
		baseUrl: DEVIN_BASE_URL,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: "swe-2-medium",
			high: null,
			xhigh: null,
			max: null,
		},
		input: ["text", "image"],
		contextWindow: 262_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

/** Devin Pro's account-owned model catalog and native subscription login. */
export function devinProvider(): Provider<"devin"> {
	let models: Model<"devin">[] = [...fallbackModels];
	const streams = devinApi();
	return {
		id: "devin",
		name: "Devin Pro",
		auth: { oauth: lazyOAuth({ name: "Devin Pro", isSubscription: true, load: loadDevinOAuth }) },
		getModels: () => models,
		refreshModels: async (context) => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model) => model.provider === "devin" && model.api === "devin",
				) as Model<"devin">[];
				const restoredIds = new Set(restored.map((model) => model.id));
				const restoredWithFallback = [...restored, ...fallbackModels.filter((model) => !restoredIds.has(model.id))];
				if (
					!(await context.publish({
						update: () => {
							models = restoredWithFallback;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork || context.credential?.type !== "oauth") return;
			const refreshed = await (await loadDevinRuntime()).discoverDevinModels(
				context.credential.access,
				context.signal,
			);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => streams.stream(model, context, options),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
	};
}
