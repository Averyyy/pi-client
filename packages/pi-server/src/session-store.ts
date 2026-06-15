import { randomUUID } from "node:crypto";
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
		session = {
			sessionId,
			staticContext: undefined,
			staticContextHash: "",
			entries: [],
			leafId: null,
			messages: [],
			revision: 0,
		};
		sessions.set(sessionId, session);
	}
	return session;
}

export function getSession(sessionId: string): SessionState | undefined {
	return sessions.get(sessionId);
}

export function setStaticContext(sessionId: string, context: SessionStaticContext): SessionState {
	const session = getOrCreateSession(sessionId);
	const newHash = hashStaticContext(context);
	session.staticContext = context;
	session.staticContextHash = newHash;
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

function deriveActiveMessages(session: SessionState): Message[] {
	const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
	const branch: SessionTreeEntry[] = [];
	let current = session.leafId ? byId.get(session.leafId) : undefined;
	while (current) {
		branch.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
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
	refreshActiveMessages(session);
	return session;
}

export function appendSessionEntries(
	sessionId: string,
	entries: SessionTreeEntry[],
	leafId: string | null,
): SessionState {
	const session = getOrCreateSession(sessionId);
	const knownIds = new Set(session.entries.map((entry) => entry.id));
	for (const entry of entries) {
		if (knownIds.has(entry.id)) {
			throw new Error(`entry ${entry.id} already exists`);
		}
		if (entry.parentId !== null && !knownIds.has(entry.parentId)) {
			throw new Error(`parent entry ${entry.parentId} does not exist`);
		}
		knownIds.add(entry.id);
	}
	session.entries.push(...entries.map((entry) => ({ ...entry })));
	assertValidLeaf(session.entries, leafId);
	session.leafId = leafId;
	session.revision++;
	refreshActiveMessages(session);
	return session;
}

export function switchSessionLeaf(sessionId: string, leafId: string | null): SessionState {
	const session = getOrCreateSession(sessionId);
	assertValidLeaf(session.entries, leafId);
	session.leafId = leafId;
	session.revision++;
	refreshActiveMessages(session);
	return session;
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
	refreshActiveMessages(session);
	return session;
}

export function appendAssistantResponse(sessionId: string, message: Message): SessionState {
	const session = getOrCreateSession(sessionId);
	session.messages.push(message);
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
	refreshActiveMessages(session);
	return true;
}

export function deleteSession(sessionId: string): boolean {
	return sessions.delete(sessionId);
}

export function clearAllSessions(): void {
	sessions.clear();
}
