import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatUserAgent } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export const PUBLIC_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface CatalogEntry {
	status: 200 | 404 | 501;
	body: string;
	etag?: string;
	lastModified?: string;
	checkedAt: number;
}

export class PublicCatalogRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Shared public pi.dev catalogs, fetched only when a client requests a provider. */
export class PublicModelCatalog {
	private readonly directory: string;
	private readonly upstreamBaseUrl: string;
	private readonly providers: Set<string>;
	private readonly pending = new Map<string, Promise<CatalogEntry>>();
	private readonly entries = new Map<string, CatalogEntry>();
	private readonly controller = new AbortController();

	constructor(directory: string, upstreamBaseUrl = "https://pi.dev") {
		this.directory = directory;
		this.upstreamBaseUrl = upstreamBaseUrl;
		const staticProviders = new Set<string>(getBuiltinProviders());
		this.providers = new Set(
			builtinProviders()
				.filter(
					(provider) =>
						staticProviders.has(provider.id) && (!provider.refreshModels || provider.id === "openrouter"),
				)
				.map((provider) => provider.id),
		);
	}

	async get(provider: string, piVersion: string | null, force = false): Promise<CatalogEntry> {
		if (!this.providers.has(provider)) throw new PublicCatalogRequestError(404, "Unknown public catalog provider");
		if (!piVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(piVersion)) {
			throw new PublicCatalogRequestError(400, "pi-version must be a semantic version");
		}
		this.controller.signal.throwIfAborted();
		const key = `${provider}--${Buffer.from(piVersion).toString("hex")}`;
		const pending = this.pending.get(key);
		if (pending) return pending;
		const request = this.refresh(key, provider, piVersion, force);
		this.pending.set(key, request);
		try {
			return await request;
		} finally {
			this.pending.delete(key);
		}
	}

	private async refresh(key: string, provider: string, piVersion: string, force: boolean): Promise<CatalogEntry> {
		const path = join(this.directory, `${key}.json`);
		let stored = this.entries.get(key);
		if (!stored) {
			try {
				stored = JSON.parse(await readFile(path, "utf8")) as CatalogEntry;
				this.entries.set(key, stored);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (!force && stored && Date.now() - stored.checkedAt < PUBLIC_CATALOG_REFRESH_INTERVAL_MS) return stored;
		const url = new URL(`/api/models/providers/${provider}`, this.upstreamBaseUrl);
		url.searchParams.set("types", "chat,image,classifier");
		url.searchParams.set("pi-version", piVersion);
		const response = await fetch(url, {
			headers: {
				accept: "application/json",
				"User-Agent": formatUserAgent({ userAgent: "detailed", version: piVersion }),
				...(stored?.etag ? { "if-none-match": stored.etag } : {}),
			},
			signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]),
		});
		let entry: CatalogEntry;
		if (response.status === 304 && stored) {
			entry = { ...stored, checkedAt: Date.now() };
		} else if (response.status === 404 || response.status === 501) {
			await response.body?.cancel();
			entry = {
				status: response.status,
				body: "[]",
				lastModified: "Thu, 01 Jan 1970 00:00:00 GMT",
				checkedAt: Date.now(),
			};
		} else if (response.status === 200) {
			const body = await response.text();
			JSON.parse(body);
			entry = {
				status: 200,
				body,
				checkedAt: Date.now(),
				etag: response.headers.get("etag") ?? undefined,
				lastModified: response.headers.get("last-modified") ?? undefined,
			};
		} else {
			await response.body?.cancel();
			throw new Error(`Model catalog request failed for ${provider}: ${response.status}`);
		}
		this.controller.signal.throwIfAborted();
		await mkdir(this.directory, { recursive: true });
		await writeFile(`${path}.tmp`, JSON.stringify(entry));
		await rename(`${path}.tmp`, path);
		this.entries.set(key, entry);
		return entry;
	}

	async close(): Promise<void> {
		this.controller.abort(new Error("Public model catalog closed"));
		await Promise.allSettled(this.pending.values());
	}
}
