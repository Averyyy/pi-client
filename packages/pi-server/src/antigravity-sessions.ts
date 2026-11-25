import type { Message } from "@earendil-works/pi-ai";
import { AntigravityRuntime } from "@earendil-works/pi-coding-agent/antigravity";
import { PiServerError, PiServerErrorCode } from "./error-codes.ts";

const IDLE_SESSION_MS = 60 * 60 * 1000;

export class AntigravitySessions {
	private readonly closing = new Set<Promise<void>>();
	private readonly sessions = new Map<
		string,
		{
			runtime: AntigravityRuntime;
			prefix?: { runId: string; messages: Message[] };
			idleTimer?: ReturnType<typeof setTimeout>;
		}
	>();

	begin(sessionId: string, baseRunId: string | undefined, delta: Message[]) {
		const previous = this.sessions.get(sessionId);
		if (previous && !previous.idleTimer) {
			throw new PiServerError(
				"An Antigravity turn is already running for this session",
				PiServerErrorCode.RUN_IN_PROGRESS,
			);
		}
		if (baseRunId && previous?.prefix?.runId !== baseRunId) {
			// Restart, idle release, and failed turns drop the prefix; the client then resends the whole context.
			throw new PiServerError(
				"PiServer no longer has this Antigravity conversation prefix",
				PiServerErrorCode.ANTIGRAVITY_PREFIX_NOT_FOUND,
			);
		}
		const state = previous ?? { runtime: new AntigravityRuntime(process.cwd(), "PiServer") };
		clearTimeout(state.idleTimer);
		state.idleTimer = undefined;
		this.sessions.set(sessionId, state);
		const messages = baseRunId ? [...state.prefix!.messages, ...delta] : delta;
		return {
			runtime: state.runtime,
			messages,
			reset: previous !== undefined && baseRunId === undefined,
			complete: (runId: string, tail: Message[]) => {
				state.prefix = { runId, messages: [...messages, ...tail] };
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

	async releaseIdle(sessionId: string, runId: string): Promise<boolean> {
		const state = this.sessions.get(sessionId);
		if (state?.prefix?.runId !== runId || !state.idleTimer) return false;
		await this.release(sessionId);
		return true;
	}

	async close(): Promise<void> {
		await Promise.all([...this.closing, ...[...this.sessions.keys()].map((sessionId) => this.release(sessionId))]);
	}
}
