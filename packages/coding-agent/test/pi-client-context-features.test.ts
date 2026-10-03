import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions, getSession } from "../../pi-server/src/session-store.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadPhoton } from "../src/utils/photon.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const MAX_REQUEST_BYTES = 65_536;
const largeText = "汉字😀".repeat(20_000);
const imageResize = { maxWidth: 32, maxHeight: 24, maxBytes: 20_000, jpegQuality: 70 };

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const name = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.byteLength);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

function createImage(): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(256, 0);
	header.writeUInt32BE(256, 4);
	header[8] = 8;
	header[9] = 6;
	const pixels = Buffer.alloc((256 * 4 + 1) * 256);
	let seed = 19;
	for (let y = 0; y < 256; y++) {
		for (let x = 0; x < 256; x++) {
			const offset = y * (256 * 4 + 1) + 1 + x * 4;
			for (let channel = 0; channel < 3; channel++) {
				seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
				pixels[offset + channel] = seed >>> 24;
			}
			pixels[offset + 3] = 255;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

describe("pi-client canonical context features through a 64 KiB HTTP guard", () => {
	const servers: Server[] = [];
	const sessions: AgentSession[] = [];
	let directory: string | undefined;

	afterEach(async () => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const server of servers.splice(0).reverse()) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
		clearAllSessions();
		resetAllSessionTracking();
		vi.unstubAllEnvs();
	});

	async function createFixture(extensionFactories: ExtensionFactory[] = []) {
		directory = mkdtempSync(join(tmpdir(), "pi-client-context-features-"));
		const faux = fauxProvider({
			models: [
				{ id: "wide", contextWindow: 1_000_000 },
				{ id: "strict", contextWindow: 1_000_000, inputLimits: { images: { resize: imageResize } } },
			],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const backend = createPiServer({ sessionStoreDir: join(directory, "server"), authToken: "test-token" }, models);
		servers.push(backend);
		const backendUrl = await listen(backend);
		const requests: Array<{ path: string; bytes: number }> = [];
		let rejected = 0;
		const proxy = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks);
				requests.push({ path: request.url ?? "/", bytes: body.byteLength });
				if (body.byteLength > MAX_REQUEST_BYTES) {
					rejected++;
					response.writeHead(413).end("Body exceeds 65536 UTF-8 bytes");
					return;
				}
				const upstream = await fetch(`${backendUrl}${request.url}`, {
					method: request.method,
					headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
					...(body.byteLength > 0 ? { body } : {}),
				});
				response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "" });
				if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
				response.end();
			} catch (error) {
				if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
				else response.writeHead(500).end(String(error));
			}
		});
		servers.push(proxy);
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "test-token");
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const extensionsResult = await createTestExtensionsResult(extensionFactories);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model: faux.getModel(),
			tools: ["read", "bash"],
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			}),
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			autoSessionName: false,
		});
		sessions.push(session);
		const contexts: TranscriptContext[] = [];
		const routes: string[] = [];
		function responses(...texts: string[]): void {
			faux.setResponses(
				texts.map((text) => (context, _options, _state, model) => {
					contexts.push(structuredClone(context));
					routes.push(model.id);
					return fauxAssistantMessage(text);
				}),
			);
		}
		function verifyTransport(): void {
			expect(requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected).toBe(0);
			expect(getSession(session.sessionId)?.entries).toEqual([]);
		}
		return { session, runtime, faux, contexts, routes, responses, verifyTransport };
	}

	it("sends append-only context edits as projection and restores the original input on another branch", async () => {
		const fixture = await createFixture();
		const manager = fixture.session.sessionManager;
		const original = { role: "user" as const, content: `ORIGINAL:${largeText}`, timestamp: 1 };
		const userId = manager.appendMessage(original);
		const assistantId = manager.appendMessage(fauxAssistantMessage("OMITTED-ASSISTANT"));
		const toolId = manager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "omitted-call",
			isError: false,
			content: [{ type: "text", text: `OMITTED-TOOL:${largeText}` }],
			timestamp: 2,
		});
		manager.appendContextEdit(userId, { content: "superseded replacement" });
		manager.appendContextEdit(userId, { content: `PROJECTED:${largeText}` });
		manager.appendContextEdit(assistantId, null);
		manager.appendContextEdit(toolId, null);
		fixture.session.refreshContext();
		fixture.responses("edited answer");
		await fixture.session.prompt("edited branch");
		const sent = JSON.stringify(fixture.contexts[0]);
		expect(sent).toContain(`PROJECTED:${largeText}`);
		for (const omitted of ["ORIGINAL:", "OMITTED-ASSISTANT", "OMITTED-TOOL", "superseded replacement"])
			expect(sent).not.toContain(omitted);
		expect(manager.getEntry(userId)).toMatchObject({ message: original });
		expect(manager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(4);
		manager.branch(userId);
		fixture.session.refreshContext();
		fixture.responses("other branch answer");
		await fixture.session.prompt("other branch");
		expect(JSON.stringify(fixture.contexts[1])).toContain(`ORIGINAL:${largeText}`);
		expect(JSON.stringify(fixture.contexts[1])).not.toContain("PROJECTED:");
		expect(manager.getEntries().some((entry) => entry.id === toolId)).toBe(true);
		fixture.verifyTransport();
	});

	// #9789, #9822: filtering conversational messages must restore the prompt/tool head first.
	it("sends context_with_system output verbatim after restoring the complete prompt and tools", async () => {
		const order: string[] = [];
		let expected: AgentMessage[] = [];
		const fixture = await createFixture([
			(pi) => {
				pi.on("context_with_system", (event) => {
					order.push("context_with_system");
					expect(event.messages[0]?.role).toBe("system");
					expect(getCurrentTools(event.messages)).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ name: "read" }),
							expect.objectContaining({ name: "bash" }),
						]),
					);
					expected = event.messages.map((message) =>
						message.role === "system"
							? {
									...message,
									content: `EPHEMERAL-SYSTEM:${largeText}`,
									sections: undefined,
									toolsAdded: message.toolsAdded?.filter((tool) => tool.name !== "bash"),
								}
							: message,
					);
					return { messages: expected };
				});
				pi.on("context", (event) => {
					order.push("context");
					expect(event.messages.some((message) => message.role === "system")).toBe(false);
					return { messages: event.messages.slice(-1) };
				});
			},
		]);
		fixture.responses("done");
		await fixture.session.prompt("transformed input");
		expect(order).toEqual(["context", "context_with_system"]);
		expect(fixture.contexts[0].messages).toEqual(JSON.parse(JSON.stringify(expected)));
		expect(getCurrentSystemPrompt(fixture.contexts[0].messages)).toBe(`EPHEMERAL-SYSTEM:${largeText}`);
		expect(getCurrentTools(fixture.contexts[0].messages).map((tool) => tool.name)).toEqual(["read"]);
		expect(fixture.session.getActiveToolNames()).toContain("bash");
		expect(JSON.stringify(fixture.session.sessionManager.getEntries())).not.toContain("EPHEMERAL-SYSTEM:");
		fixture.verifyTransport();
	});

	it("continues from a retain-none turn boundary before consuming its queued follow-up", async () => {
		let handled = false;
		const fixture = await createFixture([
			(pi) => {
				pi.on("turn_end", () => {
					if (handled) return;
					handled = true;
					pi.sendUserMessage(`STEERING:${largeText}`, { deliverAs: "steer" });
					pi.sendUserMessage(`FOLLOW-UP:${largeText}`, { deliverAs: "followUp" });
					return {
						entries: [{ type: "compaction", summary: `HANDOFF:${largeText}`, firstKeptEntryId: null }],
						continue: true,
					};
				});
			},
		]);
		fixture.responses("discarded answer", "steering answer", "follow-up answer");
		await fixture.session.prompt("discarded input");
		expect(fixture.contexts).toHaveLength(3);
		const continued = JSON.stringify(fixture.contexts[1]);
		expect(continued).toContain(`HANDOFF:${largeText}`);
		expect(continued).toContain("STEERING:");
		for (const omitted of ["discarded input", "discarded answer", "FOLLOW-UP:"])
			expect(continued).not.toContain(omitted);
		expect(JSON.stringify(fixture.contexts[2])).toContain("FOLLOW-UP:");
		const entries = fixture.session.sessionManager.getEntries();
		const compaction = entries.find((entry) => entry.type === "compaction");
		expect(compaction).toMatchObject({ firstKeptEntryId: compaction?.id });
		expect(JSON.stringify(entries)).toContain("discarded input");
		expect(JSON.stringify(entries)).toContain("discarded answer");
		expect(fixture.session.pendingMessageCount).toBe(0);
		fixture.verifyTransport();
	});

	it("commits pre-settlement continuation context before the deferred follow-up request", async () => {
		let handled = false;
		const fixture = await createFixture([
			(pi) => {
				pi.on("agent_before_settle", () => {
					if (handled) return;
					handled = true;
					pi.sendUserMessage(`FOLLOW-UP:${largeText}`, { deliverAs: "followUp" });
					return {
						entries: [
							{
								type: "custom_message",
								customType: "boundary",
								content: `BOUNDARY:${largeText}`,
								display: false,
							},
						],
						continue: true,
					};
				});
			},
		]);
		fixture.responses("first", "boundary answer", "follow-up answer");
		await fixture.session.prompt("start");
		expect(fixture.contexts).toHaveLength(3);
		expect(JSON.stringify(fixture.contexts[1])).toContain(`BOUNDARY:${largeText}`);
		expect(JSON.stringify(fixture.contexts[1])).not.toContain("FOLLOW-UP:");
		expect(JSON.stringify(fixture.contexts[2])).toContain("FOLLOW-UP:");
		expect(fixture.session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "boundary", display: false }),
		);
		fixture.verifyTransport();
	});

	it("waits for every settled handler before a handler-triggered remote run", async () => {
		let triggered = false;
		const lifecycle: string[] = [];
		const fixture = await createFixture([
			(pi) => {
				pi.on("agent_start", () => {
					lifecycle.push("start");
				});
				pi.on("agent_settled", (_event, context) => {
					lifecycle.push(`first:${context.isIdle()}`);
					if (triggered) return;
					triggered = true;
					pi.sendMessage(
						{ customType: "settled-trigger", content: `LATER:${largeText}`, display: false },
						{ triggerTurn: true },
					);
				});
				pi.on("agent_settled", (_event, context) => {
					lifecycle.push(`second:${context.isIdle()}`);
				});
			},
		]);
		fixture.responses("first", "second");
		await fixture.session.prompt("start");
		expect(lifecycle).toEqual(["start", "first:true", "second:true", "start", "first:true", "second:true"]);
		expect(fixture.contexts).toHaveLength(2);
		expect(JSON.stringify(fixture.contexts[1])).toContain(`LATER:${largeText}`);
		fixture.verifyTransport();
	});

	it("prepares every remote request, finishes each turn, and previews queued input without consuming it", async () => {
		const fixture = await createFixture();
		const agent = fixture.session.agent;
		const originalPrepare = agent.prepareRequest;
		const originalFinish = agent.finishTurn;
		const lifecycle: string[] = [];
		let finished = 0;
		agent.prepareRequest = async (request, signal) => {
			const update = await originalPrepare?.(request, signal);
			lifecycle.push("prepare");
			const context = update?.context ?? request.context;
			return {
				...update,
				context: {
					...context,
					messages: [...context.messages, { role: "user", content: `PREPARED:${largeText}`, timestamp: 0 }],
				},
			};
		};
		agent.finishTurn = async (turn, signal) => {
			lifecycle.push("finish");
			const decision = await originalFinish?.(turn, signal);
			return ++finished === 1 ? { action: "continue" } : (decision ?? undefined);
		};
		await fixture.session.followUp("previewed follow-up");
		expect(JSON.stringify(agent.peekQueuedMessages())).toContain("previewed follow-up");
		expect(agent.peekQueuedMessages()).toEqual(agent.peekQueuedMessages());
		expect(fixture.session.pendingMessageCount).toBe(1);
		fixture.responses("first", "follow-up");
		await fixture.session.prompt("start");
		expect(lifecycle).toEqual(["prepare", "finish", "prepare", "finish"]);
		expect(fixture.contexts).toHaveLength(2);
		expect(fixture.contexts.every((context) => JSON.stringify(context).includes(`PREPARED:${largeText}`))).toBe(true);
		expect(JSON.stringify(fixture.contexts[0])).not.toContain("previewed follow-up");
		expect(JSON.stringify(fixture.contexts[1])).toContain("previewed follow-up");
		expect(agent.peekQueuedMessages()).toEqual([]);
		expect(JSON.stringify(fixture.session.sessionManager.getEntries())).not.toContain("PREPARED:");
		fixture.verifyTransport();
	});

	// #9631: the selected model's resize profile applies before sending user attachments.
	it("uses remote catalog image limits after before_agent_start selects another model", async () => {
		const fixture = await createFixture([
			(pi) => {
				pi.on("before_agent_start", async (_event, context) => {
					const strict = context.modelRegistry.find("faux", "strict");
					if (!strict) throw new Error("Expected strict model in remote catalog");
					await pi.setModel(strict);
				});
			},
		]);
		const strict = fixture.runtime.getModel("faux", "strict");
		expect(strict?.inputLimits).toEqual({ images: { resize: imageResize } });
		const image = createImage();
		expect(Buffer.byteLength(image)).toBeGreaterThan(MAX_REQUEST_BYTES);
		fixture.responses("image accepted");
		await fixture.session.prompt(largeText, { images: [{ type: "image", data: image, mimeType: "image/png" }] });
		expect(fixture.session.model?.id).toBe("strict");
		expect(fixture.routes).toEqual(["strict"]);
		const normalized = fixture.contexts[0].messages.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.filter((block) => block.type === "image")
				: [],
		)[0];
		if (!normalized) throw new Error("Expected normalized image in provider context");
		expect(normalized.data).not.toBe(image);
		expect(Buffer.byteLength(normalized.data)).toBeLessThanOrEqual(imageResize.maxBytes);
		const photon = await loadPhoton();
		if (!photon) throw new Error("Photon is required to verify image dimensions");
		const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(normalized.data, "base64"));
		try {
			expect(decoded.get_width()).toBe(24);
			expect(decoded.get_height()).toBe(24);
		} finally {
			decoded.free();
		}
		fixture.verifyTransport();
	});
});
