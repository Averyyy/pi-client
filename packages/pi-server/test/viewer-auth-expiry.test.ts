import { mkdtempSync, rmSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockViewer, ViewerAuth } from "../src/viewer-auth.ts";

describe("viewer cookie lifetime", () => {
	let directory: string;
	let auth: ViewerAuth;
	let request: IncomingMessage;
	beforeEach(() => {
		vi.useFakeTimers();
		directory = mkdtempSync(join(tmpdir(), "pi-auth-expiry-"));
		auth = new ViewerAuth(directory, "fixture");
		request = new IncomingMessage(new Socket());
	});
	afterEach(() => {
		auth.close();
		request.destroy();
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	});

	it("reclaims abandoned cookies while idle and schedules only the next expiry", () => {
		const first = auth.createCookie(request).split(";")[0];
		vi.advanceTimersByTime(1000);
		const second = auth.createCookie(request).split(";")[0];
		const cookies = Reflect.get(auth, "cookies") as Map<string, number>;
		expect(cookies.size).toBe(2);
		expect(vi.getTimerCount()).toBe(1);
		expect((Reflect.get(auth, "cookieTimer") as NodeJS.Timeout).hasRef()).toBe(false);
		vi.advanceTimersByTime(12 * 60 * 60 * 1000 - 1000);
		expect(cookies.size).toBe(1);
		request.headers.cookie = first;
		expect(auth.hasCookie(request)).toBe(false);
		request.headers.cookie = second;
		expect(auth.hasCookie(request)).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1000);
		expect(cookies.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases the timer when logging out the last cookie or closing authentication", () => {
		request.headers.cookie = auth.createCookie(request).split(";")[0];
		auth.clearCookie(request);
		expect(vi.getTimerCount()).toBe(0);
		auth.createCookie(request);
		auth.close();
		expect((Reflect.get(auth, "cookies") as Map<string, number>).size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases cookie timers on lockout and external generation changes", async () => {
		auth.createCookie(request);
		request.headers.authorization = "Bearer wrong";
		for (let attempt = 0; attempt < 10; attempt++) await auth.authenticate(request);
		expect(vi.getTimerCount()).toBe(0);
		expect((Reflect.get(auth, "cookies") as Map<string, number>).size).toBe(0);
		await unlockViewer(directory);
		await auth.isLocked();
		auth.createCookie(request);
		expect(vi.getTimerCount()).toBe(1);
		await unlockViewer(directory);
		await auth.isLocked();
		expect(vi.getTimerCount()).toBe(0);
		expect((Reflect.get(auth, "cookies") as Map<string, number>).size).toBe(0);
	});
});
