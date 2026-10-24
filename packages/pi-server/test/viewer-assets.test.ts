import type * as Fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerHttp } from "../src/viewer-http.ts";

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
		return new ViewerHttp({
			host: "127.0.0.1",
			port: 0,
			authToken: "asset-fixture",
			sessionStoreDir: directory,
			uploadDir: directory,
		});
	}

	function asset(body: string) {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from(body));
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

	it.each(["app.js", "app.css"])("reads %s once and revalidates cached browser copies", async (name) => {
		asset("asset contents");
		const first = await fetch(`${base}/viewer/assets/${name}`);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("private, no-cache");
		const tag = first.headers.get("etag")!;
		expect(tag).toBeTruthy();
		expect(await first.text()).toBe("asset contents");
		const cached = await fetch(`${base}/viewer/assets/${name}`, { headers: { "If-None-Match": tag } });
		expect(cached.status).toBe(304);
		expect(await cached.text()).toBe("");
		const compressed = await fetch(`${base}/viewer/assets/${name}`, { headers: { "If-None-Match": `W/${tag}` } });
		expect(compressed.status).toBe(304);
		expect(await compressed.text()).toBe("");
		const secondVisitor = await fetch(`${base}/viewer/assets/${name}`);
		expect(await secondVisitor.text()).toBe("asset contents");
		expect(readFileSync).toHaveBeenCalledTimes(1);
		expect(existsSync).toHaveBeenCalledTimes(1);
		viewer = createViewer();
		asset("new contents");
		const updated = await fetch(`${base}/viewer/assets/${name}`, { headers: { "If-None-Match": tag } });
		expect(updated.status).toBe(200);
		expect(updated.headers.get("etag")).not.toBe(tag);
		expect(await updated.text()).toBe("new contents");
	});

	it("keeps the HTML entrypoint and authentication responses out of browser caches", async () => {
		asset("<html></html>");
		const html = await fetch(base);
		expect(html.headers.get("cache-control")).toBe("no-store");
		expect(html.headers.get("etag")).toBeNull();
		await html.text();
		const unauthorized = await fetch(`${base}/viewer/api/projects`);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("cache-control")).toBe("no-store");
	});
});
