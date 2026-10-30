import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelPiServerOperations,
	resetAllSessionTracking,
	streamPiServer,
	syncPiServerTree,
} from "../src/core/pi-server-client.ts";
import { createHarness } from "./suite/harness.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};
const context: Context = { systemPrompt: "test", messages: [] };

describe("pi-server client resource lifecycle", () => {
	beforeEach(() => resetAllSessionTracking());
	afterEach(() => {
		vi.unstubAllGlobals();
		resetAllSessionTracking();
	});

	it("releases static and tree tracking when the owning session is disposed", async () => {
		const harness = await createHarness();
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				paths.push(new URL(url).pathname);
				return Response.json({});
			}),
		);
		try {
			const sessionId = harness.session.sessionId;
			const tree = { entries: [], leafId: null };
			await syncPiServerTree(sessionId, context, tree);
			paths.length = 0;
			await syncPiServerTree(sessionId, context, tree);
			expect(paths).toEqual([]);
			harness.session.dispose();
			await syncPiServerTree(sessionId, context, tree);
			expect(paths).toEqual(["/api/session/init", "/api/session/tree/sync"]);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["success", "http-error", "recovered", "recovery-error", "aborted", "cancel-error"] as const)(
		"releases ephemeral tracking after %s while preserving unconfirmed cancellation",
		async (outcome) => {
			const controller = new AbortController();
			let sessionId = "";
			let initCount = 0;
			let streamCount = 0;
			let abortCount = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					const path = new URL(url).pathname;
					const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
						sessionId?: string;
						runId?: string;
					};
					if (path === "/api/session/init") {
						sessionId = body.sessionId!;
						initCount++;
						return Response.json({ sessionId });
					}
					if (path.endsWith("/abort")) {
						abortCount++;
						if (outcome === "cancel-error" && abortCount === 1)
							return Response.json({ error: "cancellation unavailable" }, { status: 503 });
						return Response.json({ ...body, status: "aborted" });
					}
					if (path.includes("/runs/")) {
						if (outcome === "recovery-error") throw new Error("recovery unavailable");
						return Response.json({ status: "completed", message });
					}
					if (path === "/api/stream") {
						streamCount++;
						if (streamCount === 1) {
							if (outcome === "http-error") return Response.json({ error: "rejected" }, { status: 400 });
							if (outcome === "aborted" || outcome === "cancel-error") controller.abort();
							if (outcome !== "success")
								return new Response("", { headers: { "Content-Type": "text/event-stream" } });
						}
						return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\n`, {
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					throw new Error(`Unexpected request ${path}`);
				}),
			);
			const stream = await streamPiServer(model, context, { signal: controller.signal });
			for await (const _event of stream) {
				// Wait for terminal delivery and request cleanup.
			}
			expect((await stream.result()).stopReason).toBe(
				outcome === "success" || outcome === "recovered"
					? "stop"
					: outcome === "aborted" || outcome === "cancel-error"
						? "aborted"
						: "error",
			);
			if (outcome === "cancel-error") {
				cleanupSessionResources(sessionId);
				expect(abortCount).toBe(1);
				await cancelPiServerOperations(sessionId);
				expect(abortCount).toBe(2);
			}
			const next = await streamPiServer(model, context, { sessionId });
			for await (const _event of next) {
				// Drain the request using the previous ephemeral session identity.
			}
			expect(initCount).toBe(2);
		},
	);
});
