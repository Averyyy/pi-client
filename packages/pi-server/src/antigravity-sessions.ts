import { AntigravityRuntime } from "@earendil-works/pi-coding-agent/antigravity";
import { PiServerError, PiServerErrorCode } from "./error-codes.ts";

const IDLE_SESSION_MS = 60 * 60 * 1000;

/** One live agy conversation per Pi session. The context store, not this map, holds the transcript. */
export class AntigravitySessions {
	private readonly closing = new Set<Promise<void>>();
	private readonly sessions = new Map<
		string,
		{ runtime: AntigravityRuntime; idleTimer?: ReturnType<typeof setTimeout> }
	>();

	begin(sessionId: string) {
		const previous = this.sessions.get(sessionId);
		if (previous && !previous.idleTimer) {
			throw new PiServerError(
				"An Antigravity turn is already running for this session",
				PiServerErrorCode.RUN_IN_PROGRESS,
			);
		}
		const state = previous ?? { runtime: new AntigravityRuntime(process.cwd(), "PiServer") };
		clearTimeout(state.idleTimer);
		state.idleTimer = undefined;
		this.sessions.set(sessionId, state);
		return {
			runtime: state.runtime,
			complete: () => {
				state.idleTimer = setTimeout(() => void this.release(sessionId), IDLE_SESSION_MS).unref();
			},
		};
	}

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

	/** Stop an idle agy process early; a running turn keeps it. */
	async releaseIdle(sessionId: string): Promise<boolean> {
		if (!this.sessions.get(sessionId)?.idleTimer) return false;
		await this.release(sessionId);
		return true;
	}

	async close(): Promise<void> {
		await Promise.all([...this.closing, ...[...this.sessions.keys()].map((sessionId) => this.release(sessionId))]);
	}
}
