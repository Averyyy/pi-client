import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AnyModel,
	type Api,
	type AuthEvent,
	type AuthPrompt,
	type Credential,
	type CredentialStore,
	createModels,
	isModelType,
	type Model,
	type ModelsStore,
	type ModelsStoreEntry,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { devinProvider } from "@earendil-works/pi-ai/providers/devin";
import { googleAntigravityProvider } from "@earendil-works/pi-ai/providers/google-antigravity";

export const ACCOUNT_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const ACCOUNT_REFRESH_TIMEOUT_MS = 60_000;
export const SERVER_ACCOUNT_PROVIDERS = ["devin", "google-antigravity"] as const;
export type ServerAccountProvider = (typeof SERVER_ACCOUNT_PROVIDERS)[number];

export interface ServerAccount {
	providerId: ServerAccountProvider;
	loggedIn: boolean;
	models: Model<Api>[];
	updatedAt?: number;
	error?: string;
	account?: { email?: string; projectId?: string };
}

export interface ServerAccountSnapshot {
	accounts: ServerAccount[];
}

export type AccountLoginEvent =
	| { event: "notify"; data: AuthEvent }
	| { event: "prompt"; data: { promptId: string; prompt: Omit<AuthPrompt, "signal"> } }
	| { event: "prompt_cancel"; data: { promptId: string } };

interface AccountFile {
	credential?: Credential;
	catalog?: ModelsStoreEntry;
}

interface LoginRun {
	providerId: ServerAccountProvider;
	controller: AbortController;
	prompts: Map<string, (value: string) => void>;
	settled: Promise<void>;
}

export function accountProvider(value: unknown): ServerAccountProvider {
	if (value === "devin" || value === "google-antigravity") return value;
	throw new Error("Account provider must be devin or google-antigravity");
}

/** One server process owns these credential and catalog files. */
export class ServerAccounts {
	readonly models: MutableModels;
	readonly ready: Promise<void>;
	private readonly directory: string;
	private readonly files = new Map<string, AccountFile>();
	private readonly writes = new Map<string, Promise<unknown>>();
	private readonly errors = new Map<string, string>();
	private readonly logins = new Map<string, LoginRun>();
	private readonly refreshes = new Map<string, { controller: AbortController; settled: Promise<void> }>();
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly catalogs: ModelsStore;
	private closed = false;

	constructor(directory: string, providers: readonly Provider[] = [devinProvider(), googleAntigravityProvider()]) {
		this.directory = directory;
		for (const providerId of SERVER_ACCOUNT_PROVIDERS) {
			const path = join(directory, `${providerId}.json`);
			this.files.set(providerId, existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AccountFile) : {});
		}
		const credentials: CredentialStore = {
			read: async (providerId, options) => {
				options?.signal?.throwIfAborted();
				return structuredClone(this.files.get(providerId)?.credential);
			},
			list: async (options) => {
				options?.signal?.throwIfAborted();
				return [...this.files].flatMap(([providerId, file]) =>
					file.credential ? [{ providerId, type: file.credential.type }] : [],
				);
			},
			modify: (providerId, fn, options) =>
				this.write(providerId, async (file) => {
					options?.signal?.throwIfAborted();
					const credential = await fn(structuredClone(file.credential));
					if (credential !== undefined) file.credential = credential;
					return structuredClone(file.credential);
				}),
			delete: (providerId, options) =>
				this.write(providerId, async (file) => {
					options?.signal?.throwIfAborted();
					delete file.credential;
				}),
		};
		this.catalogs = {
			read: async (providerId, options) => {
				options?.signal?.throwIfAborted();
				return structuredClone(this.files.get(providerId)?.catalog);
			},
			write: (providerId, entry, options) =>
				this.write(providerId, async (file) => {
					options?.signal?.throwIfAborted();
					file.catalog = structuredClone(entry);
				}),
			delete: (providerId, options) =>
				this.write(providerId, async (file) => {
					options?.signal?.throwIfAborted();
					delete file.catalog;
				}),
		};
		this.models = createModels({ credentials, modelsStore: this.catalogs });
		for (const provider of providers) {
			accountProvider(provider.id);
			this.models.setProvider(provider);
		}
		this.ready = this.models.refresh({ allowNetwork: false }).then((result) => {
			for (const [providerId, error] of result.errors) this.errors.set(providerId, error.message);
		});
		void this.ready
			.then(() => this.refresh())
			.catch((error: unknown) => console.error("Account refresh failed:", error));
		this.timer = setInterval(() => {
			void this.refresh().catch((error: unknown) => console.error("Account refresh failed:", error));
		}, ACCOUNT_REFRESH_INTERVAL_MS);
		this.timer.unref();
	}

	private write<T>(providerId: string, mutate: (file: AccountFile) => Promise<T>): Promise<T> {
		const previous = this.writes.get(providerId) ?? Promise.resolve();
		const operation = previous.then(async () => {
			const file = structuredClone(this.files.get(providerId) ?? {});
			const result = await mutate(file);
			mkdirSync(this.directory, { recursive: true });
			const path = join(this.directory, `${accountProvider(providerId)}.json`);
			writeFileSync(`${path}.tmp`, JSON.stringify(file), { mode: 0o600 });
			renameSync(`${path}.tmp`, path);
			this.files.set(providerId, file);
			return result;
		});
		this.writes.set(
			providerId,
			operation.then(
				() => {},
				() => {},
			),
		);
		return operation;
	}

	async snapshot(): Promise<ServerAccountSnapshot> {
		await this.ready;
		return {
			accounts: SERVER_ACCOUNT_PROVIDERS.map((providerId) => {
				const file = this.files.get(providerId)!;
				const credential = file.credential;
				const account =
					credential?.type === "oauth"
						? {
								...(typeof credential.email === "string" ? { email: credential.email } : {}),
								...(typeof credential.projectId === "string" ? { projectId: credential.projectId } : {}),
							}
						: undefined;
				return {
					providerId,
					loggedIn: credential !== undefined,
					models: credential
						? (file.catalog?.models ?? [])
								.filter((model): model is Model<Api> => isModelType(model, "chat"))
								.map((model) => ({ ...model, headers: undefined }))
						: [],
					...(file.catalog?.checkedAt !== undefined ? { updatedAt: file.catalog.checkedAt } : {}),
					...(this.errors.has(providerId) ? { error: this.errors.get(providerId) } : {}),
					...(account && Object.keys(account).length ? { account } : {}),
				};
			}),
		};
	}

	async refresh(providerId?: ServerAccountProvider): Promise<ServerAccountSnapshot> {
		await this.ready;
		if (this.closed) return this.snapshot();
		await Promise.all(
			(providerId ? [providerId] : SERVER_ACCOUNT_PROVIDERS).map(async (id) => {
				const pending = this.refreshes.get(id);
				if (pending) return pending.settled;
				const controller = new AbortController();
				const timeout = setTimeout(() => {
					controller.abort(
						new DOMException(
							`Account catalog refresh timed out after ${ACCOUNT_REFRESH_TIMEOUT_MS} ms`,
							"TimeoutError",
						),
					);
				}, ACCOUNT_REFRESH_TIMEOUT_MS);
				timeout.unref();
				const settled = this.models
					.refresh({ providers: [id], force: true, signal: controller.signal })
					.then((result) => {
						if (controller.signal.aborted) {
							const reason: unknown = controller.signal.reason;
							if (reason instanceof Error && reason.name === "TimeoutError") this.errors.set(id, reason.message);
							return;
						}
						const error = result.errors.get(id);
						if (error) this.errors.set(id, error.message);
						else this.errors.delete(id);
					})
					.finally(() => {
						clearTimeout(timeout);
						if (this.refreshes.get(id)?.controller === controller) this.refreshes.delete(id);
					});
				this.refreshes.set(id, { controller, settled });
				await settled;
			}),
		);
		return this.snapshot();
	}

	async login(
		providerId: ServerAccountProvider,
		loginId: string,
		emit: (event: AccountLoginEvent) => void,
		externalSignal?: AbortSignal,
	): Promise<ServerAccountSnapshot> {
		if (!loginId || this.logins.has(loginId)) throw new Error("A unique loginId is required");
		const previousLogins = [...this.logins].filter(([, login]) => login.providerId === providerId).map(([id]) => id);
		const controller = new AbortController();
		const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
		const run: LoginRun = { providerId, controller, prompts: new Map(), settled: Promise.resolve() };
		this.logins.set(loginId, run);
		run.settled = Promise.resolve()
			.then(async () => {
				signal.throwIfAborted();
				await this.ready;
				signal.throwIfAborted();
				for (const id of previousLogins) {
					await this.cancelLogin(id);
					signal.throwIfAborted();
				}
				await this.models.login(
					providerId,
					"oauth",
					{
						signal,
						notify: (data) => emit({ event: "notify", data }),
						prompt: (prompt) =>
							new Promise<string>((resolve, reject) => {
								const promptId = randomUUID();
								const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
								const onAbort = () => {
									run.prompts.delete(promptId);
									emit({ event: "prompt_cancel", data: { promptId } });
									reject(promptSignal.reason);
								};
								if (promptSignal.aborted) {
									reject(promptSignal.reason);
									return;
								}
								promptSignal.addEventListener("abort", onAbort, { once: true });
								run.prompts.set(promptId, (value) => {
									promptSignal.removeEventListener("abort", onAbort);
									run.prompts.delete(promptId);
									resolve(value);
								});
								const { signal: _signal, ...wirePrompt } = prompt;
								emit({ event: "prompt", data: { promptId, prompt: wirePrompt } });
							}),
					},
					{ callbackMode: "manual" },
				);
				signal.throwIfAborted();
				const refresh = this.refreshes.get(providerId);
				refresh?.controller.abort();
				await refresh?.settled;
				await this.refresh(providerId);
			})
			.finally(() => {
				this.logins.delete(loginId);
			});
		await run.settled;
		return this.snapshot();
	}

	reply(loginId: string, promptId: string, value: string): void {
		const prompt = this.logins.get(loginId)?.prompts.get(promptId);
		if (!prompt) throw new Error("Account login prompt is no longer pending");
		prompt(value);
	}

	async cancelLogin(loginId: string): Promise<void> {
		const login = this.logins.get(loginId);
		if (!login) return;
		login.controller.abort(new DOMException("Account login cancelled", "AbortError"));
		await login.settled.catch((error: unknown) => {
			if (!(error instanceof Error) || error.name !== "AbortError") throw error;
		});
	}

	async logout(providerId: ServerAccountProvider): Promise<ServerAccountSnapshot> {
		await this.ready;
		for (const [loginId, login] of this.logins) if (login.providerId === providerId) await this.cancelLogin(loginId);
		const refresh = this.refreshes.get(providerId);
		refresh?.controller.abort();
		await refresh?.settled;
		await this.models.logout(providerId);
		await this.catalogs.delete(providerId);
		this.errors.delete(providerId);
		return this.snapshot();
	}

	resolve<T extends AnyModel>(model: T): T {
		const providerId = accountProvider(model.provider);
		const file = this.files.get(providerId)!;
		if (!file.credential) throw new Error(`No server account is logged in for ${providerId}`);
		const selected = file.catalog?.models.find(
			(candidate) => (candidate.type ?? "chat") === (model.type ?? "chat") && candidate.id === model.id,
		);
		if (!selected) throw new Error(`Model is not in the server account catalog: ${providerId}/${model.id}`);
		return selected as T;
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		await this.ready;
		for (const refresh of this.refreshes.values()) refresh.controller.abort();
		await Promise.all([...this.logins.keys()].map((id) => this.cancelLogin(id)));
		await Promise.all([...this.refreshes.values()].map((refresh) => refresh.settled));
		await Promise.all(this.writes.values());
	}
}
