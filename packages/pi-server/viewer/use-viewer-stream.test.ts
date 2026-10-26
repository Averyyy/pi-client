import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerThread } from "../src/viewer-types.ts";
import { useViewer } from "./use-viewer.ts";

const runtime = vi.hoisted(() => {
	type Slot = { value?: unknown; set?: (value: unknown) => void; deps?: unknown[]; cleanup?: () => void };
	const slots: Slot[] = [];
	let index = 0;
	let dirty = false;
	let effects: (() => void)[] = [];
	const slot = () => {
		slots[index] ??= {};
		return slots[index++];
	};
	const changed = (slot: Slot, deps: unknown[]) => !slot.deps || deps.some((value, i) => value !== slot.deps?.[i]);
	return {
		render: () => {},
		reset() {
			slots.length = 0;
			dirty = true;
		},
		flush() {
			while (dirty) {
				dirty = false;
				index = 0;
				this.render();
				const pending = effects;
				effects = [];
				for (const effect of pending) effect();
			}
		},
		unmount() {
			for (const slot of slots) slot.cleanup?.();
		},
		hooks: {
			useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
				const state = slot();
				if (!state.set) {
					state.value = typeof initial === "function" ? (initial as () => T)() : initial;
					state.set = (value) => {
						const next = typeof value === "function" ? value(state.value) : value;
						if (Object.is(next, state.value)) return;
						state.value = next;
						dirty = true;
					};
				}
				return [state.value as T, state.set];
			},
			useRef<T>(value: T) {
				const ref = slot();
				ref.value ??= { current: value };
				return ref.value as { current: T };
			},
			useCallback<T>(callback: T, deps: unknown[]) {
				const memo = slot();
				if (changed(memo, deps)) {
					memo.value = callback;
					memo.deps = deps;
				}
				return memo.value as T;
			},
			useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
				const state = slot();
				if (!changed(state, deps)) return;
				state.deps = deps;
				effects.push(() => {
					state.cleanup?.();
					state.cleanup = effect() || undefined;
				});
			},
		},
	};
});

vi.mock("react", () => runtime.hooks);

const thread: ViewerThread = {
	id: "first",
	title: "对话",
	projectId: "project",
	cwd: null,
	status: "idle",
	lastActiveAt: null,
	live: { message: null, tools: [] },
	legacy: false,
};
const catalog = () => new Response(JSON.stringify({ revision: "1", projects: [], running: [] }));

function stream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
			cancel,
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
	return {
		response,
		cancel,
		send(event: string, data: unknown) {
			controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		},
		close() {
			controller.close();
		},
	};
}

let viewer: ReturnType<typeof useViewer>;
let browser: EventTarget & { location: { hash: string } };
let catalogStreams: EventTarget[];
async function settle() {
	for (let turn = 0; turn < 20; turn++) {
		await Promise.resolve();
		runtime.flush();
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	catalogStreams = [];
	browser = Object.assign(new EventTarget(), { location: { hash: "#/thread/first" } });
	vi.stubGlobal("window", browser);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 16));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
	vi.stubGlobal(
		"EventSource",
		class extends EventTarget {
			constructor() {
				super();
				catalogStreams.push(this);
			}
			close() {}
		},
	);
	runtime.reset();
	runtime.render = () => {
		viewer = useViewer();
	};
});

afterEach(async () => {
	runtime.unmount();
	await Promise.resolve();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("thread selection lifecycle", () => {
	it.each([401, 423])("returns to login when a detail request receives HTTP %s", async (status) => {
		browser.location.hash = "#/";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (url.endsWith("/projects") ? catalog() : new Response(null, { status }))),
		);
		runtime.flush();
		await settle();
		await expect(viewer.loadMessage("first", "round", "tool", new AbortController().signal)).rejects.toThrow();
		await settle();
		expect(viewer.auth).toBe("login");
		expect(viewer.locked).toBe(status === 423);
	});
	it("keeps detail failures local and passes exact encoded message identity and cancellation", async () => {
		browser.location.hash = "#/";
		const fetch = vi.fn(async (url: string) =>
			url.endsWith("/projects") ? catalog() : new Response(null, { status: 500 }),
		);
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		await settle();
		const controller = new AbortController();
		await expect(viewer.loadMessage("thread/id", "round/id", "tool/id", controller.signal)).rejects.toThrow();
		expect(fetch).toHaveBeenLastCalledWith("/viewer/api/threads/thread%2Fid/rounds/round%2Fid/messages/tool%2Fid", {
			signal: controller.signal,
			credentials: "same-origin",
		});
		expect(viewer.auth).toBe("ready");
		expect(viewer.error).toBe("");
	});
	it("clears an initial home catalog failure after a successful retry", async () => {
		browser.location.hash = "#/";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValueOnce(new Error("Catalog unavailable")).mockImplementation(catalog),
		);
		runtime.flush();
		await settle();
		expect(viewer.error).toBe("Catalog unavailable");
		viewer.retry();
		await settle();
		expect(viewer.auth).toBe("ready");
		expect(viewer.error).toBe("");
	});

	it("clears a catalog error when the catalog event stream refreshes successfully", async () => {
		browser.location.hash = "#/";
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(catalog)
				.mockRejectedValueOnce(new Error("Catalog unavailable"))
				.mockImplementation(catalog),
		);
		runtime.flush();
		await settle();
		catalogStreams[0].dispatchEvent(new MessageEvent("catalog", { data: '{"revision":"2"}' }));
		await vi.advanceTimersByTimeAsync(120);
		await settle();
		expect(viewer.error).toBe("Catalog unavailable");
		catalogStreams[0].dispatchEvent(new MessageEvent("catalog", { data: '{"revision":"3"}' }));
		await vi.advanceTimersByTimeAsync(120);
		await settle();
		expect(viewer.error).toBe("");
	});

	it("preserves the selected thread error when a slower catalog succeeds", async () => {
		let respond!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) =>
				url.endsWith("/projects")
					? new Promise<Response>((resolve) => {
							respond = resolve;
						})
					: Promise.resolve(new Response("Missing", { status: 404 })),
			),
		);
		runtime.flush();
		await settle();
		expect(viewer.error).toBe("对话不存在或已被移除");
		respond(catalog());
		await settle();
		expect(viewer.auth).toBe("ready");
		expect(viewer.error).toBe("对话不存在或已被移除");
	});

	it("starts a deep link beside a pending catalog and keeps its reader through loading to ready", async () => {
		let respond!: (response: Response) => void;
		const events = stream();
		const fetch = vi.fn((url: string) =>
			url.endsWith("/projects")
				? new Promise<Response>((resolve) => {
						respond = resolve;
					})
				: Promise.resolve(events.response),
		);
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"/viewer/api/projects",
			"/viewer/api/threads/first/events",
		]);
		events.send("snapshot", { thread, rounds: [], nextCursor: null });
		await settle();
		expect(viewer.auth).toBe("ready");
		expect(viewer.thread?.title).toBe("对话");
		expect(catalogStreams).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(200);
		await settle();
		expect(fetch.mock.calls.filter(([url]) => url.endsWith("/projects"))).toHaveLength(1);
		respond(catalog());
		await settle();
		expect(catalogStreams).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(events.cancel).not.toHaveBeenCalled();
	});

	it.each([401, 423])("keeps HTTP %s authoritative over an older catalog success", async (status) => {
		let respond!: (response: Response) => void;
		const fetch = vi.fn((url: string) =>
			url.endsWith("/projects")
				? new Promise<Response>((resolve) => {
						respond = resolve;
					})
				: Promise.resolve(new Response("Unauthorized", { status })),
		);
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		await settle();
		expect(viewer.auth).toBe("login");
		expect(viewer.locked).toBe(status === 423);
		respond(catalog());
		await settle();
		await vi.advanceTimersByTimeAsync(6000);
		runtime.flush();
		expect(viewer.auth).toBe("login");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("stops on 404 and retries the thread request when the user retries", async () => {
		const events = stream();
		let attempts = 0;
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith("/projects")) return catalog();
			return ++attempts === 1 ? new Response("Missing", { status: 404 }) : events.response;
		});
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		await settle();
		expect(viewer.error).toBe("对话不存在或已被移除");
		await vi.advanceTimersByTimeAsync(6000);
		expect(attempts).toBe(1);
		viewer.retry();
		await settle();
		expect(attempts).toBe(2);
		events.send("snapshot", { thread, rounds: [], nextCursor: null });
		await settle();
		expect(viewer.error).toBe("");
		expect(viewer.thread?.id).toBe("first");
	});

	it("marks a disconnected stream and reconnects after three seconds for a fresh snapshot", async () => {
		const first = stream();
		const second = stream();
		let attempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.endsWith("/projects") ? catalog() : ++attempts === 1 ? first.response : second.response,
			),
		);
		runtime.flush();
		first.send("snapshot", { thread, rounds: [], nextCursor: null });
		await settle();
		first.close();
		await settle();
		expect(viewer.thread?.status).toBe("disconnected");
		expect(viewer.connected).toBe(false);
		await vi.advanceTimersByTimeAsync(2999);
		expect(attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toBe(2);
		second.send("snapshot", { thread, rounds: [], nextCursor: null });
		await settle();
		expect(viewer.connected).toBe(true);
	});

	it("cancels the old selection reader and cancels reconnect timers on home", async () => {
		const first = stream();
		const second = stream();
		const fetch = vi.fn(async (url: string) =>
			url.endsWith("/projects") ? catalog() : url.includes("/first/") ? first.response : second.response,
		);
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		await settle();
		browser.location.hash = "#/thread/second";
		browser.dispatchEvent(new Event("hashchange"));
		await settle();
		expect(first.cancel).toHaveBeenCalledTimes(1);
		second.close();
		await settle();
		viewer.home();
		await settle();
		await vi.advanceTimersByTimeAsync(6000);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("stops after deleted and clears the selected conversation", async () => {
		const events = stream();
		const fetch = vi.fn(async (url: string) => (url.endsWith("/projects") ? catalog() : events.response));
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		events.send("deleted", { id: "first" });
		await settle();
		expect(viewer.current).toBeNull();
		expect(events.cancel).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(6000);
		expect(fetch.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(1);
	});

	it("cancels the reader on logout and on unmount", async () => {
		const first = stream();
		const second = stream();
		let attempts = 0;
		const fetch = vi.fn(async (url: string) => {
			if (url === "/viewer/logout") return new Response(null, { status: 204 });
			if (url.endsWith("/projects")) return catalog();
			return ++attempts === 1 ? first.response : second.response;
		});
		vi.stubGlobal("fetch", fetch);
		runtime.flush();
		await settle();
		await viewer.logout();
		await settle();
		expect(viewer.auth).toBe("login");
		expect(first.cancel).toHaveBeenCalledTimes(1);
		viewer.login();
		await settle();
		expect(attempts).toBe(2);
		runtime.unmount();
		await Promise.resolve();
		expect(second.cancel).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(6000);
		expect(attempts).toBe(2);
	});

	it("flushes queued committed messages before marking the thread disconnected", async () => {
		const events = stream();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (url.endsWith("/projects") ? catalog() : events.response)),
		);
		runtime.flush();
		events.send("snapshot", { thread, rounds: [], nextCursor: null });
		await settle();
		events.send("update", {
			thread,
			append: [{ id: "user", role: "user", timestamp: 0, content: "最后一条消息" }],
		});
		events.close();
		await settle();
		expect(viewer.rounds[0].messages[0].content).toBe("最后一条消息");
		expect(viewer.thread?.status).toBe("disconnected");
		await vi.advanceTimersByTimeAsync(16);
		await settle();
		expect(viewer.thread?.status).toBe("disconnected");
	});

	it("invalidates pending older history when a snapshot replaces the active branch", async () => {
		const events = stream();
		let respond!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/rounds?"))
					return new Promise<Response>((resolve) => {
						respond = resolve;
					});
				return Promise.resolve(url.endsWith("/projects") ? catalog() : events.response);
			}),
		);
		runtime.flush();
		events.send("snapshot", { thread, rounds: [{ id: "old", messages: [] }], nextCursor: "older" });
		await settle();
		const version = viewer.historyVersion;
		const pending = viewer.loadOlder();
		events.send("snapshot", { thread, rounds: [{ id: "new", messages: [] }], nextCursor: "new-older" });
		await settle();
		expect(viewer.loadingOlder).toBe(false);
		expect(viewer.historyVersion).toBeGreaterThan(version);
		respond(new Response(JSON.stringify({ rounds: [{ id: "oldest", messages: [] }], nextCursor: null })));
		await pending;
		await settle();
		expect(viewer.rounds.map((round) => round.id)).toEqual(["new"]);
		expect(viewer.cursor).toBe("new-older");
	});
});
