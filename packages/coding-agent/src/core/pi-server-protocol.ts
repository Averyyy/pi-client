import { createHash } from "node:crypto";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AnyModel, Message, ProviderResponse, Tool } from "@earendil-works/pi-ai";
import type { AntigravityCallback } from "../antigravity.ts";

export type PiServerProviderCallbackRequest =
	| { callbackId: string; kind: "payload"; model: AnyModel; payload: unknown }
	| { callbackId: string; kind: "response"; model: AnyModel; response: ProviderResponse }
	| { callbackId: string; kind: "antigravity"; model: AnyModel; request: AntigravityCallback };

export interface PiServerStaticContext {
	systemPrompt?: string;
	tools?: Tool[];
}

export function hashPiServerStaticContext(context: PiServerStaticContext | undefined): string {
	if (!context) return "";
	const canonical = {
		systemPrompt: context.systemPrompt,
		tools: context.tools?.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			constrainedSampling: tool.constrainedSampling,
		})),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(record)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, canonicalizeJson(item)]),
		);
	}
	return value;
}

export function hashPiServerProviderMessages(messages: readonly Message[]): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeJson(messages)))
		.digest("hex");
}

export const PI_SERVER_EMPTY_TREE_HASH = createHash("sha256").update("pi-tree-v1").digest("hex");

export function hashPiServerTreeEntry(entry: SessionTreeEntry): string {
	return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function appendPiServerTreeHash(previousHash: string, entryHash: string): string {
	return createHash("sha256").update(`${previousHash}:${entryHash}`).digest("hex");
}

export function buildPiServerTreePrefixHashes(entries: SessionTreeEntry[]): string[] {
	const hashes = [PI_SERVER_EMPTY_TREE_HASH];
	for (const entry of entries) {
		hashes.push(appendPiServerTreeHash(hashes[hashes.length - 1], hashPiServerTreeEntry(entry)));
	}
	return hashes;
}

export function hashPiServerSessionEntries(entries: SessionTreeEntry[]): string {
	return buildPiServerTreePrefixHashes(entries)[entries.length];
}

/**
 * How a stream request uses the session's context store. "record" keeps the request's new messages
 * and its reply for later turns. "read" only rebuilds the context from stored messages, for requests
 * whose context later turns never extend: cache warm replays and one-off requests.
 */
export type PiServerContextStoreMode = "record" | "read";

/**
 * A stream context the server rebuilds from its per-session message store: `base` names a
 * prefix the server already holds, and each later item is a message or the hash of a stored one.
 */
export interface PiServerContextDelta {
	base?: string;
	messages: (Message | string)[];
	/** Defaults to "record", which older clients rely on. */
	store?: PiServerContextStoreMode;
}

export const PI_SERVER_EMPTY_CONTEXT_HASH = createHash("sha256").update("pi-context-v1").digest("hex");

/** Hash one projected message from its exact JSON, so client and server name the same bytes. */
export function hashPiServerContextJson(json: string): string {
	return createHash("sha256").update(json).digest("hex");
}

/** Hash of the context prefix that ends with `messageHash`. */
export function appendPiServerContextHash(prefixHash: string, messageHash: string): string {
	return createHash("sha256").update(`${prefixHash}:${messageHash}`).digest("hex");
}
