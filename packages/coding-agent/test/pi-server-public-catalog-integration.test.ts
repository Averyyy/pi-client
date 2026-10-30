import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyModel, createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerAccounts } from "../../pi-server/src/accounts.ts";
import { PublicModelCatalog } from "../../pi-server/src/public-model-catalog.ts";
import { createPiServer } from "../../pi-server/src/server.ts";
import { VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

function catalogModels(id: string): AnyModel[] {
	const common = {
		id,
		name: id,
		provider: "openai",
		baseUrl: "https://inference.invalid/v1",
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return [
		{ ...common, input: ["text"], api: "openai-responses", reasoning: false, contextWindow: 10000, maxTokens: 1000 },
		{ ...common, input: ["text"], type: "image", api: "openai-images", output: ["image"] },
		{ ...common, input: ["text"], type: "classifier", api: "openai-decisions", contextWindow: 10000 },
	];
}

describe("ModelRuntime public catalog through pi-server HTTP", () => {
	let directory: string;
	let upstream: Server;
	let server: Server;
	let serverUrl: string;
	let status: number;
	let revision: number;
	let upstreamRequests: { url: URL; headers: IncomingHttpHeaders }[];
	let clientRequests: { url: URL; headers: IncomingHttpHeaders }[];

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-catalog-integration-"));
		vi.stubEnv("PI_SERVER_CONFIG", undefined);
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_SERVER_AUTH_TOKEN", "fixture-server-token");
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("OPENAI_API_KEY", undefined);
		vi.stubEnv("HF_TOKEN", undefined);
		vi.spyOn(builtinProviderCatalog, "getBuiltinModelDataGeneratedAt").mockReturnValue(
			Date.parse("2026-10-30T07:58:53.845Z"),
		);
		vi.spyOn(builtinProviderCatalog, "builtinProviders").mockImplementation(() => [
			openaiProvider(),
			huggingfaceProvider(),
		]);
		status = 200;
		revision = 1;
		upstreamRequests = [];
		clientRequests = [];
		upstream = createServer((req, res) => {
			upstreamRequests.push({ url: new URL(req.url ?? "", "http://fixture"), headers: req.headers });
			res.writeHead(status, {
				"Content-Type": "application/json",
				ETag: `"catalog-${revision}"`,
				"Last-Modified": "Thu, 29 Oct 2026 13:12:00 GMT",
			});
			res.end(status === 304 ? undefined : JSON.stringify(catalogModels(`public-${revision}`)));
		});
		const upstreamUrl = await listen(upstream);
		const serverCredentials = new InMemoryCredentialStore();
		await serverCredentials.modify("huggingface", async () => ({ type: "api_key", key: "fixture-server-hf-key" }));
		const serverModels = createModels({ credentials: serverCredentials });
		serverModels.setProvider(huggingfaceProvider());
		server = createPiServer(
			{
				authToken: "fixture-server-token",
				sessionStoreDir: join(directory, "sessions"),
				accountStoreDir: join(directory, "accounts"),
				uploadDir: join(directory, "uploads"),
			},
			serverModels,
			new ServerAccounts(join(directory, "accounts"), []),
			new PublicModelCatalog(join(directory, "catalog"), upstreamUrl),
		);
		serverUrl = await listen(server);
		server.prependListener("request", (req) => {
			clientRequests.push({ url: new URL(req.url ?? "", serverUrl), headers: req.headers });
		});
		vi.stubEnv("PI_SERVER_URL", serverUrl);
		const networkFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin !== serverUrl && url.origin !== upstreamUrl)
				throw new Error(`External request forbidden: ${url.origin}`);
			return networkFetch(input, init);
		});
	});

	afterEach(async () => {
		for (const endpoint of [server, upstream]) {
			endpoint.closeAllConnections();
			await new Promise<void>((resolve, reject) => endpoint.close((error) => (error ? reject(error) : resolve())));
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	async function client(configured = true, modelsStore = new InMemoryModelsStore()) {
		const credentials = new InMemoryCredentialStore();
		if (configured)
			await credentials.modify("openai", async () => ({ type: "api_key", key: "fixture-client-openai-key" }));
		return ModelRuntime.create({ credentials, modelsPath: null, modelsStore, allowModelNetwork: true });
	}

	it("requests only client-configured providers and shares public metadata without sharing availability", async () => {
		const store = new InMemoryModelsStore();
		const first = await client(true, store);
		const second = await client();
		expect(first.getError()).toBeUndefined();
		expect(second.getError()).toBeUndefined();
		expect(upstreamRequests).toHaveLength(1);
		expect(clientRequests).toHaveLength(2);
		for (const request of clientRequests) {
			expect(request.url.pathname).toBe("/api/model-catalog/providers/openai");
			expect(request.url.searchParams.get("pi-version")).toBe(VERSION);
			expect(request.headers.authorization).toBe("Bearer fixture-server-token");
			expect(request.headers["x-api-key"]).toBeUndefined();
		}
		expect(upstreamRequests[0].url.pathname).toBe("/api/models/providers/openai");
		expect(upstreamRequests[0].url.searchParams.get("pi-version")).toBe(VERSION);
		expect(upstreamRequests[0].url.searchParams.get("types")).toBe("chat,image,classifier");
		expect(upstreamRequests[0].headers.authorization).toBeUndefined();
		expect(upstreamRequests[0].headers["x-api-key"]).toBeUndefined();
		for (const type of ["chat", "image", "classifier"] as const) {
			expect(first.getModelOfType(type, "openai", "public-1")).toBeDefined();
			expect((await second.getAvailableOfType(type, "openai")).some((model) => model.id === "public-1")).toBe(true);
		}
		expect(await first.getAllAvailable("huggingface")).toEqual([]);
		const unconfigured = await client(false, store);
		expect(clientRequests).toHaveLength(2);
		for (const type of ["chat", "image", "classifier"] as const) {
			expect(unconfigured.getModelOfType(type, "openai", "public-1")).toBeDefined();
		}
		expect(await unconfigured.getAllAvailable()).toEqual([]);
		expect(upstreamRequests).toHaveLength(1);
	});

	it("revalidates on forced refresh, preserves metadata on 304, and receives the next revision", async () => {
		const runtime = await client();
		status = 304;
		expect((await runtime.refresh({ force: true })).errors.size).toBe(0);
		expect(upstreamRequests).toHaveLength(2);
		expect(upstreamRequests[1].headers["if-none-match"]).toBe('"catalog-1"');
		expect(clientRequests[1].url.searchParams.get("force")).toBe("true");
		expect(runtime.getModel("openai", "public-1")).toBeDefined();
		status = 200;
		revision = 2;
		expect((await runtime.refresh({ force: true })).errors.size).toBe(0);
		expect(upstreamRequests).toHaveLength(3);
		expect(runtime.getModel("openai", "public-2")).toBeDefined();
		expect(runtime.getModel("openai", "public-1")).toBeUndefined();
		expect((await runtime.refresh()).errors.size).toBe(0);
		expect(clientRequests).toHaveLength(4);
		expect(upstreamRequests).toHaveLength(3);
	});
});
