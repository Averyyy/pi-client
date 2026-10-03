import { createServer, type Server } from "node:http";
import type { AssistantMessage, CacheRetention, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllSessionTracking, streamPiServer } from "../src/core/pi-server-client.ts";

const model: Model<"cache-policy-fixture"> = {
	id: "fixture",
	name: "Fixture",
	api: "cache-policy-fixture",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const done = `data: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\n`;
const policy = (cacheRetention: unknown) => `event: cache_policy\ndata: ${JSON.stringify({ cacheRetention })}\n\n`;

describe("pi-server cache-policy protocol over guarded HTTP", () => {
	let server: Server;
	let streamBody: string;
	let recoveryPolicy: unknown;
	let disconnect: boolean;
	let aborts: number;
	let recoveries: number;
	let requestBytes: number[];

	beforeEach(async () => {
		resetAllSessionTracking();
		streamBody = policy("long") + done;
		recoveryPolicy = "long";
		disconnect = false;
		aborts = 0;
		recoveries = 0;
		requestBytes = [];
		server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const bytes = Buffer.concat(chunks);
			requestBytes.push(bytes.length);
			if (bytes.length > 65536) {
				res.writeHead(413);
				res.end();
				return;
			}
			if (req.headers.authorization !== "Bearer protocol-token") {
				res.writeHead(401);
				res.end();
				return;
			}
			if (req.url === "/api/stream") {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (disconnect) {
					res.write(": opened\n\n");
					setImmediate(() => res.destroy());
				} else res.end(streamBody);
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.url?.endsWith("/abort")) {
				aborts++;
				res.end(JSON.stringify({ ...JSON.parse(bytes.toString()), status: "aborted" }));
			} else if (req.url?.includes("/runs/")) {
				recoveries++;
				res.end(
					JSON.stringify({
						runId: req.url.split("/").at(-1),
						status: "completed",
						message,
						cacheRetention: recoveryPolicy,
					}),
				);
			} else {
				res.end(JSON.stringify({ sessionId: "policy-session", staticContextHash: "fixture", messageCount: 0 }));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener address");
		vi.stubEnv("PI_SERVER_URL", `http://127.0.0.1:${address.port}`);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "protocol-token");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
	});

	afterEach(async () => {
		expect(requestBytes.every((bytes) => bytes <= 65536)).toBe(true);
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		resetAllSessionTracking();
		vi.unstubAllEnvs();
	});

	it.each(["none", "short", "long"] as CacheRetention[])(
		"awaits %s policy once before assistant delivery",
		async (retention) => {
			streamBody = policy(retention) + policy(retention) + done;
			const stages: string[] = [];
			const stream = await streamPiServer(
				model,
				{ messages: [] },
				{
					sessionId: "policy-session",
					requireCacheRetention: true,
					onCacheRetentionResolved: async (resolved) => {
						stages.push(resolved);
						await new Promise<void>((resolve) => setImmediate(resolve));
						stages.push("observed");
					},
				},
			);
			for await (const event of stream) stages.push(event.type);
			expect(stages).toEqual([retention, "observed", "done"]);
			expect(aborts).toBe(0);
		},
	);

	it.each([
		["missing", done],
		["invalid", policy("unexpected") + done],
		["conflicting", policy("long") + policy("short") + done],
		["malformed", `event: cache_policy\ndata: {\n\n${done}`],
	])("rejects %s policy without retry and awaits cancellation", async (_name, body) => {
		streamBody = body;
		const stream = await streamPiServer(
			model,
			{ messages: [] },
			{ sessionId: "policy-session", requireCacheRetention: true },
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/cache policy/);
		expect(result.diagnostics?.at(-1)?.details).toMatchObject({ retryable: false });
		expect(aborts).toBe(1);
		expect(recoveries).toBe(0);
	});

	it("reports observer exceptions and awaits remote cancellation", async () => {
		const stream = await streamPiServer(
			model,
			{ messages: [] },
			{
				sessionId: "policy-session",
				onCacheRetentionResolved: () => {
					throw new Error("policy observer failed");
				},
			},
		);
		expect((await stream.result()).errorMessage).toBe("policy observer failed");
		expect(aborts).toBe(1);
		expect(recoveries).toBe(0);
	});

	it("permits low-level streams without a policy requirement", async () => {
		streamBody = done;
		const stream = await streamPiServer(model, { messages: [] });
		expect((await stream.result()).stopReason).toBe("stop");
	});

	it.each(["long", undefined])("checks recovered policy %s before terminal delivery", async (retention) => {
		disconnect = true;
		recoveryPolicy = retention;
		const resolved: CacheRetention[] = [];
		const stream = await streamPiServer(
			model,
			{ messages: [] },
			{
				sessionId: "policy-session",
				requireCacheRetention: true,
				onCacheRetentionResolved: (value) => {
					resolved.push(value);
				},
			},
		);
		const result = await stream.result();
		expect(recoveries).toBe(1);
		if (retention) {
			expect(result.stopReason).toBe("stop");
			expect(resolved).toEqual([retention]);
		} else {
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/cache policy/);
			expect(aborts).toBe(1);
		}
	});
});
