// Mutable replicated state with ordered publications for Pico conversation views.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type Draft, type Prepared, type Tracker, track } from "@earendil-works/chord/delta";

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/**
	 * Contract-immutable current value. It is not frozen and may share containers with an
	 * in-process provider; consumers must not mutate it. Later updates do not mutate previously returned values.
	 */
	readonly value: T;
	/**
	 * Each subscription serializes callbacks, awaiting hydration before updates. Values are immutable and may
	 * share unchanged revision data. At most 100 deliveries wait behind the running callback; overflow keeps
	 * only the newest pending value/context/delivery, so update sequences may skip. Failures are reported in
	 * isolation and delivery continues. Unsubscribe discards pending work without aborting or joining a callback.
	 */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>): () => void;
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/**
	 * Atomically publish one synchronous overlay mutation. Draft handles are unusable after the callback returns.
	 * Values placed through the draft are cloned by value; assigning `undefined` to an object property deletes it.
	 */
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	/**
	 * Atomically take immutable ownership of an alias-free strict-JSON replacement.
	 * The caller must not mutate the transferred root after this call.
	 */
	replace(context: Context, value: T): void;
}

/** Create mutable state with synchronous hydration and ordered immutable updates. */
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T> {
	return new MutableReplicatedStateImpl(initial);
}

/** The void signature also accepts synchronous callbacks that return an ignored value. */
type StateListener<T> = (value: T, context: Context, delivery: ReplicatedStateDelivery) => void;

type StateDelivery<T> = {
	readonly value: T;
	readonly context: Context;
	readonly delivery: ReplicatedStateDelivery;
};

/** One public subscription, independent of producer and other subscriber progress. */
class StateSubscriber<T> {
	readonly #listener: StateListener<T>;
	readonly #reportError: (error: Error) => void;
	readonly #pending: StateDelivery<T>[] = [];
	#running = false;
	#closed = false;

	constructor(listener: StateListener<T>, reportError: (error: Error) => void) {
		this.#listener = listener;
		this.#reportError = reportError;
	}

	push(frame: StateDelivery<T>): void {
		if (this.#closed) return;
		if (this.#pending.length === 100) this.#pending.length = 0;
		this.#pending.push(frame);
	}

	drain(): void {
		if (this.#running || this.#closed) return;
		this.#running = true;
		for (let frame = this.#pending.shift(); frame !== undefined; frame = this.#pending.shift()) {
			try {
				const result: unknown = this.#listener(frame.value, frame.context, frame.delivery);
				if (isPromiseLike(result)) {
					void Promise.resolve(result).then(
						() => this.#resume(),
						(error: unknown) => {
							this.#report(error);
							this.#resume();
						},
					);
					return;
				}
			} catch (error) {
				this.#report(error);
			}
		}
		this.#running = false;
	}

	close(): void {
		this.#closed = true;
		this.#pending.length = 0;
	}

	#resume(): void {
		this.#running = false;
		this.drain();
	}

	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (reportError) {
			reportErrorAsync(toError(reportError));
		}
	}
}

type Publication<T> = {
	readonly value: T;
	readonly sequence: number;
	readonly context: Context;
};

/** Maintains local publication order independently of how revisions are produced. */
class ReplicatedStatePublisher<T> {
	readonly #listeners = new Map<StateSubscriber<T>, number>();
	readonly #reportError: (error: Error) => void;
	readonly #publications: Publication<T>[] = [];
	#value: T;
	#sequence = 0;
	#delivering = false;

	constructor(initial: T, reportError: (error: Error) => void = reportErrorAsync) {
		this.#value = initial;
		this.#reportError = reportError;
	}

	subscribe(listener: StateListener<T>): () => void {
		const value = this.#value;
		const sequence = this.#sequence;
		const subscriber = new StateSubscriber(listener, this.#reportError);
		this.#listeners.set(subscriber, sequence);
		// Hydration has no caller; it is delivered with the background context.
		subscriber.push({ value, context: BACKGROUND_CONTEXT, delivery: { kind: "hydrate", sequence } });
		subscriber.drain();
		return () => {
			subscriber.close();
			this.#listeners.delete(subscriber);
		};
	}

	/** Publish an already-prepared immutable revision. Subscriber failures are reported, never thrown. */
	publish(value: T, context: Context): void {
		this.#value = value;
		this.#sequence += 1;
		this.#publications.push({ value, sequence: this.#sequence, context });
		if (this.#delivering) return;

		this.#delivering = true;
		try {
			for (
				let publication = this.#publications.shift();
				publication !== undefined;
				publication = this.#publications.shift()
			) {
				const delivery = { kind: "update", sequence: publication.sequence } as const;
				for (const [subscriber, hydratedSequence] of [...this.#listeners]) {
					if (publication.sequence <= hydratedSequence) continue;
					subscriber.push({ value: publication.value, context: publication.context, delivery });
					subscriber.drain();
				}
			}
		} finally {
			this.#delivering = false;
		}
	}
}

class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	readonly #tracker: Tracker<T>;
	readonly #publisher: ReplicatedStatePublisher<T>;
	#changing = false;

	constructor(initial: T) {
		this.#tracker = track(initial);
		this.#publisher = new ReplicatedStatePublisher(this.#tracker.value);
	}

	get value(): T {
		return this.#tracker.value;
	}

	change(context: Context, mutate: Parameters<MutableReplicatedState<T>["change"]>[1]): void {
		if (this.#changing) throw new Error("Replicated state cannot be changed reentrantly from a change callback");
		this.#changing = true;
		let prepared: Prepared<T>;
		try {
			const change = this.#tracker.beginChange();
			try {
				const outcome = (mutate as (draft: typeof change.state) => unknown)(change.state);
				if (isPromiseLike(outcome)) {
					void Promise.resolve(outcome).catch(() => undefined);
					throw new TypeError("Replicated state change callbacks must be synchronous");
				}
				prepared = change.prepare();
			} catch (error) {
				change.abort();
				throw error;
			}
		} finally {
			this.#changing = false;
		}

		this.#tracker.adopt(prepared);
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
	}

	replace(context: Context, value: T): void {
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		const prepared = this.#tracker.prepareReplace(value);
		this.#tracker.adopt(prepared);
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
	}

	subscribe(listener: StateListener<T>): () => void {
		return this.#publisher.subscribe(listener);
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function reportErrorAsync(error: Error): void {
	queueMicrotask(() => {
		throw error;
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
