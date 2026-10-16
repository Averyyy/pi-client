import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as callbackModule from "../src/auth/oauth/callback-server.ts";
import { discoverGoogleAntigravityModels, googleAntigravityOAuth } from "../src/auth/oauth/google-antigravity.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";

vi.mock("../src/auth/oauth/callback-server.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof callbackModule>();
	return { ...actual, startOAuthCallbackServer: vi.fn() };
});

const signal = new AbortController().signal;
const credential: OAuthCredential = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: 0,
	projectId: "account-project",
	email: "account@example.com",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe.sequential("Google Antigravity OAuth", () => {
	beforeEach(() => {
		vi.mocked(callbackModule.startOAuthCallbackServer).mockResolvedValue({
			redirectUri: "http://localhost:51121/oauth-callback",
			wait: async () => undefined,
			cancel: () => {},
			close: () => {},
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("advertises subscription OAuth and starts with no account models", () => {
		const provider = googleAntigravityProvider();
		expect(provider.auth.apiKey).toBeUndefined();
		expect(provider.auth.oauth?.isSubscription).toBe(true);
		expect(provider.getModels()).toEqual([]);
	});

	it("completes PKCE login on the registered callback and discovers the account project", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				if (url === "https://oauth2.googleapis.com/token") {
					return json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
				}
				if (url === "https://www.googleapis.com/oauth2/v2/userinfo?alt=json") {
					return json({ email: "account@example.com" });
				}
				if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
					return json({ cloudaicompanionProject: "account-project" });
				}
				throw new Error(`Unexpected URL ${url}`);
			}),
		);
		let authorization: URL | undefined;
		vi.mocked(callbackModule.startOAuthCallbackServer).mockImplementationOnce(async (options) => ({
			redirectUri: "http://localhost:51121/oauth-callback",
			wait: () => options.complete("browser-code"),
			cancel: () => {},
			close: () => {},
		}));
		const before = Date.now();
		const loggedIn = await googleAntigravityOAuth.login({
			signal,
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				authorization = new URL(event.url);
			},
		});
		expect(callbackModule.startOAuthCallbackServer).toHaveBeenLastCalledWith(
			expect.objectContaining({
				port: 51121,
				path: "/oauth-callback",
				redirectHost: "localhost",
				state: authorization?.searchParams.get("state"),
			}),
		);
		expect(loggedIn).toMatchObject({ ...credential, expires: expect.any(Number) });
		expect(loggedIn.expires).toBeGreaterThanOrEqual(before + 3600_000);
		expect(authorization?.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
		expect(authorization?.searchParams.get("access_type")).toBe("offline");
		expect(authorization?.searchParams.get("scope")?.split(" ")).toHaveLength(5);
		const tokenRequest = new URLSearchParams(String(requests[0].init?.body));
		expect(tokenRequest.get("code")).toBe("browser-code");
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenRequest.get("code_verifier")!));
		expect(authorization?.searchParams.get("code_challenge")).toBe(Buffer.from(hash).toString("base64url"));
		expect(JSON.parse(String(requests[2].init?.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
	});

	it("accepts a full pasted redirect and onboards the server-selected eligible tier", async () => {
		let authorization: URL | undefined;
		const requests: { url: string; init?: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				if (url.endsWith("/token"))
					return json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
				if (url.includes("/userinfo")) return json({ email: "account@example.com" });
				if (url.endsWith(":loadCodeAssist"))
					return json({ allowedTiers: [{ id: "paid-account-tier", isDefault: true }] });
				if (url.endsWith(":onboardUser"))
					return json({ done: true, response: { cloudaicompanionProject: { id: "new-project" } } });
				throw new Error(`Unexpected URL ${url}`);
			}),
		);
		const loggedIn = await googleAntigravityOAuth.login({
			signal,
			notify: (event) => {
				if (event.type === "auth_url") authorization = new URL(event.url);
			},
			prompt: async () =>
				`http://localhost:51121/oauth-callback?code=manual-code&state=${authorization?.searchParams.get("state")}`,
		});
		expect(loggedIn.projectId).toBe("new-project");
		expect(requests[3].url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser");
		expect(JSON.parse(String(requests[3].init?.body))).toMatchObject({ tier_id: "paid-account-tier" });
	});

	it("rejects a pasted redirect with the wrong state before exchanging a code", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			googleAntigravityOAuth.login({
				signal,
				notify: () => {},
				prompt: async () => "http://localhost:51121/oauth-callback?code=code&state=wrong-state",
			}),
		).rejects.toThrow("redirect or state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("announces a reserved callback port and accepts the manual redirect", async () => {
		vi.mocked(callbackModule.startOAuthCallbackServer).mockRejectedValueOnce(
			Object.assign(new Error("reserved port"), { code: "EACCES" }),
		);
		let authorization: URL | undefined;
		const notices: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/token"))
					return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
				if (url.includes("/userinfo")) return json({ email: "account@example.com" });
				if (url.endsWith(":loadCodeAssist")) return json({ cloudaicompanionProject: "project" });
				throw new Error(`Unexpected URL ${url}`);
			}),
		);
		const loggedIn = await googleAntigravityOAuth.login({
			signal,
			notify: (event) => {
				if (event.type === "auth_url") authorization = new URL(event.url);
				if (event.type === "info") notices.push(event.message);
			},
			prompt: async () =>
				`http://localhost:51121/oauth-callback?code=code&state=${authorization?.searchParams.get("state")}`,
		});
		expect(loggedIn.projectId).toBe("project");
		expect(notices).toEqual([expect.stringContaining("51121 (EACCES)")]);
	});

	it("cancels a pending manual sign-in", async () => {
		vi.mocked(callbackModule.startOAuthCallbackServer).mockRejectedValueOnce(
			Object.assign(new Error("reserved port"), { code: "EACCES" }),
		);
		const controller = new AbortController();
		const login = googleAntigravityOAuth.login({
			signal: controller.signal,
			notify: (event) => {
				if (event.type === "auth_url") controller.abort(new Error("cancelled sign-in"));
			},
			prompt: () => new Promise<string>(() => {}),
		});
		await expect(login).rejects.toThrow("cancelled sign-in");
	});

	it("requires account setup when no project or eligible tier is returned", async () => {
		let authorization: URL | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (String(input).endsWith("/token"))
					return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
				if (String(input).includes("/userinfo")) return json({ email: "account@example.com" });
				return json({});
			}),
		);
		await expect(
			googleAntigravityOAuth.login({
				signal,
				notify: (event) => {
					if (event.type === "auth_url") authorization = new URL(event.url);
				},
				prompt: async () =>
					`http://localhost:51121/oauth-callback?code=code&state=${authorization?.searchParams.get("state")}`,
			}),
		).rejects.toThrow("Complete account setup in Antigravity");
	});

	it("preserves project and account metadata when refreshing and uses refreshed transport auth", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-token");
			return json({ access_token: "new-access", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const refreshed = await googleAntigravityOAuth.refresh(credential, signal);
		expect(refreshed).toMatchObject({ ...credential, access: "new-access", expires: expect.any(Number) });
		expect(await googleAntigravityOAuth.toAuth(refreshed)).toEqual({
			apiKey: JSON.stringify({ token: "new-access", projectId: "account-project" }),
		});
	});

	it("surfaces token refresh failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ error: "invalid_grant" }, 400)),
		);
		await expect(googleAntigravityOAuth.refresh(credential, signal)).rejects.toThrow("HTTP 400");
	});

	it("uses account-selected agent models in order and excludes disabled, internal, and unlisted models", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
			expect(JSON.parse(String(init?.body))).toEqual({ project: "account-project" });
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
			return json({
				agentModelSorts: [
					{ groups: [{ modelIds: ["new-account-model", "gemini-3.8-flash-high", "disabled", "internal"] }] },
					{ groups: [{ modelIds: ["gemini-3.8-flash-high"] }] },
				],
				models: {
					"gemini-3.8-flash-high": {
						displayName: "Account Gemini Flash",
						maxTokens: 1048576,
						maxOutputTokens: 65536,
						supportsImages: true,
						supportsThinking: true,
					},
					"new-account-model": { displayName: "Account Model", maxTokens: 500, maxOutputTokens: 100 },
					disabled: { disabled: true },
					internal: { isInternal: true },
					unlisted: { displayName: "Unlisted", maxTokens: 500, maxOutputTokens: 100 },
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const models = await discoverGoogleAntigravityModels(credential, signal);
		expect(models.map((model) => model.id)).toEqual(["new-account-model", "gemini-3.8-flash-high"]);
		expect(models[0]).toMatchObject({
			reasoning: false,
			input: ["text"],
		});
		expect(models[1]).toMatchObject({
			id: "gemini-3.8-flash-high",
			name: "Account Gemini Flash",
			contextWindow: 1048576,
			maxTokens: 65536,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports an account with no selectable agent models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ agentModelSorts: [], models: {} })),
		);
		await expect(discoverGoogleAntigravityModels(credential, signal)).rejects.toThrow("no available agent models");
	});

	it("discovers the exact Gemini 3.8 Flash account variants with their supported reasoning levels", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json({
					agentModelSorts: [
						{
							groups: [
								{ modelIds: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"] },
							],
						},
					],
					models: {
						"gemini-3.8-flash-high": {
							displayName: "Gemini 3.8 Flash High",
							maxTokens: 1048576,
							maxOutputTokens: 65536,
							supportsImages: true,
							supportsThinking: true,
							thinkingBudget: -1,
						},
						"gemini-3.8-flash-medium": {
							displayName: "Gemini 3.8 Flash Medium",
							maxTokens: 1048576,
							maxOutputTokens: 65536,
							supportsImages: true,
							supportsThinking: true,
							thinkingBudget: 4000,
						},
						"gemini-3.8-flash-low": {
							displayName: "Gemini 3.8 Flash Low",
							maxTokens: 1048576,
							maxOutputTokens: 65536,
							supportsImages: true,
							supportsThinking: true,
							thinkingBudget: 1000,
						},
					},
				}),
			),
		);
		const models = await discoverGoogleAntigravityModels(credential, signal);
		expect(models).toHaveLength(3);
		expect(models[0]).toMatchObject({
			id: "gemini-3.8-flash-high",
			provider: "google-antigravity",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
		});
		expect(models.map((model) => getSupportedThinkingLevels(model))).toEqual([["high"], ["medium"], ["low"]]);
	});

	it("rejects account-selected model IDs without metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json({
					agentModelSorts: [{ groups: [{ modelIds: ["missing-model"] }] }],
					models: {},
				}),
			),
		);
		await expect(discoverGoogleAntigravityModels(credential, signal)).rejects.toThrow(
			"no model metadata for missing-model",
		);
	});
});
