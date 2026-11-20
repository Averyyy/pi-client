import { setTimeout as delay } from "node:timers/promises";
import { ANTIGRAVITY_USER_AGENT } from "../../api/google-antigravity-client.ts";
import type {
	AntigravityRoute,
	AntigravityRouteLevel,
	GoogleAntigravityModel,
} from "../../api/google-antigravity-model.ts";
import type { Model } from "../../types.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { type OAuthCallbackServer, startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const API_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = ANTIGRAVITY_USER_AGENT;
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

async function login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential> {
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let callback: OAuthCallbackServer<OAuthCredential> | undefined;
	if (options?.callbackMode !== "manual") {
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

/** Runtime ids end with the reasoning effort the model was cataloged for. */
const EFFORT_SUFFIX = /^(.*)-(low|medium|high|xhigh)$/;
const MODEL_ENUM = /^MODEL_[A-Z0-9_]+$/;

interface CatalogEntry {
	/** Runtime id the backend expects for this effort variant. */
	id: string;
	name: string;
	maxTokens: number;
	maxOutputTokens: number;
	supportsImages: boolean;
	supportsThinking: boolean;
	modelEnum?: string;
	level?: AntigravityRouteLevel;
}

/**
 * Discover the account's agent models. Effort variants of one model id are grouped into a
 * single pi model whose `thinkingLevelMap` selects the matching runtime id per request.
 */
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
				model?: string;
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
	const groups = new Map<string, CatalogEntry[]>();
	const ids = new Set(catalog.agentModelSorts.flatMap((sort) => sort.groups.flatMap((group) => group.modelIds)));
	for (const id of ids) {
		const entry = catalog.models[id];
		if (!entry) throw new Error(`Antigravity returned no model metadata for ${id}`);
		if (entry.disabled || entry.isInternal) continue;
		if (!entry.displayName || !(entry.maxTokens > 0) || !(entry.maxOutputTokens > 0)) {
			throw new Error(`Antigravity returned incomplete model metadata for ${id}`);
		}
		const suffix = EFFORT_SUFFIX.exec(id);
		const level = entry.supportsThinking === true && suffix ? (suffix[2] as AntigravityRouteLevel) : undefined;
		const baseId = level ? suffix![1]! : id;
		const catalogEntry: CatalogEntry = {
			id,
			name: entry.displayName,
			maxTokens: entry.maxTokens,
			maxOutputTokens: entry.maxOutputTokens,
			supportsImages: entry.supportsImages === true,
			supportsThinking: entry.supportsThinking === true,
			...(typeof entry.model === "string" && MODEL_ENUM.test(entry.model) ? { modelEnum: entry.model } : {}),
			...(level ? { level } : {}),
		};
		const group = groups.get(baseId);
		if (group) group.push(catalogEntry);
		else groups.set(baseId, [catalogEntry]);
	}
	const models: Model<"google-antigravity">[] = [];
	for (const [baseId, entries] of groups) {
		// A group with an unsuffixed member mixes conversation ids; keep those as their own models.
		if (entries.some((entry) => entry.level === undefined)) {
			for (const entry of entries) models.push(singleModel(entry, baseUrl));
			continue;
		}
		models.push(groupedModel(baseId, entries, baseUrl));
	}
	if (!models.length) throw new Error("Antigravity returned no available agent models for this account");
	return models;
}

/** One model and its per-effort wire routes. */
function groupedModel(baseId: string, entries: CatalogEntry[], baseUrl: string): GoogleAntigravityModel {
	const levels: Partial<Record<AntigravityRouteLevel, AntigravityRoute>> = {};
	for (const entry of entries) {
		if (levels[entry.level!]) throw new Error(`Antigravity returned duplicate effort variants for ${baseId}`);
		levels[entry.level!] = { runtimeId: entry.id, ...(entry.modelEnum ? { modelEnum: entry.modelEnum } : {}) };
	}
	const fallback = levels.low ?? levels.medium ?? levels.high ?? levels.xhigh;
	if (!fallback) throw new Error(`Antigravity returned no effort variant for ${baseId}`);
	return {
		id: baseId,
		name: entries[0]!.name.replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, ""),
		provider: "google-antigravity",
		api: "google-antigravity",
		baseUrl,
		reasoning: true,
		input: entries.every((entry) => entry.supportsImages) ? ["text", "image"] : ["text"],
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: levels.low ? "low" : null,
			medium: levels.medium ? "medium" : null,
			high: levels.high ? "high" : null,
			xhigh: levels.xhigh ? "xhigh" : null,
			max: null,
		},
		contextWindow: Math.min(...entries.map((entry) => entry.maxTokens)),
		maxTokens: Math.min(...entries.map((entry) => entry.maxOutputTokens)),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		antigravityRoutes: { default: fallback, levels },
	};
}

/** A catalog model without effort variants; its own runtime id is the only route. */
function singleModel(entry: CatalogEntry, baseUrl: string): GoogleAntigravityModel {
	return {
		id: entry.id,
		name: entry.name,
		provider: "google-antigravity",
		api: "google-antigravity",
		baseUrl,
		reasoning: entry.supportsThinking,
		input: entry.supportsImages ? ["text", "image"] : ["text"],
		contextWindow: entry.maxTokens,
		maxTokens: entry.maxOutputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(entry.modelEnum
			? {
					antigravityRoutes: {
						default: { runtimeId: entry.id, modelEnum: entry.modelEnum },
						levels: {},
					},
				}
			: {}),
	};
}
