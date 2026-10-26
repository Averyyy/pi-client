import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSessions, readThreadEvents } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("thread event stream", () => {
	it("reads UTF-8 and SSE delimiters split at every byte and ignores heartbeats", async () => {
		const bytes = new TextEncoder().encode(
			': heartbeat\n\nevent: snapshot\ndata: {"title":"你好🙂"}\n\nevent: update\ndata: {"append":[]}\n\n',
		);
		const fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const receive = vi.fn();
		const signal = new AbortController().signal;
		await readThreadEvents("thread/one", signal, receive);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/viewer/api/threads/thread%2Fone/events", {
			signal,
			credentials: "same-origin",
		});
		expect(receive.mock.calls).toEqual([
			["snapshot", '{"title":"你好🙂"}'],
			["update", '{"append":[]}'],
		]);
	});

	it("reads a large snapshot across many chunks and continues with subsequent frames", async () => {
		const payload = JSON.stringify({ content: "文🙂".repeat(600_000) });
		const bytes = new TextEncoder().encode(`event: snapshot\ndata: ${payload}\n\nevent: update\ndata: {}\n\n`);
		vi.stubGlobal("fetch", async () => {
			let offset = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset >= bytes.length) {
							controller.close();
							return;
						}
						controller.enqueue(bytes.subarray(offset, offset + 16_384));
						offset += 16_384;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const receive = vi.fn();
		await readThreadEvents("large", new AbortController().signal, receive);
		expect(receive.mock.calls).toEqual([
			["snapshot", payload],
			["update", "{}"],
		]);
	});

	it("rejects a successful HTML response instead of treating it as an event stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("<html>Proxy error</html>", {
						headers: { "Content-Type": "text/html" },
					}),
			),
		);
		await expect(readThreadEvents("thread", new AbortController().signal, vi.fn())).rejects.toThrow(
			"服务器返回了无效的对话事件流",
		);
	});

	it.each([401, 423, 404])("preserves terminal HTTP %s without reading its body", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unavailable", { status })),
		);
		const receive = vi.fn();
		await expect(readThreadEvents("thread", new AbortController().signal, receive)).rejects.toMatchObject({ status });
		expect(receive).not.toHaveBeenCalled();
	});

	it("cancels an idle reader when its selection aborts", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } }),
			),
		);
		const controller = new AbortController();
		const pending = readThreadEvents("thread", controller.signal, vi.fn());
		await Promise.resolve();
		controller.abort();
		await pending;
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels after deleted without consuming queued updates", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode("event: deleted\ndata: {}\n\nevent: update\ndata: {}\n\n"),
								);
							},
							cancel,
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					),
			),
		);
		const receive = vi.fn(() => false);
		await readThreadEvents("thread", new AbortController().signal, receive);
		expect(receive).toHaveBeenCalledExactlyOnceWith("deleted", "{}");
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});

describe("server conversation deletion", () => {
	it("deletes a full project through its encoded id with the viewer cookie", async () => {
		const result = { deletedIds: ["a", "b"], deletedCount: 2, failed: [] };
		const fetch = vi.fn(async () => new Response(JSON.stringify(result)));
		vi.stubGlobal("fetch", fetch);
		expect(await deleteSessions("project", "D:/project name")).toEqual(result);
		expect(fetch).toHaveBeenCalledWith("/viewer/api/projects/D%3A%2Fproject%20name", {
			method: "DELETE",
			credentials: "same-origin",
		});
	});

	it("preserves both successful ids and failures from a partial server deletion", async () => {
		const result = { deletedIds: ["a"], deletedCount: 1, failed: [{ id: "b", error: "Storage unavailable" }] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(result), { status: 207 })),
		);
		expect(await deleteSessions("thread", "thread/id")).toEqual(result);
	});

	it("preserves an authentication failure for the viewer login flow", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unauthorized", { status: 401 })),
		);
		await expect(deleteSessions("thread", "a")).rejects.toMatchObject({
			name: "Error",
			status: 401,
			message: "无法删除服务器对话，请重试",
		});
	});
});
