import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compactPiServer,
	hashStaticContext,
	resetAllSessionTracking,
	streamPiServer,
} from "../src/core/pi-server-client.ts";
import { hashPiServerSessionEntries, PI_SERVER_EMPTY_TREE_HASH } from "../src/core/pi-server-protocol.ts";

type JsonObject = Record<string, unknown>;

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://api.test.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function textMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp };
}

function messageEntry(id: string, message: Message): SessionTreeEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function parseBody(init?: RequestInit): JsonObject {
	const parsed = JSON.parse((init?.body as string | undefined) ?? "{}") as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected JSON object request body");
	}
	return parsed as JsonObject;
}

function sessionResponse(
	sessionId: string,
	staticContextHash: string,
	entries: SessionTreeEntry[] = [],
	leafId: string | null = null,
): Response {
	return new Response(
		JSON.stringify({
			protocolVersion: 2,
			sessionId,
			staticContextRequired: false,
			staticContextHash,
			treeHash: entries.length === 0 ? PI_SERVER_EMPTY_TREE_HASH : hashPiServerSessionEntries(entries),
			messageCount: entries.length,
			entryCount: entries.length,
			leafId,
			revision: entries.length === 0 ? 0 : 1,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function zeroByteEventStream(onCancel: () => void): Response {
	let timer: ReturnType<typeof setInterval> | undefined;
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array());
				timer = setInterval(() => controller.enqueue(new Uint8Array()), 10);
			},
			cancel() {
				if (timer) clearInterval(timer);
				onCancel();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("pi-server client no-progress detection", () => {
	beforeEach(() => {
		resetAllSessionTracking();
		process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS = "50";
		vi.useFakeTimers();
	});

	afterEach(() => {
		resetAllSessionTracking();
		delete process.env.PI_SERVER_RESPONSE_NO_PROGRESS_TIMEOUT_MS;
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("times out a provider stream that emits only zero-byte chunks", async () => {
		const sessionId = "zero-byte-provider";
		const message = textMessage("hello", 1000);
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [message],
		};
		const entries = [messageEntry("u1", message)];
		const staticContextHash = hashStaticContext(context);
		let cancelled = false;
		let streamPosts = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = new URL(input.toString()).pathname;
				const body = parseBody(init);
				if (path === "/api/session/init") {
					return sessionResponse(sessionId, staticContextHash);
				}
				if (path === "/api/session/tree/append" || path === "/api/session/tree/sync") {
					return sessionResponse(sessionId, staticContextHash, entries, "u1");
				}
				if (path === "/api/stream") {
					streamPosts++;
					return zeroByteEventStream(() => {
						cancelled = true;
					});
				}
				if (/\/api\/session\/[^/]+\/runs\/[^/]+$/u.test(path)) {
					return new Response(JSON.stringify({ error: "stream run not found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error(`Unexpected request: ${path} ${JSON.stringify(body)}`);
			}),
		);

		const stream = await streamPiServer(model, context, {
			sessionId,
			sessionTree: { entries, leafId: "u1" },
		});
		const resultPromise = stream.result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(51);

		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("pi-server response made no progress for 50ms");
		expect(result.errorMessage).toContain("no longer has durable journal");
		expect(streamPosts).toBe(1);
		expect(cancelled).toBe(true);
	});

	it("times out compact SSE that emits only zero-byte chunks", async () => {
		const sessionId = "zero-byte-compact";
		const message = textMessage("hello", 1000);
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [message],
		};
		const entries = [messageEntry("u1", message)];
		const staticContextHash = hashStaticContext(context);
		let cancelled = false;
		let compactPosts = 0;
		const compactStateDirectory = mkdtempSync(join(tmpdir(), "pi-server-compact-no-progress-"));

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = new URL(input.toString()).pathname;
				if (path === "/api/session/init") {
					return sessionResponse(sessionId, staticContextHash);
				}
				if (path === "/api/session/tree/append" || path === "/api/session/tree/sync") {
					return sessionResponse(sessionId, staticContextHash, entries, "u1");
				}
				if (path === "/api/session/compact") {
					compactPosts++;
					if (compactPosts === 1) {
						return zeroByteEventStream(() => {
							cancelled = true;
						});
					}
					return new Response(JSON.stringify({ error: "compact test stop" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error(`Unexpected request: ${path} ${JSON.stringify(parseBody(init))}`);
			}),
		);

		try {
			const resultPromise = compactPiServer(model, context, {
				sessionId,
				sessionTree: { entries, leafId: "u1" },
				piServerCompactStatePath: join(compactStateDirectory, "session.pi-server-compactions.jsonl"),
				piServerRecoveryWindowMs: 1000,
			});
			const rejection = expect(resultPromise).rejects.toThrow("compact test stop");
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(51);

			await rejection;
			expect(compactPosts).toBe(2);
			expect(cancelled).toBe(true);
		} finally {
			rmSync(compactStateDirectory, { recursive: true, force: true });
		}
	});
});
