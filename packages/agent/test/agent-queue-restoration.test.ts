import { createAssistantMessageEventStream, type UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function response() {
	const stream = createAssistantMessageEventStream();
	const message = fauxAssistantMessage("answer");
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

describe("Agent queue restoration after preparation failure", () => {
	it.each([
		{ source: "steer", mode: "all" },
		{ source: "steer", mode: "one-at-a-time" },
		{ source: "followUp", mode: "all" },
		{ source: "followUp", mode: "one-at-a-time" },
	] as const)("restores $source input in $mode order before agent_end and newer input", async ({ source, mode }) => {
		const first = user("first selected");
		const second = user("second selected");
		const newer = user("newer during preparation");
		const other = user("other queue");
		let queued = false;
		const committed: AgentMessage[] = [];
		const agent = new Agent({
			steeringMode: mode,
			followUpMode: mode,
			streamFn: (_model, context) => {
				for (const message of context.messages) expect(Object.getOwnPropertySymbols(message)).toEqual([]);
				return response();
			},
			prepareNextTurn: () => {
				agent[source](newer);
				throw new Error("preparation failed");
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_start") {
				expect(Object.getOwnPropertySymbols(event.message)).toEqual([]);
				expect(Object.getOwnPropertySymbols(agent.state.streamingMessage ?? {})).toEqual([]);
			}
			if (event.type === "message_end") {
				expect(Object.getOwnPropertySymbols(event.message)).toEqual([]);
				committed.push(event.message);
				if (!queued && event.message.role === "assistant") {
					queued = true;
					agent[source](first);
					agent[source](second);
					if (source === "steer") agent.followUp(other);
				}
			}
			if (event.type === "agent_end" && agent.state.errorMessage === "preparation failed") {
				expect(agent.hasQueuedMessages()).toBe(true);
				expect(agent.peekQueuedMessages()).toEqual(mode === "all" ? [first, second, newer] : [first]);
			}
		});
		await agent.prompt(user("start"));
		expect(committed).not.toContainEqual(first);
		expect(Object.getOwnPropertySymbols(first)).toEqual([]);
		agent.prepareNextTurn = undefined;
		await agent.continue();
		const text = agent.state.messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
		expect(text).toEqual(
			source === "steer"
				? ["start", first.content, second.content, newer.content, other.content]
				: ["start", first.content, second.content, newer.content],
		);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it.each(["clearSteeringQueue", "clearFollowUpQueue", "clearAllQueues"] as const)(
		"invalidates selected leases on %s without restoring cleared intent",
		async (clear) => {
			const source = clear === "clearFollowUpQueue" ? "followUp" : "steer";
			const cleared = user("cleared selected input");
			const fresh = user("fresh after clear");
			let queued = false;
			const agent = new Agent({
				streamFn: response,
				prepareNextTurn: () => {
					agent[clear]();
					agent[source](fresh);
					throw new Error("preparation failed after clear");
				},
			});
			agent.subscribe((event) => {
				if (!queued && event.type === "message_end" && event.message.role === "assistant") {
					queued = true;
					agent[source](cleared);
				}
			});
			await agent.prompt("start");
			expect(agent.peekQueuedMessages()).toEqual([fresh]);
			agent.prepareNextTurn = undefined;
			await agent.continue();
			expect(agent.state.messages).not.toContainEqual(cleared);
			expect(
				agent.state.messages.filter((message) => message.role === "user" && message.content === fresh.content),
			).toHaveLength(1);
		},
	);

	it.each(["error", "abort"] as const)(
		"does not restore a committed message when its listener ends with %s",
		async (outcome) => {
			const first = user("committed before listener failure");
			const pending = user("uncommitted after listener failure");
			let queued = false;
			let failed = false;
			const agent = new Agent({ steeringMode: "all", streamFn: response });
			agent.subscribe((event) => {
				if (event.type !== "message_end") return;
				expect(Object.getOwnPropertySymbols(event.message)).toEqual([]);
				if (!queued && event.message.role === "assistant") {
					queued = true;
					agent.steer(first);
					agent.steer(pending);
				}
				if (!failed && event.message.role === "user" && event.message.content === first.content) {
					failed = true;
					if (outcome === "abort") agent.abort();
					throw new Error("listener failed after state commit");
				}
			});
			await agent.prompt("start");
			expect(agent.peekQueuedMessages()).toEqual([pending]);
			await agent.continue();
			for (const message of [first, pending]) {
				expect(
					agent.state.messages.filter((entry) => entry.role === "user" && entry.content === message.content),
				).toHaveLength(1);
			}
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"restores an initial continue() $source drain that fails before commit",
		async (source) => {
			const selected = user("initial continuation input");
			let failed = false;
			const agent = new Agent({
				initialState: { messages: [user("initial"), fauxAssistantMessage("previous")] },
				streamFn: response,
			});
			agent[source](selected);
			agent.subscribe((event) => {
				if (
					!failed &&
					event.type === "message_start" &&
					event.message.role === "user" &&
					event.message.content === selected.content
				) {
					failed = true;
					throw new Error("listener failed before state commit");
				}
			});
			await agent.continue();
			expect(agent.peekQueuedMessages()).toEqual([selected]);
			await agent.continue();
			expect(
				agent.state.messages.filter((message) => message.role === "user" && message.content === selected.content),
			).toHaveLength(1);
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it.each(["all", "one-at-a-time"] as const)(
		"consumes independent leases for a reused object in %s mode",
		async (mode) => {
			const shared = user("same object twice");
			const agent = new Agent({
				initialState: { messages: [user("initial"), fauxAssistantMessage("previous")] },
				steeringMode: mode,
				streamFn: response,
			});
			agent.steer(shared);
			agent.steer(shared);
			await agent.continue();
			expect(
				agent.state.messages.filter((message) => message.role === "user" && message.content === shared.content),
			).toHaveLength(2);
			expect(Object.getOwnPropertySymbols(shared)).toEqual([]);
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("does not replay committed queued input after an ordinary cancellation", async () => {
		const selected = user("selected before ordinary cancellation");
		let queued = false;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				if (!options?.signal?.aborted) return response();
				const stream = createAssistantMessageEventStream();
				const message = fauxAssistantMessage("aborted", { stopReason: "aborted" });
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
				return stream;
			},
			prepareNextTurn: () => {
				agent.abort();
			},
		});
		agent.subscribe((event) => {
			if (!queued && event.type === "message_end" && event.message.role === "assistant") {
				queued = true;
				agent.steer(selected);
			}
		});
		await agent.prompt("start");
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.prepareNextTurn = undefined;
		await agent.prompt("next ordinary request");
		expect(
			agent.state.messages.filter((message) => message.role === "user" && message.content === selected.content),
		).toHaveLength(1);
	});

	it("retires a queued system checkpoint even when tool declaration normalization spreads it", async () => {
		const checkpoint: AgentMessage = {
			role: "system",
			content: "queued checkpoint",
			timestamp: 1,
			toolsAdded: [{ name: "discarded", description: "discarded", parameters: { type: "object" } }],
		};
		const agent = new Agent({
			initialState: { messages: [user("initial"), fauxAssistantMessage("previous")] },
			streamFn: (_model, context) => {
				for (const message of context.messages) expect(Object.getOwnPropertySymbols(message)).toEqual([]);
				return response();
			},
		});
		agent.steer(checkpoint);
		agent.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				expect(Object.getOwnPropertySymbols(event.message)).toEqual([]);
				expect(Object.getOwnPropertySymbols(agent.state.streamingMessage ?? {})).toEqual([]);
			}
		});
		await agent.continue();
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(Object.getOwnPropertySymbols(checkpoint)).toEqual([]);
		expect(checkpoint.toolsAdded).toHaveLength(1);
		for (const message of agent.state.messages) expect(Object.getOwnPropertySymbols(message)).toEqual([]);
	});
});
