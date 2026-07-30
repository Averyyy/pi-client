import { createHash } from "node:crypto";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";

export interface PiServerStaticContext {
	systemPrompt?: string;
	tools?: Tool[];
}

export interface PiServerSessionIdentity {
	staticContextHash: string;
	treeHash: string;
	entryCount: number;
	leafId: string | null;
	revision: number;
}

export interface PiServerStreamBaseIdentity {
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
}

export function matchesPiServerStreamBase(base: PiServerStreamBaseIdentity, session: PiServerSessionIdentity): boolean {
	return (
		base.baseStaticContextHash === session.staticContextHash &&
		base.baseTreeHash === session.treeHash &&
		base.baseEntryCount === session.entryCount &&
		base.baseLeafId === session.leafId &&
		base.baseRevision === session.revision
	);
}

export function canonicalJsonStringify(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		return `[${Array.from(value, (item) => canonicalJsonStringify(item) ?? "null").join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const properties: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const serialized = canonicalJsonStringify(record[key]);
			if (serialized !== undefined) {
				properties.push(`${JSON.stringify(key)}:${serialized}`);
			}
		}
		return `{${properties.join(",")}}`;
	}
	return JSON.stringify(value);
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
	const serialized = canonicalJsonStringify(canonical);
	if (serialized === undefined) {
		throw new Error("Failed to serialize pi-server static context");
	}
	return createHash("sha256").update(serialized).digest("hex");
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
