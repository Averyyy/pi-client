import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { encodeErrorEvent, encodeProxyEvent, parseProxyEvent } from "../src/event-encoding.ts";

describe("event-encoding", () => {
	it("encodes and parses a start event", () => {
		const event: ProxyAssistantMessageEvent = { type: "start" };
		const encoded = encodeProxyEvent(event);
		expect(encoded).toMatch(/^data: /);
		expect(encoded).toMatch(/\n\n$/);

		const parsed = parseProxyEvent(encoded.trim());
		expect(parsed).toEqual(event);
	});

	it("encodes and parses a text_delta event", () => {
		const event: ProxyAssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "hello" };
		const encoded = encodeProxyEvent(event);
		const parsed = parseProxyEvent(encoded.trim());
		expect(parsed).toEqual(event);
	});

	it("encodes and parses a done event", () => {
		const event: ProxyAssistantMessageEvent = {
			type: "done",
			reason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const encoded = encodeProxyEvent(event);
		const parsed = parseProxyEvent(encoded.trim());
		expect(parsed).toEqual(event);
	});

	it("encodes an error event string", () => {
		const encoded = encodeErrorEvent("test error");
		expect(encoded).toContain("test error");
		expect(encoded).toContain("error");
	});

	it("returns undefined for non-data lines", () => {
		expect(parseProxyEvent("not a data line")).toBeUndefined();
	});

	it("returns undefined for empty data", () => {
		expect(parseProxyEvent("data: ")).toBeUndefined();
	});
});
