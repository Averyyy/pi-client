import { lazyApi } from "../api/lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadDevinOAuth, loadDevinRuntime } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const devinApi = () => lazyApi(loadDevinRuntime);

/** Devin Pro's account-owned model catalog and native subscription login. */
export function devinProvider(): Provider<"devin"> {
	let models: Model<"devin">[] = [];
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
				if (
					!(await context.publish({
						update: () => {
							models = restored;
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
