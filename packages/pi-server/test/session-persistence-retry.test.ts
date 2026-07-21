import type {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePersistedSession } from "../src/session-persistence.ts";
import { clearAllSessions, replaceSessionTree } from "../src/session-store.ts";

const fsMock = vi.hoisted(() => ({
	appendFileSync: vi.fn<typeof appendFileSync>(),
	existsSync: vi.fn<typeof existsSync>(),
	mkdirSync: vi.fn<typeof mkdirSync>(),
	readdirSync: vi.fn<typeof readdirSync>(),
	readFileSync: vi.fn<typeof readFileSync>(),
	renameSync: vi.fn<typeof renameSync>(),
	rmSync: vi.fn<typeof rmSync>(),
	writeFileSync: vi.fn<typeof writeFileSync>(),
}));

vi.mock("node:fs", () => ({
	appendFileSync: fsMock.appendFileSync,
	existsSync: fsMock.existsSync,
	mkdirSync: fsMock.mkdirSync,
	readdirSync: fsMock.readdirSync,
	readFileSync: fsMock.readFileSync,
	renameSync: fsMock.renameSync,
	rmSync: fsMock.rmSync,
	writeFileSync: fsMock.writeFileSync,
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function persistedSession() {
	return replaceSessionTree(
		"persist-retry",
		[
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "one", timestamp: 1000 },
			},
		],
		"u1",
	);
}

describe("session-persistence rename retry", () => {
	beforeEach(() => {
		clearAllSessions();
		vi.clearAllMocks();
		setPlatform(originalPlatform);
	});

	afterEach(() => {
		clearAllSessions();
		setPlatform(originalPlatform);
	});

	it("retries Windows rename EPERM without deleting the target file", () => {
		setPlatform("win32");
		fsMock.renameSync
			.mockImplementationOnce(() => {
				throw errno("EPERM");
			})
			.mockImplementationOnce(() => undefined);

		savePersistedSession("/sessions", persistedSession());

		expect(fsMock.renameSync).toHaveBeenCalledTimes(2);
		expect(fsMock.rmSync.mock.calls.every(([path]) => String(path).endsWith(".wal"))).toBe(true);
	});

	it("does not retry EPERM outside Windows", () => {
		setPlatform("linux");
		const error = errno("EPERM");
		fsMock.renameSync.mockImplementationOnce(() => {
			throw error;
		});

		let thrown: unknown;
		try {
			savePersistedSession("/sessions", persistedSession());
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBe(error);
		expect(fsMock.renameSync).toHaveBeenCalledTimes(1);
		expect(fsMock.rmSync).toHaveBeenCalledTimes(1);
	});

	it("does not retry non-EPERM rename errors on Windows", () => {
		setPlatform("win32");
		const error = errno("EACCES");
		fsMock.renameSync.mockImplementationOnce(() => {
			throw error;
		});

		let thrown: unknown;
		try {
			savePersistedSession("/sessions", persistedSession());
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBe(error);
		expect(fsMock.renameSync).toHaveBeenCalledTimes(1);
		expect(fsMock.rmSync).toHaveBeenCalledTimes(1);
	});
});
