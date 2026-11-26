import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextStore } from "../src/context-store.ts";
import {
	appendPiServerContextHash,
	hashPiServerContextJson,
	PI_SERVER_EMPTY_CONTEXT_HASH,
} from "../src/pi-server-protocol.ts";

const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });
const hash = (message: Message) => hashPiServerContextJson(JSON.stringify(message));
const prefix = (...messages: Message[]) =>
	messages.reduce(
		(current, message) => appendPiServerContextHash(current, hash(message)),
		PI_SERVER_EMPTY_CONTEXT_HASH,
	);

describe("ContextStore", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-context-store-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("rebuilds a context from a known prefix, stored hashes, and new messages", () => {
		const store = new ContextStore(directory);
		const [first, second, third] = [user("first", 1), user("second", 2), user("third", 3)];
		expect(store.resolve("session", { messages: [first, second] })).toEqual([first, second]);
		expect(store.resolve("session", { base: prefix(first, second), messages: [third] })).toEqual([
			first,
			second,
			third,
		]);
		// A branch that drops `second` reuses the stored copies of the other two messages.
		expect(store.resolve("session", { base: prefix(first), messages: [hash(third)] })).toEqual([first, third]);
	});

	it("reads a context from stored messages without recording its new messages", () => {
		const store = new ContextStore(directory);
		const [first, second, oneOff] = [user("first", 1), user("second", 2), user("one-off", 3)];
		store.resolve("session", { messages: [first, second] });
		const [file] = readdirSync(directory);
		const recorded = readFileSync(join(directory, file), "utf-8");
		// A warm replay names the whole stored prefix; a one-off request appends its own message.
		expect(store.read("session", { base: prefix(first, second), messages: [] })).toEqual([first, second]);
		expect(store.read("session", { base: prefix(first), messages: [hash(second), oneOff] })).toEqual([
			first,
			second,
			oneOff,
		]);
		expect(readFileSync(join(directory, file), "utf-8")).toBe(recorded);
		expect(store.read("session", { base: prefix(first, oneOff), messages: [] })).toBeUndefined();
		expect(store.read("session", { messages: [hash(oneOff)] })).toBeUndefined();
	});

	it("reports an unknown base or message hash without recording the request", () => {
		const store = new ContextStore(directory);
		const first = user("first", 1);
		expect(store.resolve("session", { base: prefix(first), messages: [] })).toBeUndefined();
		expect(store.resolve("session", { messages: [first, hash(user("missing", 2))] })).toBeUndefined();
		expect(store.resolve("session", { messages: [hash(first)] })).toBeUndefined();
	});

	it("restores messages, prefixes, and stored replies after a restart", () => {
		const first = user("first", 1);
		const reply: Message = {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const before = new ContextStore(directory);
		before.resolve("session", { messages: [first] });
		before.add("session", [reply]);
		const after = new ContextStore(directory);
		expect(after.resolve("session", { base: prefix(first), messages: [hash(reply), user("next", 3)] })).toEqual([
			first,
			reply,
			user("next", 3),
		]);
	});

	it("drops a torn final record and keeps the records before it", () => {
		const first = user("first", 1);
		new ContextStore(directory).resolve("session", { messages: [first] });
		const [file] = readdirSync(directory);
		const intact = readFileSync(join(directory, file), "utf-8");
		appendFileSync(join(directory, file), '{"hash":"torn","mess');
		const store = new ContextStore(directory);
		expect(store.resolve("session", { base: prefix(first), messages: [] })).toEqual([first]);
		expect(readFileSync(join(directory, file), "utf-8")).toBe(intact);
	});

	it("discards a store with a damaged record so the client uploads its context again", () => {
		const first = user("first", 1);
		new ContextStore(directory).resolve("session", { messages: [first] });
		const [file] = readdirSync(directory);
		const lines = readFileSync(join(directory, file), "utf-8").split("\n");
		rmSync(join(directory, file));
		appendFileSync(join(directory, file), ["{damaged", ...lines].join("\n"));
		expect(new ContextStore(directory).resolve("session", { base: prefix(first), messages: [] })).toBeUndefined();
	});

	it("deletes a session's messages", () => {
		const store = new ContextStore(directory);
		const first = user("first", 1);
		store.resolve("session", { messages: [first] });
		store.delete("session");
		expect(readdirSync(directory)).toEqual([]);
		expect(store.resolve("session", { messages: [hash(first)] })).toBeUndefined();
	});
});
