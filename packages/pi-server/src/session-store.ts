import type { Message, Tool } from "@earendil-works/pi-ai";

export interface SessionStaticContext {
	systemPrompt?: string;
	tools?: Tool[];
}

export interface SessionState {
	sessionId: string;
	staticContext: SessionStaticContext | undefined;
	staticContextHash: string;
	messages: Message[];
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
			messages: [],
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

export function appendMessages(sessionId: string, delta: Message[]): SessionState {
	const session = getOrCreateSession(sessionId);
	session.messages.push(...delta);
	return session;
}

export function appendAssistantResponse(sessionId: string, message: Message): SessionState {
	const session = getOrCreateSession(sessionId);
	session.messages.push(message);
	return session;
}

export function replaceMessages(sessionId: string, messages: Message[]): SessionState {
	const session = getOrCreateSession(sessionId);
	session.messages = [...messages];
	return session;
}

export function dropLastAssistantError(sessionId: string): boolean {
	const session = getSession(sessionId);
	if (!session) return false;
	const last = session.messages[session.messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "error") return false;
	session.messages.pop();
	return true;
}

export function deleteSession(sessionId: string): boolean {
	return sessions.delete(sessionId);
}

export function clearAllSessions(): void {
	sessions.clear();
}
