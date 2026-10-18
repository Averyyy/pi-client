import type { ClassifierModel, ImageModel, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyPiServer,
	compactPiServer,
	generateImagesPiServer,
	resetAllSessionTracking,
} from "../src/core/pi-server-client.ts";

const baseModel = {
	id: "terminal-error",
	name: "Terminal Error",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	input: ["text"] as "text"[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const chatModel: Model<string> = {
	...baseModel,
	api: "fixture-chat",
	reasoning: false,
	contextWindow: 10000,
	maxTokens: 1000,
};
const imageModel: ImageModel<string> = {
	...baseModel,
	type: "image",
	api: "fixture-image",
	output: ["image"],
};
const classifierModel: ClassifierModel<string> = {
	...baseModel,
	type: "classifier",
	api: "fixture-classifier",
	contextWindow: 10000,
};

describe("pi-server terminal event errors", () => {
	beforeEach(() => resetAllSessionTracking());
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		{
			operation: "compaction",
			endpoint: "/api/session/compact",
			call: () => compactPiServer(chatModel, { messages: [] }),
		},
		{
			operation: "image generation",
			endpoint: "/api/generate-images",
			call: () => generateImagesPiServer(imageModel, { input: [{ type: "text", text: "draw" }] }),
		},
		{
			operation: "classification",
			endpoint: "/api/classify",
			call: () => classifyPiServer(classifierModel, { state: {}, questions: {} }),
		},
	])("surfaces $operation failure without querying run recovery", async ({ endpoint, call }) => {
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const path = new URL(url).pathname;
				paths.push(path);
				if (path === endpoint) {
					return new Response('event: error\ndata: {"error":"insufficient_quota: fixture exhausted"}\n\n', {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				if (path === "/api/session/init" || path === "/api/session/tree/sync") {
					return Response.json({});
				}
				throw new Error("run recovery unavailable");
			}),
		);

		await expect(call()).rejects.toThrow("insufficient_quota: fixture exhausted");
		expect(paths.filter((path) => path.includes("/runs/"))).toEqual([]);
		expect(paths.filter((path) => path === endpoint)).toHaveLength(1);
	});
});
