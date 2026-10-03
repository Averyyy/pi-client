import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type ApiStreamOptions,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	clampThinkingLevel,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	isModelType,
	type LoginOptions,
	lazyStream,
	type Message,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelThinkingLevel,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import {
	assertChatModel,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	cancelDeferredPiServer,
	classifyPiServer,
	fetchDeferredPiServer,
	fetchPiServerModels,
	generateImagesPiServer,
	streamPiServer,
	streamRawPiServer,
} from "./pi-server-client.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import {
	createVirtualModel,
	findLatestResponse,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteReason,
	type VirtualModelDefinition,
	withVirtualModels,
} from "./virtual-models.ts";

interface RegisteredVirtualModel {
	model: Model<Api>;
	route: VirtualModelDefinition["route"];
}

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly nativeCatalogProviders: ReadonlySet<string>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private readonly piServerMode = process.env.PI_SERVER_MODE === "true";
	private remoteCatalog: { models: readonly AnyModel[]; available: readonly AnyModel[] } = {
		models: [],
		available: [],
	};
	private remoteProviderCapabilities: readonly { id: string; fetchDeferred: boolean; cancelDeferred: boolean }[] = [];
	private remoteCatalogError: string | undefined;
	private registrationRefresh: Promise<void> = Promise.resolve();
	private readonly registrationRefreshErrors = new Map<string, string>();
	private remoteCatalogRefreshSeq = 0;
	private remoteCatalogLoaded = false;
	private localOperationAvailable: readonly AnyModel[] = [];
	private remoteProjection: { models: readonly AnyModel[]; available: readonly AnyModel[] } | undefined;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
		nativeCatalogProviders: ReadonlySet<string>,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.nativeCatalogProviders = nativeCatalogProviders;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const builtinProviders = builtinProviderCatalog.builtinProviders();
		const providers = builtinProviders.map((provider) =>
			provider.refreshModels !== undefined
				? provider
				: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
		);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.PI_OFFLINE === undefined,
			new Set(
				builtinProviders.filter((provider) => provider.refreshModels !== undefined).map((provider) => provider.id),
			),
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				const result = await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
				const remoteError = result.errors.get("pi-server");
				if (remoteError) throw remoteError;
				if (runtime.piServerMode && result.aborted) signal?.throwIfAborted();
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
			...this.virtualModels.keys(),
		]);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	private recomposeProvider(providerId: string): Provider | undefined {
		const provider = this.composeProvider(providerId);
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		else if (provider) this.models.setProvider(provider);
		else this.models.deleteProvider(providerId);
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	private composeProvider(providerId: string): Provider | undefined {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(providerId, base, this.config, extension);
			this.compositionErrors.delete(providerId);
			return provider;
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			return base;
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		this.remoteProjection = undefined;
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [allAvailable, checks, credentials] = await Promise.all([
			this.models.getAllAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		this.localOperationAvailable = allAvailable;
		this.remoteProjection = undefined;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: allAvailable.filter((model) => isModelType(model, "chat")),
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [allAvailable, auth, credential] = await Promise.all([
				this.models.getAllAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			this.localOperationAvailable = [
				...this.localOperationAvailable.filter((model) => model.provider !== providerId),
				...allAvailable,
			];
			this.remoteProjection = undefined;
			const available = allAvailable.filter((model) => isModelType(model, "chat"));
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		if (this.piServerMode) {
			const ids = new Set([
				...this.models.getProviders().map((provider) => provider.id),
				...this.getAllModels().map((model) => model.provider),
			]);
			return [...ids].flatMap((id) => this.getProvider(id) ?? []);
		}
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		const local = this.models.getProvider(providerId);
		if (!this.piServerMode) return local;
		const catalog = this.getAllModels(providerId);
		if (!local && catalog.length === 0) return undefined;
		const capabilities = this.remoteProviderCapabilities.find((provider) => provider.id === providerId);
		return {
			...local,
			id: providerId,
			name: local?.name ?? providerId,
			auth: local?.auth ?? {},
			getModels: () => this.getModels(providerId),
			getAllModels: () => this.getAllModels(providerId),
			stream: <TApi extends Api>(model: Model<TApi>, context: TranscriptContext, options?: ApiStreamOptions<TApi>) =>
				this.stream(model, context, options as ModelsApiStreamOptions<TApi> | undefined),
			streamSimple: (model, context, options) => this.streamSimple(model, context, options),
			generateImages:
				local?.generateImages || catalog.some((model) => isModelType(model, "image"))
					? (model, context, options) => this.generateImages(model, context, options)
					: undefined,
			classify:
				local?.classify || catalog.some((model) => isModelType(model, "classifier"))
					? (model, context, options) => this.classify(model, context, options)
					: undefined,
			fetchDeferred:
				local?.fetchDeferred || capabilities?.fetchDeferred
					? (model, handle, options) => this.streamDeferred(model, handle, options)
					: undefined,
			cancelDeferred:
				local?.cancelDeferred || capabilities?.cancelDeferred
					? (model, handle, options) => this.cancelDeferred(model, handle, options)
					: undefined,
		};
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		if (this.piServerMode) return this.getModelsOfType("chat", providerId);
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		if (this.piServerMode) return this.getModelOfType("chat", providerId, modelId);
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		if (this.piServerMode) return this.getRemoteModels(false, providerId).filter((model) => isModelType(model, type));
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		if (this.piServerMode) return this.getModelsOfType(type, providerId).find((model) => model.id === modelId);
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		if (this.piServerMode) return this.getRemoteModels(false, providerId);
		return this.models.getAllModels(providerId);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		if (this.piServerMode) {
			options?.signal?.throwIfAborted();
			await raceWithAbortSignal(this.registrationRefresh, options?.signal);
			if (!this.remoteCatalogLoaded) await this.refreshRemoteCatalog(options?.signal);
			return this.getRemoteModels(true, providerId).filter((model) => isModelType(model, type));
		}
		return this.models.getAvailableOfType(type, providerId, options);
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		if (this.piServerMode) {
			options?.signal?.throwIfAborted();
			await raceWithAbortSignal(this.registrationRefresh, options?.signal);
			if (!this.remoteCatalogLoaded) await this.refreshRemoteCatalog(options?.signal);
			return this.getRemoteModels(true, providerId);
		}
		return this.models.getAllAvailable(providerId, options);
	}

	private getRemoteModels(available: boolean, providerId?: string): readonly AnyModel[] {
		if (this.remoteProjection) {
			const models = available ? this.remoteProjection.available : this.remoteProjection.models;
			return providerId === undefined ? models : models.filter((model) => model.provider === providerId);
		}
		const catalog = new Map(
			this.remoteCatalog.models.map((model) => [`${model.type ?? "chat"}\0${model.provider}\0${model.id}`, model]),
		);
		for (const model of this.localOperationAvailable) {
			const key = `${model.type ?? "chat"}\0${model.provider}\0${model.id}`;
			if (!catalog.has(key)) catalog.set(key, model);
		}
		const localAvailableKeys = new Set(
			this.localOperationAvailable.map((model) => `${model.type ?? "chat"}\0${model.provider}\0${model.id}`),
		);
		for (const id of this.nativeCatalogProviders) {
			for (const model of this.models.getAllModels(id)) {
				const key = `${model.type ?? "chat"}\0${model.provider}\0${model.id}`;
				if (!catalog.has(key) || localAvailableKeys.has(key)) catalog.set(key, model);
			}
		}
		const availableKeys = new Set(
			this.remoteCatalog.available.map((model) => `${model.type ?? "chat"}\0${model.provider}\0${model.id}`),
		);
		for (const model of this.localOperationAvailable) {
			availableKeys.add(`${model.type ?? "chat"}\0${model.provider}\0${model.id}`);
		}
		const overlayProviders = new Set([...this.config.getProviderIds(), ...this.getRegisteredProviderIds()]);
		for (const id of overlayProviders) {
			const native = this.nativeExtensionProviders.get(id);
			const base = native ?? this.builtins.get(id);
			const baseModels = native
				? (native.getAllModels?.() ?? native.getModels())
				: [...catalog.values()].filter((model) => model.provider === id);
			const provider = composeModelProvider(
				id,
				base && {
					...base,
					getModels: () => baseModels.filter((model) => isModelType(model, "chat")),
					getAllModels: () => baseModels,
				},
				this.config,
				this.extensionProviders.get(id),
			);
			for (const [key, model] of catalog) if (model.provider === id) catalog.delete(key);
			for (const model of provider.getAllModels?.() ?? provider.getModels()) {
				catalog.set(`${model.type ?? "chat"}\0${model.provider}\0${model.id}`, model);
			}
		}
		const models = [...catalog.values()];
		const availableProviders = new Set(
			models
				.filter((model) => availableKeys.has(`${model.type ?? "chat"}\0${model.provider}\0${model.id}`))
				.map((model) => model.provider),
		);
		const virtualModels = [...this.virtualModels.values()].flatMap((models) =>
			[...models.values()].map((entry) => entry.model),
		);
		const virtualIds = new Set(virtualModels.map((model) => `${model.provider}\0${model.id}`));
		const physical = models.filter(
			(model) => !isModelType(model, "chat") || !virtualIds.has(`${model.provider}\0${model.id}`),
		);
		const eligibleVirtual = virtualModels.filter(
			(model) =>
				!models.some((entry) => entry.provider === model.provider) || availableProviders.has(model.provider),
		);
		this.remoteProjection = {
			models: [...physical, ...virtualModels],
			available: [
				...physical.filter((model) => availableKeys.has(`${model.type ?? "chat"}\0${model.provider}\0${model.id}`)),
				...eligibleVirtual,
			],
		};
		return this.getRemoteModels(available, providerId);
	}

	private async refreshRemoteCatalog(signal?: AbortSignal): Promise<void> {
		const seq = ++this.remoteCatalogRefreshSeq;
		const catalog = await fetchPiServerModels({ signal });
		if (seq !== this.remoteCatalogRefreshSeq) return;
		this.remoteCatalog = catalog;
		this.remoteProviderCapabilities = catalog.providers;
		this.remoteCatalogLoaded = true;
		this.remoteCatalogError = undefined;
		this.remoteProjection = undefined;
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (this.piServerMode) return this.getAvailableOfType("chat", providerId, options);
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		if (this.piServerMode) return this.getRemoteModels(true).filter((model) => isModelType(model, "chat"));
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		if (this.remoteCatalogError) errors.push(`pi-server model catalog: ${this.remoteCatalogError}`);
		for (const [providerId, error] of this.registrationRefreshErrors)
			errors.push(`Provider "${providerId}" refresh: ${error}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		if (this.piServerMode) return this.getRemoteModels(true, providerId).length > 0;
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		provider: Provider;
		model: TModel;
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		const requestModel: TModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
		return {
			provider,
			model: requestModel,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>,
		};
	}

	private async prepareRemoteRequest<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(model: TModel, options: TOptions | undefined): Promise<{ model: TModel; options: TOptions }> {
		if (options?.fetch !== undefined)
			throw new ModelsError("stream", "pi-server does not support custom fetch implementations");
		const resolution = this.models.getProvider(model.provider)
			? await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal })
			: undefined;
		let headers = mergeHeaders(mergeHeaders(model.headers, resolution?.auth.headers), options?.headers);
		const { transformHeaders, ...remoteOptions } = options ?? {};
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		return {
			model: resolution?.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...remoteOptions,
				apiKey: options?.apiKey ?? resolution?.auth.apiKey,
				headers,
				env: resolution?.env || options?.env ? { ...resolution?.env, ...options?.env } : undefined,
			} as TOptions,
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(model, async () => {
			assertChatModel(model);
			if (this.piServerMode) {
				if (isVirtualModel(model))
					throw new ModelsError(
						"stream",
						`Virtual model ${model.provider}/${model.id} must be routed before streaming`,
					);
				const prepared = await this.prepareRemoteRequest(model, options);
				return streamRawPiServer(prepared.model, transcript, prepared.options);
			}
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsRequestTransforms) | undefined,
			);
			return prepared.provider.stream(prepared.model, transcript, prepared.options as ApiStreamOptions<TApi>);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			return lazyStream(model, async () => {
				const route = await this.resolveModel(model, transcript.messages, {
					reason: "direct",
					thinkingLevel: options?.reasoning ?? "off",
					signal: options?.signal,
				});
				const { maxTokens: limit } = route.model;
				const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
				const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
				// Caller credentials were resolved for the virtual model's provider. Another provider
				// resolves its own, so they are not sent to the wrong vendor.
				const { apiKey, headers, env, ...rest } = options ?? {};
				const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
				return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
			});
		}
		return lazyStream(model, async () => {
			assertChatModel(model);
			if (this.piServerMode) {
				const prepared = await this.prepareRemoteRequest(model, options);
				return streamPiServer(prepared.model, transcript, prepared.options);
			}
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			assertChatModel(model);
			if (this.piServerMode) {
				const prepared = await this.prepareRemoteRequest(model, options);
				return fetchDeferredPiServer(prepared.model, handle, prepared.options);
			}
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		});
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		assertChatModel(model);
		if (this.piServerMode) {
			const prepared = await this.prepareRemoteRequest(model, options);
			await cancelDeferredPiServer(prepared.model, handle, prepared.options);
			return;
		}
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			if (this.piServerMode) {
				const prepared = await this.prepareRemoteRequest(model, options);
				return await generateImagesPiServer(prepared.model, context, prepared.options);
			}
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			return await prepared.provider.generateImages(prepared.model, context, prepared.options as ImagesOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			if (this.piServerMode) {
				const prepared = await this.prepareRemoteRequest(model, options);
				return await classifyPiServer(prepared.model, context, prepared.options);
			}
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal }, options);
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		if (options.signal?.aborted) return { aborted: true, errors: new Map() };
		try {
			await raceWithAbortSignal(this.registrationRefresh, options.signal);
		} catch (error) {
			if (options.signal?.aborted) return { aborted: true, errors: new Map() };
			throw error;
		}
		if (this.piServerMode) {
			this.config = await ModelConfig.load(this.modelsPath);
			this.configureRadiusProviders();
			this.rebuildProviders();
			let result = await this.models.refresh({ ...options, allowNetwork: false });
			const nativeProviders = [
				...new Set([...this.nativeCatalogProviders, ...this.nativeExtensionProviders.keys()]),
			].filter((id) => options.providers === undefined || options.providers.includes(id));
			if ((options.allowNetwork ?? this.modelNetworkEnabled) && nativeProviders.length > 0) {
				const nativeResult = await this.models.refresh({
					...options,
					providers: nativeProviders,
					allowNetwork: true,
				});
				result = {
					aborted: result.aborted || nativeResult.aborted,
					errors: new Map([...result.errors, ...nativeResult.errors]),
				};
			}
			const errors = new Map(result.errors);
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch (error) {
				if (!options.signal?.aborted)
					errors.set("availability", error instanceof Error ? error : new Error(String(error)));
			}
			try {
				if (!options.signal?.aborted) await this.refreshRemoteCatalog(options.signal);
			} catch (error) {
				if (!options.signal?.aborted) {
					const remoteError = error instanceof Error ? error : new Error(String(error));
					this.remoteCatalogError = remoteError.message;
					errors.set("pi-server", remoteError);
				}
			}
			for (const id of this.registrationRefreshErrors.keys()) {
				if (!errors.has(id) && (options.providers === undefined || options.providers.includes(id)))
					this.registrationRefreshErrors.delete(id);
			}
			return { aborted: result.aborted || options.signal?.aborted === true, errors };
		}
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		const result = await this.models.refresh(refreshOptions);
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	private queueRegistrationRefresh(providerId: string): void {
		this.registrationRefresh = this.registrationRefresh
			.then(async () => {
				const result = await this.models.refresh({ allowNetwork: false, providers: [providerId] });
				const error = result.errors.get(providerId);
				if (error) throw error;
				this.updateModelSnapshot();
				await this.refreshProviderAvailability(providerId, operationSignal());
				this.registrationRefreshErrors.delete(providerId);
			})
			.catch((error: unknown) => {
				this.registrationRefreshErrors.set(providerId, error instanceof Error ? error.message : String(error));
			});
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		this.markProvisionallyConfigured(
			provider.id,
			configuredRequestAuthStatus(this.config.getProvider(provider.id), undefined),
			provider.auth.oauth && !provider.auth.apiKey ? "oauth" : "api_key",
		);
		this.queueRegistrationRefresh(provider.id);
	}

	/**
	 * Mark a newly registered provider as configured when it has a stored credential or a configured
	 * API key. Availability checks run asynchronously, and callers such as initial model selection
	 * read the snapshot before they finish. The next availability pass replaces this entry.
	 */
	private markProvisionallyConfigured(
		providerId: string,
		configuredStatus: AuthStatus | undefined,
		type: AuthType,
	): void {
		if (!this.snapshot.storedProviders.has(providerId) && !configuredStatus?.configured) return;
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const auth = new Map(this.snapshot.auth);
		// Never clobber a real check result.
		if (!auth.get(providerId)) auth.set(providerId, { type, source: "configured provider" });
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.markProvisionallyConfigured(
			providerId,
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective),
			effective.oauth && !effective.apiKey ? "oauth" : "api_key",
		);
		this.queueRegistrationRefresh(providerId);
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.queueRegistrationRefresh(providerId);
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		const { provider: providerId, id } = definition;
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		const existing = this.getModel(providerId, id);
		if (existing && !isVirtualModel(existing)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		models.set(id, { model: createVirtualModel(definition), route: (request) => definition.route(request) });
		this.virtualModels.set(providerId, models);
		if (!this.recomposeProvider(providerId) && !this.snapshot.configuredProviders.has(providerId)) {
			// A provider of only virtual models needs no credentials. Mark it configured now: session
			// restore checks auth before the refresh below lands.
			const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			this.snapshot = { ...this.snapshot, auth, configuredProviders };
		}
		this.updateModelSnapshot();
		this.queueRegistrationRefresh(providerId);
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return;
		if (models.size === 0) this.virtualModels.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.queueRegistrationRefresh(providerId);
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	async resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute> {
		const name = `Virtual model ${model.provider}/${model.id}`;
		const virtual = this.virtualModels.get(model.provider)?.get(model.id);
		if (!virtual) throw new Error(`${name} is not registered.`);
		const { failed, ...request } = options;
		const latest = findLatestResponse(messages);
		const previousModel = latest && this.getPhysicalModel(latest.provider, latest.model);
		// A failed routing attempt names the virtual model; there is no physical request to report.
		const failedModel = failed && this.getPhysicalModel(failed.provider, failed.model);
		const route = await virtual.route({
			...request,
			model,
			previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
			failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
			messages,
		});
		const target = this.getPhysicalModel(route.model.provider, route.model.id);
		const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
		if (!target) throw new Error(`${routed}, which is not a physical model.`);
		if (!this.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
		return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
	}

	/** A catalog chat model that is not virtual. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
