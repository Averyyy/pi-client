import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_PROVIDER } from "../../src/core/antigravity-acp.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import * as piServerClient from "../../src/core/pi-server-client.ts";
import { VIRTUAL_MODEL_API } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness, totalTokens = 650): string {
	const model = harness.session.model!;
	let recentUserId = "";
	for (const label of ["old", "recent"]) {
		recentUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return recentUserId;
}

// Regression coverage for #8133.
describe("AgentSession compaction model overrides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(["manual", "auto"] as const)(
		"refuses virtual %s compaction routed to Antigravity before any request",
		async (mode) => {
			const harness = await createHarness({
				settings: { compaction: { model: "router/summary", keepRecentTokens: 150 } },
			});
			harnesses.push(harness);
			seedHistory(harness);
			vi.stubEnv("PI_SERVER_MODE", "true");
			const model = harness.getModel();
			const virtual = { ...model, id: "summary", provider: "router", api: VIRTUAL_MODEL_API };
			const antigravity = { ...model, provider: ANTIGRAVITY_PROVIDER, maxTokens: 512 };
			const runtime = harness.session.modelRuntime;
			vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([virtual]);
			const route = vi
				.spyOn(runtime, "resolveModel")
				.mockResolvedValue({ model: antigravity, thinkingLevel: "off" });
			const compactRemote = vi.spyOn(piServerClient, "compactPiServer");
			const streamLocal = vi.fn(() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("summary") });
				return stream;
			});
			harness.session.agent.streamFunction = streamLocal;

			// agy answers only the person driving the session; Pi's summaries go to another model.
			if (mode === "manual") {
				await expect(harness.session.compact()).rejects.toThrow("compaction.model");
			} else {
				const session = harness.session as unknown as {
					_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
				};
				expect(await session._runAutoCompaction("threshold", false)).toBe(false);
				expect(harness.eventsOfType("compaction_end")[0]?.errorMessage).toContain("compaction.model");
			}

			expect(route).toHaveBeenCalledOnce();
			expect(compactRemote).not.toHaveBeenCalled();
			expect(streamLocal).not.toHaveBeenCalled();
		},
	);

	it.each([
		["manual", "faux/family/summary", "family/summary"],
		["pre-prompt", "faux/family/summary", "family/summary"],
		["manual", "none", "chat"],
	] as const)("uses compaction.model for %s compaction with %s", async (path, selection, expectedModel) => {
		const harness = await createHarness({
			models: [
				{ id: "chat", contextWindow: 4000, maxTokens: 512 },
				{ id: "family/summary", contextWindow: 8000, maxTokens: 512 },
			],
			tools: [],
			settings: {
				compaction: {
					model: selection,
					keepRecentTokens: 150,
					modelOverrides: { "faux/chat": { reserveTokens: 2000 } },
				},
			},
		});
		harnesses.push(harness);
		await harness.session.modelRuntime.getAvailable();
		seedHistory(harness, 2500);
		const requests: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requests.push(model.id);
				return fauxAssistantMessage("summary");
			},
		]);
		if (path === "manual") {
			await harness.session.compact();
		} else {
			harness.appendResponses([
				(_context, _options, _state, model) => {
					requests.push(model.id);
					return fauxAssistantMessage("chat reply");
				},
			]);
			await harness.session.prompt("continue");
		}
		expect(requests).toEqual(path === "manual" ? [expectedModel] : [expectedModel, "chat"]);
		// The status indicator names only a model that compaction.model selects.
		expect(harness.eventsOfType("compaction_start")[0]?.model).toBe(selection === "none" ? undefined : expectedModel);
		expect(harness.eventsOfType("compaction_end")[0]?.result?.summary).toBe("summary");
		expect(harness.session.model?.id).toBe("chat");
	});

	it("reports an unavailable compact model during manual and automatic compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "chat", contextWindow: 4000 }],
			tools: [],
			settings: { compaction: { model: "faux/missing", reserveTokens: 2000, keepRecentTokens: 150 } },
		});
		harnesses.push(harness);
		seedHistory(harness, 2500);
		const error = "Compact model faux/missing is unavailable";
		await expect(harness.session.compact()).rejects.toThrow(error);
		harness.setResponses([fauxAssistantMessage("chat reply")]);
		await harness.session.prompt("continue");
		expect(harness.eventsOfType("compaction_end")).toMatchObject([
			{ reason: "manual", errorMessage: expect.stringContaining(error) },
			{ reason: "threshold", errorMessage: expect.stringContaining(error) },
		]);
	});

	it.each(["manual", "pre-prompt", "post-run", "overflow"] as const)(
		"uses model token settings for %s compaction and extension preparation",
		async (path) => {
			const preparations: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 4000 }],
				tools: [],
				settings: {
					compaction: {
						enabled: path !== "manual",
						reserveTokens: 10,
						keepRecentTokens: 20000,
						modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } },
					},
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							preparations.push(event);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			const recentUserId = seedHistory(harness, path === "pre-prompt" ? 2500 : 650);

			if (path === "manual") {
				await harness.session.compact();
			} else {
				harness.setResponses(
					path === "overflow"
						? [
								fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
								fauxAssistantMessage("recovered"),
							]
						: [fauxAssistantMessage(path === "post-run" ? "z".repeat(8000) : "done")],
				);
				await harness.session.prompt("continue");
			}

			expect(preparations).toHaveLength(1);
			expect(preparations[0]?.preparation.settings).toEqual({
				enabled: path !== "manual",
				reserveTokens: 2000,
				keepRecentTokens: 150,
			});
			expect(preparations[0]?.reason).toBe(
				path === "manual" ? "manual" : path === "overflow" ? "overflow" : "threshold",
			);
			if (path === "manual" || path === "pre-prompt") {
				expect(preparations[0]?.preparation.firstKeptEntryId).toBe(recentUserId);
			}
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				aborted: false,
				willRetry: path === "overflow",
				result: { summary: "compacted history" },
			});
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("uses the newly selected model without changing ordinary settings", async () => {
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 4000 },
				{ id: "big", contextWindow: 10000 },
			],
			tools: [],
			settings: {
				compaction: {
					reserveTokens: 10,
					modelOverrides: { "faux/big": { reserveTokens: 8000, keepRecentTokens: 150 } },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "big model summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedHistory(harness, 2500);
		harness.setResponses([fauxAssistantMessage("small response"), fauxAssistantMessage("big response")]);
		await harness.session.prompt("continue on small");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		// Retain usage from the small model: the next check must use the active big model's policy.
		seedHistory(harness, 2500);
		await harness.session.setModel(harness.getModel("big")!);
		await harness.session.prompt("continue on big");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]?.result?.summary).toBe("big model summary");
		expect(harness.settingsManager.getCompactionReserveTokens()).toBe(10);
		await harness.session.setModel(harness.getModel("small")!);
		expect(harness.settingsManager.getCompactionReserveTokens(harness.session.model)).toBe(10);
	});

	it("captures model identity before awaiting summarization auth", async () => {
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			settings: {
				compaction: {
					modelOverrides: {
						"faux/first": { reserveTokens: 2000, keepRecentTokens: 150 },
						"faux/second": { reserveTokens: 4000, keepRecentTokens: 20000 },
					},
				},
			},
		});
		harnesses.push(harness);
		seedHistory(harness);
		const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, ...args) => {
			harness.session.agent.state.model = harness.getModel("second")!;
			return getAuth(model, ...args);
		});
		const requests: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requests.push(model.id);
				return fauxAssistantMessage("summary");
			},
		]);
		await harness.session.compact();
		expect(requests).toEqual(["first"]);
	});
});
