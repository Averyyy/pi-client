// PiServer's Antigravity model catalog, discovered from the agy CLI on this machine.
import type { Model } from "@earendil-works/pi-ai";
import { readAntigravityModels } from "@earendil-works/pi-coding-agent/antigravity";
import { ACCOUNT_REFRESH_TIMEOUT_MS } from "./accounts.ts";

/** `models: null` means agy is missing or signed out; a failed discovery keeps the last catalog and reports why. */
export interface AntigravityCatalogSnapshot {
	models: Model<"google-antigravity">[] | null;
	error?: string;
}

/**
 * Starts agy only when a person needs the catalog: on the first read, then on explicit refresh
 * (`/model`, `/login`). No timer starts agy in the background, and client startups share the cache.
 */
export class AntigravityCatalog {
	private readonly cwd: () => string;
	private current: AntigravityCatalogSnapshot | undefined;
	private pending: Promise<AntigravityCatalogSnapshot> | undefined;

	/** `cwd` gives the directory agy's discovery session runs in. */
	constructor(cwd: () => string) {
		this.cwd = cwd;
	}

	/** The cached catalog, discovered on the first read. */
	async snapshot(): Promise<AntigravityCatalogSnapshot> {
		return this.current ?? this.refresh();
	}

	/** Discover again; concurrent callers share one agy process. */
	refresh(): Promise<AntigravityCatalogSnapshot> {
		this.pending ??= (async () => {
			try {
				const models = await readAntigravityModels(this.cwd(), AbortSignal.timeout(ACCOUNT_REFRESH_TIMEOUT_MS));
				this.current = { models: models ?? null };
			} catch (error) {
				this.current = {
					models: this.current?.models ?? null,
					error: error instanceof Error ? error.message : String(error),
				};
			} finally {
				this.pending = undefined;
			}
			return this.current;
		})();
		return this.pending;
	}

	async close(): Promise<void> {
		await this.pending;
	}
}
