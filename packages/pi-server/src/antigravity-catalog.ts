// PiServer's Antigravity model catalog, discovered from the agy CLI on this machine.
import type { Model } from "@earendil-works/pi-ai";
import { readAntigravityModels } from "@earendil-works/pi-coding-agent/antigravity";
import { ACCOUNT_REFRESH_INTERVAL_MS, ACCOUNT_REFRESH_TIMEOUT_MS } from "./accounts.ts";

/** `models: null` means agy is missing or signed out; a failed discovery keeps the last catalog and reports why. */
export interface AntigravityCatalogSnapshot {
	models: Model<"google-antigravity">[] | null;
	error?: string;
}

/**
 * Discovers at startup, every four hours, and on explicit refresh, like the server account catalogs,
 * so client startups read the cached catalog instead of each starting an agy process.
 */
export class AntigravityCatalog {
	private readonly cwd: () => string;
	private current: AntigravityCatalogSnapshot = { models: null };
	private pending: Promise<AntigravityCatalogSnapshot> | undefined;
	private readonly ready: Promise<AntigravityCatalogSnapshot>;
	private readonly timer: ReturnType<typeof setInterval>;

	/** `cwd` gives the directory agy's discovery session runs in. */
	constructor(cwd: () => string) {
		this.cwd = cwd;
		this.ready = this.refresh();
		this.timer = setInterval(() => void this.refresh(), ACCOUNT_REFRESH_INTERVAL_MS);
		this.timer.unref();
	}

	/** The catalog after startup discovery. */
	async snapshot(): Promise<AntigravityCatalogSnapshot> {
		await this.ready;
		return this.current;
	}

	/** Discover again; concurrent callers share one agy process. */
	refresh(): Promise<AntigravityCatalogSnapshot> {
		this.pending ??= (async () => {
			try {
				const models = await readAntigravityModels(this.cwd(), AbortSignal.timeout(ACCOUNT_REFRESH_TIMEOUT_MS));
				this.current = { models: models ?? null };
			} catch (error) {
				this.current = {
					models: this.current.models,
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
		clearInterval(this.timer);
		await this.pending;
	}
}
