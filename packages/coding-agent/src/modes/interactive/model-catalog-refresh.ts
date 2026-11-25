import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		let active = this.activeByRuntime.get(modelRuntime);
		if (!active) {
			const controller = new AbortController();
			let created!: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh({ refreshServerAccounts: true, signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (this.activeByRuntime.get(modelRuntime) === created) {
					this.activeByRuntime.delete(modelRuntime);
				}
			});
			created = { controller, promise, waiters: 0 };
			active = created;
			this.activeByRuntime.set(modelRuntime, active);
		}

		active.waiters++;
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				active.controller.abort();
			}
		});
	}
}

const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/** Refresh interactive catalogs and server accounts, sharing concurrent callers with independent cancellation. */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}

/** Refresh the model list while its picker is open. */
export function refreshModelsSelectorCatalogs(
	modelRuntime: ModelCatalogRuntime,
	selector: ScopedModelsSelectorComponent,
	updateModels: () => void,
	requestRender: () => void,
): () => void {
	let disposed = false;
	let timedOut = false;
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 15_000);
	const timeoutMessage = "Model refresh timed out; showing cached models.";
	void refreshModelCatalogs(modelRuntime, controller.signal)
		.then((result) => {
			if (disposed) return;
			updateModels();
			if (result.aborted && timedOut) {
				selector.setRefreshStatus(timeoutMessage, "warning");
			} else if (result.errors.size > 0) {
				selector.setRefreshStatus(
					`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
					"warning",
				);
			} else {
				selector.setRefreshStatus("Model catalogs refreshed.", "success");
			}
			requestRender();
		})
		.catch((error: unknown) => {
			if (disposed) return;
			selector.setRefreshStatus(
				timedOut
					? timeoutMessage
					: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			requestRender();
		})
		.finally(() => clearTimeout(timeout));
	return () => {
		disposed = true;
		clearTimeout(timeout);
		controller.abort();
	};
}
