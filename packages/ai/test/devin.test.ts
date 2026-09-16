import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeDevinCatalog } from "../src/api/devin-catalog.ts";
import { mapContextToChat } from "../src/api/devin-context-map.ts";
import { streamDevin } from "../src/api/devin-stream.ts";
import { packThinkingSignature, unpackThinkingSignature } from "../src/api/devin-thinking.ts";
import {
	encodeMessage,
	encodeString,
	encodeTag,
	encodeVarintField,
	frameConnectStream,
	iterFields,
} from "../src/api/devin-wire.ts";
import { loginDevin } from "../src/auth/oauth/devin.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { devinProvider } from "../src/providers/devin.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { calculateContextTokens } from "../src/utils/estimate.ts";

const model: Model<"devin"> = {
	id: "swe-2-medium",
	name: "SWE-2 Medium",
	provider: "devin",
	api: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 262000,
	maxTokens: 128000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: "user" as const, content: "test", timestamp: 1 }] };

function trailer(error?: string, message?: string): Buffer {
	const payload = Buffer.from(JSON.stringify(error ? { error: { code: error, message } } : {}));
	const header = Buffer.alloc(5);
	header[0] = 2;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

function mockFetch(frames: Buffer[], fragment = false): typeof fetch {
	return vi.fn(async (input) => {
		if (String(input).endsWith("GetUserJwt")) return new Response(new Uint8Array(encodeString(1, "test-jwt")));
		const bytes = Buffer.concat(frames);
		return new Response(
			new ReadableStream({
				start(controller) {
					if (fragment) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
					else controller.enqueue(new Uint8Array(bytes));
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/connect+proto" } },
		);
	});
}

function usageMetric(name: string, value: number): Buffer {
	const encodedValue = Buffer.alloc(4);
	encodedValue.writeFloatLE(value);
	return encodeMessage(
		2,
		Buffer.concat([encodeString(5, name), encodeMessage(4, Buffer.concat([encodeTag(2, 5), encodedValue]))]),
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("native Devin", () => {
	it("preserves overflow diagnostics while redacting credential values", async () => {
		const result = await streamDevin(model, context, {
			apiKey: "secret-value",
			fetch: mockFetch([trailer("invalid_argument", "context length exceeded secret-value test-jwt")]),
		}).result();
		expect(result.errorMessage).toContain("context length exceeded");
		expect(result.errorMessage).not.toContain("secret-value");
		expect(result.errorMessage).not.toContain("test-jwt");
	});
	it("propagates cancellation to the credential request", async () => {
		const controller = new AbortController();
		const transport: typeof fetch = vi.fn(async (_input, init) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			throw new Error("Expected cancellation");
		});
		const result = await streamDevin(model, context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: transport,
		}).result();
		expect(result.stopReason).toBe("aborted");
	});
	it("registers OAuth without a seeded model or CLI dependency", () => {
		const provider = builtinProviders().find((value) => value.id === "devin");
		expect(provider?.auth.oauth?.isSubscription).toBe(true);
		expect(provider?.getModels()).toEqual([]);
	});
	it("decodes actual catalog limits and reasoning features", () => {
		const config = Buffer.concat([
			encodeString(1, "Unlabelled effort"),
			encodeString(22, "server-model"),
			encodeVarintField(18, 262000),
			encodeMessage(23, Buffer.concat([encodeVarintField(13, 128000), encodeMessage(6, encodeVarintField(15, 1))])),
		]);
		const [actual] = decodeDevinCatalog(encodeMessage(1, config));
		expect(actual).toMatchObject({
			id: "server-model",
			reasoning: true,
			contextWindow: 262000,
			maxTokens: 128000,
			input: ["text"],
		});
		expect(() => decodeDevinCatalog(Buffer.alloc(0))).toThrow("no usable models");
		expect(() => decodeDevinCatalog(encodeMessage(1, encodeString(22, "missing-limits")))).toThrow("incomplete");
	});
	it.each([
		Buffer.from([10, 9, 1]),
		Buffer.from([13, 1]),
		Buffer.from([9, 1]),
		Buffer.from([0]),
		Buffer.alloc(11, 128),
	])("rejects malformed protobuf %j", (bytes) => {
		expect(() => [...iterFields(bytes)]).toThrow();
	});
	it("restores persisted models and exposes refresh failures", async () => {
		const provider = devinProvider();
		await provider.refreshModels?.({
			stored: { models: [model], checkedAt: 1 },
			allowNetwork: false,
			signal: new AbortController().signal,
			publish: async (update) => {
				update.update?.();
				return true;
			},
		});
		expect(provider.getModels()).toEqual([model]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("failure", { status: 503 })),
		);
		await expect(
			provider.refreshModels?.({
				allowNetwork: true,
				credential: { type: "oauth", access: "test", refresh: "", expires: Number.MAX_SAFE_INTEGER },
				signal: new AbortController().signal,
				publish: async () => true,
			}),
		).rejects.toThrow("503");
		expect(provider.getModels()).toEqual([model]);
	});
	it("handles compressed byte-fragmented streams", async () => {
		const result = await streamDevin(model, context, {
			apiKey: "test",
			fetch: mockFetch([frameConnectStream(encodeString(3, "ok")), trailer()], true),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});
	it("includes cached prompt tokens in total context usage", async () => {
		const usage = encodeMessage(
			28,
			Buffer.concat([
				usageMetric("input_tokens", 17_111),
				usageMetric("output_tokens", 512),
				usageMetric("cache_read_input_tokens", 181_248),
				usageMetric("cache_creation_input_tokens", 3_000),
			]),
		);
		const result = await streamDevin(model, context, {
			apiKey: "test",
			fetch: mockFetch([frameConnectStream(encodeString(3, "ok")), frameConnectStream(usage), trailer()]),
		}).result();

		expect(result.usage).toMatchObject({
			input: 17_111,
			output: 512,
			cacheRead: 181_248,
			cacheWrite: 3_000,
			totalTokens: 201_871,
		});
		expect(calculateContextTokens(result.usage)).toBe(201_871);
	});
	it.each([
		["missing EOS", [frameConnectStream(encodeString(3, "partial"))]],
		["bad trailer", [trailer("resource_exhausted")]],
		["truncated", [trailer(), Buffer.from([0])]],
		["failure stop", [frameConnectStream(encodeVarintField(5, 13)), trailer()]],
		["empty", [trailer()]],
	] as const)("fails closed for %s", async (_name, frames) => {
		const result = await streamDevin(model, context, { apiKey: "test", fetch: mockFetch([...frames]) }).result();
		expect(result.stopReason).toBe("error");
	});
	it("routes interleaved tool deltas by call id", async () => {
		const tool = (id: string, args: string, name?: string) =>
			frameConnectStream(
				encodeMessage(
					6,
					Buffer.concat([encodeString(1, id), ...(name ? [encodeString(2, name)] : []), encodeString(3, args)]),
				),
			);
		const result = await streamDevin(model, context, {
			apiKey: "test",
			fetch: mockFetch([
				tool("a", '{"a":', "first"),
				tool("b", '{"b":2}', "second"),
				tool("a", "1}"),
				frameConnectStream(encodeVarintField(5, 10)),
				trailer(),
			]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "a", name: "first", arguments: { a: 1 } },
			{ type: "toolCall", id: "b", name: "second", arguments: { b: 2 } },
		]);
	});
	it("never executes incomplete tool arguments", async () => {
		const result = await streamDevin(model, context, {
			apiKey: "test",
			fetch: mockFetch([
				frameConnectStream(
					encodeMessage(6, Buffer.concat([encodeString(1, "a"), encodeString(2, "tool"), encodeString(3, "{")])),
				),
				trailer(),
			]),
		}).result();
		expect(result.stopReason).toBe("error");
	});
	it("preserves signature-only redacted thinking and tool-result images", async () => {
		const result = await streamDevin(model, context, {
			apiKey: "test",
			fetch: mockFetch([
				frameConnectStream(encodeVarintField(11, 1)),
				frameConnectStream(encodeString(10, "part1")),
				frameConnectStream(Buffer.concat([encodeString(10, "part2"), encodeString(21, "sealed")])),
				trailer(),
			]),
		}).result();
		const thinking = result.content[0];
		expect(thinking.type).toBe("thinking");
		if (thinking.type !== "thinking") throw new Error("Expected thinking");
		expect(thinking.redacted).toBe(true);
		expect(unpackThinkingSignature(thinking.thinkingSignature)).toEqual({
			signature: "part1part2",
			signatureType: "sealed",
		});
		const mapped = mapContextToChat(
			{
				messages: [
					result,
					{
						role: "toolResult",
						toolCallId: "a",
						toolName: "image",
						content: [{ type: "image", mimeType: "image/png", data: "abc" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			model.id,
		);
		expect(mapped.messages[0].thinking?.signature).toBe("part1part2");
		expect(mapped.messages[1].content).toEqual([{ type: "image", mimeType: "image/png", base64Data: "abc" }]);
		const foreign: AssistantMessage = {
			...result,
			provider: "other",
			content: [{ type: "thinking", thinking: "private", thinkingSignature: packThinkingSignature("other") }],
		};
		expect(mapContextToChat({ messages: [foreign] }, model.id).messages[0].thinking).toBeUndefined();
	});
	it("blocks direct inference in server mode before any network request", async () => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		const transport = mockFetch([]);
		const result = await streamDevin(model, context, { apiKey: "test", fetch: transport }).result();
		expect(result.errorMessage).toContain("must use pi-server");
		expect(transport).not.toHaveBeenCalled();
	});
	it("uses PKCE and rejects wrong callback state without consuming login", async () => {
		const realFetch = globalThis.fetch;
		let challenge = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
				const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
				expect(body.code).toBe("test-code");
				expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
				return Response.json({ token: "test-session" });
			}),
		);
		let callbackTask: Promise<void> | undefined;
		const credential = await loginDevin({
			signal: new AbortController().signal,
			prompt: async () => {
				throw new Error("Unexpected prompt");
			},
			notify(event) {
				if (event.type !== "auth_url") return;
				const auth = new URL(event.url);
				challenge = auth.searchParams.get("code_challenge") ?? "";
				const callback = new URL(auth.searchParams.get("redirect_uri") ?? "");
				callback.searchParams.set("code", "test-code");
				callback.searchParams.set("state", "wrong");
				callbackTask = (async () => {
					expect((await realFetch(callback)).status).toBe(400);
					callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
					expect((await realFetch(callback)).status).toBe(200);
				})();
			},
		});
		await callbackTask;
		expect(credential).toMatchObject({ type: "oauth", access: "test-session", refresh: "" });
	});
	it("cancels OAuth before opening a callback listener", async () => {
		await expect(loginDevin({ signal: AbortSignal.abort(), prompt: vi.fn(), notify: vi.fn() })).rejects.toThrow();
	});
});
