import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.ts";

/** Session entry shape used by the pi-client/pi-server synchronization protocol. */
export interface LegacySessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface LegacyMessageEntry extends LegacySessionTreeEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface LegacyThinkingLevelChangeEntry extends LegacySessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface LegacyModelChangeEntry extends LegacySessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface LegacyActiveToolsChangeEntry extends LegacySessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface LegacyCompactionEntry<T = unknown> extends LegacySessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore: number;
	retainedTail?: AgentMessage[];
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface LegacyBranchSummaryEntry<T = unknown> extends LegacySessionTreeEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface LegacyCustomEntry<T = unknown> extends LegacySessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LegacyCustomMessageEntry<T = unknown> extends LegacySessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface LegacyLabelEntry extends LegacySessionTreeEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface LegacySessionInfoEntry extends LegacySessionTreeEntryBase {
	type: "session_info";
	name?: string;
}

export interface LegacyLeafEntry extends LegacySessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}

export type SessionTreeEntry =
	| LegacyMessageEntry
	| LegacyThinkingLevelChangeEntry
	| LegacyModelChangeEntry
	| LegacyActiveToolsChangeEntry
	| LegacyCompactionEntry
	| LegacyBranchSummaryEntry
	| LegacyCustomEntry
	| LegacyCustomMessageEntry
	| LegacyLabelEntry
	| LegacySessionInfoEntry
	| LegacyLeafEntry;

export interface LegacySessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}

function getLegacyContextEntries(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: LegacyCompactionEntry | undefined;
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index];
		if (entry.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	if (!compaction) return [...pathEntries];

	const entries: SessionTreeEntry[] = [compaction];
	if (!compaction.retainedTail && compaction.firstKeptEntryId) {
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index++) {
			const entry = pathEntries[index];
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) entries.push(entry);
		}
	}
	entries.push(...pathEntries.slice(compactionIndex + 1));
	return entries;
}

function legacyEntryToContextMessages(entry: SessionTreeEntry): AgentMessage[] {
	if (entry.type === "message") {
		if (entry.message.role === "assistant" && entry.message.stopReason === "deferred") return [];
		return [entry.message];
	}
	if (entry.type === "custom_message") {
		return [createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...(entry.retainedTail ?? []),
		];
	}
	if (entry.type === "branch_summary") {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	return [];
}

/** Project the pi-client/pi-server session tree into provider context. */
export function buildLegacySessionContext(pathEntries: readonly SessionTreeEntry[]): LegacySessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}
	return {
		thinkingLevel,
		model,
		activeToolNames,
		messages: getLegacyContextEntries(pathEntries).flatMap(legacyEntryToContextMessages),
	};
}
