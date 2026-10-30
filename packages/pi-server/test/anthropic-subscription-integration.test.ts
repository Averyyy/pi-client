import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lazyStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../../coding-agent/src/core/cache-warmer.ts";
import { resetAllSessionTracking, streamPiServer } from "../../coding-agent/src/core/pi-server-client.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions } from "../src/session-store.ts";

interface Payload {
	system: Array<{ type: string; text: string; cache_control?: unknown }>;
	messages: Array<{ role: string; content: unknown }>;
	max_tokens: number;
}

const prompt = "Reply with the word ok.";
const oauth = "sk-ant-oat01-fixture-access";
const headers = { "Content-Type": "application/json", Authorization: "Bearer fixture-token" };

describe("Anthropic subscription wire requests", () => {
	let directory: string;
	let upstream: Server;
	let server: Server;
	let baseUrl: string;
	let model: Model<"anthropic-messages">;
	let calls: Array<{ headers: Record<string, string | string[] | undefined>; body: Payload }>;

	async function listen(listener: Server): Promise<string> {
		listener.listen(0, "127.0.0.1");
		await once(listener, "listening");
		const address = listener.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture listener");
		return `http://127.0.0.1:${address.port}`;
	}

	beforeEach(async () => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-anthropic-subscription-"));
		calls = [];
		upstream = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Payload });
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: "msg_fixture",
						type: "message",
						role: "assistant",
						model: "claude-haiku-4-5",
						content: [],
						stop_reason: null,
						usage: { input_tokens: 20, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
		model = {
			id: "claude-haiku-4-5",
			name: "Haiku fixture",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: await listen(upstream),
			reasoning: false,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 1024,
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		};
		server = createPiServer({
			authToken: "fixture-token",
			sessionStoreDir: directory,
			accountStoreDir: join(directory, "accounts"),
		});
		baseUrl = await listen(server);
	});

	afterEach(async () => {
		for (const listener of [server, upstream]) {
			listener.closeAllConnections();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
		}
		clearAllSessions();
		resetAllSessionTracking();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	async function stream(requestKind: "api" | "simple", apiKey = oauth, extra: Record<string, unknown> = {}) {
		const response = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: `stream-${calls.length}`,
				requestKind,
				model,
				staticContext: { systemPrompt: "Custom project policy: preserve this exact sentence.", tools: [] },
				contextOverlay: [{ role: "user", content: prompt, timestamp: 1 }],
				options: { apiKey, maxTokens: 32, ...extra },
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"type":"done"');
		return calls[calls.length - 1];
	}

	it.each(["api", "simple"] as const)("shapes the builtin %s request after SDK serialization", async (kind) => {
		const captured = await stream(kind);
		expect(captured.headers.authorization).toBe(`Bearer ${oauth}`);
		expect(captured.headers["x-api-key"]).toBeUndefined();
		const version = String(captured.headers["user-agent"]).match(/^claude-cli\/(\d+\.\d+\.\d+)/)?.[1];
		expect(version).toBeTruthy();
		expect(captured.body.system[0].text).toMatch(
			new RegExp(
				`^x-anthropic-billing-header: cc_version=${version}\\.[a-f0-9]{3}; cc_entrypoint=sdk-cli; cch=[a-f0-9]{5};$`,
			),
		);
		expect(captured.body.system[0]).not.toHaveProperty("cache_control");
		expect(captured.body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(captured.body.system[2].text).toBe("Custom project policy: preserve this exact sentence.");
	});

	it("leaves API key authentication and its system prompt unchanged", async () => {
		const captured = await stream("simple", "sk-ant-api03-fixture");
		expect(captured.headers["x-api-key"]).toBe("sk-ant-api03-fixture");
		expect(captured.body.system).toHaveLength(1);
		expect(captured.body.system[0].text).toBe("Custom project policy: preserve this exact sentence.");
	});

	it.each([
		{ name: "textless first user", content: [], extraHeaders: {}, reason: "requires text in first user message" },
		{
			name: "unknown CLI User-Agent",
			content: prompt,
			extraHeaders: { "user-agent": "unknown-client" },
			reason: "requires a claude-cli/X.Y.Z User-Agent",
		},
	])("reports $name before sending to upstream", async ({ content, extraHeaders, reason }) => {
		const response = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "rejected-request",
				requestKind: "api",
				model,
				staticContext: { systemPrompt: "Project policy" },
				contextOverlay: [{ role: "user", content, timestamp: 1 }],
				options: { apiKey: oauth, headers: extraHeaders },
			}),
		});
		const events = await response.text();
		expect(calls).toHaveLength(0);
		expect(events).toContain(reason);
	});

	it("shapes a cache warm replay with the original subscription prompt prefix", async () => {
		vi.stubEnv("PI_SERVER_URL", baseUrl);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-token");
		const context = {
			systemPrompt: "Cache warming project policy",
			messages: [{ role: "user" as const, content: prompt, timestamp: 1 }],
		};
		const options = { apiKey: oauth, maxTokens: 32, cacheRetention: "short" as const };
		const runtime = {
			streamSimple: (requestModel: Model<string>, requestContext: typeof context, requestOptions?: typeof options) =>
				lazyStream(requestModel, () => streamPiServer(requestModel, requestContext, requestOptions)),
		};
		const result = await runtime.streamSimple(model, context, options).result();
		expect(result.stopReason).toBe("stop");
		const manager = SessionManager.inMemory();
		manager.appendMessage(result);
		const warmer = new CacheWarmer(
			runtime,
			manager,
			() => "streaming",
			async () => "warm",
		);
		warmer.start({ model: { ...model, promptCache: { short: 60 } }, context, options }, () => true);
		const internal = warmer as unknown as {
			run: { timer?: ReturnType<typeof setTimeout> };
			refresh(run: object): Promise<void>;
		};
		clearTimeout(internal.run.timer);
		try {
			await internal.refresh(internal.run);
			expect(manager.getBranch().filter((entry) => entry.type === "usage")).toHaveLength(1);
		} finally {
			warmer.cancel();
		}
		expect(calls).toHaveLength(2);
		const [real, warm] = calls;
		expect(warm.body.max_tokens).toBe(1);
		expect(warm.headers.authorization).toBe(real.headers.authorization);
		expect(warm.body.system).toEqual(real.body.system);
		expect(warm.body.messages).toEqual(real.body.messages);
	});

	it("shapes the callback replacement before the SDK sends it", async () => {
		const response = await fetch(`${baseUrl}/api/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "callback",
				runId: "callback-run",
				requestKind: "api",
				model,
				staticContext: { systemPrompt: "Original system" },
				contextOverlay: [{ role: "user", content: prompt, timestamp: 1 }],
				options: { apiKey: oauth },
				callbacks: { onPayload: true },
			}),
		});
		const reader = response.body!.getReader();
		let text = "";
		let replied = false;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
			if (!replied) {
				const callbackLine = text
					.split("\n")
					.find((line) => line.startsWith("data: ") && line.includes('"kind":"payload"'));
				if (!callbackLine) continue;
				const callback = JSON.parse(callbackLine.slice(6)) as { callbackId: string; payload: Payload };
				expect(callback.payload.system[0].text).not.toContain("x-anthropic-billing-header:");
				callback.payload.system.push({ type: "text", text: "Callback custom policy" });
				callback.payload.messages = [{ role: "user", content: "Callback input" }];
				const reply = await fetch(`${baseUrl}/api/provider-callback`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						sessionId: "callback",
						runId: "callback-run",
						callbackId: callback.callbackId,
						result: callback.payload,
					}),
				});
				expect(reply.status).toBe(200);
				replied = true;
			}
		}
		expect(replied).toBe(true);
		expect(text).toContain('"type":"done"');
		expect(calls[0].body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
		expect(calls[0].body.system.at(-1)?.text).toBe("Callback custom policy");
		expect(calls[0].body.messages).toEqual([{ role: "user", content: "Callback input" }]);
	});

	it("runs the compaction summarizer through the subscription adapter", async () => {
		const entries = ["old message", "retained message"].map((content, index) => ({
			type: "message",
			id: `u${index}`,
			parentId: index === 0 ? null : "u0",
			timestamp: new Date(index * 1000).toISOString(),
			message: { role: "user", content, timestamp: index * 1000 },
		}));
		const sync = await fetch(`${baseUrl}/api/session/tree/sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId: "compact", entries, leafId: "u1" }),
		});
		expect(sync.status).toBe(200);
		const response = await fetch(`${baseUrl}/api/session/compact`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sessionId: "compact",
				model,
				options: { apiKey: oauth },
				settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 0 },
				preparation: { firstKeptEntryId: "u1" },
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"summary":"ok"');
		expect(calls).toHaveLength(1);
		expect(calls[0].headers.authorization).toBe(`Bearer ${oauth}`);
		expect(calls[0].body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
	});
});
