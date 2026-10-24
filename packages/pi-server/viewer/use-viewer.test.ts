import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerProject } from "../src/viewer-types.ts";
import { CatalogRequest, OlderHistoryRequest, ProjectCache } from "./use-viewer.ts";

afterEach(() => vi.unstubAllGlobals());

describe("older history requests", () => {
	it("rejects an old branch page that resolves after an authoritative replacement", async () => {
		let respond!: (response: Response) => void;
		let requestSignal: AbortSignal | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise<Response>((resolve) => {
						respond = resolve;
						requestSignal = options.signal;
					}),
			),
		);
		const history = new OlderHistoryRequest();
		const oldPage = history.load("threads/thread/rounds?before=old", new AbortController().signal);
		expect(history.loading).toBe(true);
		history.cancel();
		expect(history.loading).toBe(false);
		respond(new Response(JSON.stringify({ rounds: [{ id: "old-branch", messages: [] }], nextCursor: "old-cursor" })));
		const result = await oldPage;
		expect(requestSignal?.aborted).toBe(true);
		expect(result.page).toBeNull();
		expect(history.isCurrent(result.generation)).toBe(false);
	});

	it("accepts the new branch page while a superseded transport is still resolving", async () => {
		const responses: ((response: Response) => void)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))),
		);
		const history = new OlderHistoryRequest();
		const selected = new AbortController().signal;
		const oldPage = history.load("threads/thread/rounds?before=old", selected);
		history.cancel();
		const newPage = history.load("threads/thread/rounds?before=new", selected);
		responses[0](new Response(JSON.stringify({ rounds: [{ id: "old", messages: [] }], nextCursor: "old-cursor" })));
		responses[1](new Response(JSON.stringify({ rounds: [{ id: "new", messages: [] }], nextCursor: null })));
		expect((await oldPage).page).toBeNull();
		const current = await newPage;
		expect(current.page?.rounds.map((round) => round.id)).toEqual(["new"]);
		expect(history.isCurrent(current.generation)).toBe(true);
		expect(history.loading).toBe(false);
	});
});

function project(id: string, revision = "epoch:1"): ViewerProject {
	return { id, path: id, name: id, threadCount: 10, updatedAt: 0, revision };
}

function page(id: string, nextCursor: string | null = null): Response {
	return new Response(JSON.stringify({ threads: [{ id, title: id }], nextCursor }));
}

describe("catalog refresh requests", () => {
	it("applies a slow response during continuous invalidations and coalesces their follow-up request", async () => {
		const responses: ((response: Response) => void)[] = [];
		const signals: AbortSignal[] = [];
		const fetch = vi.fn((_url: string, options: RequestInit) => {
			signals.push(options.signal as AbortSignal);
			return new Promise<Response>((resolve) => responses.push(resolve));
		});
		vi.stubGlobal("fetch", fetch);
		const catalog = new CatalogRequest();
		const apply = vi.fn();
		const pending = catalog.load(apply);
		for (let signal = 0; signal < 10; signal++) catalog.load(apply);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(signals[0].aborted).toBe(false);
		responses[0](new Response(JSON.stringify({ revision: "epoch:10", projects: [], running: [] })));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(apply).toHaveBeenCalledWith({ revision: "epoch:10", projects: [], running: [] });
		expect(signals[0].aborted).toBe(false);
		responses[1](new Response(JSON.stringify({ revision: "epoch:11", projects: [], running: [] })));
		await pending;
		expect(apply).toHaveBeenLastCalledWith({ revision: "epoch:11", projects: [], running: [] });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("does not apply an old successful catalog response after authentication is cleared", async () => {
		let respond!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			),
		);
		const catalog = new CatalogRequest();
		const apply = vi.fn();
		const pending = catalog.load(apply);
		catalog.cancel();
		respond(new Response(JSON.stringify({ revision: "old:1", projects: [], running: [] })));
		await pending;
		expect(apply).not.toHaveBeenCalled();
	});
});

describe("visible project cache", () => {
	it("removes only successful deletions and rejects a pre-deletion page without touching another project", async () => {
		let respond!: (response: Response) => void;
		let signal!: AbortSignal;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ threads: [{ id: "deleted" }, { id: "failed" }], nextCursor: "older" })),
			)
			.mockResolvedValueOnce(page("other-thread"))
			.mockImplementationOnce((_url: string, options: RequestInit) => {
				signal = options.signal as AbortSignal;
				return new Promise<Response>((resolve) => {
					respond = resolve;
				});
			});
		vi.stubGlobal("fetch", fetch);
		const cache = new ProjectCache(vi.fn(), vi.fn());
		cache.updateCatalog([project("a"), project("b")]);
		await cache.load("a");
		await cache.load("b");
		const oldPage = cache.load("a", true);
		cache.removeThreads(["deleted"], "a");
		expect(signal.aborted).toBe(true);
		respond(page("deleted"));
		await oldPage;
		expect(cache.rows.a.threads.map((thread) => thread.id)).toEqual(["failed"]);
		expect(cache.rows.a.revision).toBe("");
		expect(cache.rows.b.threads.map((thread) => thread.id)).toEqual(["other-thread"]);
		cache.clear();
	});
	it("loads only visible projects and shares one first request between home and sidebar", async () => {
		const fetch = vi.fn(async (url: string) => page(url));
		vi.stubGlobal("fetch", fetch);
		const cache = new ProjectCache(vi.fn(), vi.fn());
		const catalog = Array.from({ length: 41 }, (_, index) => project(`project-${index}`));
		cache.updateCatalog(catalog);
		expect(cache.expanded.size).toBe(41);
		expect(fetch).not.toHaveBeenCalled();
		cache.setVisible("project-0", "home", true);
		cache.setVisible("project-0", "sidebar", true);
		cache.setVisible("project-1", "home", true);
		await Promise.all([cache.load("project-0"), cache.load("project-1")]);
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.updateCatalog(catalog);
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.clear();
	});

	it("refreshes only changed visible projects and defers an offscreen revision until it becomes visible", async () => {
		const fetch = vi.fn(async (url: string) => page(url));
		vi.stubGlobal("fetch", fetch);
		const cache = new ProjectCache(vi.fn(), vi.fn());
		cache.updateCatalog([project("a"), project("b"), project("c")]);
		cache.setVisible("a", "home", true);
		cache.setVisible("a", "sidebar", true);
		cache.setVisible("b", "home", true);
		await Promise.all([cache.load("a"), cache.load("b")]);
		cache.setVisible("b", "home", false);
		cache.updateCatalog([project("a"), project("b", "epoch:2"), project("c", "epoch:2")]);
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.setVisible("a", "sidebar", false);
		cache.updateCatalog([project("a", "epoch:3"), project("b", "epoch:2"), project("c", "epoch:2")]);
		await cache.load("a");
		expect(fetch).toHaveBeenCalledTimes(3);
		cache.setVisible("b", "home", true);
		await cache.load("b");
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(cache.rows.b.revision).toBe("epoch:2");
		cache.clear();
	});

	it("reuses all loaded pages after collapse and refreshes their cursors together when the project changes", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page("old-first", "old-cursor"))
			.mockResolvedValueOnce(page("old-second"))
			.mockResolvedValueOnce(page("new-first", "new-cursor"))
			.mockResolvedValueOnce(page("new-second"));
		vi.stubGlobal("fetch", fetch);
		const cache = new ProjectCache(vi.fn(), vi.fn());
		cache.updateCatalog([project("a")]);
		cache.setVisible("a", "home", true);
		await cache.load("a");
		await cache.load("a", true);
		cache.toggle("a");
		cache.toggle("a");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.rows.a.pages).toBe(2);
		cache.toggle("a");
		cache.updateCatalog([project("a", "epoch:2")]);
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.toggle("a");
		await cache.load("a");
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(fetch.mock.calls[3][0]).toBe("/viewer/api/threads?project=a&cursor=new-cursor");
		expect(cache.rows.a.threads.map((thread) => thread.id)).toEqual(["new-first", "new-second"]);
		cache.clear();
	});

	it("rejects an in-flight page from a previous revision and an in-flight response after logout", async () => {
		const responses: ((response: Response) => void)[] = [];
		const signals: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, options: RequestInit) => {
				signals.push(options.signal as AbortSignal);
				return new Promise<Response>((resolve) => responses.push(resolve));
			}),
		);
		const cache = new ProjectCache(vi.fn(), vi.fn());
		cache.updateCatalog([project("a")]);
		cache.setVisible("a", "home", true);
		const old = cache.load("a");
		cache.updateCatalog([project("a", "epoch:2")]);
		const current = cache.load("a");
		expect(signals[0].aborted).toBe(true);
		responses[1](page("current"));
		await current;
		responses[0](page("obsolete"));
		await old;
		expect(cache.rows.a.threads[0].id).toBe("current");
		cache.updateCatalog([project("a", "new-epoch:1")]);
		const afterRestart = cache.load("a");
		cache.clear();
		responses[2](page("after-logout"));
		await afterRestart;
		expect(signals[2].aborted).toBe(true);
		expect(cache.rows).toEqual({});
	});
});
