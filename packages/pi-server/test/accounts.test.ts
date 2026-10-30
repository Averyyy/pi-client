import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	type LoginOptions,
	type Model,
	type OAuthCredential,
	type ProviderAuthInteraction,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_REFRESH_INTERVAL_MS, ACCOUNT_REFRESH_TIMEOUT_MS, ServerAccounts } from "../src/accounts.ts";

const model: Model<"account-test"> = {
	id: "discovered",
	name: "Discovered",
	provider: "devin",
	api: "account-test",
	baseUrl: "https://account.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};
const credential: OAuthCredential = {
	type: "oauth",
	access: "server-access",
	refresh: "server-refresh",
	expires: Number.MAX_SAFE_INTEGER,
	email: "account@example.test",
};

function fixture() {
	const fetchModels = vi.fn(async (_context: RefreshModelsContext) => [model]);
	const login = vi.fn(async (_interaction: ProviderAuthInteraction, _options?: LoginOptions) => credential);
	const refresh = vi.fn(async () => ({ ...credential, access: "renewed-access" }));
	const provider = createProvider({
		id: "devin",
		models: [{ ...model, id: "static-only" }],
		auth: { oauth: { name: "Test", login, refresh, toAuth: async (stored) => ({ apiKey: stored.access }) } },
		fetchModels,
		api: {
			stream: () => {
				throw new Error("Unused stream");
			},
			streamSimple: () => {
				throw new Error("Unused stream");
			},
		},
	});
	return { provider, fetchModels, login, refresh };
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("server accounts", () => {
	let directory: string;
	let accounts: ServerAccounts | undefined;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-server-accounts-"));
	});
	afterEach(async () => {
		await accounts?.close();
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	});

	function seed(storedCredential = credential): void {
		writeFileSync(
			join(directory, "devin.json"),
			JSON.stringify({
				credential: storedCredential,
				catalog: { models: [model], checkedAt: 123 },
			}),
		);
	}

	it("restores the committed catalog without exposing tokens or static models and retains it on refresh errors", async () => {
		seed();
		const provider = fixture();
		provider.fetchModels.mockRejectedValue(new Error("Discovery unavailable"));
		accounts = new ServerAccounts(directory, [provider.provider]);
		await accounts.refresh();
		const snapshot = await accounts.snapshot();
		expect(snapshot.accounts[0]).toEqual({
			providerId: "devin",
			loggedIn: true,
			models: [{ ...model, headers: undefined }],
			updatedAt: 123,
			error: "Discovery unavailable",
			account: { email: "account@example.test" },
		});
		expect(JSON.stringify(snapshot)).not.toContain("server-access");
		expect(JSON.stringify(snapshot)).not.toContain("server-refresh");
		expect(accounts.models.getModels("devin").map((entry) => entry.id)).toContain("static-only");
		expect(() => accounts!.resolve({ ...model, id: "static-only" })).toThrow("server account catalog");
		expect(accounts.resolve({ ...model, baseUrl: "https://client.invalid" }).baseUrl).toBe(model.baseUrl);
	});

	it("refreshes expired credentials and the account catalog on the four-hour timer", async () => {
		vi.useFakeTimers();
		seed({ ...credential, expires: 0 });
		const provider = fixture();
		accounts = new ServerAccounts(directory, [provider.provider]);
		await accounts.refresh();
		expect(provider.refresh).toHaveBeenCalledTimes(1);
		expect(provider.fetchModels).toHaveBeenCalledTimes(1);
		expect(provider.fetchModels.mock.calls[0][0].credential?.type).toBe("oauth");
		await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_INTERVAL_MS);
		expect(provider.fetchModels).toHaveBeenCalledTimes(2);
		expect(readFileSync(join(directory, "devin.json"), "utf8")).toContain("renewed-access");
		await accounts.close();
		await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_INTERVAL_MS);
		expect(provider.fetchModels).toHaveBeenCalledTimes(2);
	});

	it("logout supersedes an in-flight catalog publication and removes credentials and models from disk", async () => {
		seed();
		const pending = gate();
		const started = gate();
		const provider = fixture();
		provider.fetchModels.mockImplementation(async () => {
			started.release();
			await pending.promise;
			return [{ ...model, id: "late" }];
		});
		accounts = new ServerAccounts(directory, [provider.provider]);
		await started.promise;
		const loggedOut = await accounts.logout("devin");
		pending.release();
		await Promise.resolve();
		expect(loggedOut.accounts[0]).toEqual({ providerId: "devin", loggedIn: false, models: [] });
		expect(JSON.parse(readFileSync(join(directory, "devin.json"), "utf8"))).toEqual({});
		expect(() => accounts!.resolve(model)).toThrow("No server account");
		await accounts.close();
		accounts = new ServerAccounts(directory, [fixture().provider]);
		await accounts.refresh();
		expect((await accounts.snapshot()).accounts[0].loggedIn).toBe(false);
	});

	it("times out stalled discovery, retains the committed catalog and retries on the next periodic refresh", async () => {
		vi.useFakeTimers();
		seed();
		const pending = gate();
		const started = gate();
		const provider = fixture();
		provider.fetchModels.mockImplementationOnce(async () => {
			started.release();
			await pending.promise;
			return [{ ...model, id: "stale" }];
		});
		accounts = new ServerAccounts(directory, [provider.provider]);
		const refresh = accounts.refresh();
		await started.promise;
		await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_TIMEOUT_MS);
		const snapshot = await refresh;
		expect(snapshot.accounts[0].models.map((entry) => entry.id)).toEqual(["discovered"]);
		expect(snapshot.accounts[0].updatedAt).toBe(123);
		expect(snapshot.accounts[0].error).toBe(
			`Account catalog refresh timed out after ${ACCOUNT_REFRESH_TIMEOUT_MS} ms`,
		);
		await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_INTERVAL_MS - ACCOUNT_REFRESH_TIMEOUT_MS);
		expect(provider.fetchModels).toHaveBeenCalledTimes(2);
		expect((await accounts.snapshot()).accounts[0].error).toBeUndefined();
		pending.release();
		await Promise.resolve();
		expect((await accounts.snapshot()).accounts[0].models.map((entry) => entry.id)).toEqual(["discovered"]);
	});

	it("logout waits for a rotated refresh credential to persist before deleting it", async () => {
		seed({ ...credential, expires: 0 });
		const rotating = gate();
		const started = gate();
		const provider = fixture();
		provider.refresh.mockImplementation(async () => {
			started.release();
			await rotating.promise;
			return { ...credential, access: "rotated" };
		});
		accounts = new ServerAccounts(directory, [provider.provider]);
		await started.promise;
		let complete = false;
		const logout = accounts.logout("devin").then(() => {
			complete = true;
		});
		await Promise.resolve();
		expect(complete).toBe(false);
		rotating.release();
		await logout;
		expect(JSON.parse(readFileSync(join(directory, "devin.json"), "utf8"))).toEqual({});
	});

	it("cancels a pending login prompt and prevents login from restoring a logged-out account", async () => {
		const provider = fixture();
		provider.login.mockImplementation(async (interaction) => {
			await interaction.prompt({ type: "manual_code", message: "Paste callback" });
			return credential;
		});
		accounts = new ServerAccounts(directory, [provider.provider]);
		const prompted = gate();
		const events: string[] = [];
		const login = accounts.login("devin", "login", ({ event }) => {
			events.push(event);
			if (event === "prompt") prompted.release();
		});
		const result = login.catch((error: unknown) => error);
		await prompted.promise;
		await accounts.logout("devin");
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(events).toEqual(["prompt", "prompt_cancel"]);
		expect((await accounts.snapshot()).accounts[0].loggedIn).toBe(false);
	});

	it("persists a completed remote login and refreshes its catalog immediately", async () => {
		const provider = fixture();
		accounts = new ServerAccounts(directory, [provider.provider]);
		const result = await accounts.login("devin", "login", () => {});
		expect(provider.login.mock.calls[0][1]).toEqual({ callbackMode: "manual" });
		expect(result.accounts[0].models.map((entry) => entry.id)).toEqual(["discovered"]);
		await accounts.close();
		accounts = new ServerAccounts(directory, [fixture().provider]);
		await accounts.ready;
		expect((await accounts.snapshot()).accounts[0].loggedIn).toBe(true);
	});

	it.each(["cancel", "connection"])("cancels login during initialization through %s", async (source) => {
		const initializing = gate();
		const provider = fixture();
		const originalRefresh = provider.provider.refreshModels!;
		provider.provider.refreshModels = async (context) => {
			if (!context.allowNetwork) await initializing.promise;
			await originalRefresh(context);
		};
		accounts = new ServerAccounts(directory, [provider.provider]);
		const controller = new AbortController();
		const result = accounts
			.login("devin", "initializing", () => {}, controller.signal)
			.catch((error: unknown) => error);
		const cancelled =
			source === "cancel"
				? accounts.cancelLogin("initializing")
				: Promise.resolve().then(() => {
						controller.abort(new DOMException("Account login connection closed", "AbortError"));
					});
		await Promise.resolve();
		expect(provider.login).not.toHaveBeenCalled();
		initializing.release();
		await cancelled;
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(provider.login).not.toHaveBeenCalled();
		expect((await accounts.snapshot()).accounts[0].loggedIn).toBe(false);
	});

	it("cancels a replacement login while the previous login is cleaning up", async () => {
		const prompted = gate();
		const cleanup = gate();
		const cleanupStarted = gate();
		const provider = fixture();
		provider.login.mockImplementation(async (interaction) => {
			try {
				prompted.release();
				await interaction.prompt({ type: "manual_code", message: "Paste callback" });
				return credential;
			} finally {
				cleanupStarted.release();
				await cleanup.promise;
			}
		});
		accounts = new ServerAccounts(directory, [provider.provider]);
		const first = accounts.login("devin", "first", () => {}).catch((error: unknown) => error);
		await prompted.promise;
		const second = accounts.login("devin", "second", () => {}).catch((error: unknown) => error);
		await cleanupStarted.promise;
		const cancel = accounts.cancelLogin("second");
		cleanup.release();
		await cancel;
		expect(await first).toMatchObject({ name: "AbortError" });
		expect(await second).toMatchObject({ name: "AbortError" });
		expect(provider.login).toHaveBeenCalledTimes(1);
	});
});
