import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getPiClientUpdateMarkerPath,
	readPiClientUpdateMarker,
	writePiClientRuntimeReloadState,
} from "../src/core/pi-client-runtime-update.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("pi-client runtime update", () => {
	it("reads a valid update marker and returns undefined when no marker exists", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-client-update-"));
		tempDirs.push(agentDir);
		const markerPath = getPiClientUpdateMarkerPath(agentDir);
		expect(readPiClientUpdateMarker(agentDir)).toBeUndefined();
		writeFileSync(markerPath, '{"version":"0.80.6-piclient.5","updatedAt":"2026-07-10T00:00:00.000Z"}\n');

		expect(readPiClientUpdateMarker(agentDir)).toEqual({
			version: "0.80.6-piclient.5",
			updatedAt: "2026-07-10T00:00:00.000Z",
		});

		writeFileSync(markerPath, "{invalid json\n");
		expect(() => readPiClientUpdateMarker(agentDir)).toThrow(SyntaxError);

		writeFileSync(markerPath, '{"version":true}\n');
		expect(() => readPiClientUpdateMarker(agentDir)).toThrow(`Invalid pi-client update marker: ${markerPath}`);
	});

	it("surfaces filesystem errors while reading the marker", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-client-update-"));
		tempDirs.push(agentDir);
		mkdirSync(getPiClientUpdateMarkerPath(agentDir));

		expect(() => readPiClientUpdateMarker(agentDir)).toThrow();
	});

	it("writes reload state for the wrapper", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-client-reload-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "state.json");

		writePiClientRuntimeReloadState(path, {
			sessionId: "session-1",
			sessionDir: "C:/sessions",
			leafId: "branch-leaf-1",
			args: ["-e", "C:/fixtures/provider.ts", "--no-mcp"],
			updatedAt: "2026-10-18T00:00:01.000Z",
		});

		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			sessionId: "session-1",
			sessionDir: "C:/sessions",
			leafId: "branch-leaf-1",
			args: ["-e", "C:/fixtures/provider.ts", "--no-mcp"],
			updatedAt: "2026-10-18T00:00:01.000Z",
		});
	});
});
