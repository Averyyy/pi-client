import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

/** Devin CLI OAuth protocol; credentials belong to Pi's credential store. */
export async function loginDevin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const verifier = randomBytes(96).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const callback = {
		promise: new Promise<string>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		}),
	};
	// The callback can reject before listen/notify completes.
	void callback.promise.catch(() => {});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/callback") {
			response.writeHead(404).end();
			return;
		}
		const code = url.searchParams.get("code");
		if (request.method !== "GET" || url.searchParams.get("state") !== state || !code) {
			response.writeHead(400).end("Invalid Devin login callback.");
			return;
		}
		response
			.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
			.end("Devin login received. You can close this tab.");
		resolveCode(code);
	});
	const abort = () => rejectCode(new Error("Devin login cancelled or timed out"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		signal.throwIfAborted();
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Devin callback did not bind a TCP port");
		const url = new URL("https://app.devin.ai/auth/cli/continue");
		url.search = new URLSearchParams({
			redirect_uri: `http://127.0.0.1:${address.port}/callback`,
			state,
			prompt: "select_account",
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		interaction.notify({ type: "auth_url", url: url.href });
		const code = await callback.promise;
		const response = await fetch("https://api.devin.ai/auth/cli/token", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier }),
			signal,
		});
		if (!response.ok) throw new Error(`Devin token exchange failed (HTTP ${response.status})`);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string" || !data.token) {
			throw new Error("Devin token exchange returned no token");
		}
		// The session-token response has no expiration or refresh token. Do not
		// invent a TTL; revoked sessions require an explicit login.
		return { type: "oauth", access: data.token, refresh: "", expires: Number.MAX_SAFE_INTEGER };
	} finally {
		signal.removeEventListener("abort", abort);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

export const devinOAuth: OAuthAuth = {
	name: "Devin Pro",
	isSubscription: true,
	login: loginDevin,
	refresh: async () => {
		throw new Error("Devin session expired. Run /login devin again.");
	},
	toAuth: async (credential) => ({ apiKey: credential.access }),
};
