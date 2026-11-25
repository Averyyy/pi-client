import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

type HandleEvent = (this: object, event: AgentSessionEvent) => Promise<void>;

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

function fakeInteractiveMode() {
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		toolsFinishedInStreamingMessage: new Set<string>(),
		chatContainer: new Container(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
		sessionManager: { getCwd: () => process.cwd() },
		toolOutputExpanded: false,
		isInitialized: true,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking",
		outputPad: 1,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		maybeShowInstallChangeWarning: vi.fn(),
	};
}

function reply(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("InteractiveMode tool rows for tools that run mid-reply", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps one row when a call finishes before it reaches the streaming reply", async () => {
		const mode = fakeInteractiveMode();
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a.txt" } };
		const ids = { toolCallId: toolCall.id, toolName: toolCall.name };
		const events: AgentSessionEvent[] = [
			{ type: "message_start", message: reply([]) },
			{ type: "tool_execution_start", ...ids, args: toolCall.arguments },
			{
				type: "tool_execution_end",
				...ids,
				result: { content: [{ type: "text", text: "done" }], details: {} },
				isError: false,
			},
			// Antigravity places the executed call in its reply after the call has finished, then keeps streaming.
			{ type: "message_update", message: reply([toolCall]), assistantMessageEvent: { type: "toolcall_end" } },
			{
				type: "message_update",
				message: reply([toolCall, { type: "text", text: "after" }]),
				assistantMessageEvent: { type: "text_delta" },
			},
		] as AgentSessionEvent[];
		for (const event of events) await handleEvent.call(mode, event);
		const rows = mode.chatContainer.children.filter((child) => child instanceof ToolExecutionComponent);
		expect(rows).toHaveLength(1);
		expect(mode.pendingTools.size).toBe(0);
	});
});
