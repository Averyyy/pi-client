import assert from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import { normalizeAppleTerminalInput, ProcessTerminal, reraiseSignalIfUnowned } from "../src/terminal.ts";

describe("normalizeAppleTerminalInput", () => {
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	type NegotiationHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		send(data: string): void;
		getInput(): string | undefined;
		cleanup(): void;
	};

	function setupNegotiation(): NegotiationHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		let input: string | undefined;
		let dataHandler: ((data: string) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		(
			terminal as unknown as {
				inputHandler?: (data: string) => void;
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler = (data) => {
			input = data;
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			send(data: string): void {
				dataHandler?.(data);
			},
			getInput(): string | undefined {
				return input;
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		const harness = setupNegotiation();
		try {
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("activates Kitty mode for non-zero negotiated flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			harness.cleanup();
			assert.equal(harness.writes.join("").match(/\x1b\[<u/g)?.length, 1);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?0u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			harness.cleanup();
			assert.equal(harness.writes.join("").match(/\x1b\[>4;0m/g)?.length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for device attributes without Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?62;4;52c");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards normal input while waiting for Kitty response", () => {
		const harness = setupNegotiation();
		try {
			harness.send("a");

			assert.equal(harness.getInput(), "a");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("tracks split Kitty confirmation", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7");
			mock.timers.tick(10);

			assert.equal(harness.getInput(), undefined);

			harness.send("u");

			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});

	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[");
			mock.timers.tick(10);

			assert.equal(harness.getInput(), undefined);

			mock.timers.tick(150);

			assert.equal(harness.getInput(), "\x1b[");
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal output backpressure", () => {
	it("exposes drain and coalesces direct terminal state while blocked", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;
		let firstWrite = true;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			if (firstWrite) {
				firstWrite = false;
				return false;
			}
			return true;
		}) as typeof process.stdout.write;

		try {
			assert.strictEqual(terminal.write("frame"), false);
			let drains = 0;
			const removeDrain = terminal.onDrain(() => {
				drains += 1;
			});

			assert.strictEqual(terminal.setTitle("old"), false);
			assert.strictEqual(terminal.setTitle("latest"), false);
			assert.strictEqual(terminal.write("raw-after-backpressure"), false);
			(terminal as unknown as { enableModifyOtherKeys(): void }).enableModifyOtherKeys();
			assert.strictEqual(terminal.hideCursor(), false);
			assert.strictEqual(terminal.setProgress(true), false);
			assert.deepStrictEqual(writes, ["frame"]);

			process.stdout.emit("drain");

			assert.strictEqual(drains, 1);
			assert.strictEqual(writes.length, 2);
			assert.ok(writes[1]?.includes("\x1b]0;latest\x07"));
			assert.ok(!writes[1]?.includes("\x1b]0;old\x07"));
			assert.ok(writes[1]?.includes("raw-after-backpressure"));
			assert.ok(writes[1]?.includes("\x1b[>4;2m"), "keyboard state must not be overwritten by cursor state");
			assert.ok(writes[1]?.includes("\x1b[?25l"), "cursor state must not be overwritten by keyboard state");
			assert.ok(writes[1]?.includes("\x1b]9;4;3\x07"));
			removeDrain();
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
			setKittyProtocolActive(false);
		}
	});

	it("fails explicitly instead of growing pending raw output without a bound", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return false;
		}) as typeof process.stdout.write;

		try {
			assert.strictEqual(terminal.write("frame"), false);
			for (let index = 0; index < 256; index++) {
				assert.strictEqual(terminal.write("x"), false);
			}
			assert.throws(() => terminal.write("overflow"), /Terminal pending output capacity exceeded/);
			assert.deepStrictEqual(writes, ["frame"]);
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
		}
	});

	it("observes a pre-existing once signal owner before deciding whether to re-raise", () => {
		const emitter = new EventEmitter();
		const calls: string[] = [];
		emitter.once("signal", () => {
			calls.push("application");
		});
		emitter.prependOnceListener("signal", () => {
			calls.push("terminal");
			reraiseSignalIfUnowned(emitter.listenerCount("signal"), () => {
				calls.push("reraise");
			});
		});

		emitter.emit("signal");
		assert.deepStrictEqual(calls, ["terminal", "application"]);
	});

	it("re-raises an unowned signal after the reset listener is removed", () => {
		const emitter = new EventEmitter();
		let reraises = 0;
		emitter.prependOnceListener("signal", () => {
			reraiseSignalIfUnowned(emitter.listenerCount("signal"), () => {
				reraises += 1;
			});
		});

		emitter.emit("signal");
		assert.strictEqual(reraises, 1, "an unowned signal must recover the default exit behavior");
	});

	it("prepends emergency reset handlers ahead of pre-existing once handlers", () => {
		const terminal = new ProcessTerminal();
		const applicationHandler = () => {};
		process.once("SIGTERM", applicationHandler);
		try {
			(terminal as unknown as { installEmergencyResetHandlers(): void }).installEmergencyResetHandlers();
			const terminalHandler = (
				terminal as unknown as { emergencySignalHandlers: Map<NodeJS.Signals, () => void> }
			).emergencySignalHandlers.get("SIGTERM");
			assert.ok(terminalHandler);
			const listeners = process.listeners("SIGTERM");
			assert.ok(listeners.indexOf(terminalHandler) < listeners.indexOf(applicationHandler));
		} finally {
			(terminal as unknown as { removeEmergencyResetHandlers(): void }).removeEmergencyResetHandlers();
			process.removeListener("SIGTERM", applicationHandler);
		}
	});

	it("writes one complete terminal reset when stopped under backpressure", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return false;
		}) as typeof process.stdout.write;

		try {
			assert.strictEqual(terminal.write("frame"), false);
			(terminal as unknown as { enableModifyOtherKeys(): void }).enableModifyOtherKeys();
			terminal.setProgress(true);
			terminal.stop();

			assert.strictEqual(writes.length, 2);
			const cleanup = writes[1] ?? "";
			assert.ok(cleanup.includes("\x1b[?2026l"));
			assert.ok(cleanup.includes("\x1b]9;4;0;\x07"));
			assert.ok(cleanup.includes("\x1b[?2004l"));
			assert.ok(cleanup.includes("\x1b[>4;0m"));
			assert.ok(cleanup.includes("\x1b[?25h"));
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
			setKittyProtocolActive(false);
		}
	});
});
