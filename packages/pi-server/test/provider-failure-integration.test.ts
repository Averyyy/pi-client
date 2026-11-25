import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import { CompactionError, compactLegacy } from "@earendil-works/pi-agent-core";
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
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions } from "../src/session-store.ts";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
	...(await importOriginal<typeof AgentCore>()),
	compactLegacy: vi.fn(),
}));

const model: Model<"test-chat"> = {
	id: "chat",
	name: "Chat",
	api: "test-chat",
	provider: "failure-fixture",
	baseUrl: "http://secret.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("provider failure logging", () => {
	let server: Server;
	let directory: string;
	let base: string;
	let sessionId: string;
	let models: ReturnType<typeof createModels>;
	let diagnostic: MockInstance<typeof console.error>;
	const headers = { Authorization: "Bearer fixture", "Content-Type": "application/json" };

	async function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	}

	beforeEach(async () => {
		clearAllSessions();
		directory = mkdtempSync(join(tmpdir(), "pi-failure-log-"));
		sessionId = randomUUID();
		models = createModels();
		diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		server = createPiServer({ sessionStoreDir: directory, authToken: "fixture" }, models);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing server address");
		base = `http://127.0.0.1:${address.port}`;
		await post("/api/session/init", { sessionId, staticContext: { systemPrompt: "secret prompt" } });
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.restoreAllMocks();
		clearAllSessions();
		rmSync(directory, { recursive: true, force: true });
	});

	it("rejects Antigravity inference before provider dispatch", async () => {
		const stream = vi.spyOn(models, "streamSimple");
		const response = await post("/api/stream", { sessionId, model: { ...model, provider: "google-antigravity" } });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("local agy CLI") });
		expect(stream).not.toHaveBeenCalled();
	});

	it.each([429, 503])("logs terminal HTTP %s while preserving the SSE error", async (status) => {
		const error = {
			...fauxAssistantMessage(""),
			stopReason: "error" as const,
			errorMessage: "private upstream error",
			...(status === 429
				? {
						diagnostics: [
							{
								type: "google_antigravity_response_failure",
								timestamp: 1,
								details: {
									status: 429,
									rpcStatus: "RESOURCE_EXHAUSTED",
									reason: "RATE_LIMIT_EXCEEDED",
									retryDelay: "30s",
									privatePayload: "secret diagnostic",
								},
							},
						],
					}
				: {}),
		};
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "error", reason: "error", error };
		};
		vi.spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
			void options?.onResponse?.({ status, headers: { authorization: "secret" } }, model);
			return stream;
		});
		const response = await post("/api/stream", {
			sessionId,
			model,
			runId: "failed",
			contextOverlay: [{ role: "user", content: "secret message", timestamp: 1 }],
			options: { reasoning: "high", maxTokens: 100, apiKey: "secret key" },
		});
		expect(await response.text()).toContain("private upstream error");
		expect(diagnostic).toHaveBeenCalledTimes(1);
		const line = diagnostic.mock.calls[0][0] as string;
		expect(JSON.parse(line)).toMatchObject({
			event: "provider_failure",
			operation: "stream",
			phase: "result",
			sessionId,
			runId: "failed",
			provider: model.provider,
			model: model.id,
			api: model.api,
			upstreamStatus: status,
			upstreamResponses: 1,
			reasoning: "high",
			maxTokens: 100,
			messageCount: 1,
			toolCount: 0,
		});
		if (status === 429)
			expect(JSON.parse(line)).toMatchObject({
				providerStatus: 429,
				providerCode: "RESOURCE_EXHAUSTED",
				providerReason: "RATE_LIMIT_EXCEEDED",
				retryDelay: "30s",
			});
		expect(line).not.toMatch(/secret|private upstream error/);
		await (await fetch(`${base}/api/session/${sessionId}/runs/failed`, { headers })).text();
		expect(diagnostic).toHaveBeenCalledTimes(1);
	});

	it.each(["dispatch", "iteration", "end"])("logs one %s failure without a run id", async (phase) => {
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "start", partial: fauxAssistantMessage("") };
			if (phase === "iteration") throw new TypeError("secret transport error");
		};
		vi.spyOn(models, "streamSimple").mockImplementation(() => {
			if (phase === "dispatch") throw new Error("secret dispatch error");
			return stream;
		});
		await (await post("/api/stream", { sessionId, model })).text();
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect(JSON.parse(diagnostic.mock.calls[0][0] as string)).toMatchObject({
			event: "provider_failure",
			phase: phase === "dispatch" ? "dispatch" : "stream",
		});
	});

	it("does not log successful execution or completed replay", async () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") });
		stream.end();
		const provider = vi.spyOn(models, "streamSimple").mockReturnValue(stream);
		for (let index = 0; index < 2; index++)
			await (await post("/api/stream", { sessionId, model, runId: "ok" })).text();
		expect(provider).toHaveBeenCalledTimes(1);
		expect(diagnostic).not.toHaveBeenCalled();
	});

	it("does not log explicit user cancellation", async () => {
		let aborted!: () => void;
		const cancellation = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const stream = createAssistantMessageEventStream();
		stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "start", partial: fauxAssistantMessage("") };
			await cancellation;
			throw new DOMException("Aborted", "AbortError");
		};
		vi.spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
			options?.signal?.addEventListener("abort", aborted, { once: true });
			return stream;
		});
		const response = await post("/api/stream", { sessionId, model, runId: "abort" });
		expect((await post(`/api/session/${sessionId}/runs/abort/abort`, {})).status).toBe(200);
		await response.text();
		expect(diagnostic).not.toHaveBeenCalled();
	});

	it.each([false, true])("logs compaction result failure with streaming=%s", async (streamResponse) => {
		const entries = ["u1", "u2"].map((id, index) => ({
			type: "message",
			id,
			parentId: index ? "u1" : null,
			timestamp: new Date(index).toISOString(),
			message: { role: "user", content: "History", timestamp: index },
		}));
		await post("/api/session/tree/sync", { sessionId, entries, leafId: "u2" });
		vi.mocked(compactLegacy).mockResolvedValue({
			ok: false,
			error: new CompactionError("summarization_failed", "secret failure"),
		});
		await (
			await post("/api/session/compact", {
				sessionId,
				model,
				runId: "compact",
				streamResponse,
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			})
		).text();
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect(JSON.parse(diagnostic.mock.calls[0][0] as string)).toMatchObject({
			operation: "compact",
			phase: "result",
			code: "summarization_failed",
		});
	});

	it("logs deferred cancellation provider failures", async () => {
		vi.spyOn(models, "cancelDeferred").mockRejectedValue(new Error("secret provider error"));
		await (
			await post("/api/cancel-deferred", { sessionId, model, runId: "deferred", handle: { id: "secret handle" } })
		).text();
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect(JSON.parse(diagnostic.mock.calls[0][0] as string)).toMatchObject({
			operation: "deferred-cancel",
			phase: "dispatch",
		});
	});

	it.each(["image", "classifier"] as const)("logs %s result failure once across replay", async (kind) => {
		const image: ImageModel<"test-image"> = {
			type: "image",
			id: "image",
			name: "Image",
			api: "test-image",
			provider: model.provider,
			baseUrl: model.baseUrl,
			input: ["text"],
			output: ["image"],
			cost: model.cost,
		};
		const classifier: ClassifierModel<"test-classifier"> = {
			type: "classifier",
			id: "classifier",
			name: "Classifier",
			api: "test-classifier",
			provider: model.provider,
			baseUrl: model.baseUrl,
			input: ["text"],
			cost: model.cost,
			contextWindow: 1000,
		};
		models.setProvider(
			createProvider({
				id: model.provider,
				models: [image, classifier],
				auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
				images: {
					"test-image": {
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
		const result = {
			provider: model.provider,
			model: kind,
			stopReason: "error" as const,
			errorMessage: "secret failure",
			timestamp: 1,
		};
		const generate = vi.spyOn(models, "generateImages").mockResolvedValue({ ...result, api: image.api, output: [] });
		const classify = vi.spyOn(models, "classify").mockResolvedValue({ ...result, api: classifier.api, answers: {} });
		const body = { sessionId, runId: "operation", model: kind === "image" ? image : classifier, context: {} };
		const endpoint = kind === "image" ? "/api/generate-images" : "/api/classify";
		for (let index = 0; index < 2; index++) await (await post(endpoint, body)).text();
		expect(kind === "image" ? generate : classify).toHaveBeenCalledTimes(1);
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect(JSON.parse(diagnostic.mock.calls[0][0] as string)).toMatchObject({ operation: kind, phase: "result" });
	});
});
