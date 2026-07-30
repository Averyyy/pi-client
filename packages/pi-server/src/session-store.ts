import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	buildSessionContext,
	type CompactionEntry,
	type CompactResult,
	convertToLlm,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { Message, Tool } from "@earendil-works/pi-ai";
import {
	appendPiServerTreeHash,
	buildPiServerTreePrefixHashes,
	canonicalJsonStringify,
	hashPiServerSessionEntries,
	hashPiServerStaticContext,
	hashPiServerTreeEntry,
} from "./pi-server-protocol.ts";

export interface SessionStaticContext {
	systemPrompt?: string;
	tools?: Tool[];
}

export interface SessionState {
	sessionId: string;
	staticContext: SessionStaticContext | undefined;
	staticContextHash: string;
	entries: SessionTreeEntry[];
	/** Runtime-only entry index. Persist entries and rebuild this map when restoring a session. */
	entryById: Map<string, SessionTreeEntry>;
	/**
	 * Runtime-only logical payload size. This is the UTF-8 byte length of the canonical JSON static context
	 * (zero when absent) plus the UTF-8 byte length of JSON.stringify(entry) for every durable tree entry.
	 */
	logicalBytes: number;
	leafId: string | null;
	treeHash: string;
	prefixHashes: string[];
	messages: Message[];
	revision: number;
	createdAt: number;
	updatedAt: number;
	persistenceChange: SessionPersistenceChange | undefined;
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

export interface PiServerCompactionOperationMetadata {
	version: 1;
	operationId: string;
	requestHash: string;
	baseStaticContextHash: string;
	baseTreeHash: string;
	baseEntryCount: number;
	baseLeafId: string | null;
	baseRevision: number;
}

export type PiServerCompactionEntry = CompactionEntry & {
	piServerCompactOperation: PiServerCompactionOperationMetadata;
};

export interface ApplyPiServerCompactionEntryInput {
	entry: PiServerCompactionEntry;
	operation: PiServerCompactionOperationMetadata;
	updatedTreeHash: string;
	updatedRevision: number;
}

export type SessionPersistenceChange =
	| { kind: "snapshot" }
	| { kind: "wal"; entries: SessionTreeEntry[]; staticContextChanged: boolean };

const sessions = new Map<string, SessionState>();

export interface SessionCapacityLimits {
	maxEntriesPerSession: number;
	maxLogicalBytesPerSession: number;
	maxAggregateEntries: number;
	maxAggregateLogicalBytes: number;
	maxLoadedSessions: number;
}

export const DEFAULT_SESSION_CAPACITY_LIMITS: Readonly<SessionCapacityLimits> = Object.freeze({
	maxEntriesPerSession: 250_000,
	maxLogicalBytesPerSession: 256 * 1024 * 1024,
	maxAggregateEntries: 500_000,
	maxAggregateLogicalBytes: 512 * 1024 * 1024,
	maxLoadedSessions: 1024,
});

export const SESSION_CAPACITY_ERROR_CODE = "PI_SERVER_SESSION_CAPACITY_EXCEEDED";

export type SessionCapacityResource =
	| "session_entries"
	| "session_logical_bytes"
	| "aggregate_entries"
	| "aggregate_logical_bytes"
	| "loaded_sessions";

export class SessionCapacityError extends Error {
	readonly code = SESSION_CAPACITY_ERROR_CODE;
	readonly retryable = false as const;
	readonly resource: SessionCapacityResource;
	readonly sessionId: string;
	readonly current: number;
	readonly requested: number;
	readonly limit: number;

	constructor(input: {
		resource: SessionCapacityResource;
		sessionId: string;
		current: number;
		requested: number;
		limit: number;
	}) {
		super(
			`Session capacity exceeded for ${input.resource}: current=${input.current}, requested=${input.requested}, limit=${input.limit}`,
		);
		this.name = "SessionCapacityError";
		this.resource = input.resource;
		this.sessionId = input.sessionId;
		this.current = input.current;
		this.requested = input.requested;
		this.limit = input.limit;
	}
}

export type SessionCapacityContentMutation =
	| {
			kind: "append_entries";
			entries: SessionTreeEntry[];
			leafId: string | null;
	  }
	| {
			kind: "replace_entries";
			entries: SessionTreeEntry[];
			leafId: string | null;
	  }
	| {
			kind: "append_messages";
			messages: Message[];
	  }
	| {
			kind: "replace_messages";
			messages: Message[];
	  };

export interface SessionCapacityMutation {
	staticContext?: SessionStaticContext;
	content?: SessionCapacityContentMutation;
}

export interface SessionCapacityProjection {
	entryCount: number;
	logicalBytes: number;
}

export interface SessionCapacityUsage {
	loadedSessions: number;
	entryCount: number;
	logicalBytes: number;
}

let capacityLimits: SessionCapacityLimits = { ...DEFAULT_SESSION_CAPACITY_LIMITS };
let aggregateEntryCount = 0;
let aggregateLogicalBytes = 0;

function cloneSerializable<T>(value: T): T {
	return structuredClone(value);
}

function measureStaticContextLogicalBytes(context: SessionStaticContext | undefined): number {
	if (context === undefined) return 0;
	const serialized = canonicalJsonStringify(context);
	if (serialized === undefined) {
		throw new Error("Failed to serialize pi-server static context for capacity accounting");
	}
	return Buffer.byteLength(serialized, "utf8");
}

function measureEntryLogicalBytes(entry: SessionTreeEntry): number {
	const serialized = JSON.stringify(entry);
	if (serialized === undefined) {
		throw new Error(`Failed to serialize session entry ${entry.id} for capacity accounting`);
	}
	return Buffer.byteLength(serialized, "utf8");
}

function measureEntriesLogicalBytes(entries: readonly SessionTreeEntry[]): number {
	let logicalBytes = 0;
	for (const entry of entries) {
		logicalBytes += measureEntryLogicalBytes(entry);
	}
	return logicalBytes;
}

/**
 * Returns the stable logical payload size used for admission. Container punctuation and runtime indexes/messages
 * are intentionally excluded so appends can update the exact total incrementally without rewriting history.
 */
export function calculateSessionLogicalBytes(
	staticContext: SessionStaticContext | undefined,
	entries: readonly SessionTreeEntry[],
): number {
	return measureStaticContextLogicalBytes(staticContext) + measureEntriesLogicalBytes(entries);
}

function assertPositiveSafeInteger(name: keyof SessionCapacityLimits, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function capacityError(
	resource: SessionCapacityResource,
	sessionId: string,
	current: number,
	requested: number,
	limit: number,
): SessionCapacityError {
	return new SessionCapacityError({ resource, sessionId, current, requested, limit });
}

function assertCapacityTransition(
	sessionId: string,
	currentEntryCount: number,
	currentLogicalBytes: number,
	nextEntryCount: number,
	nextLogicalBytes: number,
	createsSession: boolean,
	limits = capacityLimits,
): void {
	if (createsSession && sessions.size + 1 > limits.maxLoadedSessions) {
		throw capacityError("loaded_sessions", sessionId, sessions.size, sessions.size + 1, limits.maxLoadedSessions);
	}
	if (nextEntryCount > limits.maxEntriesPerSession) {
		throw capacityError("session_entries", sessionId, currentEntryCount, nextEntryCount, limits.maxEntriesPerSession);
	}
	if (nextLogicalBytes > limits.maxLogicalBytesPerSession) {
		throw capacityError(
			"session_logical_bytes",
			sessionId,
			currentLogicalBytes,
			nextLogicalBytes,
			limits.maxLogicalBytesPerSession,
		);
	}
	const requestedAggregateEntries = aggregateEntryCount - currentEntryCount + nextEntryCount;
	if (requestedAggregateEntries > limits.maxAggregateEntries) {
		throw capacityError(
			"aggregate_entries",
			sessionId,
			aggregateEntryCount,
			requestedAggregateEntries,
			limits.maxAggregateEntries,
		);
	}
	const requestedAggregateLogicalBytes = aggregateLogicalBytes - currentLogicalBytes + nextLogicalBytes;
	if (requestedAggregateLogicalBytes > limits.maxAggregateLogicalBytes) {
		throw capacityError(
			"aggregate_logical_bytes",
			sessionId,
			aggregateLogicalBytes,
			requestedAggregateLogicalBytes,
			limits.maxAggregateLogicalBytes,
		);
	}
}

function assertEntryCountTransition(
	sessionId: string,
	currentEntryCount: number,
	nextEntryCount: number,
	createsSession: boolean,
	limits = capacityLimits,
): void {
	if (createsSession && sessions.size + 1 > limits.maxLoadedSessions) {
		throw capacityError("loaded_sessions", sessionId, sessions.size, sessions.size + 1, limits.maxLoadedSessions);
	}
	if (nextEntryCount > limits.maxEntriesPerSession) {
		throw capacityError("session_entries", sessionId, currentEntryCount, nextEntryCount, limits.maxEntriesPerSession);
	}
	const requestedAggregateEntries = aggregateEntryCount - currentEntryCount + nextEntryCount;
	if (requestedAggregateEntries > limits.maxAggregateEntries) {
		throw capacityError(
			"aggregate_entries",
			sessionId,
			aggregateEntryCount,
			requestedAggregateEntries,
			limits.maxAggregateEntries,
		);
	}
}

function commitCapacityTransition(
	session: SessionState,
	previousEntryCount: number,
	previousLogicalBytes: number,
): void {
	aggregateEntryCount += session.entries.length - previousEntryCount;
	aggregateLogicalBytes += session.logicalBytes - previousLogicalBytes;
}

export function configureSessionCapacityLimits(overrides: Partial<SessionCapacityLimits>): SessionCapacityLimits {
	const nextLimits: SessionCapacityLimits = { ...capacityLimits, ...overrides };
	for (const name of [
		"maxEntriesPerSession",
		"maxLogicalBytesPerSession",
		"maxAggregateEntries",
		"maxAggregateLogicalBytes",
		"maxLoadedSessions",
	] as const) {
		assertPositiveSafeInteger(name, nextLimits[name]);
	}
	if (sessions.size > nextLimits.maxLoadedSessions) {
		throw capacityError(
			"loaded_sessions",
			"<configuration>",
			sessions.size,
			sessions.size,
			nextLimits.maxLoadedSessions,
		);
	}
	for (const session of sessions.values()) {
		assertCapacityTransition(
			session.sessionId,
			session.entries.length,
			session.logicalBytes,
			session.entries.length,
			session.logicalBytes,
			false,
			nextLimits,
		);
	}
	capacityLimits = nextLimits;
	return { ...capacityLimits };
}

export function resetSessionCapacityLimits(): void {
	configureSessionCapacityLimits({ ...DEFAULT_SESSION_CAPACITY_LIMITS });
}

export function getSessionCapacityLimits(): SessionCapacityLimits {
	return { ...capacityLimits };
}

export function getSessionCapacityUsage(): SessionCapacityUsage {
	return {
		loadedSessions: sessions.size,
		entryCount: aggregateEntryCount,
		logicalBytes: aggregateLogicalBytes,
	};
}

function hashStaticContext(ctx: SessionStaticContext | undefined): string {
	return hashPiServerStaticContext(ctx);
}

function buildEntryIndex(entries: SessionTreeEntry[]): Map<string, SessionTreeEntry> {
	const entryById = new Map<string, SessionTreeEntry>();
	for (const entry of entries) {
		if (entryById.has(entry.id)) {
			throw new Error(`session tree contains duplicate entry ${entry.id}`);
		}
		entryById.set(entry.id, entry);
	}
	for (const entry of entries) {
		if (entry.parentId !== null && !entryById.has(entry.parentId)) {
			throw new Error(`parent entry ${entry.parentId} does not exist`);
		}
	}

	const visitState = new Map<string, "visiting" | "visited">();
	for (const entry of entries) {
		if (visitState.get(entry.id) === "visited") continue;
		const path: SessionTreeEntry[] = [];
		let current: SessionTreeEntry | undefined = entry;
		while (current) {
			const state = visitState.get(current.id);
			if (state === "visiting") {
				throw new Error(`session tree contains a parent cycle at entry ${current.id}`);
			}
			if (state === "visited") break;
			visitState.set(current.id, "visiting");
			path.push(current);
			current = current.parentId === null ? undefined : entryById.get(current.parentId);
		}
		for (const pathEntry of path) {
			visitState.set(pathEntry.id, "visited");
		}
	}
	return entryById;
}

export function getOrCreateSession(sessionId: string): SessionState {
	let session = sessions.get(sessionId);
	if (!session) {
		assertCapacityTransition(sessionId, 0, 0, 0, 0, true);
		const now = Date.now();
		session = {
			sessionId,
			staticContext: undefined,
			staticContextHash: "",
			entries: [],
			entryById: new Map(),
			logicalBytes: 0,
			leafId: null,
			treeHash: hashPiServerSessionEntries([]),
			prefixHashes: buildPiServerTreePrefixHashes([]),
			messages: [],
			revision: 0,
			createdAt: now,
			updatedAt: now,
			persistenceChange: { kind: "snapshot" },
		};
		sessions.set(sessionId, session);
	}
	return session;
}

export function getSession(sessionId: string): SessionState | undefined {
	return sessions.get(sessionId);
}

export function hashSessionEntries(entries: SessionTreeEntry[]): string {
	return hashPiServerSessionEntries(entries);
}

export function listSessions(): SessionSummary[] {
	return Array.from(sessions.values())
		.map((session) => ({
			sessionId: session.sessionId,
			staticContextHash: session.staticContextHash,
			treeHash: session.treeHash,
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
		staticContext: cloneSerializable(session.staticContext),
		entries: cloneSerializable(session.entries),
		leafId: session.leafId,
		revision: session.revision,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
	};
}

/**
 * Fully validate a persisted state without changing the global store. Startup
 * uses this for every staged session before any recovery I/O or in-memory commit.
 */
export function validatePersistedSessionState(persisted: PersistedSessionState): void {
	const previousSession = sessions.get(persisted.sessionId);
	assertEntryCountTransition(
		persisted.sessionId,
		previousSession?.entries.length ?? 0,
		persisted.entries.length,
		previousSession === undefined,
	);
	const entryById = buildEntryIndex(persisted.entries);
	assertValidLeaf(entryById, persisted.leafId);
	const logicalBytes = calculateSessionLogicalBytes(persisted.staticContext, persisted.entries);
	assertCapacityTransition(
		persisted.sessionId,
		previousSession?.entries.length ?? 0,
		previousSession?.logicalBytes ?? 0,
		persisted.entries.length,
		logicalBytes,
		previousSession === undefined,
	);
	hashStaticContext(persisted.staticContext);
	hashSessionEntries(persisted.entries);
	buildPiServerTreePrefixHashes(persisted.entries);
	deriveActiveMessagesFromIndex(entryById, persisted.leafId);
}

export function restoreSessionState(persisted: PersistedSessionState): SessionState {
	const previousSession = sessions.get(persisted.sessionId);
	assertEntryCountTransition(
		persisted.sessionId,
		previousSession?.entries.length ?? 0,
		persisted.entries.length,
		previousSession === undefined,
	);
	const entries = cloneSerializable(persisted.entries);
	const staticContext = cloneSerializable(persisted.staticContext);
	const entryById = buildEntryIndex(entries);
	assertValidLeaf(entryById, persisted.leafId);
	const logicalBytes = calculateSessionLogicalBytes(staticContext, entries);
	assertCapacityTransition(
		persisted.sessionId,
		previousSession?.entries.length ?? 0,
		previousSession?.logicalBytes ?? 0,
		entries.length,
		logicalBytes,
		previousSession === undefined,
	);
	const session: SessionState = {
		sessionId: persisted.sessionId,
		staticContext,
		staticContextHash: hashStaticContext(staticContext),
		entries,
		entryById,
		logicalBytes,
		leafId: persisted.leafId,
		treeHash: hashSessionEntries(entries),
		prefixHashes: buildPiServerTreePrefixHashes(entries),
		messages: [],
		revision: persisted.revision,
		createdAt: persisted.createdAt,
		updatedAt: persisted.updatedAt,
		persistenceChange: undefined,
	};
	session.messages = deriveActiveMessages(session);
	commitCapacityTransition(session, previousSession?.entries.length ?? 0, previousSession?.logicalBytes ?? 0);
	sessions.set(session.sessionId, session);
	return session;
}

export function setStaticContext(sessionId: string, context: SessionStaticContext): SessionState {
	const nextContext = cloneSerializable(context);
	const newHash = hashStaticContext(nextContext);
	const existingSession = sessions.get(sessionId);
	if (existingSession && newHash === existingSession.staticContextHash) {
		return existingSession;
	}
	const nextLogicalBytes =
		(existingSession?.logicalBytes ?? 0) -
		measureStaticContextLogicalBytes(existingSession?.staticContext) +
		measureStaticContextLogicalBytes(nextContext);
	assertCapacityTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		existingSession?.logicalBytes ?? 0,
		existingSession?.entries.length ?? 0,
		nextLogicalBytes,
		existingSession === undefined,
	);
	const persistenceChange = deriveWalPersistenceChange(
		existingSession ? existingSession.persistenceChange : { kind: "snapshot" },
		[],
		true,
	);
	const updatedAt = Date.now();
	const session = getOrCreateSession(sessionId);
	const previousLogicalBytes = session.logicalBytes;
	session.staticContext = nextContext;
	session.staticContextHash = newHash;
	session.logicalBytes = nextLogicalBytes;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = persistenceChange;
	commitCapacityTransition(session, session.entries.length, previousLogicalBytes);
	return session;
}

function entryToMessageEntry(message: Message, parentId: string | null): SessionTreeEntry {
	return {
		type: "message",
		id: randomUUID(),
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message: cloneSerializable(message),
	};
}

function buildMessageEntries(messages: readonly Message[], initialParentId: string | null): SessionTreeEntry[] {
	let parentId = initialParentId;
	return messages.map((message) => {
		const entry = entryToMessageEntry(message, parentId);
		parentId = entry.id;
		return entry;
	});
}

function prepareEntriesToAppend(
	sessionId: string,
	session: SessionState | undefined,
	entries: readonly SessionTreeEntry[],
	leafId: string | null,
): SessionTreeEntry[] {
	const pendingEntriesById = new Map<string, SessionTreeEntry>();
	const entriesToAppend: SessionTreeEntry[] = [];
	for (const entry of entries) {
		const knownEntry = pendingEntriesById.get(entry.id) ?? session?.entryById.get(entry.id);
		if (knownEntry) {
			if (!isDeepStrictEqual(knownEntry, entry)) {
				throw new Error(`entry ${entry.id} already exists`);
			}
			continue;
		}
		if (
			entry.parentId !== null &&
			!pendingEntriesById.has(entry.parentId) &&
			session?.entryById.has(entry.parentId) !== true
		) {
			throw new Error(`parent entry ${entry.parentId} does not exist`);
		}
		assertEntryCountTransition(
			sessionId,
			session?.entries.length ?? 0,
			(session?.entries.length ?? 0) + entriesToAppend.length + 1,
			session === undefined,
		);
		const entryToAppend = cloneSerializable(entry);
		entriesToAppend.push(entryToAppend);
		pendingEntriesById.set(entryToAppend.id, entryToAppend);
	}
	if (leafId !== null && !pendingEntriesById.has(leafId) && session?.entryById.has(leafId) !== true) {
		throw new Error(`leafId ${leafId} does not exist in session tree`);
	}
	return entriesToAppend;
}

/**
 * Performs the combined, read-only capacity/shape preflight used by server handlers before applying
 * static-context and history changes synchronously. A successful result reserves nothing; callers must not
 * yield between this check and the store mutations.
 */
export function preflightSessionCapacityMutation(
	sessionId: string,
	mutation: SessionCapacityMutation,
): SessionCapacityProjection {
	const session = sessions.get(sessionId);
	const nextStaticContext = Object.hasOwn(mutation, "staticContext")
		? cloneSerializable(mutation.staticContext)
		: session?.staticContext;
	let nextEntryCount = session?.entries.length ?? 0;
	let nextEntryLogicalBytes = (session?.logicalBytes ?? 0) - measureStaticContextLogicalBytes(session?.staticContext);

	if (mutation.content) {
		switch (mutation.content.kind) {
			case "append_entries": {
				const entriesToAppend = prepareEntriesToAppend(
					sessionId,
					session,
					mutation.content.entries,
					mutation.content.leafId,
				);
				nextEntryCount += entriesToAppend.length;
				nextEntryLogicalBytes += measureEntriesLogicalBytes(entriesToAppend);
				break;
			}
			case "replace_entries": {
				assertEntryCountTransition(
					sessionId,
					session?.entries.length ?? 0,
					mutation.content.entries.length,
					session === undefined,
				);
				const nextEntries = cloneSerializable(mutation.content.entries);
				const nextEntryById = buildEntryIndex(nextEntries);
				assertValidLeaf(nextEntryById, mutation.content.leafId);
				nextEntryCount = nextEntries.length;
				nextEntryLogicalBytes = measureEntriesLogicalBytes(nextEntries);
				break;
			}
			case "append_messages": {
				assertEntryCountTransition(
					sessionId,
					session?.entries.length ?? 0,
					(session?.entries.length ?? 0) + mutation.content.messages.length,
					session === undefined,
				);
				const entries = buildMessageEntries(mutation.content.messages, session?.leafId ?? null);
				nextEntryCount += entries.length;
				nextEntryLogicalBytes += measureEntriesLogicalBytes(entries);
				break;
			}
			case "replace_messages": {
				assertEntryCountTransition(
					sessionId,
					session?.entries.length ?? 0,
					mutation.content.messages.length,
					session === undefined,
				);
				const entries = buildMessageEntries(mutation.content.messages, null);
				nextEntryCount = entries.length;
				nextEntryLogicalBytes = measureEntriesLogicalBytes(entries);
				break;
			}
		}
	}

	const nextLogicalBytes = measureStaticContextLogicalBytes(nextStaticContext) + nextEntryLogicalBytes;
	assertCapacityTransition(
		sessionId,
		session?.entries.length ?? 0,
		session?.logicalBytes ?? 0,
		nextEntryCount,
		nextLogicalBytes,
		session === undefined,
	);
	return { entryCount: nextEntryCount, logicalBytes: nextLogicalBytes };
}

/**
 * Atomically applies a request's static context and content mutation. All
 * cloning, shape validation, projection, hashing, and context conversion is
 * completed against the final state before the live session is changed.
 */
export function applySessionMutation(sessionId: string, mutation: SessionCapacityMutation): SessionState {
	const existingSession = sessions.get(sessionId);
	const hasStaticContext = Object.hasOwn(mutation, "staticContext");
	if (!hasStaticContext) {
		switch (mutation.content?.kind) {
			case "append_entries":
				return appendSessionEntries(sessionId, mutation.content.entries, mutation.content.leafId);
			case "replace_entries":
				return replaceSessionTree(sessionId, mutation.content.entries, mutation.content.leafId);
			case "append_messages":
				return appendMessages(sessionId, mutation.content.messages);
			case "replace_messages":
				return replaceMessages(sessionId, mutation.content.messages);
			default:
				return existingSession ?? getOrCreateSession(sessionId);
		}
	}

	const nextStaticContext = cloneSerializable(mutation.staticContext);
	const nextStaticContextHash = hashStaticContext(nextStaticContext);
	if (existingSession?.staticContextHash === nextStaticContextHash) {
		return applySessionMutation(sessionId, { content: mutation.content });
	}

	let nextEntries = existingSession?.entries ?? [];
	let nextLeafId = existingSession?.leafId ?? null;
	let appendedEntries: SessionTreeEntry[] = [];
	let contentRequiresSnapshot = false;
	switch (mutation.content?.kind) {
		case "append_entries": {
			appendedEntries = prepareEntriesToAppend(
				sessionId,
				existingSession,
				mutation.content.entries,
				mutation.content.leafId,
			);
			nextEntries = nextEntries.concat(appendedEntries);
			nextLeafId = mutation.content.leafId;
			break;
		}
		case "replace_entries": {
			const replacement = cloneSerializable(mutation.content.entries);
			const replacementIndex = buildEntryIndex(replacement);
			assertValidLeaf(replacementIndex, mutation.content.leafId);
			if (
				existingSession?.leafId !== mutation.content.leafId ||
				!isDeepStrictEqual(existingSession.entries, replacement)
			) {
				nextEntries = replacement;
				nextLeafId = mutation.content.leafId;
				contentRequiresSnapshot = true;
			}
			break;
		}
		case "append_messages": {
			assertEntryCountTransition(
				sessionId,
				existingSession?.entries.length ?? 0,
				(existingSession?.entries.length ?? 0) + mutation.content.messages.length,
				existingSession === undefined,
			);
			appendedEntries = buildMessageEntries(mutation.content.messages, nextLeafId);
			nextEntries = nextEntries.concat(appendedEntries);
			nextLeafId = appendedEntries.at(-1)?.id ?? nextLeafId;
			break;
		}
		case "replace_messages": {
			const contentUnchanged =
				existingSession !== undefined &&
				existingSession.entries.length === mutation.content.messages.length &&
				existingSession.entries.every((entry) => entry.type === "message") &&
				isDeepStrictEqual(existingSession.messages, mutation.content.messages);
			if (!contentUnchanged) {
				assertEntryCountTransition(
					sessionId,
					existingSession?.entries.length ?? 0,
					mutation.content.messages.length,
					existingSession === undefined,
				);
				nextEntries = buildMessageEntries(mutation.content.messages, null);
				nextLeafId = nextEntries.at(-1)?.id ?? null;
				contentRequiresSnapshot = true;
			}
			break;
		}
	}

	const nextEntryById =
		nextEntries === existingSession?.entries ? existingSession.entryById : buildEntryIndex(nextEntries);
	assertValidLeaf(nextEntryById, nextLeafId);
	const nextLogicalBytes = calculateSessionLogicalBytes(nextStaticContext, nextEntries);
	assertCapacityTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		existingSession?.logicalBytes ?? 0,
		nextEntries.length,
		nextLogicalBytes,
		existingSession === undefined,
	);
	const treeState =
		nextEntries === existingSession?.entries
			? { treeHash: existingSession.treeHash, prefixHashes: existingSession.prefixHashes }
			: deriveTreeHashes(nextEntries);
	const messages =
		nextEntries === existingSession?.entries && nextLeafId === existingSession.leafId
			? existingSession.messages
			: deriveActiveMessagesFromIndex(nextEntryById, nextLeafId);
	const persistenceChange =
		existingSession === undefined || contentRequiresSnapshot
			? ({ kind: "snapshot" } as const)
			: deriveWalPersistenceChange(existingSession.persistenceChange, appendedEntries, true);
	const updatedAt = Date.now();
	const session = getOrCreateSession(sessionId);
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	session.staticContext = nextStaticContext;
	session.staticContextHash = nextStaticContextHash;
	session.entries = nextEntries;
	session.entryById = nextEntryById;
	session.logicalBytes = nextLogicalBytes;
	session.leafId = nextLeafId;
	session.treeHash = treeState.treeHash;
	session.prefixHashes = treeState.prefixHashes;
	session.messages = messages;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = persistenceChange;
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return session;
}

function getSessionBranchFromIndex(
	entryById: ReadonlyMap<string, SessionTreeEntry>,
	leafId: string | null,
): SessionTreeEntry[] {
	const branch: SessionTreeEntry[] = [];
	let current = leafId ? entryById.get(leafId) : undefined;
	const seen = new Set<string>();
	while (current) {
		if (seen.has(current.id)) {
			throw new Error(`session tree contains a parent cycle at entry ${current.id}`);
		}
		seen.add(current.id);
		branch.push(current);
		if (current.parentId === null) break;
		const parent = entryById.get(current.parentId);
		if (!parent) {
			throw new Error(`parent entry ${current.parentId} does not exist`);
		}
		current = parent;
	}
	branch.reverse();
	return branch;
}

export function getSessionBranch(session: SessionState): SessionTreeEntry[] {
	return getSessionBranchFromIndex(session.entryById, session.leafId);
}

function deriveActiveMessagesFromIndex(
	entryById: ReadonlyMap<string, SessionTreeEntry>,
	leafId: string | null,
): Message[] {
	const branch = getSessionBranchFromIndex(entryById, leafId);
	return convertToLlm(buildSessionContext(branch).messages);
}

function deriveActiveMessages(session: SessionState): Message[] {
	return deriveActiveMessagesFromIndex(session.entryById, session.leafId);
}

function deriveAppendedMessages(entries: SessionTreeEntry[]): Message[] {
	return entries.length === 0 ? [] : convertToLlm(buildSessionContext(entries).messages);
}

function deriveTreeHashes(entries: SessionTreeEntry[]): { treeHash: string; prefixHashes: string[] } {
	const prefixHashes = buildPiServerTreePrefixHashes(entries);
	return { treeHash: prefixHashes[prefixHashes.length - 1], prefixHashes };
}

function deriveAppendedTreeHashes(treeHash: string, entries: SessionTreeEntry[]): string[] {
	const appendedHashes: string[] = [];
	for (const entry of entries) {
		treeHash = appendPiServerTreeHash(treeHash, hashPiServerTreeEntry(entry));
		appendedHashes.push(treeHash);
	}
	return appendedHashes;
}

function assertValidLeaf(entryById: Map<string, SessionTreeEntry>, leafId: string | null): void {
	if (leafId === null) return;
	if (!entryById.has(leafId)) {
		throw new Error(`leafId ${leafId} does not exist in session tree`);
	}
}

export function replaceSessionTree(
	sessionId: string,
	entries: SessionTreeEntry[],
	leafId: string | null,
): SessionState {
	const existingSession = sessions.get(sessionId);
	assertEntryCountTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		entries.length,
		existingSession === undefined,
	);
	const nextEntries = cloneSerializable(entries);
	const nextEntryById = buildEntryIndex(nextEntries);
	assertValidLeaf(nextEntryById, leafId);
	if (existingSession?.leafId === leafId && isDeepStrictEqual(existingSession.entries, nextEntries)) {
		return existingSession;
	}
	if (!existingSession && nextEntries.length === 0 && leafId === null) {
		return getOrCreateSession(sessionId);
	}
	const nextLogicalBytes =
		measureStaticContextLogicalBytes(existingSession?.staticContext) + measureEntriesLogicalBytes(nextEntries);
	assertCapacityTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		existingSession?.logicalBytes ?? 0,
		nextEntries.length,
		nextLogicalBytes,
		existingSession === undefined,
	);
	const { treeHash, prefixHashes } = deriveTreeHashes(nextEntries);
	const messages = deriveActiveMessagesFromIndex(nextEntryById, leafId);
	const updatedAt = Date.now();
	const session = getOrCreateSession(sessionId);
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	session.entries = nextEntries;
	session.entryById = nextEntryById;
	session.logicalBytes = nextLogicalBytes;
	session.leafId = leafId;
	session.treeHash = treeHash;
	session.prefixHashes = prefixHashes;
	session.messages = messages;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = { kind: "snapshot" };
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return session;
}

export function appendSessionEntries(
	sessionId: string,
	entries: SessionTreeEntry[],
	leafId: string | null,
): SessionState {
	const existingSession = sessions.get(sessionId);
	const entriesToAppend = prepareEntriesToAppend(sessionId, existingSession, entries, leafId);
	if (entriesToAppend.length === 0) {
		if (existingSession?.leafId === leafId) return existingSession;
		if (!existingSession && leafId === null) return getOrCreateSession(sessionId);
	}
	const nextLogicalBytes = (existingSession?.logicalBytes ?? 0) + measureEntriesLogicalBytes(entriesToAppend);
	const nextEntryCount = (existingSession?.entries.length ?? 0) + entriesToAppend.length;
	assertCapacityTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		existingSession?.logicalBytes ?? 0,
		nextEntryCount,
		nextLogicalBytes,
		existingSession === undefined,
	);
	const previousLeafId = existingSession?.leafId ?? null;
	const extendsActiveLeaf =
		entriesToAppend.length > 0 &&
		entriesToAppend[0].parentId === previousLeafId &&
		entriesToAppend.every((entry, index) => index === 0 || entry.parentId === entriesToAppend[index - 1].id) &&
		leafId === entriesToAppend[entriesToAppend.length - 1].id &&
		entriesToAppend.every((entry) => entry.type !== "compaction");
	const appendedHashes = deriveAppendedTreeHashes(
		existingSession?.treeHash ?? hashPiServerSessionEntries([]),
		entriesToAppend,
	);
	const appendedMessages = extendsActiveLeaf ? deriveAppendedMessages(entriesToAppend) : [];
	let replacementMessages: Message[] | undefined;
	if (!extendsActiveLeaf) {
		const nextEntryById = new Map(existingSession?.entryById);
		for (const entry of entriesToAppend) nextEntryById.set(entry.id, entry);
		replacementMessages = deriveActiveMessagesFromIndex(nextEntryById, leafId);
	}
	const persistenceChange = deriveWalPersistenceChange(
		existingSession ? existingSession.persistenceChange : { kind: "snapshot" },
		entriesToAppend,
	);
	const updatedAt = Date.now();
	const session = getOrCreateSession(sessionId);
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	for (const entry of entriesToAppend) {
		session.entries.push(entry);
		session.entryById.set(entry.id, entry);
	}
	session.logicalBytes = nextLogicalBytes;
	session.leafId = leafId;
	for (const hash of appendedHashes) session.prefixHashes.push(hash);
	if (appendedHashes.length > 0) session.treeHash = appendedHashes[appendedHashes.length - 1];
	if (extendsActiveLeaf) {
		for (const message of appendedMessages) session.messages.push(message);
	} else {
		session.messages = replacementMessages!;
	}
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = persistenceChange;
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return session;
}

export function switchSessionLeaf(sessionId: string, leafId: string | null): SessionState {
	const existingSession = sessions.get(sessionId);
	assertValidLeaf(existingSession?.entryById ?? new Map(), leafId);
	if (existingSession?.leafId === leafId) {
		return existingSession;
	}
	if (!existingSession && leafId === null) {
		return getOrCreateSession(sessionId);
	}
	if (!existingSession) {
		assertCapacityTransition(sessionId, 0, 0, 0, 0, true);
	}
	const messages = deriveActiveMessagesFromIndex(existingSession?.entryById ?? new Map(), leafId);
	const persistenceChange = deriveWalPersistenceChange(
		existingSession ? existingSession.persistenceChange : { kind: "snapshot" },
		[],
	);
	const updatedAt = Date.now();
	const session = getOrCreateSession(sessionId);
	session.leafId = leafId;
	session.messages = messages;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = persistenceChange;
	return session;
}

export function appendCompactionEntry(
	sessionId: string,
	compaction: CompactResult & { firstKeptEntryId: string; fromHook?: boolean },
): { session: SessionState; entry: CompactionEntry } {
	const session = sessions.get(sessionId);
	if (!session || !getSessionBranch(session).some((entry) => entry.id === compaction.firstKeptEntryId)) {
		throw new Error(`firstKeptEntryId ${compaction.firstKeptEntryId} does not exist on the active session branch`);
	}
	const entry: CompactionEntry = {
		type: "compaction",
		id: randomUUID(),
		parentId: session.leafId,
		timestamp: new Date().toISOString(),
		summary: compaction.summary,
		firstKeptEntryId: compaction.firstKeptEntryId,
		tokensBefore: compaction.tokensBefore,
		...(compaction.retainedTail !== undefined ? { retainedTail: compaction.retainedTail } : {}),
		...(compaction.details !== undefined ? { details: compaction.details } : {}),
		...(compaction.usage !== undefined ? { usage: compaction.usage } : {}),
		...(compaction.fromHook !== undefined ? { fromHook: compaction.fromHook } : {}),
	};
	const savedEntry = cloneSerializable(entry);
	const nextLogicalBytes = session.logicalBytes + measureEntryLogicalBytes(savedEntry);
	assertCapacityTransition(
		sessionId,
		session.entries.length,
		session.logicalBytes,
		session.entries.length + 1,
		nextLogicalBytes,
		false,
	);
	const appendedHashes = deriveAppendedTreeHashes(session.treeHash, [savedEntry]);
	const nextEntryById = new Map(session.entryById);
	nextEntryById.set(savedEntry.id, savedEntry);
	const messages = deriveActiveMessagesFromIndex(nextEntryById, savedEntry.id);
	const persistenceChange = deriveWalPersistenceChange(session.persistenceChange, [savedEntry]);
	const updatedAt = Date.now();
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	session.entries.push(savedEntry);
	session.entryById.set(savedEntry.id, savedEntry);
	session.logicalBytes = nextLogicalBytes;
	session.leafId = savedEntry.id;
	session.treeHash = appendedHashes[0];
	session.prefixHashes.push(appendedHashes[0]);
	session.messages = messages;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = persistenceChange;
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return { session, entry: savedEntry };
}

function getPiServerCompactionOperation(entry: SessionTreeEntry): PiServerCompactionOperationMetadata | undefined {
	if (entry.type !== "compaction" || !("piServerCompactOperation" in entry)) return undefined;
	const operation = entry.piServerCompactOperation;
	return typeof operation === "object" && operation !== null
		? (operation as PiServerCompactionOperationMetadata)
		: undefined;
}

export function applyPiServerCompactionEntry(
	sessionId: string,
	input: ApplyPiServerCompactionEntryInput,
): SessionState {
	if (!isDeepStrictEqual(input.entry.piServerCompactOperation, input.operation)) {
		throw new Error(`Compaction operation metadata differs from entry ${input.entry.id}`);
	}
	const session = sessions.get(sessionId);
	if (!session) {
		throw new Error(
			`Session base identity changed before compaction operation ${input.operation.operationId} could be applied`,
		);
	}
	const existingOperationEntry = session.entries.find(
		(entry) => getPiServerCompactionOperation(entry)?.operationId === input.operation.operationId,
	);
	if (existingOperationEntry) {
		if (!isDeepStrictEqual(existingOperationEntry, input.entry)) {
			throw new Error(
				`Compaction operation ${input.operation.operationId} is already bound to a different session entry`,
			);
		}
		const existingIndex = session.entries.indexOf(existingOperationEntry);
		if (
			session.prefixHashes[existingIndex + 1] !== input.updatedTreeHash ||
			session.revision < input.updatedRevision
		) {
			throw new Error(
				`Compaction operation ${input.operation.operationId} has inconsistent persisted session identity`,
			);
		}
		return session;
	}
	const existingEntry = session.entryById.get(input.entry.id);
	if (existingEntry) {
		throw new Error(`Compaction entry ${input.entry.id} already exists without matching operation metadata`);
	}
	if (
		session.staticContextHash !== input.operation.baseStaticContextHash ||
		session.treeHash !== input.operation.baseTreeHash ||
		session.entries.length !== input.operation.baseEntryCount ||
		session.leafId !== input.operation.baseLeafId ||
		session.revision !== input.operation.baseRevision
	) {
		throw new Error(
			`Session base identity changed before compaction operation ${input.operation.operationId} could be applied`,
		);
	}
	if (input.entry.parentId !== session.leafId) {
		throw new Error(`Compaction entry ${input.entry.id} parent does not match the base leaf`);
	}
	if (!getSessionBranch(session).some((entry) => entry.id === input.entry.firstKeptEntryId)) {
		throw new Error(`firstKeptEntryId ${input.entry.firstKeptEntryId} does not exist on the active session branch`);
	}
	const expectedTreeHash = appendPiServerTreeHash(session.treeHash, hashPiServerTreeEntry(input.entry));
	if (expectedTreeHash !== input.updatedTreeHash || input.updatedRevision !== session.revision + 1) {
		throw new Error(`Compaction operation ${input.operation.operationId} commit identity is invalid`);
	}
	const entry = cloneSerializable(input.entry);
	const nextLogicalBytes = session.logicalBytes + measureEntryLogicalBytes(entry);
	assertCapacityTransition(
		sessionId,
		session.entries.length,
		session.logicalBytes,
		session.entries.length + 1,
		nextLogicalBytes,
		false,
	);
	const nextEntryById = new Map(session.entryById);
	nextEntryById.set(entry.id, entry);
	const messages = deriveActiveMessagesFromIndex(nextEntryById, entry.id);
	const updatedAt = Date.now();
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	session.entries.push(entry);
	session.entryById.set(entry.id, entry);
	session.logicalBytes = nextLogicalBytes;
	session.leafId = entry.id;
	session.treeHash = input.updatedTreeHash;
	session.prefixHashes.push(input.updatedTreeHash);
	session.messages = messages;
	session.revision = input.updatedRevision;
	session.updatedAt = updatedAt;
	session.persistenceChange = { kind: "snapshot" };
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return session;
}

export function getActiveMessages(sessionId: string): Message[] {
	const session = getSession(sessionId);
	return session ? cloneSerializable(session.messages) : [];
}

export function appendMessages(sessionId: string, delta: Message[]): SessionState {
	const existingSession = sessions.get(sessionId);
	if (delta.length === 0) {
		return existingSession ?? getOrCreateSession(sessionId);
	}
	assertEntryCountTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		(existingSession?.entries.length ?? 0) + delta.length,
		existingSession === undefined,
	);
	const entries = buildMessageEntries(delta, existingSession?.leafId ?? null);
	return appendSessionEntries(sessionId, entries, entries[entries.length - 1].id);
}

export function appendAssistantResponse(sessionId: string, message: Message): SessionState {
	return appendMessages(sessionId, [message]);
}

export function replaceMessages(sessionId: string, messages: Message[]): SessionState {
	const existingSession = sessions.get(sessionId);
	if (
		existingSession &&
		existingSession.entries.length === messages.length &&
		existingSession.entries.every((entry) => entry.type === "message") &&
		isDeepStrictEqual(existingSession.messages, messages)
	) {
		return existingSession;
	}
	if (!existingSession && messages.length === 0) {
		return getOrCreateSession(sessionId);
	}
	assertEntryCountTransition(
		sessionId,
		existingSession?.entries.length ?? 0,
		messages.length,
		existingSession === undefined,
	);
	const entries = buildMessageEntries(messages, null);
	return replaceSessionTree(sessionId, entries, entries.at(-1)?.id ?? null);
}

export function dropLastAssistantError(sessionId: string): boolean {
	const session = getSession(sessionId);
	if (!session) return false;
	const leaf = session.leafId ? session.entryById.get(session.leafId) : undefined;
	if (leaf?.type !== "message" || leaf.message.role !== "assistant" || leaf.message.stopReason !== "error") {
		return false;
	}
	const nextEntries = session.entries.filter((entry) => entry.id !== leaf.id);
	const nextEntryById = buildEntryIndex(nextEntries);
	const nextLogicalBytes = session.logicalBytes - measureEntryLogicalBytes(leaf);
	const { treeHash, prefixHashes } = deriveTreeHashes(nextEntries);
	const messages = deriveActiveMessagesFromIndex(nextEntryById, leaf.parentId);
	const updatedAt = Date.now();
	const previousEntryCount = session.entries.length;
	const previousLogicalBytes = session.logicalBytes;
	session.entries = nextEntries;
	session.entryById = nextEntryById;
	session.logicalBytes = nextLogicalBytes;
	session.leafId = leaf.parentId;
	session.treeHash = treeHash;
	session.prefixHashes = prefixHashes;
	session.messages = messages;
	session.revision++;
	session.updatedAt = updatedAt;
	session.persistenceChange = { kind: "snapshot" };
	commitCapacityTransition(session, previousEntryCount, previousLogicalBytes);
	return true;
}

export function deleteSession(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session || !sessions.delete(sessionId)) return false;
	aggregateEntryCount -= session.entries.length;
	aggregateLogicalBytes -= session.logicalBytes;
	return true;
}

export function clearAllSessions(): void {
	sessions.clear();
	aggregateEntryCount = 0;
	aggregateLogicalBytes = 0;
}

function deriveWalPersistenceChange(
	current: SessionPersistenceChange | undefined,
	entries: SessionTreeEntry[],
	staticContextChanged = false,
): SessionPersistenceChange {
	if (current?.kind === "snapshot") return current;
	const clonedEntries = cloneSerializable(entries);
	return {
		kind: "wal",
		entries: (current?.entries ?? []).concat(clonedEntries),
		staticContextChanged: current?.staticContextChanged === true || staticContextChanged,
	};
}

export function markSessionPersisted(session: SessionState): void {
	session.persistenceChange = undefined;
}
