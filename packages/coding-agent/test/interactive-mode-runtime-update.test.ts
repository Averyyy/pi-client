import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPiClientUpdateMarkerPath } from "../src/core/pi-client-runtime-update.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ReloadContext = {
	runtimeHost: { services: { agentDir: string } };
	options: { runtimeReloadArgs: string[] };
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		isAborting: boolean;
		isBashRunning: boolean;
		pendingMessageCount: number;
	};
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	pendingUserInputs: string[];
	compactionQueuedMessages: unknown[];
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	shutdown: (options?: { exitCode?: number }) => Promise<void>;
	reloadUpdatedPiClientRuntime: () => Promise<boolean>;
	resetExtensionUI: () => void;
};

type ShutdownContext = {
	isShuttingDown: boolean;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
};

const prototype = InteractiveMode.prototype as unknown as {
	reloadUpdatedPiClientRuntime(this: ReloadContext): Promise<boolean>;
	handleReloadCommand(this: ReloadContext): Promise<void>;
	shutdown(this: ShutdownContext, options?: { exitCode?: number }): Promise<void>;
};

describe("interactive pi-client runtime update", () => {
	let root: string;
	let agentDir: string;
	let statePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-runtime-update-"));
		agentDir = join(root, "agent");
		statePath = join(root, "state.json");
		mkdirSync(agentDir);
		vi.stubEnv("PI_SERVER_MODE", "true");
		vi.stubEnv("PI_CLIENT_RELOAD_STATE_PATH", statePath);
		vi.stubEnv("PI_CLIENT_RUNTIME_UPDATED_AT", "");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function writeMarker(): void {
		writeFileSync(
			getPiClientUpdateMarkerPath(agentDir),
			JSON.stringify({ version: "1.2.0-piclient.2", updatedAt: "2026-10-18T00:00:00Z" }),
		);
	}

	function createContext(sessionManager = SessionManager.create(root, join(root, "sessions"))): ReloadContext {
		const context: ReloadContext = {
			runtimeHost: { services: { agentDir } },
			options: { runtimeReloadArgs: ["--no-mcp", "--no-extensions", "--extension", join(root, "extension.ts")] },
			session: {
				isStreaming: false,
				isCompacting: false,
				isAborting: false,
				isBashRunning: false,
				pendingMessageCount: 0,
			},
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			pendingUserInputs: [],
			compactionQueuedMessages: [],
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			shutdown: vi.fn(async () => {}),
			reloadUpdatedPiClientRuntime: () => prototype.reloadUpdatedPiClientRuntime.call(context),
			resetExtensionUI: vi.fn(),
		};
		return context;
	}

	it("hands off the complete persisted tree and selected leaf through /reload", async () => {
		writeMarker();
		const context = createContext();
		const manager = context.sessionManager;
		const first = manager.appendMessage({ role: "user", content: "First branch", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "Other branch", timestamp: 2 });
		manager.branch(first);
		const entries = manager.getEntries();
		context.settingsManager.setDefaultThinkingLevel("high");

		await prototype.handleReloadCommand.call(context);

		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
			sessionId: manager.getSessionId(),
			sessionDir: manager.getSessionDir(),
			leafId: first,
			args: context.options.runtimeReloadArgs,
			updatedAt: "2026-10-18T00:00:00Z",
		});
		expect(SessionManager.open(manager.getSessionFile()!).getEntries()).toEqual(entries);
		expect(manager.getEntries()).toEqual(entries);
		expect(manager.getLeafId()).toBe(first);
		expect(context.shutdown).toHaveBeenCalledExactlyOnceWith({ exitCode: 75 });
		expect(context.resetExtensionUI).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("persists an empty session with its original identity before handoff", async () => {
		writeMarker();
		const context = createContext();
		const manager = context.sessionManager;
		const sessionFile = manager.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(false);

		await prototype.handleReloadCommand.call(context);

		const restored = SessionManager.open(sessionFile);
		expect(restored.getSessionId()).toBe(manager.getSessionId());
		expect(restored.getEntries()).toEqual([]);
		expect(restored.getLeafId()).toBeNull();
		expect(context.shutdown).toHaveBeenCalledWith({ exitCode: 75 });
	});

	it("leaves ordinary resource reload available when no update marker exists", async () => {
		const context = createContext();

		await expect(prototype.reloadUpdatedPiClientRuntime.call(context)).resolves.toBe(false);

		expect(context.shutdown).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
		expect(existsSync(statePath)).toBe(false);
	});

	it("keeps ordinary resource reload when this runtime already loaded the marker generation", async () => {
		writeMarker();
		vi.stubEnv("PI_CLIENT_RUNTIME_UPDATED_AT", "2026-10-18T00:00:00Z");
		const context = createContext();

		await expect(prototype.reloadUpdatedPiClientRuntime.call(context)).resolves.toBe(false);

		expect(context.shutdown).not.toHaveBeenCalled();
		expect(existsSync(statePath)).toBe(false);
	});

	it("lets two older sessions hand off using the same shared update marker", async () => {
		writeMarker();
		const first = createContext();
		const second = createContext();

		await prototype.handleReloadCommand.call(first);
		await prototype.handleReloadCommand.call(second);

		expect(first.shutdown).toHaveBeenCalledWith({ exitCode: 75 });
		expect(second.shutdown).toHaveBeenCalledWith({ exitCode: 75 });
		expect(existsSync(getPiClientUpdateMarkerPath(agentDir))).toBe(true);
	});

	it("reports missing launcher support without falling through to resource reload", async () => {
		writeMarker();
		vi.stubEnv("PI_CLIENT_RELOAD_STATE_PATH", "");
		const context = createContext();

		await prototype.handleReloadCommand.call(context);

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("requires the pi-client launcher"));
		expect(context.resetExtensionUI).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	it("keeps an in-memory session active and explains the restart constraint", async () => {
		writeMarker();
		const context = createContext(SessionManager.inMemory(root));

		await prototype.handleReloadCommand.call(context);

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("cannot resume a --no-session session"));
		expect(context.shutdown).not.toHaveBeenCalled();
		expect(existsSync(statePath)).toBe(false);
	});

	it("keeps the UI active when the marker or state file cannot be read or written", async () => {
		writeFileSync(getPiClientUpdateMarkerPath(agentDir), "{");
		const context = createContext();
		await prototype.handleReloadCommand.call(context);
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("Runtime reload failed:"));
		expect(context.shutdown).not.toHaveBeenCalled();
		expect(context.resetExtensionUI).not.toHaveBeenCalled();

		writeMarker();
		mkdirSync(statePath);
		await prototype.handleReloadCommand.call(context);
		expect(context.showError).toHaveBeenCalledTimes(2);
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	it.each(["abort", "bash", "session input", "UI input", "compaction input"])(
		"keeps transient %s active until it can be handed off",
		async (kind) => {
			writeMarker();
			const context = createContext();
			if (kind === "abort") context.session.isAborting = true;
			if (kind === "bash") context.session.isBashRunning = true;
			if (kind === "session input") context.session.pendingMessageCount = 1;
			if (kind === "UI input") context.pendingUserInputs.push("pending");
			if (kind === "compaction input") context.compactionQueuedMessages.push("pending");

			await prototype.handleReloadCommand.call(context);

			expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("Finish pending input"));
			expect(context.shutdown).not.toHaveBeenCalled();
			expect(existsSync(statePath)).toBe(false);
		},
	);

	it("uses normal terminal and extension cleanup before exiting with the reload code", async () => {
		const calls: string[] = [];
		const exit = new Error("process exit");
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		const context: ShutdownContext = {
			isShuttingDown: false,
			runtimeHost: {
				dispose: async () => {
					calls.push("dispose");
				},
			},
			ui: {
				terminal: {
					drainInput: async () => {
						calls.push("drainInput");
					},
				},
			},
			themeController: {
				disableAutoSync: () => {
					calls.push("disableAutoSync");
				},
			},
			stop: () => {
				calls.push("stop");
			},
		};

		await expect(prototype.shutdown.call(context, { exitCode: 75 })).rejects.toBe(exit);

		expect(calls).toEqual(["disableAutoSync", "drainInput", "stop", "dispose"]);
		expect(process.exit).toHaveBeenCalledWith(75);
	});
});
