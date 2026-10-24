import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewerThread } from "../src/viewer-types.ts";
import { Transcript } from "./transcript.tsx";

const thread: ViewerThread = {
	id: "thread",
	title: "检查服务",
	projectId: "project",
	cwd: "/project",
	lastActiveAt: null,
	status: "running",
	legacy: false,
	live: {
		message: {
			id: "live",
			role: "assistant",
			timestamp: 0,
			content: [
				{ type: "text", text: "正在检查服务状态", phase: "commentary" },
				{ type: "thinking", thinking: "内部推理内容" },
			],
		},
		tools: [{ id: "call", name: "bash", arguments: { command: "private-command" }, status: "running" }],
	},
};

describe("transcript disclosures", () => {
	it("offers automatic top pagination and an explicit retry only after a history failure", () => {
		const props = {
			rounds: [],
			thread,
			nextCursor: "older",
			loadingOlder: false,
			historyVersion: 0,
			loadOlder: async () => false,
		};
		const initial = renderToStaticMarkup(<Transcript {...props} olderError="" />);
		expect(initial).toContain('tabindex="0"');
		expect(initial).toContain("向上滚动加载更早的对话");
		expect(initial).not.toContain("加载更早的 5 轮对话");
		expect(initial).not.toContain("重试");
		const failed = renderToStaticMarkup(<Transcript {...props} olderError="无法读取历史" />);
		expect(failed).toContain("无法读取历史");
		expect(failed).toContain("重试");
	});
	it("shows streaming prose while thought and command content remain independently collapsed", () => {
		const html = renderToStaticMarkup(
			<Transcript
				rounds={[{ id: "user", messages: [{ id: "user", role: "user", timestamp: 0, content: "检查服务" }] }]}
				thread={thread}
				nextCursor={null}
				loadingOlder={false}
				olderError=""
				historyVersion={0}
				loadOlder={async () => false}
			/>,
		);
		expect(html).toContain("正在检查服务状态");
		expect(html).toContain("思考过程");
		expect(html).toContain("bash");
		expect(html).not.toContain("内部推理内容");
		expect(html).not.toContain("private-command");
	});
	it("exposes only the final answer by default after completion", () => {
		const html = renderToStaticMarkup(
			<Transcript
				rounds={[
					{
						id: "user",
						messages: [
							{ id: "user", role: "user", timestamp: 0, content: "检查服务" },
							{
								id: "comment",
								role: "assistant",
								timestamp: 0,
								content: "正在检查",
								phase: "commentary",
								stopReason: "stop",
							},
							{ id: "final", role: "assistant", timestamp: 0, content: "服务正常", stopReason: "stop" },
						],
					},
				]}
				thread={{ ...thread, status: "idle", live: { message: null, tools: [] } }}
				nextCursor={null}
				loadingOlder={false}
				olderError=""
				historyVersion={0}
				loadOlder={async () => false}
			/>,
		);
		expect(html).toContain("服务正常");
		expect(html).not.toContain("正在检查");
		expect(html).toContain("处理过程");
	});
});
