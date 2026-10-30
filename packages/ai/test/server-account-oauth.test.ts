import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devinOAuth } from "../src/auth/oauth/devin.ts";
import { googleAntigravityOAuth } from "../src/auth/oauth/google-antigravity.ts";
import type { OAuthAuth } from "../src/auth/types.ts";

vi.mock("node:http", () => ({
	createServer: vi.fn(() => {
		throw new Error("Server account OAuth must not bind a callback listener");
	}),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe.each([
	["devin", devinOAuth, "http://127.0.0.1:51122/callback"],
	["google-antigravity", googleAntigravityOAuth, "http://localhost:51121/oauth-callback"],
] satisfies [string, OAuthAuth, string][])("%s server account OAuth", (providerId, oauth, redirectUri) => {
	it("exchanges a manually relayed state-bound PKCE code without opening a callback listener", async () => {
		let authorization: URL | undefined;
		const requests: { url: string; init?: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://api.devin.ai/auth/cli/token") return Response.json({ token: "server-token" });
			if (url === "https://oauth2.googleapis.com/token") {
				return Response.json({ access_token: "server-token", refresh_token: "server-refresh", expires_in: 3600 });
			}
			if (url === "https://www.googleapis.com/oauth2/v2/userinfo?alt=json") {
				return Response.json({ email: "account@example.invalid" });
			}
			if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				return Response.json({ cloudaicompanionProject: "account-project" });
			}
			throw new Error(`Unexpected OAuth request: ${url}`);
		});
		const credential = await oauth.login(
			{
				signal: new AbortController().signal,
				notify: (event) => {
					if (event.type === "auth_url") authorization = new URL(event.url);
				},
				prompt: async (prompt) => {
					expect(prompt.type).toBe("manual_code");
					return `${redirectUri}?code=relayed-code&state=${authorization?.searchParams.get("state")}`;
				},
			},
			{ callbackMode: "manual" },
		);
		expect(createServer).not.toHaveBeenCalled();
		expect(credential.access).toBe("server-token");
		expect(authorization?.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authorization?.searchParams.get("code_challenge_method")).toBe("S256");
		const tokenRequest =
			providerId === "devin"
				? (JSON.parse(String(requests[0].init?.body)) as Record<string, string>)
				: Object.fromEntries(new URLSearchParams(String(requests[0].init?.body)));
		expect(tokenRequest.code).toBe("relayed-code");
		expect(createHash("sha256").update(tokenRequest.code_verifier).digest("base64url")).toBe(
			authorization?.searchParams.get("code_challenge"),
		);
		if (providerId === "google-antigravity") {
			expect(tokenRequest.redirect_uri).toBe(redirectUri);
			expect(credential).toMatchObject({ refresh: "server-refresh", projectId: "account-project" });
			expect(new Headers(requests[1].init?.headers).get("Authorization")).toBe("Bearer server-token");
			expect(new Headers(requests[2].init?.headers).get("Authorization")).toBe("Bearer server-token");
		}
	});

	it.each(["state", "origin", "code"])(
		"rejects a redirect with an invalid %s before token exchange",
		async (invalid) => {
			const fetcher = vi.fn();
			vi.stubGlobal("fetch", fetcher);
			let authorization: URL | undefined;
			await expect(
				oauth.login(
					{
						signal: new AbortController().signal,
						notify: (event) => {
							if (event.type === "auth_url") authorization = new URL(event.url);
						},
						prompt: async () => {
							const redirect = new URL(redirectUri);
							redirect.searchParams.set(
								"state",
								invalid === "state" ? "incorrect-state" : authorization!.searchParams.get("state")!,
							);
							if (invalid !== "code") redirect.searchParams.set("code", "relayed-code");
							if (invalid === "origin") redirect.hostname = "example.invalid";
							return redirect.href;
						},
					},
					{ callbackMode: "manual" },
				),
			).rejects.toThrow(invalid === "code" ? "missing the authorization code" : "redirect or state mismatch");
			expect(fetcher).not.toHaveBeenCalled();
			expect(createServer).not.toHaveBeenCalled();
		},
	);

	it("cancels the relayed prompt before any token request", async () => {
		const controller = new AbortController();
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		let promptSignal: AbortSignal | undefined;
		await expect(
			oauth.login(
				{
					signal: controller.signal,
					notify: () => {},
					prompt: (prompt) =>
						new Promise<string>((_resolve, reject) => {
							promptSignal = prompt.signal;
							prompt.signal?.addEventListener("abort", () => reject(prompt.signal?.reason), { once: true });
							controller.abort(new Error("Server account sign-in cancelled"));
						}),
				},
				{ callbackMode: "manual" },
			),
		).rejects.toThrow("Server account sign-in cancelled");
		expect(promptSignal?.aborted).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
		expect(createServer).not.toHaveBeenCalled();
	});
});
