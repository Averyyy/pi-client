import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const PI_CLIENT_RUNTIME_RELOAD_EXIT_CODE = 75;
const UPDATE_MARKER_FILE = "pi-client-update.json";

export interface PiClientUpdateMarker {
	version: string;
	updatedAt: string;
}

export interface PiClientRuntimeReloadState {
	sessionId: string;
	sessionDir?: string;
	leafId: string | null;
	args: string[];
	updatedAt: string;
}

export function getPiClientUpdateMarkerPath(agentDir = getAgentDir()): string {
	return join(agentDir, UPDATE_MARKER_FILE);
}

export function readPiClientUpdateMarker(agentDir = getAgentDir()): PiClientUpdateMarker | undefined {
	const path = getPiClientUpdateMarkerPath(agentDir);
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(content) as Partial<PiClientUpdateMarker> | null;
	if (typeof value?.version !== "string" || typeof value?.updatedAt !== "string") {
		throw new Error(`Invalid pi-client update marker: ${path}`);
	}
	return { version: value.version, updatedAt: value.updatedAt };
}

export function writePiClientRuntimeReloadState(path: string, state: PiClientRuntimeReloadState): void {
	writeFileSync(path, `${JSON.stringify(state)}\n`);
}
