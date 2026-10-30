import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_CATALOG_REFRESH_INTERVAL_MS, PublicModelCatalog } from "../src/public-model-catalog.ts";
import { createPiServer } from "../src/server.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("public model catalog", () => {
	let directory: string;
	let upstream: Server;
	let upstreamUrl: string;
	let catalog: PublicModelCatalog;
	let server: Server | undefined;
	let now: number;
	let status: number;
	let body: string;
	let requests: { url: string; headers: IncomingHttpHeaders }[];
	let gate: Promise<void> | undefined;
	let releaseGate: (() => void) | undefined;
	let onRequest: (() => void) | undefined;
	const etag = '"catalog-1"';
	const lastModified = "Thu, 29 Oct 2026 00:00:00 GMT";

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-public-catalog-"));
		now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		status = 200;
		body = JSON.stringify({ models: [{ id: "test", provider: "openai" }] });
		requests = [];
		gate = undefined;
		releaseGate = undefined;
		onRequest = undefined;
		upstream = createServer(async (req, res) => {
			requests.push({ url: req.url ?? "", headers: req.headers });
			onRequest?.();
			if (gate) await gate;
			res.writeHead(status, { "Content-Type": "application/json", ETag: etag, "Last-Modified": lastModified });
			res.end(status === 304 ? undefined : body);
		});
		upstreamUrl = await listen(upstream);
		catalog = new PublicModelCatalog(join(directory, "catalog"), upstreamUrl);
	});

	afterEach(async () => {
		releaseGate?.();
		await catalog.close();
		if (server) {
			await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
			server = undefined;
		}
		upstream.closeAllConnections();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("does not fetch at construction and shares concurrent provider requests", async () => {
		expect(requests).toEqual([]);
		gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const started = new Promise<void>((resolve) => {
			onRequest = resolve;
		});
		const first = catalog.get("openai", "0.86.0");
		const second = catalog.get("openai", "0.86.0");
		await started;
		expect(requests).toHaveLength(1);
		releaseGate?.();
		expect(await first).toEqual(await second);
		expect((await catalog.get("openai", "0.86.0")).body).toBe(body);
		expect(requests).toHaveLength(1);
		const url = new URL(requests[0].url, upstreamUrl);
		expect(url.pathname).toBe("/api/models/providers/openai");
		expect(url.searchParams.get("types")).toBe("chat,image,classifier");
		expect(url.searchParams.get("pi-version")).toBe("0.86.0");
		expect(requests[0].headers["user-agent"]).toContain("0.86.0");
	});

	it("revalidates expired entries with ETag and preserves the cached body on 304", async () => {
		const original = await catalog.get("openai", "0.86.0");
		now += PUBLIC_CATALOG_REFRESH_INTERVAL_MS;
		status = 304;
		const refreshed = await catalog.get("openai", "0.86.0");
		expect(requests[1].headers["if-none-match"]).toBe(etag);
		expect(refreshed).toEqual({ ...original, checkedAt: now });
		await catalog.get("openai", "0.86.0");
		expect(requests).toHaveLength(2);
	});

	it("forces a fresh entry to revalidate and shares concurrent forced requests", async () => {
		await catalog.get("openai", "0.86.0");
		status = 304;
		await Promise.all([catalog.get("openai", "0.86.0", true), catalog.get("openai", "0.86.0", true)]);
		expect(requests).toHaveLength(2);
		expect(requests[1].headers["if-none-match"]).toBe(etag);
	});

	it("retains expired cache and retries on the next ordinary request after an upstream failure", async () => {
		await catalog.get("openai", "0.86.0");
		const path = join(directory, "catalog", readdirSync(join(directory, "catalog"))[0]);
		const persisted = readFileSync(path, "utf8");
		now += PUBLIC_CATALOG_REFRESH_INTERVAL_MS;
		status = 503;
		await expect(catalog.get("openai", "0.86.0")).rejects.toThrow("503");
		expect(readFileSync(path, "utf8")).toBe(persisted);
		status = 304;
		expect((await catalog.get("openai", "0.86.0")).body).toBe(body);
		expect(requests).toHaveLength(3);
		expect(requests[2].headers["if-none-match"]).toBe(etag);
	});

	it("isolates exact client versions and reloads fresh persistent entries after restart", async () => {
		const first = await catalog.get("openai", "0.86.0");
		body = JSON.stringify({ models: [{ id: "second" }] });
		const second = await catalog.get("openai", "0.86.1");
		expect(second.body).not.toBe(first.body);
		await catalog.close();
		catalog = new PublicModelCatalog(join(directory, "catalog"), upstreamUrl);
		expect(await catalog.get("openai", "0.86.0")).toEqual(first);
		expect(await catalog.get("openai", "0.86.1")).toEqual(second);
		expect(requests).toHaveLength(2);
	});

	it.each([404, 501])("caches upstream %s without fetching another provider", async (upstreamStatus) => {
		status = upstreamStatus;
		expect((await catalog.get("openai", "0.86.0")).status).toBe(upstreamStatus);
		expect((await catalog.get("openai", "0.86.0")).status).toBe(upstreamStatus);
		expect(requests).toHaveLength(1);
	});

	it("rejects non-public providers and unsafe or missing versions without upstream requests", async () => {
		for (const provider of ["devin", "google-antigravity", "radius", "custom", "../openai"]) {
			await expect(catalog.get(provider, "0.86.0")).rejects.toMatchObject({ status: 404 });
		}
		for (const version of [null, "", "../../catalog", "0.86.0/../other"]) {
			await expect(catalog.get("openai", version)).rejects.toMatchObject({ status: 400 });
		}
		expect(requests).toHaveLength(0);
		expect((await catalog.get("openrouter", "0.86.0-piclient.1")).status).toBe(200);
	});

	it("aborts and drains an in-flight catalog fetch on close", async () => {
		gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const started = new Promise<void>((resolve) => {
			onRequest = resolve;
		});
		const pending = catalog.get("openai", "0.86.0");
		const rejected = expect(pending).rejects.toThrow("Public model catalog closed");
		await started;
		await catalog.close();
		await rejected;
		await expect(catalog.get("openai", "0.86.0")).rejects.toThrow("Public model catalog closed");
	});

	it("authenticates the HTTP route, returns validators, and never forwards client credentials", async () => {
		server = createPiServer(
			{
				authToken: "server-secret",
				sessionStoreDir: join(directory, "sessions"),
				accountStoreDir: join(directory, "accounts"),
			},
			createModels(),
			undefined,
			catalog,
		);
		const baseUrl = await listen(server);
		expect(requests).toHaveLength(0);
		const url = `${baseUrl}/api/model-catalog/providers/openai?pi-version=0.86.0`;
		expect((await fetch(url)).status).toBe(401);
		expect(requests).toHaveLength(0);
		const headers = { authorization: "Bearer server-secret", "x-api-key": "client-secret", cookie: "client-cookie" };
		const response = await fetch(url, { headers });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(body);
		expect(response.headers.get("etag")).toBe(etag);
		expect(response.headers.get("last-modified")).toBe(lastModified);
		expect(requests[0].headers.authorization).toBeUndefined();
		expect(requests[0].headers["x-api-key"]).toBeUndefined();
		expect(requests[0].headers.cookie).toBeUndefined();
		const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": `W/${etag}` } });
		expect(unchanged.status).toBe(304);
		expect(await unchanged.text()).toBe("");
		expect(requests).toHaveLength(1);
		now += PUBLIC_CATALOG_REFRESH_INTERVAL_MS;
		status = 503;
		expect((await fetch(url, { headers })).status).toBe(502);
		status = 304;
		expect((await fetch(url, { headers })).status).toBe(200);
		expect(requests).toHaveLength(3);
		status = 404;
		const missing = await fetch(`${url}&force=true`, { headers });
		expect(missing.status).toBe(200);
		expect(await missing.json()).toEqual([]);
		expect(missing.headers.get("last-modified")).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
		expect(missing.headers.get("etag")).toBeNull();
		expect(requests).toHaveLength(4);
	});
});
