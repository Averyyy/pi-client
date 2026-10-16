import {
	type AssistantMessage,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resetAllSessionTracking } from "../src/core/pi-server-client.ts";

const providerId = "google-antigravity";
const model: Model<"google-antigravity"> = {
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-antigravity",
	provider: providerId,
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function credentialsWithOAuth(): Promise<InMemoryCredentialStore> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		access: "test",
		refresh: "test-refresh",
		expires: Number.MAX_SAFE_INTEGER,
		projectId: "test-project",
	}));
	return credentials;
}

describe("Google Antigravity ModelRuntime", () => {
	beforeEach(() => {
		vi.stubEnv("PI_SERVER_MODE", "false");
		resetAllSessionTracking();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetAllSessionTracking();
	});

	it("advertises native subscription login and starts without an account catalog", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		expect(runtime.getProvider(providerId)?.auth.oauth).toMatchObject({
			name: "Google Antigravity",
			isSubscription: true,
			loginLabel: "Sign in with Google Antigravity",
		});
		expect(runtime.getModels(providerId)).toEqual([]);
		expect(await runtime.getAvailable(providerId)).toEqual([]);
		expect(await runtime.getAuth(providerId)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("discovers the account chat picker IDs through Cloud Code and persists their exact limits", async () => {
		const modelsStore = new InMemoryModelsStore();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(`${model.baseUrl}/v1internal:fetchAvailableModels`);
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
			expect(JSON.parse(String(init?.body))).toEqual({ project: "test-project" });
			return Response.json({
				agentModelSorts: [{ groups: [{ modelIds: [model.id] }] }],
				models: {
					[model.id]: {
						displayName: model.name,
						maxTokens: model.contextWindow,
						maxOutputTokens: model.maxTokens,
						supportsImages: true,
						supportsThinking: true,
					},
					"unknown-account-model": { displayName: "Unknown", maxTokens: 200_000, maxOutputTokens: 8000 },
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const runtime = await ModelRuntime.create({
			credentials: await credentialsWithOAuth(),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});
		expect(runtime.getModels(providerId)).toEqual([]);
		const refreshed = await runtime.refresh({ providers: [providerId], allowNetwork: true });

		expect(refreshed.errors.size).toBe(0);
		expect(runtime.getModels(providerId)).toEqual([model]);
		expect(await runtime.getAvailable(providerId)).toEqual([model]);
		expect(runtime.isUsingOAuth(providerId)).toBe(true);
		expect(runtime.isUsingSubscription(providerId)).toBe(true);
		expect(await runtime.getAuth(model)).toMatchObject({
			auth: { apiKey: JSON.stringify({ token: "test", projectId: "test-project" }) },
		});
		expect((await modelsStore.read(providerId))?.models).toEqual([model]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("restores the account catalog offline and retains it when discovery fails", async () => {
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write(providerId, { models: [model], checkedAt: 1 });
		const fetchMock = vi.fn(async () => {
			throw new Error("account catalog unavailable");
		});
		vi.stubGlobal("fetch", fetchMock);
		const runtime = await ModelRuntime.create({
			credentials: await credentialsWithOAuth(),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});

		expect(runtime.getModels(providerId)).toEqual([model]);
		expect(await runtime.getAvailable(providerId)).toEqual([model]);
		expect(fetchMock).not.toHaveBeenCalled();
		const refreshed = await runtime.refresh({ providers: [providerId], allowNetwork: true });
		expect(refreshed.errors.get(providerId)?.message).toContain("account catalog unavailable");
		expect(runtime.getModels(providerId)).toEqual([model]);
		expect(await runtime.getAvailable(providerId)).toEqual([model]);
		expect((await modelsStore.read(providerId))?.models).toEqual([model]);
	});

	it.each([
		["runtime", true],
		["runtime", false],
		["provider", true],
		["provider", false],
	] as const)("routes %s inference through pi-server with client OAuth=%s", async (entryPoint, clientOAuth) => {
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_URL", "https://pi-server.test");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "server-token");
		const context = normalizeContext({
			systemPrompt: "Use the lookup tool.",
			tools: [{ name: "lookup", description: "Find a value", parameters: Type.Object({ key: Type.String() }) }],
			messages: [{ role: "user", content: "Look up answer", timestamp: 1 }],
		});
		const toolCall = {
			type: "toolCall" as const,
			id: "call-lookup",
			name: "lookup",
			arguments: { key: "answer" },
			thoughtSignature: "signed-tool-call",
		};
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "thinking", thinking: "Find the value.", thinkingSignature: "signed-thinking" }, toolCall],
			responseId: "antigravity-response",
			rawStopReason: "STOP",
			stopReason: "toolUse",
			usage: {
				input: 10,
				output: 3,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 33,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1234,
		};
		const requests: { path: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://pi-server.test");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-token");
				const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
				requests.push({ path: url.pathname, body });
				if (url.pathname === "/api/models") {
					return Response.json({ models: [model], available: [model], providers: [] });
				}
				if (url.pathname === "/api/session/init") return Response.json({ sessionId: body.sessionId });
				if (url.pathname === "/api/stream") {
					return new Response(
						[
							{ type: "start" },
							{ type: "toolcall_start", contentIndex: 0, id: toolCall.id, toolName: toolCall.name },
							{ type: "toolcall_end", contentIndex: 0, toolCall },
							{ type: "done", reason: "toolUse", usage: message.usage, message },
						]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				throw new Error(`Unexpected pi-server request: ${url.pathname}`);
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: clientOAuth ? await credentialsWithOAuth() : new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		expect(await runtime.getAvailable(providerId)).toEqual([model]);
		expect(runtime.hasConfiguredAuth(providerId)).toBe(true);
		const stream =
			entryPoint === "runtime"
				? runtime.streamSimple(model, context, { sessionId: "antigravity-runtime" })
				: runtime.getProvider(providerId)!.stream(model, context, { sessionId: "antigravity-runtime" });
		const events = [];
		for await (const event of stream) events.push(event);
		expect(await stream.result()).toEqual(message);
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({ toolCall });
		expect(requests.map((request) => request.path)).toEqual(["/api/models", "/api/session/init", "/api/stream"]);
		const request = requests.find((request) => request.path === "/api/stream")?.body;
		expect(request).toMatchObject({ model, contextOverlay: context.messages });
		expect(request?.options).toMatchObject(
			clientOAuth ? { apiKey: JSON.stringify({ token: "test", projectId: "test-project" }) } : {},
		);
		if (!clientOAuth) expect(request?.options).not.toHaveProperty("apiKey");
	});
});
