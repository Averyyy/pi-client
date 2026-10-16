import { setTimeout as delay } from "node:timers/promises";
import type { Model } from "../../types.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { type OAuthCallbackServer, startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const API_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/hub/2.23.0 darwin/arm64";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

interface LoadResponse {
	cloudaicompanionProject?: string | { id?: string };
	allowedTiers?: { id: string; isDefault?: boolean }[];
	ineligibleTiers?: { reasonMessage: string }[];
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`Antigravity request failed (HTTP ${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as T;
}

function authenticatedRequest(
	token: string,
	body: unknown,
	signal: AbortSignal,
	headers: Record<string, string> = {},
): RequestInit {
	return {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			...headers,
		},
		body: JSON.stringify(body),
		signal,
	};
}

async function discoverProject(access: string, signal: AbortSignal): Promise<string> {
	const loaded = await requestJson<LoadResponse>(
		"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
		authenticatedRequest(access, { metadata: { ideType: "ANTIGRAVITY" } }, signal),
	);
	const project = loaded.cloudaicompanionProject;
	if (typeof project === "string" && project) return project;
	if (typeof project === "object" && project.id) return project.id;
	const tier = loaded.allowedTiers?.find((candidate) => candidate.isDefault);
	if (!tier) {
		throw new Error(
			loaded.ineligibleTiers?.map((entry) => entry.reasonMessage).join("; ") ||
				"Antigravity returned no project or eligible onboarding tier. Complete account setup in Antigravity.",
		);
	}
	const body = {
		tier_id: tier.id,
		metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.23.0", ide_name: "antigravity" },
	};
	for (;;) {
		const onboarded = await requestJson<{
			done?: boolean;
			error?: { message: string };
			response?: { cloudaicompanionProject?: { id?: string } };
		}>(
			`${API_BASE_URL}/v1internal:onboardUser`,
			authenticatedRequest(access, body, signal, {
				"User-Agent": `${USER_AGENT} google-api-nodejs-client/10.3.0`,
				"X-Goog-Api-Client": "gl-node/22.21.1",
			}),
		);
		if (onboarded.error) throw new Error(`Antigravity onboarding failed: ${onboarded.error.message}`);
		if (onboarded.done) {
			const id = onboarded.response?.cloudaicompanionProject?.id;
			if (!id) throw new Error("Antigravity onboarding returned no project");
			return id;
		}
		await delay(2000, undefined, { signal });
	}
}

async function exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<OAuthCredential> {
	const tokens = await requestJson<TokenResponse>(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
		signal,
	});
	if (!tokens.access_token || !tokens.refresh_token || !(tokens.expires_in > 0)) {
		throw new Error("Antigravity token exchange returned incomplete credentials");
	}
	const expires = Date.now() + tokens.expires_in * 1000;
	const user = await requestJson<{ email: string }>("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
		headers: { Authorization: `Bearer ${tokens.access_token}` },
		signal,
	});
	const projectId = await discoverProject(tokens.access_token, signal);
	return {
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token,
		expires,
		projectId,
		email: user.email,
	};
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let callback: OAuthCallbackServer<OAuthCredential> | undefined;
	try {
		callback = await startOAuthCallbackServer({
			providerName: "Google Antigravity",
			host: getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1",
			redirectHost: "localhost",
			port: 51121,
			path: "/oauth-callback",
			state,
			signal,
			complete: (code) => exchangeCode(code, verifier, signal),
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EACCES" && code !== "EADDRINUSE") throw error;
		interaction.notify({
			type: "info",
			message: `Cannot listen for the Antigravity callback on port 51121 (${code}). After sign-in, paste the full localhost redirect URL from your browser.`,
		});
	}
	try {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.search = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent",
		}).toString();
		interaction.notify({ type: "auth_url", url: url.href });
		const result = await raceWithAbortSignal(
			waitForCallbackOrManualInput(
				{
					...interaction,
					signal,
					prompt: (prompt) =>
						interaction.prompt({
							...prompt,
							signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal,
						}),
				},
				callback,
				{
					message: "Complete sign-in in your browser, or paste the full redirect URL:",
					placeholder: REDIRECT_URI,
				},
			),
			signal,
		);
		if (result.type === "callback") return result.value;
		const redirect = new URL(result.input.trim());
		if (redirect.origin + redirect.pathname !== REDIRECT_URI || redirect.searchParams.get("state") !== state) {
			throw new Error("Antigravity OAuth redirect or state mismatch");
		}
		const error = redirect.searchParams.get("error");
		if (error) throw new Error(`Antigravity authorization failed: ${error}`);
		const code = redirect.searchParams.get("code");
		if (!code) throw new Error("Antigravity redirect is missing the authorization code");
		return await exchangeCode(code, verifier, signal);
	} finally {
		callback?.close();
	}
}

export const googleAntigravityOAuth: OAuthAuth = {
	name: "Google Antigravity",
	isSubscription: true,
	loginLabel: "Sign in with Google Antigravity",
	login,
	async refresh(credential, signal) {
		const tokens = await requestJson<TokenResponse>(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				refresh_token: credential.refresh,
				grant_type: "refresh_token",
			}),
			signal,
		});
		if (!tokens.access_token || !(tokens.expires_in > 0))
			throw new Error("Antigravity refresh returned no valid token");
		return {
			...credential,
			access: tokens.access_token,
			refresh: tokens.refresh_token ?? credential.refresh,
			expires: Date.now() + tokens.expires_in * 1000,
		};
	},
	async toAuth(credential) {
		if (typeof credential.projectId !== "string" || !credential.projectId) {
			throw new Error("Antigravity credentials are missing the project ID. Run /login google-antigravity.");
		}
		return { apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }) };
	},
};

const VARIANT_THINKING_LEVELS: Record<string, Model<"google-antigravity">["thinkingLevelMap"]> = {
	"gemini-3.1-pro-high": { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	"gemini-3.1-pro-low": { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
	"gemini-3.8-flash-high": { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	"gemini-3.8-flash-medium": {
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
		max: null,
	},
	"gemini-3.8-flash-low": { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
};

export async function discoverGoogleAntigravityModels(
	credential: OAuthCredential,
	signal: AbortSignal,
	baseUrl = API_BASE_URL,
): Promise<Model<"google-antigravity">[]> {
	if (typeof credential.projectId !== "string" || !credential.projectId) {
		throw new Error("Antigravity credentials are missing the project ID. Run /login google-antigravity.");
	}
	const catalog = await requestJson<{
		agentModelSorts: { groups: { modelIds: string[] }[] }[];
		models: Record<
			string,
			{
				displayName: string;
				maxTokens: number;
				maxOutputTokens: number;
				supportsImages?: boolean;
				supportsThinking?: boolean;
				disabled?: boolean;
				isInternal?: boolean;
			}
		>;
	}>(
		`${baseUrl.replace(/\/$/, "")}/v1internal:fetchAvailableModels`,
		authenticatedRequest(credential.access, { project: credential.projectId }, signal),
	);
	if (!catalog.agentModelSorts) throw new Error("Antigravity returned no agent model selections");
	const models: Model<"google-antigravity">[] = [];
	const ids = new Set(catalog.agentModelSorts.flatMap((sort) => sort.groups.flatMap((group) => group.modelIds)));
	for (const id of ids) {
		const entry = catalog.models[id];
		if (!entry) throw new Error(`Antigravity returned no model metadata for ${id}`);
		if (entry.disabled || entry.isInternal) continue;
		if (!entry.displayName || !(entry.maxTokens > 0) || !(entry.maxOutputTokens > 0)) {
			throw new Error(`Antigravity returned incomplete model metadata for ${id}`);
		}
		models.push({
			id,
			name: entry.displayName,
			provider: "google-antigravity",
			api: "google-antigravity",
			baseUrl,
			reasoning: entry.supportsThinking === true,
			input: entry.supportsImages ? ["text", "image"] : ["text"],
			...(entry.supportsThinking && VARIANT_THINKING_LEVELS[id]
				? { thinkingLevelMap: VARIANT_THINKING_LEVELS[id] }
				: {}),
			contextWindow: entry.maxTokens,
			maxTokens: entry.maxOutputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	if (!models.length) throw new Error("Antigravity returned no available agent models for this account");
	return models;
}
