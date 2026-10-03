import assert from "node:assert/strict";
import { it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("screen snapshots preserve the rendered viewport and overlays without exposing mutable state", async () => {
	const terminal = new VirtualTerminal(20, 3);
	const tui = new TuiAltScreen(terminal);
	tui.addChild(new Text("one\ntwo\nthree\nfour\nfive", 0, 0));
	assert.deepEqual(tui.getScreenLines(), []);
	tui.start();
	try {
		await terminal.waitForRender();
		const snapshot = tui.getScreenLines();
		assert.deepEqual(
			snapshot.map((line) => stripTerminalSequences(line).trimEnd()),
			["three", "four", "five"],
		);
		snapshot[0] = "mutated";
		assert.notEqual(tui.getScreenLines()[0], "mutated");
		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepEqual(
			tui.getScreenLines().map((line) => stripTerminalSequences(line).trimEnd()),
			["two", "three", "four"],
		);
		const overlay = tui.showOverlay(new Text("overlay", 0, 0), { width: 10, row: 1, col: 0 });
		await terminal.waitForRender();
		assert.ok(tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("overlay")));
		overlay.hide();
		await terminal.waitForRender();
		assert.ok(tui.getScreenLines().every((line) => !stripTerminalSequences(line).includes("overlay")));
	} finally {
		tui.stop();
	}
});
