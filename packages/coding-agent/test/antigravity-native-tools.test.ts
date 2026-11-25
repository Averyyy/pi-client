import { describe, expect, it } from "vitest";
import { AntigravityNativeTools } from "../src/core/antigravity-native-tools.ts";

describe("AntigravityNativeTools", () => {
	it("follows a tool call through partial ACP updates and ends with its result", () => {
		const tools = new AntigravityNativeTools();
		expect(
			tools.apply({
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Edit notes",
				kind: "edit",
				status: "pending",
				rawInput: { path: "/w/notes.txt" },
			}),
		).toEqual({
			type: "start",
			toolCall: { type: "toolCall", id: "call-1", name: "agy_edit", arguments: { path: "/w/notes.txt" } },
		});
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "in_progress",
				content: [{ type: "diff", path: "/w/notes.txt" }],
			}),
		).toMatchObject({ type: "update", content: [{ type: "text", text: "Changed /w/notes.txt" }] });
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "failed",
				rawOutput: "denied",
			}),
		).toEqual({
			type: "end",
			started: true,
			outcome: {
				toolCall: { type: "toolCall", id: "call-1", name: "agy_edit", arguments: { path: "/w/notes.txt" } },
				result: { content: [{ type: "text", text: "Changed /w/notes.txt" }], details: { rawOutput: "denied" } },
				isError: true,
			},
		});
	});

	it("names tools for every provider and reports calls that finish in their first update", () => {
		const tools = new AntigravityNativeTools();
		expect(
			tools.apply({
				sessionUpdate: "tool_call",
				toolCallId: "call-2",
				name: "web.search query",
				title: "Search the web",
				status: "completed",
				rawOutput: { hits: 3 },
			}),
		).toEqual({
			type: "end",
			started: false,
			outcome: {
				toolCall: {
					type: "toolCall",
					id: "call-2",
					name: "agy_web_search_query",
					arguments: { title: "Search the web" },
				},
				result: { content: [{ type: "text", text: '{"hits":3}' }], details: { rawOutput: { hits: 3 } } },
				isError: false,
			},
		});
	});

	it("gives every call agy left open a result when its turn ends", () => {
		const tools = new AntigravityNativeTools();
		tools.apply({ sessionUpdate: "tool_call", toolCallId: "call-3", kind: "execute", status: "in_progress" });
		expect(tools.finish("Turn ended")).toEqual([
			{
				toolCall: { type: "toolCall", id: "call-3", name: "agy_execute", arguments: {} },
				result: { content: [{ type: "text", text: "Turn ended" }], details: {} },
				isError: true,
			},
		]);
		expect(tools.finish("Turn ended")).toEqual([]);
	});
});
