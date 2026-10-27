import type * as Fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerHttp } from "../src/viewer-http.ts";

const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as { version: string };

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

describe("viewer asset caching", () => {
	let directory: string;
	let viewer: ViewerHttp;
	let server: Server;
	let base: string;

	function createViewer() {
		return new ViewerHttp(
			{
				host: "127.0.0.1",
				port: 0,
				authToken: "asset-fixture",
				sessionStoreDir: directory,
				uploadDir: directory,
			},
			async (ids) => ({ deletedIds: ids, deletedCount: ids.length, failed: [] }),
		);
	}

	function assets(version = "build-one", body = "asset contents") {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync)
			.mockReturnValueOnce(JSON.stringify({ version }))
			.mockReturnValueOnce(
				Buffer.from(
					`<meta name="pi-server-version" content="__PI_SERVER_VERSION__"><script src="/viewer/assets/${version}/app.js"></script>`,
				),
			)
			.mockReturnValueOnce(Buffer.from(body))
			.mockReturnValueOnce(Buffer.from(body));
		vi.clearAllMocks();
	}

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-viewer-assets-"));
		viewer = createViewer();
		server = createServer((req, res) => viewer.handle(req, res, new URL(req.url!, base)));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP listener");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		viewer.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		vi.clearAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each(["app.js", "app.css"])("caches versioned %s across visits and process restarts", async (name) => {
		assets();
		const first = await fetch(`${base}/viewer/assets/build-one/${name}`);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		const tag = first.headers.get("etag")!;
		expect(tag).toBeTruthy();
		expect(await first.text()).toBe("asset contents");
		const cached = await fetch(`${base}/viewer/assets/build-one/${name}`, { headers: { "If-None-Match": tag } });
		expect(cached.status).toBe(304);
		expect(await cached.text()).toBe("");
		const compressed = await fetch(`${base}/viewer/assets/build-one/${name}`, {
			headers: { "If-None-Match": `W/${tag}` },
		});
		expect(compressed.status).toBe(304);
		expect(await compressed.text()).toBe("");
		const secondVisitor = await fetch(`${base}/viewer/assets/build-one/${name}`);
		expect(await secondVisitor.text()).toBe("asset contents");
		expect(readFileSync).toHaveBeenCalledTimes(4);
		expect(existsSync).toHaveBeenCalledTimes(1);
		viewer = createViewer();
		assets();
		const restarted = await fetch(`${base}/viewer/assets/build-one/${name}`, { headers: { "If-None-Match": tag } });
		expect(restarted.status).toBe(304);
		expect(restarted.headers.get("etag")).toBe(tag);
	});

	it("binds HTML and immutable assets to the same build and rejects obsolete URLs", async () => {
		assets();
		const first = await fetch(base);
		expect(await first.text()).toContain("/viewer/assets/build-one/app.js");
		viewer = createViewer();
		assets("build-two", "new contents");
		const updated = await fetch(base);
		expect(await updated.text()).toContain("/viewer/assets/build-two/app.js");
		for (const path of ["build-one/app.js", "app.js", "build-two/unknown.js"])
			expect((await fetch(`${base}/viewer/assets/${path}`)).status).toBe(404);
		const asset = await fetch(`${base}/viewer/assets/build-two/app.js`);
		expect(await asset.text()).toBe("new contents");
		expect(readFileSync).toHaveBeenCalledTimes(4);
	});

	it("keeps the HTML entrypoint and authentication responses out of browser caches", async () => {
		assets();
		const html = await fetch(base);
		expect(html.headers.get("cache-control")).toBe("no-store");
		expect(html.headers.get("etag")).toBeNull();
		const body = await html.text();
		expect(body).toContain(`<meta name="pi-server-version" content="${packageVersion}">`);
		expect(body).not.toContain("__PI_SERVER_VERSION__");
		const unauthorized = await fetch(`${base}/viewer/api/projects`);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("cache-control")).toBe("no-store");
	});

	it("reports unavailable build assets when the build manifest is missing", async () => {
		vi.mocked(existsSync).mockReturnValueOnce(false);
		const response = await fetch(base);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Viewer assets unavailable" });
	});
});
