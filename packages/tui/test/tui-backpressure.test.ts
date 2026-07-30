import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";

class StreamingComponent implements Component {
	line = "initial";
	renderCount = 0;
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		this.renderCount += 1;
		return [`${this.line}${CURSOR_MARKER}`];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

class SlowTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	private inputHandler?: (data: string) => void;
	private blocked = false;
	private blockNextWrite = true;
	private drainListeners = new Set<() => void>();

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {
		this.inputHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): boolean {
		this.writes.push(data);
		if (this.blockNextWrite) {
			this.blockNextWrite = false;
			this.blocked = true;
			return false;
		}
		return !this.blocked;
	}

	onDrain(listener: () => void): () => void {
		this.drainListeners.add(listener);
		return () => {
			this.drainListeners.delete(listener);
		};
	}

	moveBy(_lines: number): boolean {
		return true;
	}

	hideCursor(): boolean {
		return true;
	}

	showCursor(): boolean {
		return true;
	}

	clearLine(): boolean {
		return true;
	}

	clearFromCursor(): boolean {
		return true;
	}

	clearScreen(): boolean {
		return true;
	}

	setTitle(_title: string): boolean {
		return true;
	}

	setProgress(_active: boolean): boolean {
		return true;
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	emitDrain(): void {
		this.blocked = false;
		for (const listener of [...this.drainListeners]) {
			listener();
		}
	}

	get drainListenerCount(): number {
		return this.drainListeners.size;
	}
}

class ThrowOnceTerminal extends SlowTerminal {
	private shouldThrow = true;

	override write(data: string): boolean {
		if (this.shouldThrow) {
			this.shouldThrow = false;
			throw new Error("simulated terminal write failure");
		}
		return super.write(data);
	}
}

class MultilineComponent implements Component {
	render(_width: number): string[] {
		return [`top${CURSOR_MARKER}`, "bottom"];
	}

	invalidate(): void {}
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(message);
}

describe("TUI output backpressure", () => {
	it("keeps one queued frame and renders only the latest state after drain", async () => {
		const terminal = new SlowTerminal();
		const component = new StreamingComponent();
		const tui = new TUI(terminal, true);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();

		await waitFor(() => terminal.writes.length === 1, "initial render did not reach the terminal");
		assert.strictEqual(terminal.drainListenerCount, 1);
		assert.strictEqual(component.renderCount, 1);

		for (let i = 0; i < 20_000; i++) {
			component.line = `stream ${i}`;
			tui.requestRender();
		}
		terminal.sendInput("x");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));

		assert.deepStrictEqual(component.inputs, ["x"], "input must remain live while stdout is backpressured");
		assert.strictEqual(terminal.writes.length, 1, "no extra frame may enter the blocked stdout queue");
		assert.strictEqual(component.renderCount, 1, "blocked renders must coalesce before component rendering");

		terminal.emitDrain();
		await waitFor(() => terminal.writes.length === 2, "latest frame was not rendered after drain");

		assert.strictEqual(terminal.writes.length, 2, "drain must render exactly one replacement frame");
		assert.ok(terminal.writes[1]?.includes("stream 19999"), "the replacement frame must contain latest state");
		assert.ok(
			!terminal.writes[1]?.includes("\x1b[2J"),
			"the replacement must diff from the already accepted frame state",
		);
		assert.strictEqual(component.renderCount, 2);
		const state = tui as unknown as {
			previousLines: string[];
			hardwareCursorRow: number;
			renderRequested: boolean;
		};
		assert.ok(state.previousLines[0]?.includes("stream 19999"));
		assert.strictEqual(state.hardwareCursorRow, 0);
		assert.strictEqual(state.renderRequested, false);
		for (const frame of terminal.writes) {
			assert.strictEqual(frame.match(/\x1b\[\?2026h/g)?.length, 1);
			assert.strictEqual(frame.match(/\x1b\[\?2026l/g)?.length, 1);
		}

		component.line = "after drain";
		tui.requestRender();
		await waitFor(() => terminal.writes.length === 3, "rendering did not continue after drain");
		assert.ok(terminal.writes[2]?.includes("after drain"));
		tui.stop();
	});

	it("stops during backpressure with a synchronized-output reset and no late render", async () => {
		const terminal = new SlowTerminal();
		const component = new StreamingComponent();
		const tui = new TUI(terminal);
		tui.addChild(component);
		tui.start();
		await waitFor(() => terminal.writes.length === 1, "initial render did not reach the terminal");

		component.line = "must not render";
		tui.requestRender();
		tui.stop();

		assert.strictEqual(terminal.drainListenerCount, 0);
		assert.ok(terminal.writes.at(-1)?.includes("\x1b[?2026l"));
		const writesAtStop = terminal.writes.length;
		terminal.emitDrain();
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		assert.strictEqual(terminal.writes.length, writesAtStop);
	});

	it("does not write direct terminal queries until output drains", async () => {
		const terminal = new SlowTerminal();
		const component = new StreamingComponent();
		const tui = new TUI(terminal);
		tui.addChild(component);
		tui.start();
		await waitFor(() => terminal.writes.length === 1, "initial render did not reach the terminal");

		const background = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
		const colorScheme = tui.queryTerminalColorScheme({ timeoutMs: 10 });
		assert.strictEqual(terminal.writes.length, 1, "direct terminal queries must queue behind backpressure");

		terminal.emitDrain();
		assert.strictEqual(terminal.writes.length, 2);
		assert.ok(terminal.writes[1]?.includes("\x1b]11;?\x07"));
		assert.ok(terminal.writes[1]?.includes("\x1b[?996n"));
		await Promise.all([background, colorScheme]);
		tui.stop();
	});

	it("fails explicitly when deferred direct terminal output reaches its bound", async () => {
		const terminal = new SlowTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new StreamingComponent());
		tui.start();
		await waitFor(() => terminal.writes.length === 1, "initial render did not reach the terminal");
		const writeTerminal = (tui as unknown as { writeTerminal(data: string): boolean }).writeTerminal.bind(tui);

		for (let index = 0; index < 256; index++) {
			assert.strictEqual(writeTerminal("x"), false);
		}
		assert.throws(() => writeTerminal("overflow"), /TUI pending terminal output capacity exceeded/);
		assert.strictEqual(terminal.writes.length, 1);
		tui.stop();
	});

	it("keeps committed cursor state when a forced redraw is stopped before drain", async () => {
		const terminal = new SlowTerminal();
		const tui = new TUI(terminal, true);
		tui.addChild(new MultilineComponent());
		tui.start();
		await waitFor(() => terminal.writes.length === 1, "initial render did not reach the terminal");

		tui.requestRender(true);
		tui.stop();

		assert.ok(
			terminal.writes.at(-1)?.includes("\x1b[2B"),
			"stop must move below the accepted two-line frame using committed cursor state",
		);
	});

	it("best-effort terminates synchronized output when a frame write throws", () => {
		const terminal = new ThrowOnceTerminal();
		const component = new StreamingComponent();
		const tui = new TUI(terminal);
		tui.addChild(component);

		assert.throws(() => (tui as unknown as { doRender(): void }).doRender(), /simulated terminal write failure/);
		assert.strictEqual(terminal.writes.at(-1), "\x1b[?2026l");
	});
});
