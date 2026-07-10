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
	updateMarkerPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function getPiClientUpdateMarkerPath(agentDir = getAgentDir()): string {
	return join(agentDir, UPDATE_MARKER_FILE);
}

export function readPiClientUpdateMarker(agentDir = getAgentDir()): PiClientUpdateMarker | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(getPiClientUpdateMarkerPath(agentDir), "utf-8"));
		if (!isRecord(value) || typeof value.version !== "string" || typeof value.updatedAt !== "string") {
			return undefined;
		}
		return { version: value.version, updatedAt: value.updatedAt };
	} catch {
		return undefined;
	}
}

export function writePiClientRuntimeReloadState(path: string, state: PiClientRuntimeReloadState): void {
	writeFileSync(path, `${JSON.stringify(state)}\n`);
}
