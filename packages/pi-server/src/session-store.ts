import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildSessionContext, convertToLlm, type SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Message, Tool } from "@earendil-works/pi-ai";

export interface SessionStaticContext {
	systemPrompt?: string;
	tools?: Tool[];
}

export interface SessionState {
	sessionId: string;
	staticContext: SessionStaticContext | undefined;
	staticContextHash: string;
	entries: SessionTreeEntry[];
	leafId: string | null;
	messages: Message[];
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface SessionSummary {
	sessionId: string;
	staticContextHash: string;
	treeHash: string;
	messageCount: number;
	entryCount: number;
	leafId: string | null;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface PersistedSessionState {
	sessionId: string;
	staticContext: SessionStaticContext | undefined;
	entries: SessionTreeEntry[];
	leafId: string | null;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

const sessions = new Map<string, SessionState>();

function hashStaticContext(ctx: SessionStaticContext | undefined): string {
	if (!ctx) return "";
	const parts: string[] = [];
	if (ctx.systemPrompt !== undefined) parts.push(`sp:${ctx.systemPrompt}`);
	if (ctx.tools) {
		parts.push(
			`t:${JSON.stringify(ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))}`,
		);
	}
	return parts.join("|");
}

export function getOrCreateSession(sessionId: string): SessionState {
	let session = sessions.get(sessionId);
	if (!session) {
		const now = Date.now();
		session = {
			sessionId,
			staticContext: undefined,
			staticContextHash: "",
			entries: [],
			leafId: null,
			messages: [],
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		sessions.set(sessionId, session);
	}
	return session;
}

export function getSession(sessionId: string): SessionState | undefined {
	return sessions.get(sessionId);
}

export function hashSessionEntries(entries: SessionTreeEntry[]): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function listSessions(): SessionSummary[] {
	return Array.from(sessions.values())
		.map((session) => ({
			sessionId: session.sessionId,
			staticContextHash: session.staticContextHash,
			treeHash: hashSessionEntries(session.entries),
			messageCount: session.messages.length,
			entryCount: session.entries.length,
			leafId: session.leafId,
			revision: session.revision,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
}

export function exportSessionState(session: SessionState): PersistedSessionState {
	return {
		sessionId: session.sessionId,
		staticContext: session.staticContext,
		entries: session.entries.map((entry) => ({ ...entry })),
		leafId: session.leafId,
		revision: session.revision,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
	};
}

export function restoreSessionState(persisted: PersistedSessionState): SessionState {
	assertValidLeaf(persisted.entries, persisted.leafId);
	const session: SessionState = {
		sessionId: persisted.sessionId,
		staticContext: persisted.staticContext,
		staticContextHash: hashStaticContext(persisted.staticContext),
		entries: persisted.entries.map((entry) => ({ ...entry })),
		leafId: persisted.leafId,
		messages: [],
		revision: persisted.revision,
		createdAt: persisted.createdAt,
		updatedAt: persisted.updatedAt,
	};
	refreshActiveMessages(session);
	sessions.set(session.sessionId, session);
	return session;
}

export function setStaticContext(sessionId: string, context: SessionStaticContext): SessionState {
	const session = getOrCreateSession(sessionId);
	const newHash = hashStaticContext(context);
	session.staticContext = context;
	session.staticContextHash = newHash;
	session.updatedAt = Date.now();
	return session;
}

function entryToMessageEntry(message: Message, parentId: string | null): SessionTreeEntry {
	return {
		type: "message",
		id: randomUUID(),
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

export function getSessionBranch(session: SessionState): SessionTreeEntry[] {
	const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
	const branch: SessionTreeEntry[] = [];
	let current = session.leafId ? byId.get(session.leafId) : undefined;
	const seen = new Set<string>();
	while (current) {
		if (seen.has(current.id)) {
			throw new Error(`session tree contains a parent cycle at entry ${current.id}`);
		}
		seen.add(current.id);
		branch.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch;
}

function deriveActiveMessages(session: SessionState): Message[] {
	const branch = getSessionBranch(session);
	return convertToLlm(buildSessionContext(branch).messages);
}

function refreshActiveMessages(session: SessionState): void {
	session.messages = deriveActiveMessages(session);
}

function assertValidLeaf(entries: SessionTreeEntry[], leafId: string | null): void {
	if (leafId === null) return;
	if (!entries.some((entry) => entry.id === leafId)) {
		throw new Error(`leafId ${leafId} does not exist in session tree`);
	}
}

export function replaceSessionTree(
	sessionId: string,
	entries: SessionTreeEntry[],
	leafId: string | null,
): SessionState {
	assertValidLeaf(entries, leafId);
	const session = getOrCreateSession(sessionId);
	session.entries = entries.map((entry) => ({ ...entry }));
	session.leafId = leafId;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return session;
}

export function appendSessionEntries(
	sessionId: string,
	entries: SessionTreeEntry[],
	leafId: string | null,
): SessionState {
	const session = getOrCreateSession(sessionId);
	const knownEntries = new Map(session.entries.map((entry) => [entry.id, entry]));
	const entriesToAppend: SessionTreeEntry[] = [];
	for (const entry of entries) {
		const knownEntry = knownEntries.get(entry.id);
		if (knownEntry) {
			if (!isDeepStrictEqual(knownEntry, entry)) {
				throw new Error(`entry ${entry.id} already exists`);
			}
			continue;
		}
		if (entry.parentId !== null && !knownEntries.has(entry.parentId)) {
			throw new Error(`parent entry ${entry.parentId} does not exist`);
		}
		const entryToAppend = { ...entry };
		entriesToAppend.push(entryToAppend);
		knownEntries.set(entryToAppend.id, entryToAppend);
	}
	if (leafId !== null && !knownEntries.has(leafId)) {
		throw new Error(`leafId ${leafId} does not exist in session tree`);
	}
	if (entriesToAppend.length === 0 && session.leafId === leafId) {
		return session;
	}
	session.entries.push(...entriesToAppend);
	assertValidLeaf(session.entries, leafId);
	session.leafId = leafId;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return session;
}

export function switchSessionLeaf(sessionId: string, leafId: string | null): SessionState {
	const session = getOrCreateSession(sessionId);
	assertValidLeaf(session.entries, leafId);
	session.leafId = leafId;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return session;
}

export function appendCompactionEntry(
	sessionId: string,
	compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown },
): { session: SessionState; entry: SessionTreeEntry } {
	const session = getOrCreateSession(sessionId);
	const entry: SessionTreeEntry = {
		type: "compaction",
		id: randomUUID(),
		parentId: session.leafId,
		timestamp: new Date().toISOString(),
		summary: compaction.summary,
		firstKeptEntryId: compaction.firstKeptEntryId,
		tokensBefore: compaction.tokensBefore,
		details: compaction.details,
	};
	session.entries.push(entry);
	session.leafId = entry.id;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return { session, entry };
}

export function getActiveMessages(sessionId: string): Message[] {
	const session = getSession(sessionId);
	return session ? [...session.messages] : [];
}

export function appendMessages(sessionId: string, delta: Message[]): SessionState {
	const session = getOrCreateSession(sessionId);
	const entries = delta.map((message) => {
		const entry = entryToMessageEntry(message, session.leafId);
		session.leafId = entry.id;
		return entry;
	});
	session.entries.push(...entries);
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return session;
}

export function appendAssistantResponse(sessionId: string, message: Message): SessionState {
	const session = getOrCreateSession(sessionId);
	session.messages.push(message);
	session.updatedAt = Date.now();
	return session;
}

export function replaceMessages(sessionId: string, messages: Message[]): SessionState {
	const session = getOrCreateSession(sessionId);
	let parentId: string | null = null;
	session.entries = messages.map((message) => {
		const entry = entryToMessageEntry(message, parentId);
		parentId = entry.id;
		return entry;
	});
	session.leafId = parentId;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return session;
}

export function dropLastAssistantError(sessionId: string): boolean {
	const session = getSession(sessionId);
	if (!session) return false;
	const leaf = session.leafId ? session.entries.find((entry) => entry.id === session.leafId) : undefined;
	if (leaf?.type !== "message" || leaf.message.role !== "assistant" || leaf.message.stopReason !== "error") {
		return false;
	}
	session.entries = session.entries.filter((entry) => entry.id !== leaf.id);
	session.leafId = leaf.parentId;
	session.revision++;
	session.updatedAt = Date.now();
	refreshActiveMessages(session);
	return true;
}

export function deleteSession(sessionId: string): boolean {
	return sessions.delete(sessionId);
}

export function clearAllSessions(): void {
	sessions.clear();
}
