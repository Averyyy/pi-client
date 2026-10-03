import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createModels, normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions } from "../../pi-server/src/session-store.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const MAX_REQUEST_BYTES = 65_536;
const largeText = "汉字😀".repeat(20_000);

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("pi-client session features through a 64 KiB HTTP proxy", () => {
	const servers: Server[] = [];
	let directory: string | undefined;

	afterEach(async () => {
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

	async function createFixture(enableProviderHooks = false) {
		directory = mkdtempSync(join(tmpdir(), "pi-client-session-features-"));
		const faux = fauxProvider({ models: [{ id: "remote-chat", contextWindow: 1_000_000 }] });
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
				if (upstream.body) {
					for await (const chunk of upstream.body) response.write(chunk);
				}
				response.end();
			} catch (error) {
				response.writeHead(500).end(String(error));
			}
		});
		servers.push(proxy);
		vi.stubEnv("PI_SERVER_URL", await listen(proxy));
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "test-token");
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_CLIENT_MAX_REQUEST_KB", "64");
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const inputEvents: string[] = [];
		const providerEvents: string[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerCommand("handled", { handler: async () => {} });
				pi.on("input", (event) => {
					inputEvents.push(event.text);
					if (event.text === "intercept") return { action: "handled" };
				});
				if (enableProviderHooks)
					pi.on("before_provider_request", () => {
						providerEvents.push("before_provider_request");
						return { replacement: largeText };
					});
				if (enableProviderHooks)
					pi.on("after_provider_response", (event) => {
						expect(event.status).toBe(200);
						providerEvents.push("after_provider_response");
					});
				if (enableProviderHooks)
					pi.on("provider_stream_event", (event) => {
						expect(event.data).toEqual({ type: "fixture-event" });
						providerEvents.push("provider_stream_event");
					});
			},
		]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, keepRecentTokens: 4096 },
				retry: { enabled: false },
			}),
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			autoSessionName: false,
		});
		return { session, runtime, faux, requests, inputEvents, providerEvents, rejected: () => rejected };
	}

	// #9098 and #9803: accepted inputs report their own disposition, including extension interception.
	it("preserves prompt, steer, follow-up dispositions and server-only auth across oversized queued turns", async () => {
		const { session, runtime, faux, requests, rejected } = await createFixture();
		try {
			expect(await runtime.getAuth(faux.getModel())).toBeUndefined();
			await session.setModel(faux.getModel());
			const dispositions: string[] = [];
			await session.prompt("/handled", { preflightResult: (result) => dispositions.push(result) });
			expect(await session.steer("intercept")).toBe("handled");
			expect(await session.followUp(largeText)).toBe("queued");
			let releaseFirst: ((message: AssistantMessage) => void) | undefined;
			const firstResponse = new Promise<AssistantMessage>((resolve) => {
				releaseFirst = resolve;
			});
			faux.setResponses([() => firstResponse, fauxAssistantMessage("steering"), fauxAssistantMessage("follow-up")]);
			const run = session.prompt(largeText, { preflightResult: (result) => dispositions.push(result) });
			await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
			expect(await session.steer(largeText)).toBe("queued");
			await session.prompt("queued from RPC", {
				streamingBehavior: "followUp",
				preflightResult: (result) => dispositions.push(result),
			});
			faux.appendResponses([fauxAssistantMessage("RPC follow-up")]);
			releaseFirst?.(fauxAssistantMessage("first"));
			await run;
			expect(dispositions).toEqual(["handled", "started", "queued"]);
			expect(session.getLastAssistantText()).toBe("RPC follow-up");
			expect(session.pendingMessageCount).toBe(0);
			expect(session.getSessionStats().assistantMessages).toBe(4);
			expect(faux.state.callCount).toBe(4);
			expect(requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
			const unknown = resolveCliModel({ cliProvider: "faux", cliModel: "missing-chat", modelRuntime: runtime });
			expect(unknown.model).toBeUndefined();
			expect(unknown.error).toContain("not found");
		} finally {
			session.dispose();
		}
	});

	it("summarizes branches and compacts the authoritative tree without client provider credentials", async () => {
		const { session, faux, requests, rejected } = await createFixture();
		try {
			faux.setResponses([
				fauxAssistantMessage("first"),
				fauxAssistantMessage("second"),
				fauxAssistantMessage("Abandoned branch summary"),
				fauxAssistantMessage("Compacted operational state"),
			]);
			await session.prompt(largeText);
			const firstUser = session.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!firstUser) throw new Error("Expected first user entry");
			await session.prompt(largeText);
			const result = await session.navigateTree(firstUser.id, { summarize: true });
			expect(result.cancelled).toBe(false);
			expect(result.summaryEntry?.summary).toContain("Abandoned branch summary");
			await session.prompt(largeText);
			faux.appendResponses([fauxAssistantMessage("Compacted operational state")]);
			const compacted = await session.compact();
			expect(compacted.summary).toContain("Compacted operational state");
			expect(session.sessionManager.getBranch().at(-1)?.type).toBe("compaction");
			expect(requests.some((request) => request.path === "/api/session/compact")).toBe(true);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("forwards explicit caller credentials and headers through the SDK remote stream", async () => {
		const { session, faux, requests, rejected } = await createFixture();
		try {
			faux.setResponses([
				(_context, options) => {
					expect(options?.apiKey).toBe("fixture-caller-key");
					expect(options?.headers?.["X-Fixture"]).toBe("caller-header");
					return fauxAssistantMessage("forwarded");
				},
			]);
			const stream = await session.agent.streamFunction(
				faux.getModel(),
				normalizeContext({ messages: [{ role: "user", content: largeText, timestamp: 1 }] }),
				{ apiKey: "fixture-caller-key", headers: { "X-Fixture": "caller-header" } },
			);
			expect((await stream.result()).content).toEqual([{ type: "text", text: "forwarded" }]);
			expect(faux.state.callCount).toBe(1);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("awaits SDK payload replacement and response observers across bounded callback replies", async () => {
		const { session, faux, requests, rejected } = await createFixture();
		try {
			const events: string[] = [];
			let releasePayload: (() => void) | undefined;
			let releaseResponse: (() => void) | undefined;
			const payloadGate = new Promise<void>((resolve) => {
				releasePayload = resolve;
			});
			const responseGate = new Promise<void>((resolve) => {
				releaseResponse = resolve;
			});
			faux.setResponses([
				async (_context, options, _state, model) => {
					events.push("provider-response");
					const payload = await options?.onPayload?.({ original: largeText }, model);
					expect(payload).toEqual({ replacement: largeText });
					events.push("provider-payload");
					return fauxAssistantMessage("observed");
				},
			]);
			const stream = await session.agent.streamFunction(
				faux.getModel(),
				normalizeContext({ messages: [{ role: "user", content: "callbacks", timestamp: 1 }] }),
				{
					onPayload: async (payload, model) => {
						expect(payload).toEqual({ original: largeText });
						expect(model.id).toBe("remote-chat");
						events.push("client-payload");
						await payloadGate;
						return { replacement: largeText };
					},
					onResponse: async (response, model) => {
						expect(response).toEqual({ status: 200, headers: {} });
						expect(model.id).toBe("remote-chat");
						events.push("client-response");
						await responseGate;
					},
				},
			);
			const result = stream.result();
			let completed: AssistantMessage | undefined;
			void result.then((message) => {
				completed = message;
			});
			await vi.waitFor(() => {
				if (completed) expect(completed.errorMessage).toBeUndefined();
				expect(events).toEqual(["client-response"]);
			});
			releaseResponse?.();
			await vi.waitFor(() => expect(events).toEqual(["client-response", "provider-response", "client-payload"]));
			releasePayload?.();
			expect((await result).content).toEqual([{ type: "text", text: "observed" }]);
			expect(events).toEqual(["client-response", "provider-response", "client-payload", "provider-payload"]);
			expect(requests.some((request) => request.path === "/api/request/chunk")).toBe(true);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("dispatches session extension request and response hooks through the remote callback bridge", async () => {
		const { session, faux, requests, providerEvents, rejected } = await createFixture(true);
		try {
			faux.setResponses([
				async (_context, options, _state, model) => {
					expect(await options?.onPayload?.({ original: largeText }, model)).toEqual({ replacement: largeText });
					await options?.onProviderStreamEvent?.({ type: "fixture-event" }, model);
					return fauxAssistantMessage("extension hooks");
				},
			]);
			await session.prompt(largeText);
			expect(session.getLastAssistantText()).toBe("extension hooks");
			expect(providerEvents).toEqual([
				"after_provider_response",
				"before_provider_request",
				"provider_stream_event",
			]);
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("omits unused internal callbacks and raw observation from ordinary remote prompts", async () => {
		const { session, faux, requests, rejected } = await createFixture();
		try {
			faux.setResponses([
				(_context, options) => {
					expect(options?.onPayload).toBeUndefined();
					expect(options?.onResponse).toBeUndefined();
					expect(options?.onProviderStreamEvent).toBeUndefined();
					return fauxAssistantMessage("ordinary");
				},
			]);
			await session.prompt(largeText);
			expect(session.getLastAssistantText()).toBe("ordinary");
			expect(requests.every((request) => request.bytes <= MAX_REQUEST_BYTES)).toBe(true);
			expect(rejected()).toBe(0);
		} finally {
			session.dispose();
		}
	});
});
