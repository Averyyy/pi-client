import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { resetAllSessionTracking, streamPiServer } from "../src/core/pi-server-client.ts";
import { ChunkRequest } from "../src/core/pi-server-request.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	return `http://127.0.0.1:${address.port}`;
}

it("reports opt-in timing after nonempty provider content over direct and chunked HTTP", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-latency-"));
	const previousLimit = process.env.PI_CLIENT_MAX_REQUEST_KB;
	process.env.PI_CLIENT_MAX_REQUEST_KB = "64";
	let providerFirstSse = 0;
	let providerRoles: string[] = [];
	let mode: "content" | "empty" | "error" = "content";
	const provider = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string }[] };
		providerRoles = body.messages.map((message) => message.role);
		if (mode === "error") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: { message: "insufficient_quota", type: "insufficient_quota", code: "insufficient_quota" },
				}),
			);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.flushHeaders();
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		providerFirstSse = performance.now();
		res.write(
			`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		if (mode === "content")
			res.write(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
			);
		res.write(
			`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 80 } } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	const providerUrl = await listen(provider);
	const server = createPiServer({ authToken: "fixture-token", sessionStoreDir: dir });
	const serverUrl = await listen(server);
	let posts: { path: string; bytes: number }[] = [];
	const guard = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		posts.push({ path: req.url ?? "/", bytes: body.length });
		if (body.length > 65_536) {
			res.writeHead(413);
			res.end();
			return;
		}
		const reply = await fetch(`${serverUrl}${req.url}`, {
			method: req.method,
			headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
			body,
		});
		res.writeHead(reply.status, { "Content-Type": reply.headers.get("content-type") ?? "application/json" });
		res.flushHeaders();
		if (reply.body) for await (const chunk of reply.body) res.write(chunk);
		res.end();
	});
	const guardUrl = await listen(guard);
	const request = new ChunkRequest({ serverUrl: guardUrl, authToken: "fixture-token" });
	const model: Model<"openai-completions"> = {
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: `${providerUrl}/v1`,
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
	};
	try {
		for (const observeTiming of [false, true])
			for (const size of [32, 100_000])
				for (const kind of ["message", "tool-result"]) {
					posts = [];
					const messages: Message[] = [{ role: "user", content: "你".repeat(size), timestamp: 1 }];
					if (kind === "tool-result")
						messages.push(
							{
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: [{ type: "toolCall", id: "call_fixture", name: "read", arguments: {} }],
								stopReason: "toolUse",
								timestamp: 2,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							},
							{
								role: "toolResult",
								toolCallId: "call_fixture",
								toolName: "read",
								content: [{ type: "text", text: "你".repeat(size) }],
								isError: false,
								timestamp: 3,
							},
						);
					const response = await request.postJson("/api/stream", {
						sessionId: `latency-${observeTiming}-${size}-${kind}`,
						runId: "run",
						model,
						observeTiming,
						staticContext: {
							systemPrompt: "fixture",
							tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
						},
						contextOverlay: messages,
						options: { apiKey: "fixture-key" },
					});
					expect(response.status).toBe(200);
					let firstSse = 0;
					let firstContent = 0;
					let accumulated = "";
					if (!response.body) throw new Error("Missing response body");
					for await (const chunk of response.body) {
						if (!firstSse) firstSse = performance.now();
						accumulated += new TextDecoder().decode(chunk);
						if (!firstContent && accumulated.includes('"type":"text_delta"')) firstContent = performance.now();
					}
					expect(accumulated).toContain('"type":"done"');
					expect(firstContent).toBeGreaterThan(firstSse);
					expect(posts.every((post) => post.bytes <= 65_536)).toBe(true);
					expect(providerRoles.at(-1)).toBe(kind === "message" ? "user" : "tool");
					const timingFrames = accumulated.split("\n\n").filter((frame) => frame.includes("event: timing"));
					expect(timingFrames).toHaveLength(observeTiming ? 1 : 0);
					if (observeTiming) {
						const data = timingFrames[0].split("\n").find((line) => line.startsWith("data: "));
						if (!data) throw new Error("Missing timing data");
						const timing = JSON.parse(data.slice(6)) as {
							bodyReadyMs: number;
							providerDispatchMs: number;
							upstreamRequestMs: number;
							upstreamHeadersMs: number;
							firstContentMs: number;
						};
						expect(timing.bodyReadyMs).toBeGreaterThanOrEqual(0);
						expect(timing.providerDispatchMs).toBeGreaterThanOrEqual(timing.bodyReadyMs);
						expect(timing.upstreamRequestMs).toBeGreaterThanOrEqual(timing.providerDispatchMs);
						expect(timing.upstreamHeadersMs).toBeGreaterThanOrEqual(timing.upstreamRequestMs);
						expect(timing.firstContentMs - timing.upstreamHeadersMs).toBeGreaterThanOrEqual(40);
						expect(firstContent - providerFirstSse).toBeGreaterThanOrEqual(40);
					}
				}
		vi.stubEnv("PI_SERVER_URL", guardUrl);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-token");
		vi.stubEnv("PI_TIMING", "1");
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		const stages: string[] = [];
		const stream = await streamPiServer(
			model,
			{ systemPrompt: "fixture", messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
			{
				sessionId: "callbacks",
				apiKey: "fixture-key",
				onPayload: (payload) => {
					stages.push("payload");
					return payload;
				},
				onResponse: () => {
					stages.push("response");
				},
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(stages).toEqual(["payload", "response"]);
		const logs = diagnostic.mock.calls.filter(([value]) => String(value).startsWith("[pi-server timing] "));
		expect(logs).toHaveLength(1);
		const timing = JSON.parse(String(logs[0][0]).slice("[pi-server timing] ".length)) as {
			firstContentMs: number;
			server: { firstContentMs: number; upstreamHeadersMs: number };
		};
		expect(timing.server.firstContentMs - timing.server.upstreamHeadersMs).toBeGreaterThanOrEqual(40);
		expect(timing.firstContentMs).toBeGreaterThanOrEqual(timing.server.firstContentMs);
		expect(result.diagnostics?.find((entry) => entry.type === "pi_server_timing")?.details).toMatchObject({
			server: timing.server,
		});
		for (const terminalMode of ["empty", "error"] as const) {
			mode = terminalMode;
			diagnostic.mockClear();
			const terminal = await streamPiServer(
				model,
				{ systemPrompt: "fixture", messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
				{ sessionId: terminalMode, apiKey: "fixture-key" },
			);
			const message = await terminal.result();
			expect(message.stopReason).toBe(terminalMode === "empty" ? "stop" : "error");
			const details = message.diagnostics?.find((entry) => entry.type === "pi_server_timing")?.details;
			expect(details).toMatchObject({
				server: { bodyReadyMs: expect.any(Number), providerDispatchMs: expect.any(Number) },
			});
			expect(details).not.toHaveProperty("firstContentMs");
			expect(details?.server).not.toHaveProperty("firstContentMs");
			expect(
				diagnostic.mock.calls.filter(([value]) => String(value).startsWith("[pi-server timing] ")),
			).toHaveLength(1);
		}
	} finally {
		for (const item of [guard, server, provider]) {
			item.closeAllConnections();
			await new Promise<void>((resolve) => item.close(() => resolve()));
		}
		rmSync(dir, { recursive: true, force: true });
		if (previousLimit === undefined) delete process.env.PI_CLIENT_MAX_REQUEST_KB;
		else process.env.PI_CLIENT_MAX_REQUEST_KB = previousLimit;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetAllSessionTracking();
	}
});
