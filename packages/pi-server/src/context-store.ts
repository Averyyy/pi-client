// Per-session store of projected provider messages, so clients upload each message once.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	appendPiServerContextHash,
	hashPiServerContextJson,
	PI_SERVER_EMPTY_CONTEXT_HASH,
	type PiServerContextDelta,
} from "./pi-server-protocol.ts";

/** One line of a session's append-only context file. */
type ContextRecord = { hash: string; message: Message } | { parent: string; hash: string };

interface SessionContexts {
	messages: Map<string, Message>;
	/** Each known prefix hash with its parent prefix and last message. */
	prefixes: Map<string, { parent: string; hash: string }>;
}

/**
 * Messages are stored by the hash of their exact JSON, and every context prefix a client has
 * sent is a node in a hash chain. A request names the longest prefix it knows the server holds
 * and sends the rest as messages or message hashes. Sessions load lazily and stay in memory.
 */
export class ContextStore {
	private readonly directory: string;
	private readonly sessions = new Map<string, SessionContexts>();

	constructor(directory: string) {
		this.directory = directory;
	}

	/** Rebuild the full context and record its new messages and prefixes; undefined when the base or a hash is unknown. */
	resolve(sessionId: string, delta: PiServerContextDelta): Message[] | undefined {
		const store = this.load(sessionId);
		const messages = delta.base === undefined ? [] : walkPrefix(store, delta.base);
		if (!messages) return undefined;
		for (const item of delta.messages) {
			if (typeof item === "string" && !store.messages.has(item)) return undefined;
		}
		const records: string[] = [];
		let prefix = delta.base ?? PI_SERVER_EMPTY_CONTEXT_HASH;
		for (const item of delta.messages) {
			let hash: string;
			let message: Message;
			if (typeof item === "string") {
				hash = item;
				message = store.messages.get(item)!;
			} else {
				const json = JSON.stringify(item);
				hash = hashPiServerContextJson(json);
				message = item;
				if (!store.messages.has(hash)) {
					store.messages.set(hash, item);
					records.push(`{"hash":"${hash}","message":${json}}`);
				}
			}
			const next = appendPiServerContextHash(prefix, hash);
			if (!store.prefixes.has(next)) {
				store.prefixes.set(next, { parent: prefix, hash });
				records.push(JSON.stringify({ parent: prefix, hash }));
			}
			prefix = next;
			messages.push(message);
		}
		this.append(sessionId, records);
		return messages;
	}

	/** Store messages the server produced for the client, such as tool results it relayed. */
	add(sessionId: string, messages: readonly Message[]): void {
		const store = this.load(sessionId);
		const records: string[] = [];
		for (const message of messages) {
			const json = JSON.stringify(message);
			const hash = hashPiServerContextJson(json);
			if (store.messages.has(hash)) continue;
			store.messages.set(hash, message);
			records.push(`{"hash":"${hash}","message":${json}}`);
		}
		this.append(sessionId, records);
	}

	/** Forget a deleted session's messages. */
	delete(sessionId: string): void {
		this.sessions.delete(sessionId);
		rmSync(this.path(sessionId), { force: true });
	}

	private path(sessionId: string): string {
		return join(this.directory, `${createHash("sha256").update(sessionId).digest("hex")}.context.jsonl`);
	}

	private append(sessionId: string, records: string[]): void {
		if (records.length === 0) return;
		mkdirSync(this.directory, { recursive: true });
		appendFileSync(this.path(sessionId), `${records.join("\n")}\n`, "utf-8");
	}

	private load(sessionId: string): SessionContexts {
		let store = this.sessions.get(sessionId);
		if (store) return store;
		store = { messages: new Map(), prefixes: new Map() };
		const path = this.path(sessionId);
		if (existsSync(path)) {
			try {
				readRecords(path, store);
			} catch (error) {
				// The file only caches client uploads: dropping it makes clients resend their context once.
				console.warn(`Discarding unreadable context store ${path}:`, error);
				rmSync(path, { force: true });
				store = { messages: new Map(), prefixes: new Map() };
			}
		}
		this.sessions.set(sessionId, store);
		return store;
	}
}

function walkPrefix(store: SessionContexts, base: string): Message[] | undefined {
	const hashes: string[] = [];
	for (let prefix = base; prefix !== PI_SERVER_EMPTY_CONTEXT_HASH; ) {
		const node = store.prefixes.get(prefix);
		if (!node) return undefined;
		hashes.push(node.hash);
		prefix = node.parent;
	}
	return hashes.reverse().map((hash) => store.messages.get(hash)!);
}

function readRecords(path: string, store: SessionContexts): void {
	const lines = readFileSync(path, "utf-8").split("\n");
	let offset = 0;
	for (const [index, line] of lines.entries()) {
		const start = offset;
		offset += Buffer.byteLength(line, "utf8") + 1;
		if (!line) continue;
		let record: ContextRecord;
		try {
			record = JSON.parse(line) as ContextRecord;
		} catch (error) {
			if (lines.slice(index + 1).some(Boolean)) throw error;
			// A crash can tear only the last append; every earlier record precedes the prefixes that use it.
			truncateSync(path, start);
			return;
		}
		if ("message" in record) store.messages.set(record.hash, record.message);
		else {
			store.prefixes.set(appendPiServerContextHash(record.parent, record.hash), {
				parent: record.parent,
				hash: record.hash,
			});
		}
	}
}
