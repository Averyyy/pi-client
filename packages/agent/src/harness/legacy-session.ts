import type {
	AssistantMessage,
	ImageContent,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
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
	/** Complete prompt and tool state at this compaction boundary. */
	systemMessage?: SystemMessage;
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

/** Content that a context edit may replace without changing message metadata. */
export type LegacyContextEditableContent =
	| UserMessage["content"]
	| AssistantMessage["content"]
	| ToolResultMessage["content"]
	| LegacyCustomMessageEntry["content"];

/** Append-only overlay for one earlier model-visible entry. */
export interface LegacyContextEditEntry extends LegacySessionTreeEntryBase {
	type: "context_edit";
	targetId: string;
	/** Null omits the target from provider context. A value replaces only its content. */
	replacement: { content: LegacyContextEditableContent } | null;
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
	| LegacyContextEditEntry
	| LegacyLabelEntry
	| LegacySessionInfoEntry
	| LegacyLeafEntry;

export interface LegacySessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}

/** One raw legacy entry and its model-visible projection after context edits. */
export interface LegacyProjectedSessionEntry {
	sourceEntry: SessionTreeEntry;
	messages: AgentMessage[];
}

export interface LegacySessionProjection extends LegacySessionContext {
	entries: LegacyProjectedSessionEntry[];
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
			if (
				foundFirstKept &&
				!(compaction.systemMessage && entry.type === "message" && entry.message.role === "system")
			) {
				entries.push(entry);
			}
		}
	}
	entries.push(...pathEntries.slice(compactionIndex + 1));
	return entries;
}

function isLegacyContextMessage(message: AgentMessage): boolean {
	return message.role !== "assistant" || message.stopReason !== "deferred";
}

/** Convert one raw legacy entry into its unedited provider messages. */
export function legacyEntryToContextMessages(entry: SessionTreeEntry): AgentMessage[] {
	if (entry.type === "message") {
		return isLegacyContextMessage(entry.message) ? [entry.message] : [];
	}
	if (entry.type === "custom_message") {
		return [createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [
			...(entry.systemMessage ? [entry.systemMessage] : []),
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...(entry.retainedTail ?? []).filter(isLegacyContextMessage),
		];
	}
	if (entry.type === "branch_summary") {
		return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
	}
	return [];
}

function projectLegacyContextEntry(entry: SessionTreeEntry, edit: LegacyContextEditEntry | undefined): AgentMessage[] {
	const messages = legacyEntryToContextMessages(entry);
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];

	return messages.map((message) => {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "custom"
		) {
			return message;
		}
		const content =
			(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		return { ...message, content } as AgentMessage;
	});
}

/** Build provenance-preserving provider context for a legacy session branch. */
export function buildLegacySessionProjection(pathEntries: readonly SessionTreeEntry[]): LegacySessionProjection {
	const contextEntries = getLegacyContextEntries(pathEntries);
	const edits = new Map<string, LegacyContextEditEntry>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}

	const entries = contextEntries.map(
		(sourceEntry, index): LegacyProjectedSessionEntry => ({
			sourceEntry,
			// Older compactions can remain in the newest compaction's retained raw range.
			// They are durable history but only the newest checkpoint contributes context.
			messages:
				sourceEntry.type === "compaction" && index > 0
					? []
					: projectLegacyContextEntry(sourceEntry, edits.get(sourceEntry.id)),
		}),
	);

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
		entries,
		messages: entries.flatMap((entry) => entry.messages),
	};
}

/** Project the pi-client/pi-server session tree into provider context. */
export function buildLegacySessionContext(pathEntries: readonly SessionTreeEntry[]): LegacySessionContext {
	const projection = buildLegacySessionProjection(pathEntries);
	return {
		thinkingLevel: projection.thinkingLevel,
		model: projection.model,
		activeToolNames: projection.activeToolNames,
		messages: projection.messages,
	};
}
