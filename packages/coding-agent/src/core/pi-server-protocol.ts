import { createHash } from "node:crypto";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";

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
		})),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
