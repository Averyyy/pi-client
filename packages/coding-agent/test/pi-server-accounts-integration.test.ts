import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AuthEvent,
	type AuthPrompt,
	createAssistantMessageEventStream,
	createModels,
	InMemoryModelsStore,
	type Model,
	type OAuthCredential,
	type Provider,
	type ProviderAuthInteraction,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerAccounts } from "../../pi-server/src/accounts.ts";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions } from "../../pi-server/src/session-store.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CacheWarmer } from "../src/core/cache-warmer.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { loginPiServerAccount, readPiServerAccounts } from "../src/core/pi-server-accounts.ts";
import { compactPiServer, resetAllSessionTracking, streamPiServer } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const accountModel: Model<"account-fixture"> = {
	id: "account-model",
	name: "Account model",
	provider: "devin",
	api: "account-fixture",
	baseUrl: "https://account.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
	promptCache: { short: 60, long: 300 },
};
const credential: OAuthCredential = {
	type: "oauth",
	access: "server-access-token",
	refresh: "server-refresh-token",
	expires: Number.MAX_SAFE_INTEGER,
	email: "account@example.invalid",
};
const oldCredential: OAuthCredential = { ...credential, access: "obsolete-client-token" };

describe("pi-server account ownership over HTTP", () => {
	let server: Server;
	let baseUrl: string;
	let directory: string;
	let accounts: ServerAccounts;
	let provider: Provider;
	let loginFlow: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>;
	let catalog: Model<"account-fixture">[];
	let calls: StreamOptions[];
	let requests: string[];
	let localCredentials: AuthStorage;
	let originalFetch: typeof fetch;

	beforeEach(async () => {
		clearAllSessions();
		resetAllSessionTracking();
		catalog = [accountModel];
		calls = [];
		requests = [];
		loginFlow = async (interaction) => {
			interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/authorize" });
			const code = await interaction.prompt({ type: "manual_code", message: "Authorization code" });
			expect(code).toBe("fixture-code");
			return credential;
		};
		let current: Model<"account-fixture">[] = [];
		const fixtureStream: Provider["stream"] = (model, _context, options) => {
			calls.push(options ?? {});
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text: "Fixture summary" }],
				stopReason: "stop",
				timestamp: 1,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		};
		provider = {
			id: "devin",
			name: "Devin fixture",
			getModels: () => current,
			auth: {
				oauth: {
					name: "Devin fixture",
					login: (interaction) => loginFlow(interaction),
					refresh: async (value) => value,
					toAuth: async (value) => ({ apiKey: value.access }),
				},
			},
			refreshModels: async (context) => {
				const models = context.allowNetwork ? catalog : context.stored?.models;
				if (!models || context.credential?.type !== "oauth") return;
				await context.publish({
					persist: { models, checkedAt: Date.now() },
					update: () => {
						current = models as Model<"account-fixture">[];
					},
				});
			},
			stream: fixtureStream,
			streamSimple: fixtureStream,
		};
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockReturnValue([
			{
				...provider,
				getModels: () => [{ ...accountModel, id: "client-only-model" }],
				refreshModels: async () => {
					throw new Error("Client account discovery is forbidden");
				},
				stream: () => {
					throw new Error("Client inference is forbidden");
				},
				streamSimple: () => {
					throw new Error("Client inference is forbidden");
				},
			},
		]);
		directory = mkdtempSync(join(tmpdir(), "pi-account-http-"));
		accounts = new ServerAccounts(join(directory, "accounts"), [provider]);
		server = createPiServer(
			{ authToken: "account-http-token", sessionStoreDir: join(directory, "sessions") },
			createModels(),
			accounts,
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener address");
		baseUrl = `http://127.0.0.1:${address.port}`;
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", baseUrl);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "account-http-token");
		localCredentials = AuthStorage.inMemory({ devin: oldCredential });
		originalFetch = fetch;
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(String(input));
			return originalFetch(input, init);
		});
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(directory, { recursive: true, force: true });
		resetAllSessionTracking();
		clearAllSessions();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	function runtime() {
		return ModelRuntime.create({
			credentials: localCredentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
		});
	}

	async function login(client: ModelRuntime) {
		const notifications: AuthEvent[] = [];
		const result = await client.login("devin", "oauth", {
			prompt: async () => "fixture-code",
			notify: (event) => notifications.push(event),
		});
		expect(notifications).toEqual([{ type: "auth_url", url: "https://auth.example.invalid/authorize" }]);
		expect(result).toEqual({ type: "remote", providerId: "devin" });
	}

	it("publishes account models at startup and keeps tokens exclusively on the server", async () => {
		const client = await runtime();
		expect(await client.getAvailable("devin")).toEqual([]);
		expect(await client.listCredentials()).toEqual([]);
		await login(client);
		expect(client.getAvailableSnapshot()).toEqual([accountModel]);
		expect(await client.getAuth("devin")).toBeUndefined();
		expect(client.getProviderAuthStatus("devin")).toEqual({
			configured: true,
			source: "server_account",
			label: "pi-server account",
		});
		expect(await localCredentials.read("devin")).toEqual(oldCredential);
		expect(readFileSync(join(directory, "accounts", "devin.json"), "utf8")).toContain(credential.access);
		expect(JSON.stringify(await readPiServerAccounts())).not.toContain(credential.access);
		const restartedClient = await runtime();
		expect(restartedClient.getAvailableSnapshot()).toEqual([accountModel]);
		expect(requests.some((request) => new URL(request).pathname === "/api/models")).toBe(false);
		catalog = [{ ...accountModel, id: "new-account-model" }];
		await accounts.refresh("devin");
		await restartedClient.refresh({ providers: ["devin"], allowNetwork: false });
		expect(restartedClient.getAvailableSnapshot().map((model) => model.id)).toEqual(["new-account-model"]);
		await restartedClient.logout("devin");
		expect(restartedClient.getAvailableSnapshot()).toEqual([]);
		expect(await localCredentials.read("devin")).toEqual(oldCredential);
		expect(readFileSync(join(directory, "accounts", "devin.json"), "utf8")).not.toContain(credential.access);
	});

	it("cancels obsolete manual prompts and continues the server OAuth flow", async () => {
		loginFlow = async (interaction) => {
			const controller = new AbortController();
			const oldPrompt = interaction.prompt({ type: "manual_code", message: "Old code", signal: controller.signal });
			const rejected = oldPrompt.catch((error: unknown) => error);
			controller.abort();
			await rejected;
			expect(await interaction.prompt({ type: "text", message: "Current code" })).toBe("fixture-code");
			return credential;
		};
		const prompts: string[] = [];
		let cancelled = false;
		await loginPiServerAccount("devin", {
			notify: () => {},
			prompt: (prompt) => {
				prompts.push(prompt.message);
				if (prompt.message === "Current code") return Promise.resolve("fixture-code");
				return new Promise<string>((_resolve, reject) => {
					prompt.signal?.addEventListener(
						"abort",
						() => {
							cancelled = true;
							reject(prompt.signal?.reason);
						},
						{ once: true },
					);
				});
			},
		});
		expect(prompts).toEqual(["Old code", "Current code"]);
		expect(cancelled).toBe(true);
	});

	it("acknowledges cancelled login and clears pending prompts without storing credentials", async () => {
		const controller = new AbortController();
		let resolvePrompt: (prompt: AuthPrompt) => void = () => {};
		const promptReceived = new Promise<AuthPrompt>((resolve) => {
			resolvePrompt = resolve;
		});
		const pending = loginPiServerAccount("devin", {
			signal: controller.signal,
			notify: () => {},
			prompt: (prompt) => {
				resolvePrompt(prompt);
				return new Promise<string>((_resolve, reject) => {
					prompt.signal?.addEventListener("abort", () => reject(prompt.signal?.reason), { once: true });
				});
			},
		});
		const rejected = expect(pending).rejects.toThrow();
		const prompt = await promptReceived;
		controller.abort();
		await rejected;
		expect(prompt.signal?.aborted).toBe(true);
		expect((await accounts.snapshot()).accounts[0].loggedIn).toBe(false);
		expect(requests.some((request) => request.endsWith("/api/accounts/login/cancel"))).toBe(true);
		const client = await runtime();
		await login(client);
	});

	it("uses server account auth for chat, compaction, and replay", async () => {
		const client = await runtime();
		await login(client);
		const chat = await client
			.streamSimple(
				accountModel,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{
					sessionId: "account-chat",
					apiKey: "caller-client-key",
					headers: { Authorization: "Bearer caller-client-token" },
					env: { CLIENT_TOKEN: "caller-client-token" },
				},
			)
			.result();
		expect(chat.stopReason).toBe("stop");
		const compact = await compactPiServer(
			accountModel,
			{
				messages: [
					{ role: "user", content: "Summarize this conversation", timestamp: 1 },
					chat,
					{ role: "user", content: "Continue", timestamp: 2 },
				],
			},
			{
				sessionId: "account-compact",
				authSource: "server-account",
				apiKey: "caller-client-key",
				headers: { Authorization: "Bearer caller-client-token" },
				env: { CLIENT_TOKEN: "caller-client-token" },
				settings: { reserveTokens: 100, keepRecentTokens: 0 },
			},
		);
		expect(compact.compaction.summary).toContain("Fixture summary");
		const warm = await streamPiServer(
			accountModel,
			{ messages: [] },
			{
				sessionId: "account-chat",
				authSource: "server-account",
				apiKey: "obsolete-client-token",
				cacheRetention: "long",
				onCacheRetentionResolved: (retention) => expect(retention).toBe("long"),
			},
		);
		expect((await warm.result()).stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(3);
		for (const options of calls) {
			expect(options.apiKey).toBe(credential.access);
			expect(options.headers?.Authorization).toBeUndefined();
			expect(options.env?.CLIENT_TOKEN).toBeUndefined();
		}
	});

	it("keeps server auth through the SDK's scheduled cache warming request", async () => {
		const client = await runtime();
		await login(client);
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
		]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: client,
			model: accountModel,
			settingsManager: SettingsManager.inMemory({
				cacheWarming: "idle",
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			autoSessionName: false,
			tools: [],
		});
		try {
			await session.prompt("Use server account auth");
			const warmer = (session as unknown as { _cacheWarmer: CacheWarmer })._cacheWarmer;
			const scheduled = warmer as unknown as {
				run?: { timer?: ReturnType<typeof setTimeout> };
				refresh(run: object): Promise<void>;
			};
			expect(scheduled.run).toBeDefined();
			clearTimeout(scheduled.run?.timer);
			await scheduled.refresh(scheduled.run!);
			expect(calls).toHaveLength(2);
			expect(calls[0].apiKey).toBe(credential.access);
			expect(calls[1]).toMatchObject({ apiKey: credential.access, maxTokens: 1 });
			expect(JSON.stringify(calls)).not.toContain(oldCredential.access);
		} finally {
			session.dispose();
		}
	});

	it("requires an API token for account reads and mutations", async () => {
		const viewerLogin = await fetch(`${baseUrl}/viewer/login`, {
			method: "POST",
			headers: { Origin: baseUrl, Authorization: "Bearer account-http-token" },
		});
		expect(viewerLogin.status).toBe(200);
		const cookie = viewerLogin.headers.get("set-cookie")!.split(";")[0];
		expect((await fetch(`${baseUrl}/viewer/api/projects`, { headers: { Cookie: cookie } })).status).toBe(200);
		for (const [path, body] of [
			["/api/accounts", undefined],
			["/api/accounts/refresh", {}],
			["/api/accounts/logout", { providerId: "devin" }],
			["/api/accounts/login", { providerId: "devin", loginId: "unauthenticated" }],
		] as const) {
			const response = await fetch(`${baseUrl}${path}`, {
				method: body ? "POST" : "GET",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: body ? JSON.stringify(body) : undefined,
			});
			expect(response.status).toBe(401);
		}
	});
});
