import { lazyApi } from "../api/lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import {
	loadGoogleAntigravityCatalog,
	loadGoogleAntigravityOAuth,
	loadGoogleAntigravityRuntime,
} from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";

export const googleAntigravityApi = () => lazyApi(loadGoogleAntigravityRuntime);

export function googleAntigravityProvider(): Provider<"google-antigravity"> {
	return createProvider({
		id: "google-antigravity",
		name: "Google Antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: {
			oauth: lazyOAuth({
				name: "Google Antigravity",
				isSubscription: true,
				loginLabel: "Sign in with Google Antigravity",
				load: loadGoogleAntigravityOAuth,
			}),
		},
		models: [],
		fetchModels: async (context) => {
			if (context.credential?.type !== "oauth") return [];
			return (await loadGoogleAntigravityCatalog()).discoverGoogleAntigravityModels(
				context.credential,
				context.signal,
				context.baseUrl,
			);
		},
		api: googleAntigravityApi(),
	});
}
