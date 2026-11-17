import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, createContextKey, withContextValue } from "@earendil-works/chord/context";
import { test } from "vitest";
import { replicatedState } from "../../../src/harness/pico3/replicated-state.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("hydrates synchronously and retains immutable revisions without empty publications", () => {
	const state = replicatedState({ count: 0, items: ["a"] });
	const initial = state.value;
	const deliveries: number[] = [];
	const stop = state.subscribe((_value, _context, delivery) => deliveries.push(delivery.sequence));
	assert.deepEqual(deliveries, [0]);
	state.change(BACKGROUND_CONTEXT, (draft) => {
		draft.count = 1;
		draft.items.push("b");
	});
	state.change(BACKGROUND_CONTEXT, () => {});
	assert.deepEqual(initial, { count: 0, items: ["a"] });
	assert.deepEqual(state.value, { count: 1, items: ["a", "b"] });
	assert.deepEqual(deliveries, [0, 1]);
	stop();
	state.replace(BACKGROUND_CONTEXT, { count: 2, items: [] });
	assert.deepEqual(deliveries, [0, 1]);
});

test("publishes reentrant changes in commit order with each commit's context", () => {
	const state = replicatedState({ count: 0 });
	const key = createContextKey<string>("commit");
	const first = withContextValue(key, "first", BACKGROUND_CONTEXT);
	const second = withContextValue(key, "second", BACKGROUND_CONTEXT);
	state.subscribe((value) => {
		if (value.count === 1) state.replace(second, { count: 2 });
	});
	const seen: [number, string | undefined][] = [];
	state.subscribe((value, context) => seen.push([value.count, context.value(key)]));
	state.replace(first, { count: 1 });
	assert.deepEqual(seen, [
		[0, undefined],
		[1, "first"],
		[2, "second"],
	]);
});

test("serializes asynchronous hydration and retains the newest update on overflow", async () => {
	const state = replicatedState({ count: 0 });
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seen: number[] = [];
	const stop = state.subscribe(async (value) => {
		seen.push(value.count);
		if (value.count === 0) await pending;
	});
	for (let count = 1; count <= 101; count++) state.replace(BACKGROUND_CONTEXT, { count });
	assert.deepEqual(seen, [0]);
	release();
	await tick();
	assert.deepEqual(seen, [0, 101]);
	stop();
});

test("aborts an unsuccessful mutation without publishing it", () => {
	const state = replicatedState({ count: 0 });
	const values: number[] = [];
	state.subscribe((value) => values.push(value.count));
	assert.throws(
		() =>
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.count = 1;
				throw new Error("failed");
			}),
		/failed/,
	);
	assert.equal(state.value.count, 0);
	assert.deepEqual(values, [0]);
	state.replace(BACKGROUND_CONTEXT, { count: 2 });
	assert.deepEqual(values, [0, 2]);
});
