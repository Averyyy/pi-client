import { describe, expect, it } from "vitest";
import type { ViewerMessage } from "../src/viewer-types.ts";
import { appendMessages, isFinal, mergeRecentRounds, partitionRound } from "./rounds.ts";

function message(
	id: string,
	role: string,
	content: ViewerMessage["content"],
	fields: Partial<ViewerMessage> = {},
): ViewerMessage {
	return { id, role, content, timestamp: 0, ...fields };
}

describe("conversation round projection", () => {
	it("keeps commentary and tool calls in the process until a terminal answer exists", () => {
		const user = message("user", "user", "检查服务");
		const commentary = message("comment", "assistant", "正在检查", { phase: "commentary", stopReason: "stop" });
		const tool = message(
			"tool",
			"assistant",
			[{ type: "toolCall", id: "call", name: "bash", arguments: { command: "status" } }],
			{ stopReason: "toolUse" },
		);
		expect(isFinal(commentary)).toBe(false);
		expect(isFinal(tool)).toBe(false);
		const pending = partitionRound([user, commentary, tool]);
		expect(pending.response).toBeUndefined();
		expect(pending.process).toEqual([commentary, tool]);
		const final = message("final", "assistant", "服务正常", { stopReason: "stop" });
		const complete = partitionRound([user, commentary, tool, final]);
		expect(complete.response).toEqual({ ...final, content: [{ type: "text", text: "服务正常" }] });
		expect(complete.outcome).toBe("complete");
	});

	it("uses per-part phases for commentary and final text in the same assistant message", () => {
		const final = message(
			"answer",
			"assistant",
			[
				{ type: "thinking", thinking: "判断状态" },
				{ type: "text", text: "正在检查", phase: "commentary" },
				{ type: "text", text: "服务正常", phase: "final_answer" },
			],
			{ phase: "final_answer", stopReason: "stop" },
		);
		const split = partitionRound([message("user", "user", "检查"), final]);
		expect(split.process[0].content).toEqual([
			{ type: "thinking", thinking: "判断状态" },
			{ type: "text", text: "正在检查", phase: "commentary" },
		]);
		expect(split.response?.content).toEqual([{ type: "text", text: "服务正常", phase: "final_answer" }]);
	});

	it("does not infer completion from ordinary text and preserves terminal errors", () => {
		expect(isFinal(message("partial", "assistant", "还有下一步"))).toBe(false);
		const failed = message("failed", "assistant", "", { stopReason: "error", errorMessage: "insufficient_quota" });
		const split = partitionRound([message("user", "user", "运行"), failed]);
		expect(split.response?.errorMessage).toBe("insufficient_quota");
		expect(split.outcome).toBe("failed");
	});

	it("appends committed messages without duplicate ids and starts a round at user boundaries", () => {
		const user = message("user", "user", "检查");
		const answer = message("answer", "assistant", "完成", { stopReason: "stop" });
		const next = message("next", "user", "继续");
		const rounds = appendMessages([{ id: "user", messages: [user] }], [user, answer, next]);
		expect(rounds.map((round) => round.messages.map((item) => item.id))).toEqual([["user", "answer"], ["next"]]);
	});
	it("preserves loaded older rounds across reconnect when the recent snapshot shares their branch", () => {
		const older = { id: "older", messages: [message("older", "user", "旧问题")] };
		const current = { id: "current", messages: [message("current", "user", "当前问题")] };
		const updated = { ...current, messages: [...current.messages, message("answer", "assistant", "当前答案")] };
		expect(mergeRecentRounds([older, current], [updated])).toEqual({
			rounds: [older, updated],
			preservedOlder: true,
		});
		const branch = { id: "branch", messages: [message("branch", "user", "另一个分支")] };
		expect(mergeRecentRounds([older, current], [branch])).toEqual({ rounds: [branch], preservedOlder: false });
	});
	it("retains ten loaded rounds when a persisted branch appends a new round", () => {
		const rounds = Array.from({ length: 11 }, (_, index) => ({
			id: `user-${index}`,
			messages: [message(`user-${index}`, "user", `Question ${index}`)],
		}));
		expect(mergeRecentRounds(rounds.slice(0, 10), rounds.slice(6))).toEqual({
			rounds,
			preservedOlder: true,
		});
		expect(mergeRecentRounds(rounds, rounds.slice(6))).toEqual({ rounds, preservedOlder: true });
	});
});
