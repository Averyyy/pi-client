import type {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePersistedSession } from "../src/session-persistence.ts";
import { clearAllSessions, replaceSessionTree } from "../src/session-store.ts";

const fsMock = vi.hoisted(() => ({
	appendFileSync: vi.fn<typeof appendFileSync>(),
	closeSync: vi.fn<typeof closeSync>(),
	existsSync: vi.fn<typeof existsSync>(),
	fsyncSync: vi.fn<typeof fsyncSync>(),
	mkdirSync: vi.fn<typeof mkdirSync>(),
	openSync: vi.fn<typeof openSync>(),
	readdirSync: vi.fn<typeof readdirSync>(),
	readFileSync: vi.fn<typeof readFileSync>(),
	renameSync: vi.fn<typeof renameSync>(),
	rmSync: vi.fn<typeof rmSync>(),
	statSync: vi.fn<typeof statSync>(),
	truncateSync: vi.fn<typeof truncateSync>(),
	writeFileSync: vi.fn<typeof writeFileSync>(),
	writeSync: vi.fn<(fd: number, buffer: Uint8Array, offset?: number, length?: number) => number>(),
}));

vi.mock("node:fs", () => ({
	appendFileSync: fsMock.appendFileSync,
	closeSync: fsMock.closeSync,
	existsSync: fsMock.existsSync,
	fsyncSync: fsMock.fsyncSync,
	mkdirSync: fsMock.mkdirSync,
	openSync: fsMock.openSync,
	readdirSync: fsMock.readdirSync,
	readFileSync: fsMock.readFileSync,
	renameSync: fsMock.renameSync,
	rmSync: fsMock.rmSync,
	statSync: fsMock.statSync,
	truncateSync: fsMock.truncateSync,
	writeFileSync: fsMock.writeFileSync,
	writeSync: fsMock.writeSync,
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

function persistedSession(sessionId: string) {
	return replaceSessionTree(
		sessionId,
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
		fsMock.existsSync.mockImplementation((path) => String(path) === "/" || String(path) === "\\");
		fsMock.openSync.mockReturnValue(42);
		fsMock.writeSync.mockImplementation((_fd, buffer, offset = 0, length) => length ?? buffer.byteLength - offset);
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

		savePersistedSession("/sessions", persistedSession("persist-retry-windows"));

		expect(fsMock.renameSync).toHaveBeenCalledTimes(4);
		expect(fsMock.rmSync).not.toHaveBeenCalled();
	});

	it("does not retry EPERM outside Windows", () => {
		setPlatform("linux");
		const error = errno("EPERM");
		fsMock.renameSync.mockImplementationOnce(() => {
			throw error;
		});

		let thrown: unknown;
		try {
			savePersistedSession("/sessions", persistedSession("persist-retry-linux"));
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
			savePersistedSession("/sessions", persistedSession("persist-retry-eacces"));
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBe(error);
		expect(fsMock.renameSync).toHaveBeenCalledTimes(1);
		expect(fsMock.rmSync).toHaveBeenCalledTimes(1);
	});

	it("fsyncs each replacement and its containing directory outside Windows", () => {
		setPlatform("linux");

		savePersistedSession("/sessions", persistedSession("persist-fsync-linux"));

		const directoryOpens = fsMock.openSync.mock.calls.filter(([, flags]) => flags === "r");
		expect(fsMock.renameSync).toHaveBeenCalledTimes(3);
		expect(directoryOpens).toHaveLength(4);
		expect(fsMock.fsyncSync).toHaveBeenCalledTimes(7);
	});
});
