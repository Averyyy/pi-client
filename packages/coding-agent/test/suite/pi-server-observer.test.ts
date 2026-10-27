import { createServer, type Server, type ServerResponse } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
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
	terminateHandshake: boolean;
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
		terminateHandshake: false,
	};
	fixture.server.on("request", async (request, response) => {
		if (request.headers.authorization !== "Bearer observer-test") {
			response.writeHead(401).end();
			return;
		}
		if (request.method === "GET") {
			fixture.connectRequests++;
			if (fixture.terminateHandshake) {
				response.destroy();
				return;
			}
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
		vi.unstubAllGlobals();
	});

	it("publishes a child relationship when its run starts before the parent tool returns", async () => {
		const events = createEventBus();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const record: {
			type: string;
			description: string;
			status: "running" | "completed";
			session?: { sessionId: string };
		} = {
			type: "Explore",
			description: "Inspect child",
			status: "running",
		};
		vi.stubGlobal(Symbol.for("pi-subagents:manager"), {
			getRecord: (id: string) => (id === "exact-task-id" ? record : undefined),
		});
		const parent = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getEventBus: () => events },
			tools: [
				{
					name: "delegate",
					label: "Delegate",
					description: "Delegate",
					parameters: Type.Object({}),
					execute: async () => {
						events.emit("subagents:started", { id: "exact-task-id" });
						await gate;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});
		const child = await createHarness();
		harnesses.push(parent, child);
		const fixture = await createFixture();
		fixtures.push(fixture);
		observers.push(new PiServerObserver(parent.session), new PiServerObserver(child.session));
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("parent done"),
		]);
		child.setResponses([fauxAssistantMessage("child done")]);
		const parentRun = parent.session.prompt("delegate");
		await vi.waitFor(() => expect(parent.eventsOfType("tool_execution_start")).toHaveLength(1));
		record.session = child.session;
		await child.session.prompt("child task");
		await vi.waitFor(() =>
			expect(
				fixture.updates.some(
					(update) =>
						update.sessionId === parent.session.sessionId &&
						update.subagents?.[0]?.sessionId === child.session.sessionId,
				),
			).toBe(true),
		);
		expect(parent.session.isStreaming).toBe(true);
		expect(fixture.updates.filter((update) => update.subagents?.length).at(-1)?.subagents?.[0]?.taskStatus).toBe(
			"running",
		);
		record.status = "completed";
		events.emit("subagents:completed", { id: "exact-task-id" });
		release?.();
		await parentRun;
		await vi.waitFor(() =>
			expect(fixture.updates.filter((update) => update.subagents?.length).at(-1)?.subagents?.[0]?.taskStatus).toBe(
				"completed",
			),
		);
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
		const run = harness.session.prompt("prepare").catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("running"));
		rejectPreparation?.(new Error("preparation failed"));
		expect(await run).toMatchObject({ message: "preparation failed" });
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
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

	it("reconnects quietly after repeated presence socket termination and publishes the current branch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(1));
		for (let attempt = 0; attempt < 2; attempt++) {
			fixture.sockets[attempt]!.destroy();
			harness.setResponses([fauxAssistantMessage(`response ${attempt}`)]);
			await harness.session.prompt(`prompt ${attempt}`);
			await vi.waitFor(() => expect(fixture.sockets).toHaveLength(attempt + 2), { timeout: 4000 });
			await vi.waitFor(() =>
				expect(fixture.updates.at(-1)?.replace?.at(-1)?.content).toEqual([
					{ type: "text", text: `response ${attempt}` },
				]),
			);
			expect(fixture.updates.at(-1)?.replace).toHaveLength((attempt + 1) * 2);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(diagnostic).not.toHaveBeenCalled();
		}
	});

	it("reports socket termination before the presence handshake", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		fixture.terminateHandshake = true;
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith("pi-server observer disconnected: fetch failed"));
		expect(fixture.updates).toEqual([]);
	});

	it("reports presence authentication failures", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = await createFixture();
		fixtures.push(fixture);
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "wrong-token");
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		observers.push(new PiServerObserver(harness.session));
		await vi.waitFor(() =>
			expect(diagnostic).toHaveBeenCalledWith("pi-server observer disconnected: connection failed (HTTP 401)"),
		);
		expect(fixture.updates).toEqual([]);
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
		expect(diagnostic).toHaveBeenCalledWith("pi-server observer disconnected: update failed (HTTP 503)");
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
		const cancellation = harness.session.abort();
		await vi.waitFor(() => expect(aborted).toBe(true));
		expect(harness.session.isStreaming).toBe(true);
		expect(fixture.updates.at(-1)?.status).toBe("running");
		release?.();
		await Promise.all([run, cancellation]);
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.status).toBe("idle"));
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
		const oldId = harness.session.sessionId;
		harness.sessionManager.newSession();
		harness.session.refreshContext();
		await vi.waitFor(() => expect(fixture.updates.at(-1)?.sessionId).not.toBe(oldId));
		expect(fixture.closed).toBe(1);
		expect(fixture.updates.at(-1)).toMatchObject({
			sessionId: harness.session.sessionId,
			sequence: 1,
			title: "",
			replace: [],
		});
	});

	it("delivers entries committed while an older update is awaiting acknowledgement", async () => {
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
		const id = harness.sessionManager.appendMessage({ role: "user", content: "committed", timestamp: 1 });
		emit({ type: "message_committed", entry: harness.sessionManager.getEntry(id)! });
		fixture.holdResponse = undefined;
		release?.();
		await vi.waitFor(() => expect(fixture.updates).toHaveLength(2));
		expect(fixture.updates[1]?.append?.map((message) => message.id)).toEqual([id]);
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
