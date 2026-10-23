import { afterEach, describe, expect, it, vi } from "vitest";
import { OlderHistoryRequest } from "./use-viewer.ts";

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
		history.cancel();
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
	});
});
