import { afterEach, describe, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-4-argon-contributor",
	name: "Gemini 4 Argon Contributor",
	api: "google-generative-ai",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenCode Go Google API", () => {
	it.each(["stream", "streamSimple"] as const)(
		"dispatches %s through the Google adapter with Go routing and auth",
		async (method) => {
			const requests: Request[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (input, init) => {
					requests.push(new Request(input, init));
					const chunk = {
						candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
					};
					return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}),
			);

			const result = await opencodeGoProvider()
				[method](model, context, {
					apiKey: "test-opencode-key",
					sessionId: "conversation-1",
					cacheRetention: "none",
				})
				.result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(requests).toHaveLength(1);
			const request = requests[0];
			expect(request?.url).toBe(
				"https://opencode.ai/zen/go/v1/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse",
			);
			expect(request?.method).toBe("POST");
			expect(request?.headers.get("x-goog-api-key")).toBe("test-opencode-key");
			expect(request?.headers.get("x-opencode-session")).toBe("conversation-1");
		},
	);
});
