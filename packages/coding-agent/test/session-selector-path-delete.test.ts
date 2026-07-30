import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	acquirePiServerRunStateLease,
	getPiServerRunStatePath,
	releasePiServerRunStateLease,
} from "../src/core/pi-server-run-state.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import {
	deleteSessionFile,
	getSessionDeletionPaths,
	SessionSelectorComponent,
} from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enumerates the session, recovery journals, and complete pi-server lock database family", () => {
		const sessionPath = join("sessions", "session.jsonl");
		const runStatePath = `${sessionPath}.pi-server-runs.jsonl`;
		const lockPath = `${runStatePath}.lock.sqlite`;
		expect(getSessionDeletionPaths(sessionPath)).toEqual([
			sessionPath,
			`${sessionPath}.tool-effects.jsonl`,
			runStatePath,
			lockPath,
			`${lockPath}-journal`,
			`${lockPath}-wal`,
			`${lockPath}-shm`,
		]);
	});

	it("deletes the session and recovery sidecars under an exclusive pi-server lease", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-delete-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		const toolEffectPath = `${sessionPath}.tool-effects.jsonl`;
		const runStatePath = getPiServerRunStatePath(sessionPath);
		writeFileSync(sessionPath, "session\n");
		writeFileSync(toolEffectPath, "tool effect\n");
		writeFileSync(runStatePath, "run state\n");
		const lease = acquirePiServerRunStateLease(runStatePath);
		releasePiServerRunStateLease(lease);

		const result = await deleteSessionFile(sessionPath);

		expect(result.ok).toBe(true);
		expect(getSessionDeletionPaths(sessionPath).every((path) => !existsSync(path))).toBe(true);
	});

	it("bounds the trash subprocess and falls back to unlink after a timeout", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-delete-timeout-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		writeFileSync(sessionPath, "session\n");
		const observedOptions: SpawnSyncOptionsWithStringEncoding[] = [];
		const timeoutError = Object.assign(new Error("spawnSync trash ETIMEDOUT"), { code: "ETIMEDOUT" });
		const timedOutResult: SpawnSyncReturns<string> = {
			pid: 123,
			output: [null, "", ""],
			stdout: "",
			stderr: "",
			status: null,
			signal: "SIGKILL",
			error: timeoutError,
		};

		const result = await deleteSessionFile(sessionPath, {
			trashTimeoutMs: 25,
			spawnTrash: (_command, _args, options) => {
				observedOptions.push(options);
				return timedOutResult;
			},
		});

		expect(result).toEqual({ ok: true, method: "unlink" });
		expect(observedOptions.length).toBeGreaterThanOrEqual(1);
		for (const options of observedOptions) {
			expect(options).toMatchObject({
				timeout: 25,
				killSignal: "SIGKILL",
				windowsHide: true,
				maxBuffer: 64 * 1024,
			});
		}
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("fails without deleting data when another process owns the pi-server session lease", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-delete-locked-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		const toolEffectPath = `${sessionPath}.tool-effects.jsonl`;
		const runStatePath = getPiServerRunStatePath(sessionPath);
		writeFileSync(sessionPath, "session\n");
		writeFileSync(toolEffectPath, "tool effect\n");
		writeFileSync(runStatePath, "run state\n");
		const lease = acquirePiServerRunStateLease(runStatePath);
		try {
			const result = await deleteSessionFile(sessionPath);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("another process owns the session");
			expect(existsSync(sessionPath)).toBe(true);
			expect(existsSync(toolEffectPath)).toBe(true);
			expect(existsSync(runStatePath)).toBe(true);
		} finally {
			releasePiServerRunStateLease(lease);
		}
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("sorts threaded sessions by latest activity in their subtree", async () => {
		const parentOne = makeSession({
			id: "parent-one",
			name: "Parent one",
			modified: new Date("2026-01-02T00:00:00.000Z"),
		});
		const parentTwo = makeSession({
			id: "parent-two",
			name: "Parent two",
			modified: new Date("2026-01-01T00:00:00.000Z"),
		});
		const childTwo = makeSession({
			id: "child-two",
			name: "Child two",
			parentSessionPath: parentTwo.path,
			modified: new Date("2026-01-03T00:00:00.000Z"),
		});

		const selector = new SessionSelectorComponent(
			async () => [parentOne, parentTwo, childTwo],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		const parentTwoIndex = output.indexOf("Parent two");
		const childTwoIndex = output.indexOf("└─ Child two");
		const parentOneIndex = output.indexOf("Parent one");

		expect(parentTwoIndex).toBeGreaterThanOrEqual(0);
		expect(childTwoIndex).toBeGreaterThan(parentTwoIndex);
		expect(parentOneIndex).toBeGreaterThan(childTwoIndex);
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			paths.parentAliasA,
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
