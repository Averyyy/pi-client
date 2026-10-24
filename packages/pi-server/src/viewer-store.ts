import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type TextSignatureV1 } from "@earendil-works/pi-ai";
import { getSession, getSessionBranch, listSessions, type SessionState } from "./session-store.ts";
import type {
	ObserverUpdate,
	ThreadSummary,
	ViewerCatalog,
	ViewerContent,
	ViewerMessage,
	ViewerProject,
	ViewerRound,
	ViewerThread,
	ViewerUpdate,
} from "./viewer-types.ts";

interface RoundOffset {
	id: string;
	start: number;
	end: number;
}
interface StoredThread {
	fileId: string;
	logId: string;
	thread: ViewerThread;
	rounds: RoundOffset[];
	length: number;
}

interface ProjectIndex {
	project: ViewerProject;
	threads: ThreadSummary[];
}

function compareThreads(
	left: Pick<ThreadSummary, "id" | "updatedAt">,
	right: Pick<ThreadSummary, "id" | "updatedAt">,
): number {
	return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function threadOffset(
	threads: ThreadSummary[],
	target: Pick<ThreadSummary, "id" | "updatedAt">,
	after = false,
): number {
	let start = 0;
	let end = threads.length;
	while (start < end) {
		const middle = (start + end) >>> 1;
		const order = compareThreads(threads[middle], target);
		if (order < 0 || (after && order === 0)) start = middle + 1;
		else end = middle;
	}
	return start;
}

function normalizeProjectPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function staticPromptCwd(prompt: string): string | undefined {
	const legacy = /\r?\nCurrent working directory: ([^\r\n]+)(?:\r?\n)*$/.exec(prompt)?.[1];
	if (legacy !== undefined) return legacy;
	const sections: string[] = [];
	let cwd: string | undefined;
	let cwdStart = 0;
	let cwdCount = 0;
	for (const tag of prompt.matchAll(/^<(\/?)([a-z][a-z0-9_-]*)(?:[ \t][^<>\r\n]*)?>\r?$/gm)) {
		const name = tag[2];
		if (tag[1] === "") {
			if (sections.length === 0 && name === "cwd") {
				if (tag[0].trimEnd() !== "<cwd>") return undefined;
				cwdCount++;
				cwdStart = tag.index + tag[0].length;
			}
			if (!tag[0].trimEnd().endsWith("/>")) sections.push(name);
		} else {
			if (sections.pop() !== name) return undefined;
			if (sections.length === 0 && name === "cwd")
				cwd = /^\r?\n([^\r\n]+)\r?\n$/.exec(prompt.slice(cwdStart, tag.index))?.[1];
		}
	}
	if (sections.length > 0 || cwdCount > 1) return undefined;
	return cwdCount === 1 ? cwd : undefined;
}

export class ViewerStore {
	private readonly directory: string;
	private readonly threads = new Map<string, StoredThread>();
	private readonly connections = new Map<string, { id: string; sequence: number }>();
	private readonly deletedConnections = new Set<string>();
	private readonly archiveMetadata = new Map<
		string,
		{ revision: number; title: string | undefined; cwd: string | null }
	>();
	private readonly listeners = new Map<string, Set<(update: ViewerUpdate) => void>>();
	private readonly catalogEpoch = randomUUID();
	private catalogSequence = 0;
	private catalogInitialized = false;
	private catalog: ViewerCatalog | undefined;
	private readonly indexedSummaries = new Map<string, ThreadSummary>();
	private readonly projectIndex = new Map<string, ProjectIndex>();
	private readonly running = new Map<string, ThreadSummary>();
	readonly catalogListeners = new Set<() => void>();
	readonly removedListeners = new Set<(id: string) => void>();

	constructor(sessionStoreDir: string) {
		this.directory = join(sessionStoreDir, ".viewer", "threads");
		if (!existsSync(this.directory)) return;
		for (const file of readdirSync(this.directory)) {
			if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
			const stored = JSON.parse(readFileSync(join(this.directory, file), "utf8")) as StoredThread;
			const log = join(this.directory, `${stored.logId}.jsonl`);
			if (statSync(log).size < stored.length) throw new Error("Viewer log is shorter than committed index");
			truncateSync(log, stored.length);
			stored.thread.status = "disconnected";
			stored.thread.live = { message: null, tools: [] };
			this.threads.set(stored.thread.id, stored);
		}
	}

	projects(): ViewerCatalog {
		this.initializeCatalog();
		this.catalog ??= {
			projects: [...this.projectIndex.values()]
				.map(({ project }) => project)
				.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
			running: [...this.running.values()].sort(compareThreads),
			revision: `${this.catalogEpoch}:${this.catalogSequence}`,
		};
		return this.catalog;
	}

	projectThreadIds(project: string): string[] {
		this.initializeCatalog();
		return this.projectIndex.get(project)?.threads.map((thread) => thread.id) ?? [];
	}

	page(project: string, cursor: string | null): { threads: ThreadSummary[]; nextCursor: string | null } {
		this.initializeCatalog();
		const threads = this.projectIndex.get(project)?.threads ?? [];
		let start = 0;
		if (cursor !== null) {
			const anchor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
				id: string;
				updatedAt: number;
			};
			if (typeof anchor.id !== "string" || typeof anchor.updatedAt !== "number")
				throw new Error("Invalid pagination cursor");
			start = threadOffset(threads, anchor, true);
		}
		const page = threads.slice(start, start + 5);
		const last = page.at(-1);
		return {
			threads: page,
			nextCursor:
				threads.length > start + 5 && last
					? Buffer.from(JSON.stringify({ id: last.id, updatedAt: last.updatedAt })).toString("base64url")
					: null,
		};
	}

	get(id: string): ViewerThread | undefined {
		const summary = this.summary(id);
		if (!summary) return undefined;
		const stored = this.threads.get(id);
		const session = getSession(id);
		return {
			...summary,
			legacy: !stored || (stored.length === 0 && Boolean(session?.entries.length)),
			live: stored ? structuredClone(stored.thread.live) : { message: null, tools: [] },
		};
	}

	refreshSession(id: string): void {
		this.refreshCatalog(id);
		const listeners = this.listeners.get(id);
		if (listeners?.size) {
			const thread = this.get(id);
			if (thread) {
				const update: ViewerUpdate = { thread, replace: true, refresh: true, ...this.rounds(id, null) };
				for (const listener of listeners) listener(update);
			}
		}
	}

	subscribe(id: string, listener: (update: ViewerUpdate) => void): () => void {
		let listeners = this.listeners.get(id);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(id, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(id);
		};
	}

	remove(id: string): void {
		const connection = this.connections.get(id);
		if (connection) this.deletedConnections.add(connection.id);
		this.connections.delete(id);
		this.archiveMetadata.delete(id);
		const stored = this.threads.get(id);
		if (stored) {
			rmSync(join(this.directory, `${stored.fileId}.json`), { force: true });
			rmSync(join(this.directory, `${stored.logId}.jsonl`), { force: true });
			this.threads.delete(id);
		}
		for (const listener of this.removedListeners) listener(id);
		this.refreshCatalog(id, true);
	}

	rounds(id: string, before: string | null): { rounds: ViewerRound[]; nextCursor: string | null } {
		const stored = this.threads.get(id);
		const session = getSession(id);
		if (!stored || (stored.length === 0 && session?.entries.length)) {
			if (!session) throw new Error("Thread not found");
			const branch = getSessionBranch(session).filter(
				(entry): entry is Extract<SessionTreeEntry, { type: "message" }> =>
					entry.type === "message" && entry.message.role !== "system",
			);
			const boundaries: { id: string; offset: number }[] = [];
			for (const [offset, entry] of branch.entries()) {
				if (!boundaries.length || (entry.message as Record<string, unknown>).role === "user")
					boundaries.push({ id: entry.id, offset });
			}
			const end = before === null ? boundaries.length : this.roundCursor(before, boundaries);
			const start = Math.max(0, end - 5);
			const rounds: ViewerRound[] = boundaries.slice(start, end).map((boundary, index) => ({
				id: boundary.id,
				messages: branch
					.slice(boundary.offset, boundaries[start + index + 1]?.offset ?? branch.length)
					.map((entry) =>
						projectMessage({
							...(entry.message as Record<string, unknown>),
							id: entry.id,
							timestamp: new Date(entry.timestamp).getTime(),
						}),
					),
			}));
			return { rounds, nextCursor: start > 0 ? boundaries[start].id : null };
		}
		const end = before === null ? stored.rounds.length : this.roundCursor(before, stored.rounds);
		const start = Math.max(0, end - 5);
		const offsets = stored.rounds.slice(start, end);
		const fd = openSync(join(this.directory, `${stored.logId}.jsonl`), "r");
		try {
			const rounds = offsets.map((round) => {
				const buffer = Buffer.alloc(round.end - round.start);
				readSync(fd, buffer, 0, buffer.length, round.start);
				return {
					id: round.id,
					messages: buffer
						.toString("utf8")
						.trimEnd()
						.split("\n")
						.map((line) => JSON.parse(line) as ViewerMessage),
				};
			});
			return { rounds, nextCursor: start > 0 ? stored.rounds[start].id : null };
		} finally {
			closeSync(fd);
		}
	}

	connect(id: string): { connectionId: string; close: () => void } {
		const connectionId = randomUUID();
		this.connections.set(id, { id: connectionId, sequence: 0 });
		const stored = this.threads.get(id);
		if (stored) {
			stored.thread.status = "unknown";
			stored.thread.live = { message: null, tools: [] };
			this.emit(stored);
		}
		return {
			connectionId,
			close: () => {
				if (this.connections.get(id)?.id !== connectionId) return;
				this.connections.delete(id);
				const thread = this.threads.get(id);
				if (!thread) return;
				thread.thread.status = "disconnected";
				thread.thread.live = { message: null, tools: [] };
				this.emit(thread);
			},
		};
	}

	update(body: ObserverUpdate): void {
		if (this.deletedConnections.has(body.connectionId)) throw new Error("Observer session deleted");
		const connection = this.connections.get(body.sessionId);
		if (connection?.id !== body.connectionId) throw new Error("Observer connection expired");
		if (body.sequence <= connection.sequence) return;
		let stored = this.threads.get(body.sessionId);
		const created = !stored;
		if (!stored) {
			if (!body.replace || !body.cwd) throw new Error("First observer update requires cwd and replace");
			stored = {
				fileId: randomUUID(),
				logId: randomUUID(),
				thread: {
					id: body.sessionId,
					title: body.title ?? body.sessionId,
					cwd: body.cwd,
					projectId: body.cwd,
					status: "unknown",
					updatedAt: Date.now(),
					legacy: false,
					live: { message: null, tools: [] },
				},
				rounds: [],
				length: 0,
			};
			this.threads.set(body.sessionId, stored);
		}
		const metadataChanged =
			(body.cwd !== undefined && body.cwd !== stored.thread.cwd) ||
			(body.title !== undefined && body.title !== stored.thread.title);
		const statusChanged = body.status !== undefined && body.status !== stored.thread.status;
		if (body.cwd !== undefined) {
			stored.thread.cwd = body.cwd;
			stored.thread.projectId = body.cwd;
		}
		if (body.title !== undefined) stored.thread.title = body.title;
		if (body.status !== undefined) stored.thread.status = body.status;
		if (body.live !== undefined) stored.thread.live = body.live;
		const messages = body.replace ?? body.append ?? [];
		const replacesArchive =
			stored.length === 0 && messages.length > 0 && Boolean(getSession(body.sessionId)?.entries.length);
		const oldLogId = stored.logId;
		if (body.replace) {
			stored.logId = randomUUID();
			stored.rounds = [];
			stored.length = 0;
		}
		const log = join(this.directory, `${stored.logId}.jsonl`);
		if (created || body.replace || messages.length || metadataChanged) mkdirSync(this.directory, { recursive: true });
		if (body.replace) writeFileSync(log, "");
		for (const message of messages) {
			if (!stored.rounds.length || message.role === "user")
				stored.rounds.push({ id: message.id, start: stored.length, end: stored.length });
			const line = `${JSON.stringify(message)}\n`;
			appendFileSync(log, line);
			stored.length += Buffer.byteLength(line);
			stored.rounds[stored.rounds.length - 1].end = stored.length;
		}
		if (created || messages.length || body.replace || metadataChanged) {
			stored.thread.updatedAt = Date.now();
			const path = join(this.directory, `${stored.fileId}.json`);
			writeFileSync(
				`${path}.tmp`,
				JSON.stringify({
					...stored,
					thread: { ...stored.thread, status: "disconnected", live: { message: null, tools: [] } },
				}),
			);
			renameSync(`${path}.tmp`, path);
			if (body.replace && oldLogId !== stored.logId)
				rmSync(join(this.directory, `${oldLogId}.jsonl`), { force: true });
		}
		connection.sequence = body.sequence;
		this.emit(
			stored,
			body.append,
			body.replace !== undefined || replacesArchive,
			created || messages.length > 0 || body.replace !== undefined || metadataChanged || statusChanged,
		);
	}

	private initializeCatalog(): void {
		if (this.catalogInitialized) return;
		this.catalogInitialized = true;
		const ids = new Set([...listSessions().map((session) => session.sessionId), ...this.threads.keys()]);
		for (const id of ids) {
			const summary = this.summary(id)!;
			this.indexedSummaries.set(id, summary);
			let project = this.projectIndex.get(summary.projectId);
			if (!project) {
				project = this.createProjectIndex(summary);
				this.projectIndex.set(summary.projectId, project);
			}
			project.threads.push(summary);
			project.project.threadCount++;
			if (summary.status === "running") this.running.set(id, summary);
		}
		for (const indexed of this.projectIndex.values()) {
			indexed.threads.sort(compareThreads);
			indexed.project.updatedAt = indexed.threads[0].updatedAt;
		}
	}

	private createProjectIndex(summary: ThreadSummary): ProjectIndex {
		return {
			project: {
				id: summary.projectId,
				path: summary.cwd,
				name: summary.cwd?.split("/").filter(Boolean).at(-1) ?? "Unassigned archives",
				threadCount: 0,
				revision: `${this.catalogEpoch}:${this.catalogSequence}`,
				updatedAt: summary.updatedAt,
			},
			threads: [],
		};
	}

	private refreshCatalog(id: string, removed = false): void {
		if (!this.catalogInitialized) {
			if (this.catalogListeners.size === 0) return;
			this.initializeCatalog();
			for (const listener of this.catalogListeners) listener();
			return;
		}
		const previous = this.indexedSummaries.get(id);
		const next = removed ? undefined : this.summary(id);
		if (
			previous?.title === next?.title &&
			previous?.projectId === next?.projectId &&
			previous?.cwd === next?.cwd &&
			previous?.status === next?.status &&
			previous?.updatedAt === next?.updatedAt
		)
			return;
		const revision = `${this.catalogEpoch}:${++this.catalogSequence}`;
		if (previous) {
			const project = this.projectIndex.get(previous.projectId)!;
			project.threads.splice(threadOffset(project.threads, previous), 1);
			project.project = {
				...project.project,
				threadCount: project.threads.length,
				updatedAt: project.threads[0]?.updatedAt ?? 0,
				revision,
			};
			if (project.threads.length === 0) this.projectIndex.delete(previous.projectId);
		}
		this.indexedSummaries.delete(id);
		this.running.delete(id);
		if (next) {
			this.indexedSummaries.set(id, next);
			let project = this.projectIndex.get(next.projectId);
			if (!project) {
				project = this.createProjectIndex(next);
				this.projectIndex.set(next.projectId, project);
			}
			project.threads.splice(threadOffset(project.threads, next), 0, next);
			project.project = {
				...project.project,
				threadCount: project.threads.length,
				updatedAt: project.threads[0].updatedAt,
				revision,
			};
			if (next.status === "running") this.running.set(id, next);
		}
		this.catalog = undefined;
		for (const listener of this.catalogListeners) listener();
	}

	private summary(id: string): ThreadSummary | undefined {
		const stored = this.threads.get(id)?.thread;
		const session = getSession(id);
		if (!session && !stored) return undefined;
		const metadata = session ? this.sessionMetadata(session) : undefined;
		const cwd = metadata?.cwd ?? (stored?.cwd ? normalizeProjectPath(stored.cwd) : null);
		return {
			id,
			title: metadata?.title ?? stored?.title ?? id,
			cwd,
			projectId: cwd ?? "unassigned",
			status: stored?.status ?? "unknown",
			updatedAt: Math.max(session?.updatedAt ?? 0, stored?.updatedAt ?? 0),
		};
	}

	private emit(stored: StoredThread, append?: ViewerMessage[], replace = false, catalog = true): void {
		if (catalog) this.refreshCatalog(stored.thread.id);
		const listeners = this.listeners.get(stored.thread.id);
		if (listeners?.size) {
			const thread = this.get(stored.thread.id)!;
			const update: ViewerUpdate = replace
				? { thread, replace: true, ...this.rounds(thread.id, null) }
				: { thread, ...(append?.length ? { append } : {}) };
			for (const listener of listeners) listener(update);
		}
	}

	private roundCursor(value: string, rounds: { id: string }[]): number {
		const index = rounds.findIndex((round) => round.id === value);
		if (index < 0) throw new Error("Round cursor is no longer available");
		return index;
	}

	private sessionMetadata(session: SessionState): { title: string | undefined; cwd: string | null } {
		const cached = this.archiveMetadata.get(session.sessionId);
		if (cached?.revision === session.revision) return cached;
		let name: string | undefined;
		let firstUser: string | undefined;
		for (const entry of getSessionBranch(session)) {
			if (entry.type === "session_info") name = entry.name;
			if (firstUser !== undefined || entry.type !== "message" || !entry.message) continue;
			const message = entry.message as Record<string, unknown>;
			if (message.role !== "user") continue;
			if (typeof message.content === "string") firstUser = message.content.slice(0, 120);
			else if (Array.isArray(message.content))
				firstUser = message.content
					.map((part: Record<string, unknown>) =>
						part.type === "text" && typeof part.text === "string" ? part.text : "",
					)
					.join("")
					.slice(0, 120);
		}
		const section = getCurrentSystemMessage(session.messages)?.sections?.cwd;
		const prompt = session.staticContext?.systemPrompt ?? "";
		const cwd =
			(typeof section === "string" ? /^<cwd>\r?\n([^\r\n]+)\r?\n<\/cwd>$/.exec(section)?.[1] : undefined) ??
			staticPromptCwd(prompt);
		const metadata = {
			revision: session.revision,
			title: name ?? firstUser,
			cwd: cwd ? normalizeProjectPath(cwd) : null,
		};
		this.archiveMetadata.set(session.sessionId, metadata);
		return metadata;
	}
}

export function projectMessage(value: Record<string, unknown>): ViewerMessage {
	if (
		typeof value.id !== "string" ||
		typeof value.role !== "string" ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp)
	)
		throw new Error("Invalid observer message identity");
	let content: ViewerMessage["content"];
	if (typeof value.content === "string") content = value.content;
	else if (Array.isArray(value.content)) content = projectContent(value.content);
	else throw new Error("Invalid observer message content");
	let phase = typeof value.phase === "string" ? value.phase : undefined;
	if (typeof content !== "string")
		for (const part of content) if (part.type === "text" && part.phase) phase = part.phase;
	return {
		id: value.id,
		role: value.role,
		timestamp: value.timestamp,
		content,
		...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
		...(phase !== undefined ? { phase } : {}),
		...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
	};
}

export function projectContent(value: unknown): ViewerContent[] {
	if (!Array.isArray(value)) throw new Error("Content must be an array");
	return value.map((block: unknown): ViewerContent => {
		if (!block || typeof block !== "object") throw new Error("Invalid message content");
		const part = block as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") {
			let phase: TextSignatureV1["phase"] =
				part.phase === "commentary" || part.phase === "final_answer" ? part.phase : undefined;
			if (typeof part.textSignature === "string" && part.textSignature.startsWith("{")) {
				try {
					const signature = JSON.parse(part.textSignature) as Partial<TextSignatureV1>;
					if (
						signature.v === 1 &&
						typeof signature.id === "string" &&
						(signature.phase === "commentary" || signature.phase === "final_answer")
					)
						phase = signature.phase;
				} catch {
					/* Other provider signatures carry no display phase. */
				}
			}
			return { type: "text", text: part.text, ...(phase ? { phase } : {}) };
		}
		if (part.type === "thinking" && typeof part.thinking === "string")
			return { type: "thinking", thinking: part.thinking };
		if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
			return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
		if (part.type === "attachment" && typeof part.label === "string")
			return { type: "attachment", label: part.label };
		if (part.type === "image" || part.type === "audio" || part.type === "video" || part.type === "file")
			return { type: "attachment", label: part.type };
		throw new Error("Unsupported observer content block");
	});
}
