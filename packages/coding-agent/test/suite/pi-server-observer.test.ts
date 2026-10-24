import { createServer, type Server, type ServerResponse } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { type ObserverUpdate, PiServerObserver, projectObserverEntries } from "../../src/core/pi-server-observer.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

interface ObserverFixture {
	server: Server;
	updates: ObserverUpdate[];
	sockets: ServerResponse[];
	rawSizes: number[];
	chunkTargets: string[];
	connectRequests: number;
	closed: number;
	fail: boolean;
	deleted: boolean;
	holdResponse?: Promise<void>;
}

async function createFixture(): Promise<ObserverFixture> {
	const chunks = new Map<string, string[]>();
	const fixture: ObserverFixture = {
		server: createServer(),
		updates: [],
		sockets: [],
		rawSizes: [],
		chunkTargets: [],
		connectRequests: 0,
		closed: 0,
		fail: false,
		deleted: false,
	};
	fixture.server.on("request", async (request, response) => {
		if (request.headers.authorization !== "Bearer observer-test") {
			response.writeHead(401).end();
			return;
		}
		if (request.method === "GET") {
			fixture.connectRequests++;
			response.on("close", () => {
				fixture.closed++;
			});
			if (fixture.deleted) {
				response.writeHead(410, { "Content-Type": "application/json" }).end('{"deleted":true}');
				return;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				`event: connected\r\ndata: ${JSON.stringify({ connectionId: `connection-${fixture.sockets.length}` })}\r\n\r\n`,
			);
			fixture.sockets.push(response);
			return;
		}
		const buffers: Buffer[] = [];
		for await (const chunk of request) buffers.push(Buffer.from(chunk));
		const raw = Buffer.concat(buffers);
		fixture.rawSizes.push(raw.length);
		if (raw.length > 65536) {
			response.writeHead(413).end();
			return;
		}
		if (fixture.deleted) {
			response
				.writeHead(410, { "Content-Type": "application/json" })
				.end('{"error":"Observer session deleted","deleted":true}');
			return;
		}
		if (fixture.fail) {
			response.writeHead(503).end();
			return;
		}
		let body: unknown = JSON.parse(raw.toString());
		if (request.url === "/api/request/chunk") {
			const envelope = body as {
				requestId: string;
				target: string;
				chunkIndex: number;
				totalChunks: number;
				chunk: string;
			};
			fixture.chunkTargets.push(envelope.target);
			const parts = chunks.get(envelope.requestId) ?? [];
			parts[envelope.chunkIndex] = envelope.chunk;
			chunks.set(envelope.requestId, parts);
			if (parts.filter(Boolean).length < envelope.totalChunks) {
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						received: true,
						requestId: envelope.requestId,
						chunkIndex: envelope.chunkIndex,
						totalChunks: envelope.totalChunks,
					}),
				);
				return;
			}
			body = JSON.parse(Buffer.from(parts.join(""), "base64").toString());
			chunks.delete(envelope.requestId);
		}
		fixture.updates.push(body as ObserverUpdate);
		await fixture.holdResponse;
		response.writeHead(200, { "Content-Type": "application/json" }).end('{"accepted":true}');
	});
	await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
	const address = fixture.server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	vi.stubEnv("PI_SERVER_URL", `http://127.0.0.1:${address.port}`);
	vi.stubEnv("PI_SERVER_AUTH_TOKEN", "observer-test");
	vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
	return fixture;
}

function createRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		},
		async () => {
			throw new Error("Runtime replacement is not part of this fixture");
		},
	);
}

describe("pi-server observer", () => {
	const harnesses: Harness[] = [];
	const fixtures: ObserverFixture[] = [];
	const observers: PiServerObserver[] = [];

	afterEach(async () => {
		for (const observer of observers.splice(0)) observer.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const fixture of fixtures.splice(0)) {
			for (const socket of fixture.sockets) socket.destroy();
			fixture.server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				fixture.server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("publishes a full branch through byte-limited transport without sending system instructions or image data", async () => {
		const manager = SessionManager.inMemory("C:/project");
		manager.appendMessage({ role: "system", content: "private system prompt", timestamp: 1 });
		const userId = manager.appendMessage({ role: "user", content: "观察历史".repeat(30000), timestamp: 2 });
		manager.appendCompaction("summary", userId, 100000);
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "private-image", mimeType: "image/png" }],
			timestamp: 3,
		});
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const update = fixture.updates[0]!;
		expect(update.cwd).toBe(manager.getCwd());
		expect(update.status).toBe("idle");
		expect(update.replace?.map((message) => message.role)).toEqual(["user", "compaction", "user"]);
		expect(update.replace?.[0]?.id).toBe(userId);
		expect(update.replace?.[2]?.content).toEqual([{ type: "attachment", label: "image/png" }]);
		expect(JSON.stringify(update)).not.toContain("private");
		expect(fixture.chunkTargets.length).toBeGreaterThan(1);
		expect(new Set(fixture.chunkTargets)).toEqual(new Set(["/api/observer"]));
		expect(Math.max(...fixture.rawSizes)).toBeLessThanOrEqual(65536);
	});

	it.each(["message", "custom_message", "compaction", "branch_summary"] as const)(
		"derives initial activity from a durable %s entry",
		async (type) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const manager = harness.sessionManager;
			let id: string;
			if (type === "message") id = manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
			else if (type === "custom_message") id = manager.appendCustomMessageEntry("notice", "visible", true);
			else if (type === "compaction") id = manager.appendCompaction("summary", null, 100);
			else id = manager.branchWithSummary(null, "branch summary");
			manager.getEntry(id)!.timestamp = "2020-01-01T00:00:00.000Z";
			const fixture = await createFixture();
			fixtures.push(fixture);
			observers.push(new PiServerObserver(harness.session));
			await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
			expect(fixture.updates[0]?.lastActiveAt).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
			expect(fixture.updates[0]?.replace?.[0]?.timestamp).toBe(fixture.updates[0]?.lastActiveAt);
		},
	);

	it("keeps sessions without visible activity undated", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const manager = harness.sessionManager;
		manager.appendMessage({ role: "system", content: "instructions", timestamp: 1 });
		manager.appendMessage({ role: "custom", customType: "hidden", content: "hidden", display: false, timestamp: 2 });
		manager.appendCustomMessageEntry("hidden", "hidden", false);
		manager.appendCustomEntry("metadata", {});
		manager.appendSessionInfo("name");
		manager.appendModelChange("provider", "model");
		manager.appendThinkingLevelChange("high");
		manager.appendUsage("warm", "provider", "model", fauxAssistantMessage("").usage);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		expect(fixture.updates[0]?.lastActiveAt).toBeNull();
		expect(fixture.updates[0]?.replace).toEqual([]);
	});

	it("preserves whole-tree activity across reconnect, title changes, history replay, and old branches", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const manager = harness.sessionManager;
		const first = manager.appendMessage({ role: "user", content: "older", timestamp: 1 });
		manager.getEntry(first)!.timestamp = "2020-01-01T00:00:00.000Z";
		const latest = manager.appendMessage({ role: "user", content: "newer branch", timestamp: 2 });
		manager.getEntry(latest)!.timestamp = "2020-01-02T00:00:00.000Z";
		manager.branch(first);
		let emit: AgentSessionEventListener = () => {};
		vi.spyOn(harness.session, "subscribe").mockImplementation((listener) => {
			emit = listener;
			return () => {};
		});
		const fixture = await createFixture();
		fixtures.push(fixture);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const activity = Date.parse("2020-01-02T00:00:00.000Z");
		expect(fixture.updates[0]?.lastActiveAt).toBe(activity);
		emit({ type: "session_info_changed", name: "renamed" });
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(2));
		emit({ type: "history_reconciled", entryCount: 2, messageCount: 2 });
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(3));
		manager.resetLeaf();
		emit({ type: "session_tree_changed" });
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(4));
		expect(fixture.updates.at(-1)?.replace).toEqual([]);
		fixture.sockets[0]?.end();
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(5), { timeout: 4000 });
		expect(fixture.updates.every((update) => update.lastActiveAt === activity)).toBe(true);
		expect(diagnostic).toHaveBeenLastCalledWith("pi-server observer connected");
	});

	it("advances activity on lifecycle boundaries and committed entries while live deltas retain their boundary time", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let emit: AgentSessionEventListener = () => {};
		vi.spyOn(harness.session, "subscribe").mockImplementation((listener) => {
			emit = listener;
			return () => {};
		});
		const clock = vi.spyOn(Date, "now");
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		let time = 1000;
		clock.mockReturnValue(time);
		emit({ type: "run_state_changed", running: true });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		time += 1000;
		clock.mockReturnValue(time);
		const message = fauxAssistantMessage("stream", { timestamp: 20 });
		emit({ type: "message_start", message });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		clock.mockReturnValue(9000);
		for (let index = 0; index < 200; index++) {
			emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
			});
		}
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.live.message?.timestamp).toBe(20));
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time);
		time += 1000;
		clock.mockReturnValue(time);
		emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "wait", args: {} });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		clock.mockReturnValue(9000);
		for (let index = 0; index < 200; index++) {
			emit({
				type: "tool_execution_update",
				toolCallId: "tool",
				toolName: "wait",
				args: {},
				partialResult: { content: [{ type: "text", text: `partial ${index}` }], details: {} },
			});
		}
		await vi.waitFor(() =>
			expect(fixture.updates.at(-1)?.live.tools[0]?.result).toEqual({
				content: [{ type: "text", text: "partial 199" }],
			}),
		);
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time);
		time += 1000;
		clock.mockReturnValue(time);
		emit({
			type: "tool_execution_end",
			toolCallId: "tool",
			toolName: "wait",
			result: { content: [], details: {} },
			isError: true,
		});
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		time += 1000;
		clock.mockReturnValue(time);
		emit({ type: "compaction_start", reason: "manual" });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		time += 1000;
		clock.mockReturnValue(time);
		emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		time += 1000;
		clock.mockReturnValue(time);
		emit({ type: "run_state_changed", running: false });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(time));
		const id = harness.sessionManager.appendMessage({ role: "user", content: "committed", timestamp: 1 });
		const entry = harness.sessionManager.getEntry(id)!;
		entry.timestamp = new Date(8000).toISOString();
		emit({ type: "entry_appended", entry });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.lastActiveAt).toBe(8000));
		entry.timestamp = new Date(1000).toISOString();
		emit({ type: "message_committed", entry });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.append?.[0]?.timestamp).toBe(1000));
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(8000);
	});

	it("stays running through tools and appends final persisted entries before becoming idle", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const persisted: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_committed") return;
			expect(harness.sessionManager.getEntry(event.entry.id)).toBe(event.entry);
			if (event.entry.type === "message") persisted.push(event.entry.id);
		});
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "thinking", thinking: "considering" }, fauxToolCall("wait", { value: "actual argument" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([
				{ type: "text", text: "final", textSignature: '{"v":1,"id":"msg_final","phase":"final_answer"}' },
			]),
		]);
		const run = harness.session.prompt("start");
		await vi.waitFor(() =>
			expect(fixture.updates.some((update) => update.live.tools[0]?.status === "running")).toBe(true),
		);
		const active = fixture.updates.at(-1)!;
		expect(active.status).toBe("running");
		expect(active.live.tools[0]).toMatchObject({ name: "wait", arguments: { value: "actual argument" } });
		expect(harness.session.isStreaming).toBe(true);
		release?.();
		await run;
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		const appended = fixture.updates.flatMap((update) => update.append ?? []);
		expect(appended.map((message) => message.id)).toEqual(
			persisted.filter(
				(id) =>
					harness.sessionManager.getEntry(id)?.type === "message" &&
					(harness.sessionManager.getEntry(id) as { message: { role: string } }).message.role !== "system",
			),
		);
		expect(
			appended.some(
				(message) =>
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "thinking" && part.thinking === "considering"),
			),
		).toBe(true);
		expect(appended.at(-1)).toMatchObject({
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "text", text: "final" }],
		});
		expect(fixture.updates.slice(1).every((update) => update.replace === undefined)).toBe(true);
		expect(harness.eventsOfType("run_state_changed")).toEqual([
			{ type: "run_state_changed", running: true },
			{ type: "run_state_changed", running: false },
		]);
	});

	it("reports running while preparation waits and idle after preparation fails", async () => {
		let rejectPreparation: ((error: Error) => void) | undefined;
		const gate = new Promise<never>((_resolve, reject) => {
			rejectPreparation = reject;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => gate);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const startedAt = Date.now() + 1000000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
		const run = harness.session.prompt("prepare").catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("running"));
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(startedAt);
		clock.mockReturnValue(startedAt + 1000);
		rejectPreparation?.(new Error("preparation failed"));
		expect(await run).toMatchObject({ message: "preparation failed" });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(startedAt + 1000);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("streams a live assistant message before committing it", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_update", async (event) => {
						if (event.assistantMessageEvent.type === "text_end") await gate;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("streaming response")]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const run = harness.session.prompt("start");
		await vi.waitFor(() =>
			expect(fixture.updates.at(-1)?.live.message).toMatchObject({
				role: "assistant",
				stopReason: "pending",
				content: [{ type: "text", text: "streaming response" }],
			}),
		);
		expect(fixture.updates.at(-1)?.status).toBe("running");
		expect(
			fixture.updates.flatMap((update) => update.append ?? []).some((message) => message.role === "assistant"),
		).toBe(false);
		release?.();
		await run;
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		expect(fixture.updates.at(-1)?.live.message).toBeNull();
		expect(
			fixture.updates.flatMap((update) => update.append ?? []).filter((message) => message.role === "assistant"),
		).toHaveLength(1);
	});

	it("timestamps a five-minute assistant response at commit while retaining its live message timestamp", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_update", async (event) => {
						if (event.assistantMessageEvent.type === "text_end") await gate;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		vi.useFakeTimers({ toFake: ["Date"] });
		const startedAt = Date.parse("2020-01-01T00:00:00.000Z");
		vi.setSystemTime(startedAt);
		harness.setResponses([fauxAssistantMessage("long response", { timestamp: startedAt })]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const run = harness.session.prompt("start");
		await vi.waitFor(() =>
			expect(fixture.updates.at(-1)?.live.message?.content).toEqual([{ type: "text", text: "long response" }]),
		);
		expect(fixture.updates.at(-1)?.live.message?.timestamp).toBe(startedAt);
		vi.setSystemTime(startedAt + 300000);
		release?.();
		await run;
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		const committed = fixture.updates
			.flatMap((update) => update.append ?? [])
			.find((message) => message.role === "assistant");
		expect(committed?.timestamp).toBe(startedAt + 300000);
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(startedAt + 300000);
	});

	it("preserves failed attempts in transcript history and stays running until retry recovery settles", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			async () => {
				await gate;
				return fauxAssistantMessage("recovered");
			},
		]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const run = harness.session.prompt("start");
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
		await vi.waitFor(() =>
			expect(
				fixture.updates.flatMap((update) => update.append ?? []).some((message) => message.stopReason === "error"),
			).toBe(true),
		);
		expect(fixture.updates.at(-1)?.status).toBe("running");
		release?.();
		await run;
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toBe(true);
	});

	it("replaces the viewed branch and updates names, then closes the old socket on session disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstId = harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		harness.sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		harness.session.setSessionName("named session");
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.title).toBe("named session"));
		expect(fixture.updates.at(-1)?.replace).toBeUndefined();
		await harness.session.navigateTree(firstId);
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.replace).toEqual([]));
		harness.session.dispose();
		await vi.waitFor(() => expect(fixture.closed).toBe(1));
	});

	it("isolates observer transport failure from prompts and reconnects with a fresh branch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		fixture.fail = true;
		harness.setResponses([fauxAssistantMessage("completed despite observer failure")]);
		await harness.session.prompt("go");
		await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(1));
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		fixture.fail = false;
		await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2), { timeout: 4000 });
		await vi.waitFor(() =>
			expect(fixture.updates.at(-1)?.replace?.at(-1)?.content).toEqual([
				{ type: "text", text: "completed despite observer failure" },
			]),
		);
		await vi.waitFor(() => expect(diagnostic).toHaveBeenLastCalledWith("pi-server observer connected"));
	});

	it("keeps cancellation running until tool cleanup finishes", async () => {
		let release: (() => void) | undefined;
		let aborted = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for cleanup",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
					},
					{ once: true },
				);
				await gate;
				return { content: [{ type: "text", text: "cleaned up" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const run = harness.session.prompt("start");
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.live.tools[0]?.status).toBe("running"));
		const settledAt = Date.now() + 1000000;
		vi.spyOn(Date, "now").mockReturnValue(settledAt);
		const cancellation = harness.session.abort();
		await vi.waitFor(() => expect(aborted).toBe(true));
		expect(harness.session.isStreaming).toBe(true);
		expect(fixture.updates.at(-1)?.status).toBe("running");
		release?.();
		await Promise.all([run, cancellation]);
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		expect(fixture.updates.at(-1)?.lastActiveAt).toBe(settledAt);
		expect(fixture.updates.at(-1)?.live).toEqual({ message: null, tools: [] });
	});

	it("moves presence to the new session immediately when its manager changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old session", timestamp: 1 });
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		expect(fixture.updates[0]?.lastActiveAt).toBeTypeOf("number");
		const oldId = harness.session.sessionId;
		harness.sessionManager.newSession();
		harness.session.refreshContext();
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.sessionId).not.toBe(oldId));
		expect(fixture.closed).toBe(1);
		expect(fixture.updates.at(-1)).toMatchObject({
			sessionId: harness.session.sessionId,
			sequence: 1,
			replace: [],
			lastActiveAt: null,
		});
	});

	it("retains activity arriving while an older update is awaiting acknowledgement", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let emit: AgentSessionEventListener = () => {};
		vi.spyOn(harness.session, "subscribe").mockImplementation((listener) => {
			emit = listener;
			return () => {};
		});
		const fixture = await createFixture();
		fixtures.push(fixture);
		let release: (() => void) | undefined;
		fixture.holdResponse = new Promise<void>((resolve) => {
			release = resolve;
		});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		expect(fixture.updates[0]?.lastActiveAt).toBeNull();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		emit({ type: "run_state_changed", running: true });
		clock.mockReturnValue(2000);
		emit({ type: "run_state_changed", running: false });
		fixture.holdResponse = undefined;
		release?.();
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(2));
		expect(fixture.updates[1]?.lastActiveAt).toBe(2000);
	});

	it("preserves each native text phase and omits unrelated provider signature formats", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "working", textSignature: '{"v":1,"id":"msg1","phase":"commentary"}' },
				{ type: "text", text: "answer", textSignature: '{"v":1,"id":"msg2","phase":"final_answer"}' },
				{ type: "text", text: "other", textSignature: "{opaque-provider-signature" },
			]),
		);
		expect(projectObserverEntries(manager.getBranch())[0]).toMatchObject({
			phase: "final_answer",
			content: [
				{ type: "text", text: "working", phase: "commentary" },
				{ type: "text", text: "answer", phase: "final_answer" },
				{ type: "text", text: "other", phase: undefined },
			],
		});
	});

	it("projects durable transcript content without provider replay signatures", () => {
		const manager = SessionManager.inMemory();
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "opaque" },
			{ type: "text", text: "answer", textSignature: '{"v":1,"id":"msg","phase":"final_answer"}' },
		]);
		manager.appendMessage(message);
		expect(projectObserverEntries(manager.getBranch())).toEqual([
			{
				id: manager.getLeafId(),
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "visible reasoning" },
					{ type: "text", text: "answer", phase: "final_answer" },
				],
				stopReason: "stop",
				phase: "final_answer",
				timestamp: Date.parse(manager.getEntry(manager.getLeafId()!)!.timestamp),
				errorMessage: undefined,
			},
		]);
	});

	it("marks manual compaction running until its summary commits", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						await gate;
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		const compact = harness.session.compact();
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("running"));
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(false);
		release?.();
		await compact;
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
		expect(fixture.updates.at(-1)?.append?.at(-1)).toMatchObject({ role: "compaction", content: "manual summary" });
	});

	it("drains an in-flight update and final message through immediate print-mode runtime disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("printed final response")]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		let release: (() => void) | undefined;
		fixture.holdResponse = new Promise<void>((resolve) => {
			release = resolve;
		});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		let finished = false;
		const print = runPrintMode(createRuntime(harness), { mode: "text", initialMessage: "print" }).then((code) => {
			finished = true;
			return code;
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(false));
		await vi.waitFor(() => expect(harness.session.messages.at(-1)?.role).toBe("assistant"));
		expect(finished).toBe(false);
		expect(fixture.closed).toBe(0);
		fixture.holdResponse = undefined;
		release?.();
		expect(await print).toBe(0);
		const messages = fixture.updates.flatMap((update) => [...(update.replace ?? []), ...(update.append ?? [])]);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "printed final response" }]);
		expect(fixture.updates.at(-1)?.status).toBe("idle");
		await vi.waitFor(() => expect(fixture.closed).toBe(1));
	});

	it("bounds print-mode observer shutdown and reports delivery failure without changing the prompt result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("successful prompt")]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.holdResponse = new Promise<void>(() => {});
		const print = runPrintMode(createRuntime(harness), { mode: "text", initialMessage: "print" });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.append?.at(-1)?.role).toBe("assistant"));
		deadline.abort(new Error("shutdown deadline reached"));
		expect(await print).toBe(0);
		expect(timeout).toHaveBeenCalledWith(10000);
		expect(diagnostic).toHaveBeenCalledWith("pi-server observer shutdown failed: shutdown deadline reached");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("delivers the final print response when shutdown begins before the observer handshake finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("fast final response")]);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		expect(await runPrintMode(createRuntime(harness), { mode: "text", initialMessage: "print" })).toBe(0);
		const messages = fixture.updates.flatMap((update) => [...(update.replace ?? []), ...(update.append ?? [])]);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "fast final response" }]);
		expect(fixture.updates.at(-1)?.status).toBe("idle");
	});

	it("stops mirroring a deleted session until another session is opened", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.sockets[0]?.end(`event: deleted\ndata: ${JSON.stringify({ id: harness.session.sessionId })}\n\n`);
		await vi.waitFor(() => expect(fixture.closed).toBe(1));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		harness.session.setSessionName("deleted thread");
		await vi.advanceTimersByTimeAsync(2500);
		expect(fixture.sockets).toHaveLength(1);
		expect(fixture.updates).toHaveLength(1);
		expect(diagnostic).not.toHaveBeenCalled();
		vi.useRealTimers();
		harness.sessionManager.newSession();
		harness.session.refreshContext();
		await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.sessionId).toBe(harness.session.sessionId));
	});

	it("stops reconnecting when the presence handshake reports deletion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		fixture.deleted = true;
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.closed).toBe(1));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		harness.session.setSessionName("deleted thread");
		await vi.advanceTimersByTimeAsync(5000);
		expect(fixture.connectRequests).toBe(1);
		expect(fixture.updates).toEqual([]);
		expect(diagnostic).not.toHaveBeenCalled();
		vi.useRealTimers();
		fixture.deleted = false;
		harness.sessionManager.newSession();
		harness.session.refreshContext();
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.sessionId).toBe(harness.session.sessionId));
		expect(fixture.connectRequests).toBe(2);
	});

	it("treats HTTP 410 as deletion when it arrives before the presence deletion event", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.deleted = true;
		harness.session.setSessionName("deleted thread");
		await vi.waitFor(() => expect(fixture.closed).toBe(1));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		harness.session.setSessionName("still deleted");
		await vi.advanceTimersByTimeAsync(2500);
		expect(fixture.sockets).toHaveLength(1);
		expect(fixture.updates).toHaveLength(1);
		expect(diagnostic).not.toHaveBeenCalled();
		vi.useRealTimers();
		fixture.deleted = false;
		harness.sessionManager.newSession();
		harness.session.refreshContext();
		await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.sessionId).toBe(harness.session.sessionId));
	});
});
