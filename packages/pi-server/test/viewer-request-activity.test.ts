import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { compactLegacy } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessageEvent,
	type ClassifierModel,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	fauxAssistantMessage,
	type ImageModel,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions, getSession } from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerThread } from "../src/viewer-types.ts";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
	...(await importOriginal<typeof AgentCore>()),
	compactLegacy: vi.fn(),
}));

const model: Model<"test-chat"> = {
	id: "chat",
	name: "Chat",
	api: "test-chat",
	provider: "activity",
	baseUrl: "http://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("server request activity", () => {
	let directory: string;
	let server: Server;
	let base: string;
	let cookie: string;
	let sessionId: string;
	let clock: number;
	let models: ReturnType<typeof createModels>;
	const headers = { Authorization: "Bearer activity-fixture", "Content-Type": "application/json" };

	async function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	}

	async function thread(): Promise<ViewerThread | undefined> {
		const response = await fetch(`${base}/viewer/api/threads/${sessionId}`, { headers: { Cookie: cookie } });
		if (response.status === 404) return undefined;
		expect(response.status).toBe(200);
		return ((await response.json()) as { thread: ViewerThread }).thread;
	}

	async function initialize(): Promise<void> {
		expect(
			(
				await post("/api/session/init", {
					sessionId,
					staticContext: { systemPrompt: "Pi\nCurrent working directory: D:/activity" },
				})
			).status,
		).toBe(200);
	}

	beforeEach(async () => {
		clearAllSessions();
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-request-activity-"));
		sessionId = randomUUID();
		clock = 100;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		models = createModels();
		server = createPiServer({ sessionStoreDir: directory, authToken: "activity-fixture" }, models);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing server address");
		base = `http://127.0.0.1:${address.port}`;
		const login = await fetch(`${base}/viewer/login`, { method: "POST", headers: { ...headers, Origin: base } });
		expect(login.status).toBe(200);
		cookie = login.headers.get("set-cookie")!.split(";")[0];
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.restoreAllMocks();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("records old stream request shapes without an observer, persists activity and leaves the durable tree unchanged", async () => {
		await initialize();
		const original = structuredClone(getSession(sessionId));
		const finish = gate();
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			await finish.promise;
			yield { type: "done", reason: "stop", message: fauxAssistantMessage("Answer") };
		};
		vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		expect((await thread())?.lastActiveAt).toBeNull();
		const response = await post("/api/stream", { sessionId, model });
		expect((await thread())?.lastActiveAt).toBe(100);
		clock = 200;
		finish.release();
		expect(await response.text()).toContain('"type":"done"');
		expect((await thread())?.lastActiveAt).toBe(200);
		expect(getSession(sessionId)).toEqual(original);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(new ViewerStore(directory).get(sessionId)?.lastActiveAt).toBe(200);
	});

	it("does not count completed replays, history reads, synchronization or metadata", async () => {
		await initialize();
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Answer") });
		stream.end();
		const provider = vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		await (await post("/api/stream", { sessionId, model, runId: "run" })).text();
		expect((await thread())?.lastActiveAt).toBe(100);
		clock = 900;
		await (await post("/api/stream", { sessionId, model, runId: "run" })).text();
		for (const suffix of ["history", "runs/run"]) {
			const response = await fetch(`${base}/api/session/${sessionId}/${suffix}`, { headers });
			expect(response.status).toBe(200);
			await response.text();
		}
		await initialize();
		await post("/api/session/sync", {
			sessionId,
			messages: [{ role: "user", content: "History", timestamp: 9999999 }],
		});
		await post("/api/session/update", {
			sessionId,
			staticContext: { systemPrompt: "Pi\nCurrent working directory: D:/moved" },
		});
		expect((await thread())?.lastActiveAt).toBe(100);
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it.each(["construction", "iteration"])("records stream %s failures", async (failure) => {
		await initialize();
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "start", partial: fauxAssistantMessage("") };
			clock = 250;
			throw new Error("Provider failed");
		};
		vi.spyOn(models, "streamSimple").mockImplementation(() => {
			if (failure === "construction") {
				clock = 250;
				throw new Error("Provider failed");
			}
			return stream;
		});
		const response = await post("/api/stream", { sessionId, model, runId: "failure" });
		expect(await response.text()).toContain("Provider failed");
		expect((await thread())?.lastActiveAt).toBe(250);
	});

	it("records abort completion only after provider cleanup", async () => {
		await initialize();
		const abort = gate();
		const cleanup = gate();
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "start", partial: fauxAssistantMessage("") };
			await abort.promise;
			await cleanup.promise;
			throw new DOMException("Aborted", "AbortError");
		};
		vi.spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
			options?.signal?.addEventListener("abort", abort.release, { once: true });
			return stream;
		});
		const response = await post("/api/stream", { sessionId, model, runId: "abort" });
		clock = 150;
		expect((await post("/api/stream", { sessionId, model, runId: "abort" })).status).toBe(409);
		expect((await thread())?.lastActiveAt).toBe(100);
		clock = 200;
		const cancellation = post(`/api/session/${sessionId}/runs/abort/abort`, {});
		await abort.promise;
		expect((await thread())?.lastActiveAt).toBe(100);
		clock = 300;
		cleanup.release();
		expect((await cancellation).status).toBe(200);
		await response.text();
		expect((await thread())?.lastActiveAt).toBe(300);
		clock = 900;
		expect((await post(`/api/session/${sessionId}/runs/abort/abort`, {})).status).toBe(200);
		expect((await post("/api/stream", { sessionId, model, runId: "abort" })).status).toBe(409);
		expect((await thread())?.lastActiveAt).toBe(300);
	});

	it("does not resurrect a deleted session when an unjournaled provider finishes", async () => {
		await initialize();
		const finish = gate();
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			await finish.promise;
			yield { type: "done", reason: "stop", message: fauxAssistantMessage("Answer") };
		};
		vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		const response = await post("/api/stream", { sessionId, model });
		expect((await fetch(`${base}/api/session/${sessionId}`, { method: "DELETE", headers })).status).toBe(200);
		clock = 500;
		finish.release();
		await response.text();
		expect(await thread()).toBeUndefined();
		expect(new ViewerStore(directory).get(sessionId)).toBeUndefined();
		expect(readdirSync(join(directory, ".viewer", "threads"))).toEqual([]);
	});

	it.each([false, true])(
		"records compaction execution and excludes run and leaf replays with streaming=%s",
		async (streamResponse) => {
			await initialize();
			const entries = ["u1", "u2"].map((id, index) => ({
				type: "message",
				id,
				parentId: index ? "u1" : null,
				timestamp: new Date(9999999 + index).toISOString(),
				message: { role: "user", content: "History", timestamp: 9999999 + index },
			}));
			await post("/api/session/tree/sync", { sessionId, entries, leafId: "u2" });
			const started = gate();
			const finish = gate();
			vi.mocked(compactLegacy).mockImplementation(async () => {
				started.release();
				await finish.promise;
				return {
					ok: true,
					value: { summary: "Summary", firstKeptEntryId: "u2", tokensBefore: 100, retainedTail: [] },
				};
			});
			const body = {
				sessionId,
				model,
				runId: "compact",
				streamResponse,
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			};
			const response = await post("/api/session/compact", body);
			await started.promise;
			expect((await thread())?.lastActiveAt).toBe(100);
			clock = 200;
			finish.release();
			expect(await response.text()).toContain('"success":true');
			expect((await thread())?.lastActiveAt).toBe(200);
			clock = 900;
			await (await post("/api/session/compact", body)).text();
			await (await post("/api/session/compact", { ...body, runId: "leaf-replay" })).text();
			expect((await thread())?.lastActiveAt).toBe(200);
			expect(compactLegacy).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["image", "classifier"] as const)(
		"records %s execution without an observer and excludes operation replay",
		async (kind) => {
			const image: ImageModel<"test-images"> = {
				type: "image",
				id: "image",
				name: "Image",
				api: "test-images",
				provider: "activity",
				baseUrl: "http://unused.invalid",
				input: ["text"],
				output: ["image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const classifier: ClassifierModel<"test-classifier"> = {
				type: "classifier",
				id: "classifier",
				name: "Classifier",
				api: "test-classifier",
				provider: "activity",
				baseUrl: "http://unused.invalid",
				input: ["text"],
				contextWindow: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			models.setProvider(
				createProvider({
					id: "activity",
					auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
					models: [image, classifier],
					images: {
						"test-images": {
							generateImages: async () => {
								throw new Error("Unused");
							},
						},
					},
					classifiers: {
						"test-classifier": {
							classify: async () => {
								throw new Error("Unused");
							},
						},
					},
				}),
			);
			const finish = gate();
			const result = { provider: "activity", model: kind, stopReason: "stop" as const, timestamp: 9999999 };
			const generate = vi.spyOn(models, "generateImages").mockImplementation(async () => {
				await finish.promise;
				return { ...result, api: image.api, output: [] };
			});
			const classify = vi.spyOn(models, "classify").mockImplementation(async () => {
				await finish.promise;
				return { ...result, api: classifier.api, answers: {} };
			});
			const endpoint = kind === "image" ? "/api/generate-images" : "/api/classify";
			const body = { sessionId, runId: "operation", model: kind === "image" ? image : classifier, context: {} };
			const response = await post(endpoint, body);
			expect((await thread())?.lastActiveAt).toBe(100);
			clock = 200;
			finish.release();
			expect(await response.text()).toContain("event: result");
			expect((await thread())?.lastActiveAt).toBe(200);
			clock = 900;
			await (await post(endpoint, body)).text();
			expect((await thread())?.lastActiveAt).toBe(200);
			expect(kind === "image" ? generate : classify).toHaveBeenCalledTimes(1);
			expect(getSession(sessionId)).toBeUndefined();
		},
	);

	it("records deferred stream execution", async () => {
		await initialize();
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			clock = 200;
			yield { type: "done", reason: "stop", message: fauxAssistantMessage("Deferred answer") };
		};
		const deferred = vi.spyOn(models, "streamDeferred").mockReturnValue(stream);
		const response = await post("/api/stream", {
			sessionId,
			model,
			runId: "deferred",
			requestKind: "deferred",
			deferredHandle: { id: "deferred-handle" },
		});
		await response.text();
		expect((await thread())?.lastActiveAt).toBe(200);
		expect(deferred).toHaveBeenCalledTimes(1);
	});

	it("does not count invalid deferred requests", async () => {
		await initialize();
		const deferred = vi.spyOn(models, "streamDeferred");
		const response = await post("/api/stream", { sessionId, model, requestKind: "deferred" });
		expect(response.status).toBe(400);
		expect((await thread())?.lastActiveAt).toBeNull();
		expect(deferred).not.toHaveBeenCalled();
	});

	it("records deferred cancellation execution and excludes replay", async () => {
		const cancel = vi.spyOn(models, "cancelDeferred").mockImplementation(async () => {
			clock = 200;
		});
		const body = { sessionId, model, runId: "cancel-deferred", handle: { id: "handle" } };
		await (await post("/api/cancel-deferred", body)).text();
		expect((await thread())?.lastActiveAt).toBe(200);
		clock = 900;
		await (await post("/api/cancel-deferred", body)).text();
		expect((await thread())?.lastActiveAt).toBe(200);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("reports activity persistence failures without changing the provider result", async () => {
		await initialize();
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(ViewerStore.prototype, "recordActivity").mockImplementation(() => {
			throw new Error("Activity storage unavailable");
		});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Answer") });
		stream.end();
		vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		const response = await post("/api/stream", { sessionId, model });
		expect(await response.text()).toContain('"type":"done"');
		expect(diagnostic).toHaveBeenCalledTimes(2);
		expect(diagnostic).toHaveBeenCalledWith(
			`Failed to record viewer activity for session ${sessionId}:`,
			expect.objectContaining({ message: "Activity storage unavailable" }),
		);
	});
});
