// The live agy conversations PiServer runs for Pi sessions, and the records that resume them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	ANTIGRAVITY_CLIENT_NAME,
	AntigravityRuntime,
	type AntigravitySavedConversation,
} from "@earendil-works/pi-coding-agent/antigravity";
import { PiServerError, PiServerErrorCode } from "./error-codes.ts";

const IDLE_SESSION_MS = 60 * 60 * 1000;

/**
 * One agy process per Pi session; the context store, not this map, holds the transcript.
 * After each completed turn the agy session ID is saved, so a restarted or idle-released
 * process resumes the conversation instead of receiving the transcript again.
 */
export class AntigravitySessions {
	private readonly directory: string;
	private readonly closing = new Set<Promise<void>>();
	private readonly sessions = new Map<
		string,
		{ runtime: AntigravityRuntime; idleTimer?: ReturnType<typeof setTimeout> }
	>();

	constructor(directory: string) {
		this.directory = directory;
	}

	/**
	 * The agy session's working directory: the Pi workspace when this machine has it, else an
	 * empty directory, so agy never works in PiServer's own directory.
	 */
	cwd(clientCwd: string | undefined): string {
		if (clientCwd && isAbsolute(clientCwd) && existsSync(clientCwd)) return clientCwd;
		const workspace = join(homedir(), `.${ANTIGRAVITY_CLIENT_NAME}`, "antigravity-workspace");
		mkdirSync(workspace, { recursive: true });
		return workspace;
	}

	begin(sessionId: string, cwd: string) {
		const previous = this.sessions.get(sessionId);
		if (previous && !previous.idleTimer) {
			throw new PiServerError(
				"An Antigravity turn is already running for this session",
				PiServerErrorCode.RUN_IN_PROGRESS,
			);
		}
		const state = previous ?? { runtime: new AntigravityRuntime(cwd, "PiServer", this.read(sessionId)) };
		clearTimeout(state.idleTimer);
		state.idleTimer = undefined;
		this.sessions.set(sessionId, state);
		return {
			runtime: state.runtime,
			complete: () => {
				const saved = state.runtime.savedConversation;
				if (saved) {
					mkdirSync(this.directory, { recursive: true });
					writeFileSync(this.path(sessionId), JSON.stringify(saved), "utf-8");
				}
				state.idleTimer = setTimeout(() => void this.release(sessionId), IDLE_SESSION_MS).unref();
			},
		};
	}

	/** Stop the session's agy process; its saved conversation stays resumable. */
	async release(sessionId: string): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state) return;
		this.sessions.delete(sessionId);
		clearTimeout(state.idleTimer);
		const closing = state.runtime.close();
		this.closing.add(closing);
		try {
			await closing;
		} finally {
			this.closing.delete(closing);
		}
	}

	/** Stop the process and drop the saved conversation, after a failed turn or a deleted session. */
	async forget(sessionId: string): Promise<void> {
		rmSync(this.path(sessionId), { force: true });
		await this.release(sessionId);
	}

	/** Stop an idle agy process early; a running turn keeps it. */
	async releaseIdle(sessionId: string): Promise<boolean> {
		if (!this.sessions.get(sessionId)?.idleTimer) return false;
		await this.release(sessionId);
		return true;
	}

	async close(): Promise<void> {
		await Promise.all([...this.closing, ...[...this.sessions.keys()].map((sessionId) => this.release(sessionId))]);
	}

	private path(sessionId: string): string {
		return join(this.directory, `${createHash("sha256").update(sessionId).digest("hex")}.agy.json`);
	}

	private read(sessionId: string): AntigravitySavedConversation | undefined {
		const path = this.path(sessionId);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as AntigravitySavedConversation;
		} catch {
			// A torn record only costs a transcript replay into a new agy session.
			return undefined;
		}
	}
}
