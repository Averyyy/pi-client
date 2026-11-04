import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewerRound, ViewerThread } from "../src/viewer-types.ts";
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

function renderTranscript(currentThread: ViewerThread, rounds: ViewerRound[] = []) {
	return renderToStaticMarkup(
		<Transcript
			rounds={rounds}
			thread={currentThread}
			nextCursor={null}
			loadingOlder={false}
			olderError=""
			historyVersion={0}
			loadOlder={async () => false}
			loadMessage={async () => {
				throw new Error("Collapsed detail must not load");
			}}
		/>,
	);
}

describe("transcript disclosures", () => {
	it("offers automatic top pagination and an explicit retry only after a history failure", () => {
		const props = {
			rounds: [],
			thread,
			nextCursor: "older",
			loadingOlder: false,
			historyVersion: 0,
			loadOlder: async () => false,
			loadMessage: async () => {
				throw new Error("Collapsed detail must not load");
			},
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
	it("collapses all streaming activity under the latest prose", () => {
		const html = renderToStaticMarkup(
			<Transcript
				rounds={[{ id: "user", messages: [{ id: "user", role: "user", timestamp: 0, content: "检查服务" }] }]}
				thread={thread}
				nextCursor={null}
				loadingOlder={false}
				olderError=""
				historyVersion={0}
				loadOlder={async () => false}
				loadMessage={async () => {
					throw new Error("Collapsed detail must not load");
				}}
			/>,
		);
		expect(html).toContain("正在检查服务状态");
		expect(html).toContain('title="正在检查服务状态"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('class="process-summary is-running"');
		expect(html).not.toContain("process-body");
		expect(html).not.toContain("思考过程");
		expect(html).not.toContain("bash");
		expect(html).not.toContain("内部推理内容");
		expect(html).not.toContain("private-command");
	});
	it("shows the final answer outside the collapsed process summary after completion", () => {
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
				loadMessage={async () => {
					throw new Error("Collapsed detail must not load");
				}}
			/>,
		);
		expect(html).toContain("服务正常");
		expect(html).toContain('class="final-answer"');
		expect(html).toContain('class="process-summary" title="正在检查"');
		expect(html).not.toContain("process-body");
		expect(html).not.toContain("is-running");
	});

	it("uses the last nonempty assistant text even when newer tools and thinking arrive", () => {
		const html = renderTranscript(
			{
				...thread,
				live: {
					...thread.live,
					message: { ...thread.live.message!, content: [{ type: "thinking", thinking: "新推理" }] },
				},
			},
			[
				{
					id: "user",
					messages: [
						{ id: "user", role: "user", timestamp: 0, content: "检查服务" },
						{ id: "old", role: "assistant", timestamp: 0, content: "旧进度", phase: "commentary" },
						{
							id: "latest",
							role: "assistant",
							timestamp: 0,
							content: [
								{ type: "text", text: "前一条文本" },
								{ type: "text", text: "最新进度\n检查中" },
								{ type: "text", text: "  " },
								{ type: "toolCall", id: "edit", name: "edit", arguments: { text: "命令参数" } },
							],
						},
						{ id: "result", role: "toolResult", timestamp: 0, content: "命令输出", contentDeferred: true },
						{ id: "bash", role: "bashExecution", timestamp: 0, content: "终端输出" },
					],
				},
			],
		);
		expect(html).toContain('title="最新进度\n检查中"');
		for (const hidden of ["旧进度", "前一条文本", "新推理", "命令参数", "命令输出", "终端输出", "process-body"])
			expect(html).not.toContain(hidden);
	});

	it.each(["idle", "disconnected", "unknown"] as const)("stops shimmer for %s threads", (status) => {
		const html = renderTranscript({ ...thread, status });
		expect(html).toContain('class="process-summary" title="正在检查服务状态"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("is-running");
	});

	it.each(["running", "idle"] as const)("labels a %s process without assistant prose", (status) => {
		const html = renderTranscript({ ...thread, status, live: { ...thread.live, message: null } }, [
			{
				id: "user",
				messages: [
					{ id: "user", role: "user", timestamp: 0, content: "检查服务" },
					{
						id: "thought",
						role: "assistant",
						timestamp: 0,
						content: [{ type: "thinking", thinking: "内部推理" }],
					},
				],
			},
		]);
		expect(html).toContain(`title="${status === "running" ? "正在处理" : "处理过程"}"`);
		expect(html).not.toContain("内部推理");
		expect(html).not.toContain("bash");
	});

	it("shimmers while waiting for the first assistant activity", () => {
		const html = renderTranscript({ ...thread, live: { message: null, tools: [] } }, [
			{ id: "user", messages: [{ id: "user", role: "user", timestamp: 0, content: "检查服务" }] },
		]);
		expect(html).toContain('class="process-summary is-running">正在处理');
		expect(html).not.toContain("process-toggle");
	});
});
