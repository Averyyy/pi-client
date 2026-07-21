import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192, contextWindow = 200000): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function getPromptText(context: { messages: Message[] }): string {
	const message = context.messages[0];
	if (message?.role !== "user" || !Array.isArray(message.content)) return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("asks summaries to preserve operational state", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const prompt = getPromptText(completeSimpleMock.mock.calls[0][1]);
		expect(prompt).toContain("## Operational State");
		expect(prompt).toContain("Modified files");
		expect(prompt).toContain("Read files");
		expect(prompt).toContain("Open failures");
		expect(prompt).toContain("Last command");
		expect(prompt).toContain("Last failing assertion/error");
		expect(prompt).toContain("Pending TODO");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("chunks summary input to fit the active model context window", async () => {
		const prompts: string[] = [];
		completeSimpleMock.mockImplementation(async (_model: Model<any>, context: { messages: Message[] }) => {
			prompts.push(getPromptText(context));
			return {
				...mockSummaryResponse,
				content: [{ type: "text", text: `summary ${prompts.length}` }],
			};
		});
		const chunkedMessages: AgentMessage[] = [
			{ role: "user", content: `chunk-a ${"a".repeat(4000)}`, timestamp: Date.now() },
			{ role: "user", content: `chunk-b ${"b".repeat(4000)}`, timestamp: Date.now() },
			{ role: "user", content: `chunk-c ${"c".repeat(4000)}`, timestamp: Date.now() },
			{ role: "user", content: `chunk-d ${"d".repeat(4000)}`, timestamp: Date.now() },
		];

		const summary = await generateSummary(chunkedMessages, createModel(false, 2048, 2800), 1000, "test-key");

		expect(summary).toBe("summary 4");
		expect(prompts).toHaveLength(4);
		expect(prompts[0]).toContain("chunk-a");
		expect(prompts[0]).not.toContain("chunk-b");
		expect(prompts[1]).toContain("<previous-summary>\nsummary 1\n</previous-summary>");
		expect(prompts[3]).toContain("chunk-d");
	});

	it("splits one oversized serialized message to fit the active model context window", async () => {
		const prompts: string[] = [];
		completeSimpleMock.mockImplementation(async (_model: Model<any>, context: { messages: Message[] }) => {
			prompts.push(getPromptText(context));
			return {
				...mockSummaryResponse,
				content: [{ type: "text", text: `summary ${prompts.length}` }],
			};
		});
		const oversizedMessages: AgentMessage[] = [
			{ role: "user", content: `single-start ${"x".repeat(9000)} single-end`, timestamp: Date.now() },
		];

		const summary = await generateSummary(oversizedMessages, createModel(false, 2048, 2800), 1000, "test-key");

		expect(summary).toBe(`summary ${prompts.length}`);
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts[0]).toContain("single-start");
		expect(prompts[0]).not.toContain("single-end");
		expect(prompts[1]).toContain("<previous-summary>\nsummary 1\n</previous-summary>");
		expect(prompts[prompts.length - 1]).toContain("single-end");
	});

	it("recursively splits a summary chunk when the provider reports context overflow", async () => {
		const prompts: string[] = [];
		completeSimpleMock.mockImplementation(async (_model: Model<any>, context: { messages: Message[] }) => {
			prompts.push(getPromptText(context));
			if (prompts.length === 1) {
				return {
					...mockSummaryResponse,
					content: [],
					stopReason: "error",
					errorMessage: "maximum context length is 100 tokens",
				};
			}
			return {
				...mockSummaryResponse,
				content: [{ type: "text", text: `summary ${prompts.length}` }],
			};
		});
		const oversizedMessages: AgentMessage[] = [
			{ role: "user", content: "left side", timestamp: Date.now() },
			{ role: "user", content: "right side", timestamp: Date.now() },
		];

		const summary = await generateSummary(oversizedMessages, createModel(false, 2048, 200000), 1000, "test-key");

		expect(summary).toBe("summary 3");
		expect(prompts).toHaveLength(3);
		expect(prompts[0]).toContain("left side");
		expect(prompts[0]).toContain("right side");
		expect(prompts[1]).toContain("left side");
		expect(prompts[1]).not.toContain("right side");
		expect(prompts[2]).toContain("<previous-summary>\nsummary 2\n</previous-summary>");
		expect(prompts[2]).toContain("right side");
	});
});
