import type { Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	getSelectPageIndex,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getDistinctModelName, getModelSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
function normalizeEnabled(result: string[], allIds: string[]): EnabledIds {
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

function toggle(enabledIds: EnabledIds, allIds: string[], id: string): EnabledIds {
	if (enabledIds === null) return allIds.filter((modelId) => modelId !== id);
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return normalizeEnabled([...enabledIds, id], allIds);
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return normalizeEnabled(result, allIds);
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<any> | undefined;
	enabled: boolean;
}

export interface ModelsConfig {
	allModels: readonly Model<any>[];
	enabledModelIds?: string[] | null;
	refreshStatus?: string;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

interface ModelSelectionCallbacks {
	selectedModelId: string;
	onSelect: (modelId: string) => void;
	onCancel: () => void;
}

/**
 * Searchable model list for editing the cycling scope or selecting one compact model.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	readonly capturesViewportInput: boolean = true;
	private modelsById: Map<string, Model<any>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private filteredItems: ModelItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private footerText: Text;
	private callbacks: ModelsCallbacks | ModelSelectionCallbacks;
	private maxVisible = 8;
	private isDirty = false;
	private refreshStatusText?: Text;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks | ModelSelectionCallbacks) {
		super();
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.enabledIds = config.enabledModelIds ? [...config.enabledModelIds] : null;
		this.filteredItems = this.buildItems();
		const singleSelection = "onSelect" in callbacks;
		if (singleSelection) {
			this.selectedIndex = this.filteredItems.findIndex((item) => item.fullId === callbacks.selectedModelId);
		}

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", theme.bold(singleSelection ? "Compact Model" : "Model Configuration")), 0, 0),
		);
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					singleSelection
						? "Select the model for manual and automatic compaction."
						: `Session-only. ${keyDisplayText("app.models.save")} to save to settings.`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer hint
		this.addChild(new Spacer(1));
		if (config.refreshStatus) {
			this.refreshStatusText = new Text(theme.fg("muted", `  ${config.refreshStatus}`), 0, 0);
			this.addChild(this.refreshStatusText);
		}
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());
		this.updateList();
	}

	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
		this.refresh();
		const refreshedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
		if (refreshedIndex >= 0) {
			this.selectedIndex = refreshedIndex;
			this.updateList();
		}
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		this.refreshStatusText?.setText(theme.fg(kind, `  ${message}`));
	}

	private buildItems(): ModelItem[] {
		if ("onSelect" in this.callbacks) {
			const { selectedModelId } = this.callbacks;
			const ids = ["none", ...this.allIds];
			if (!ids.includes(selectedModelId)) ids.splice(1, 0, selectedModelId);
			return ids.map((fullId) => ({
				fullId,
				model: this.modelsById.get(fullId),
				enabled: fullId === selectedModelId,
			}));
		}
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	private getFooterText(): string {
		if ("onSelect" in this.callbacks) {
			return theme.fg("dim", `  ${keyDisplayText("tui.select.confirm")} select · Esc back`);
		}
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const parts = [
			`${keyDisplayText("tui.select.confirm")} toggle`,
			`${keyDisplayText("app.models.enableAll")} all`,
			`${keyDisplayText("app.models.clearAll")} clear`,
			`${keyDisplayText("app.models.toggleProvider")} provider`,
			`${keyDisplayText("app.models.reorderUp")}/${keyDisplayText("app.models.reorderDown")} reorder`,
			`${keyDisplayText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query
			? fuzzyFilter(items, query, (item) =>
					item.model
						? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: item.fullId,
				)
			: items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		const singleSelection = "onSelect" in this.callbacks;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const id = item.model?.id ?? item.fullId;
			const isNone = singleSelection && item.fullId === "none";
			const styledId = item.model || isNone ? id : theme.strikethrough(id);
			const modelText = isSelected ? theme.fg("accent", styledId) : styledId;
			const name = item.model ? getDistinctModelName(item.model) : undefined;
			const nameText = name ? theme.fg("muted", ` (${name})`) : "";
			const providerBadge = isNone
				? ""
				: theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
			const status = item.enabled && (item.model || singleSelection) ? theme.fg("accent", "✓ ") : "  ";
			this.listContainer.addChild(new Text(`${prefix}${status}${modelText}${nameText}${providerBadge}`, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		const selected = this.filteredItems[this.selectedIndex];
		const detail = selected.model
			? `Model Name: ${selected.model.name}`
			: singleSelection && selected.fullId === "none"
				? "Use the session model"
				: "Model unavailable";
		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(theme.fg("muted", `  ${detail}`), 0, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Navigation
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		const pageIndex = getSelectPageIndex(kb, data, this.selectedIndex, this.filteredItems.length, this.maxVisible);
		if (pageIndex !== undefined) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = pageIndex;
			this.updateList();
			return;
		}
		if ("onSelect" in this.callbacks) {
			if (kb.matches(data, "tui.select.confirm")) {
				const item = this.filteredItems[this.selectedIndex];
				if (item && (item.model || item.fullId === "none")) this.callbacks.onSelect(item.fullId);
				return;
			}
		} else if (this.handleScopeInput(data, this.callbacks)) {
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		// A new query moves the selection to the top match. Cursor keys leave the selection alone.
		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const query = this.searchInput.getValue();
		if (query === previousQuery) return;
		if (query) this.selectedIndex = 0;
		this.refresh();
	}

	private handleScopeInput(data: string, callbacks: ModelsCallbacks): boolean {
		const kb = getKeybindings();
		const notifyChange = () => callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);

		// Reorder enabled models
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return true;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.selectedIndex += delta;
					this.refresh();
					notifyChange();
				}
			}
			return true;
		}

		// Toggle on Enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.enabledIds = toggle(this.enabledIds, this.allIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				notifyChange();
			}
			return true;
		}

		// Enable all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			notifyChange();
			return true;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			notifyChange();
			return true;
		}

		// Toggle provider of current item
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				notifyChange();
			}
			return true;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return true;
		}
		return false;
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
