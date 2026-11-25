import { describe, expect, it } from "vitest";
import { AntigravityNativeTools } from "../src/core/antigravity-native-tools.ts";

describe("AntigravityNativeTools", () => {
	it("records a read of one location as Pi's read, relative to the workspace", () => {
		const tools = new AntigravityNativeTools("/w");
		expect(
			tools.apply({
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Read notes",
				kind: "read",
				status: "pending",
				locations: [{ path: "/w/docs/notes.txt", line: 5 }],
			}),
		).toEqual({
			display: {
				type: "start",
				toolCall: {
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "docs/notes.txt", offset: 5 },
				},
			},
		});
		const toolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "docs/notes.txt", offset: 5 },
		};
		const result = { content: [{ type: "text", text: "line five" }], details: {} };
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "line five" } }],
			}),
		).toEqual({
			display: { type: "end", toolCall, started: true, result, isError: false },
			record: { type: "tool", outcome: { toolCall, result, isError: false } },
		});
	});

	it("records one diff as Pi's edit, or as write for a new file, and keeps paths outside the workspace", () => {
		const tools = new AntigravityNativeTools("/w");
		tools.apply({ sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "pending" });
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "edit",
				status: "in_progress",
				content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }],
			}),
		).toMatchObject({
			display: {
				type: "update",
				toolCall: { name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } },
				content: [{ type: "text", text: "Changed a.ts" }],
			},
		});
		expect(
			tools.apply({
				sessionUpdate: "tool_call",
				toolCallId: "write",
				kind: "edit",
				status: "completed",
				content: [{ type: "diff", path: "/tmp/new.ts", newText: "x" }],
			}),
		).toMatchObject({
			display: { type: "end", started: false },
			record: {
				type: "tool",
				outcome: { toolCall: { name: "write", arguments: { path: "/tmp/new.ts", content: "x" } }, isError: false },
			},
		});
	});

	it("records a command Pi ran in its terminal as Pi's bash, with its output and exit code", () => {
		const tools = new AntigravityNativeTools("/w");
		tools.apply({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run tests", kind: "execute" });
		tools.observe("terminal/create", { command: "npm", args: ["test", "a b"], cwd: "/w/pkg" }, { terminalId: "t1" });
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "run",
				status: "in_progress",
				content: [{ type: "terminal", terminalId: "t1" }],
			}),
		).toMatchObject({
			display: { type: "update", toolCall: { name: "bash", arguments: { command: "cd pkg && npm test 'a b'" } } },
		});
		tools.observe("terminal/wait_for_exit", { terminalId: "t1" }, { exitCode: 1, signal: null });
		tools.observe("terminal/output", { terminalId: "t1" }, { output: "1 failed", truncated: false });
		expect(tools.apply({ sessionUpdate: "tool_call_update", toolCallId: "run", status: "failed" })).toMatchObject({
			record: {
				type: "tool",
				outcome: {
					toolCall: { name: "bash", arguments: { command: "cd pkg && npm test 'a b'" } },
					result: { content: [{ type: "text", text: "1 failed\n\nCommand exited with code 1" }] },
					isError: true,
				},
			},
		});
	});

	it("records calls ACP does not describe exactly as notes, so no model sees an agy tool", () => {
		const tools = new AntigravityNativeTools("/w");
		expect(
			tools.apply({ sessionUpdate: "tool_call", toolCallId: "s", title: "Search for foo", kind: "search" }),
		).toEqual({
			display: {
				type: "start",
				toolCall: { type: "toolCall", id: "s", name: "agy_search", arguments: { title: "Search for foo" } },
			},
		});
		expect(
			tools.apply({
				sessionUpdate: "tool_call_update",
				toolCallId: "s",
				status: "completed",
				rawOutput: { hits: 3 },
			}),
		).toMatchObject({
			display: { type: "end", toolCall: { name: "agy_search" } },
			record: { type: "note", text: '[Antigravity ran: Search for foo]\n{"hits":3}' },
		});
		// A command agy ran without Pi's terminal names no command Pi can record.
		expect(
			tools.apply({
				sessionUpdate: "tool_call",
				toolCallId: "x",
				title: "Run build",
				kind: "execute",
				status: "failed",
			}),
		).toMatchObject({ record: { type: "note", text: "[Antigravity failed: Run build]" } });
	});

	it("gives every call agy left open a result when its turn ends", () => {
		const tools = new AntigravityNativeTools("/w");
		tools.apply({ sessionUpdate: "tool_call", toolCallId: "r", kind: "read", locations: [{ path: "/w/a" }] });
		tools.apply({ sessionUpdate: "tool_call", toolCallId: "f", title: "Fetch docs", kind: "fetch" });
		const reason = [{ type: "text", text: "Turn ended" }];
		expect(tools.finish("Turn ended")).toEqual([
			{
				display: {
					type: "end",
					toolCall: { type: "toolCall", id: "r", name: "read", arguments: { path: "a" } },
					started: true,
					result: { content: reason, details: {} },
					isError: true,
				},
				record: {
					type: "tool",
					outcome: {
						toolCall: { type: "toolCall", id: "r", name: "read", arguments: { path: "a" } },
						result: { content: reason, details: {} },
						isError: true,
					},
				},
			},
			expect.objectContaining({ record: { type: "note", text: "[Antigravity failed: Fetch docs]\nTurn ended" } }),
		]);
		expect(tools.finish("Turn ended")).toEqual([]);
	});
});
