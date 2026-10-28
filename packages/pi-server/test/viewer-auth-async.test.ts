import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockViewer, ViewerAuth } from "../src/viewer-auth.ts";

vi.mock("node:fs/promises", { spy: true });

describe("asynchronous viewer authentication", () => {
	let directory: string;
	const requests: IncomingMessage[] = [];
	function request(token?: string, cookie?: string): IncomingMessage {
		const message = new IncomingMessage(new Socket());
		if (token !== undefined) message.headers.authorization = `Bearer ${token}`;
		if (cookie !== undefined) message.headers.cookie = cookie;
		requests.push(message);
		return message;
	}
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-auth-async-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const message of requests.splice(0)) message.destroy();
		rmSync(directory, { recursive: true, force: true });
	});

	it("preserves all concurrent failures, lockout, external unlock and cookie invalidation", async () => {
		const auth = new ViewerAuth(directory, "fixture");
		const cookie = auth.createCookie(request()).split(";")[0];
		const failures = await Promise.all(Array.from({ length: 10 }, () => auth.authenticate(request("wrong"))));
		expect(failures.filter((status) => status === 401)).toHaveLength(9);
		expect(failures.filter((status) => status === 423)).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(directory, ".viewer", "auth.json"), "utf8"))).toMatchObject({ failures: 10 });
		expect(await auth.authenticate(request("fixture"))).toBe(423);
		expect(auth.hasCookie(request(undefined, cookie))).toBe(false);
		await unlockViewer(directory);
		expect(await auth.authenticate(request("fixture"))).toBe(200);
		const nextCookie = auth.createCookie(request()).split(";")[0];
		expect(auth.hasCookie(request(undefined, nextCookie))).toBe(true);
		await unlockViewer(directory);
		expect(await auth.authenticate(request("fixture"))).toBe(200);
		expect(auth.hasCookie(request(undefined, nextCookie))).toBe(false);
	});

	it("awaits state reads without blocking the event loop and keeps missing credentials outside the failure budget", async () => {
		const auth = new ViewerAuth(directory, "fixture");
		await unlockViewer(directory);
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});

		vi.spyOn(fs, "readFile").mockImplementation(async () => {
			started();
			await blocked;
			return JSON.stringify({ failures: 0, generation: 1 });
		});
		let settled = false;
		const pending = auth.authenticate(request("fixture"));
		void pending.then(() => {
			settled = true;
		});
		try {
			await entered;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
		} finally {
			release();
		}
		expect(await pending).toBe(200);
		vi.restoreAllMocks();
		expect(await auth.authenticate(request())).toBe(401);
		expect(JSON.parse(readFileSync(join(directory, ".viewer", "auth.json"), "utf8"))).toMatchObject({ failures: 0 });
	});
});
