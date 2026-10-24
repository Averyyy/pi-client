import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSessions } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

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
