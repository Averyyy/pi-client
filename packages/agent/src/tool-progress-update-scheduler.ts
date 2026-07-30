export const TOOL_PROGRESS_UPDATE_INTERVAL_MS = 100;

export class ToolProgressUpdateScheduler<T> {
	private readonly emitUpdate: (value: T) => Promise<void> | void;
	private readonly intervalMs: number;
	private pendingValue: T | undefined;
	private hasPendingValue = false;
	private lastEmitAt: number | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private emission: Promise<void> | undefined;
	private finishPromise: Promise<void> | undefined;
	private failure: unknown;
	private closed = false;

	constructor(emitUpdate: (value: T) => Promise<void> | void, intervalMs = TOOL_PROGRESS_UPDATE_INTERVAL_MS) {
		if (!Number.isFinite(intervalMs) || intervalMs < 0) {
			throw new Error("Tool progress update interval must be a non-negative finite number");
		}
		this.emitUpdate = emitUpdate;
		this.intervalMs = intervalMs;
	}

	update(value: T): void {
		if (this.closed) return;
		if (this.lastEmitAt === undefined && !this.emission) {
			this.startEmission(value);
			return;
		}
		this.pendingValue = value;
		this.hasPendingValue = true;
		this.schedulePendingEmission();
	}

	finish(): Promise<void> {
		if (this.finishPromise) return this.finishPromise;
		this.closed = true;
		this.clearTimer();
		this.finishPromise = this.flushAndFinish();
		return this.finishPromise;
	}

	private async flushAndFinish(): Promise<void> {
		if (this.emission) {
			await this.emission;
		}
		if (this.hasPendingValue) {
			const pendingValue = this.takePendingValue();
			await this.startEmission(pendingValue);
		}
		if (this.failure !== undefined) {
			throw this.failure;
		}
	}

	private schedulePendingEmission(): void {
		if (this.closed || !this.hasPendingValue || this.emission || this.timer !== undefined) return;
		const elapsedMs = this.lastEmitAt === undefined ? this.intervalMs : Date.now() - this.lastEmitAt;
		const delayMs = Math.max(0, this.intervalMs - elapsedMs);
		if (delayMs === 0) {
			this.emitPendingValue();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.emitPendingValue();
		}, delayMs);
	}

	private emitPendingValue(): void {
		if (this.closed || this.emission || !this.hasPendingValue) return;
		this.startEmission(this.takePendingValue());
	}

	private takePendingValue(): T {
		const value = this.pendingValue as T;
		this.pendingValue = undefined;
		this.hasPendingValue = false;
		return value;
	}

	private startEmission(value: T): Promise<void> {
		this.lastEmitAt = Date.now();
		let emitted: Promise<void>;
		try {
			emitted = Promise.resolve(this.emitUpdate(value));
		} catch (error) {
			this.failure ??= error;
			emitted = Promise.resolve();
		}
		let tracked: Promise<void>;
		tracked = emitted
			.catch((error: unknown) => {
				this.failure ??= error;
			})
			.finally(() => {
				if (this.emission === tracked) {
					this.emission = undefined;
				}
				this.schedulePendingEmission();
			});
		this.emission = tracked;
		return tracked;
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
