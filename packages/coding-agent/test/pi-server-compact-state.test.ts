import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acknowledgePiServerPendingCompact,
	readPiServerPendingCompact,
	writePiServerAppliedCompact,
	writePiServerPendingCompact,
	writePiServerTerminalCompact,
} from "../src/core/pi-server-compact-state.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

describe("pi-server compact state", () => {
	let directory: string;
	let statePath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-server-compact-state-"));
		statePath = join(directory, "state.jsonl");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function writePending(operationId = "operation-1"): void {
		writePiServerPendingCompact(statePath, {
			serverHash: HASH_A,
			sessionId: "session-1",
			operationId,
			requestHash: HASH_B,
			baseStaticContextHash: HASH_C,
			baseTreeHash: HASH_D,
			baseEntryCount: 3,
			baseLeafId: "u2",
			baseRevision: 4,
			timestamp: 100,
		});
	}

	it("durably records an idempotent local apply before acknowledgement", () => {
		writePending();
		const applied = {
			operationId: "operation-1",
			requestHash: HASH_B,
			entryId: "compact-1",
			entryHash: HASH_E,
			updatedTreeHash: HASH_A,
			updatedLeafId: "compact-1",
			updatedRevision: 5,
			timestamp: 101,
		} as const;

		expect(writePiServerAppliedCompact(statePath, applied)).toMatchObject({
			kind: "applied",
			resolution: "tree_applied",
		});
		expect(writePiServerAppliedCompact(statePath, applied)).toEqual(
			expect.objectContaining({ kind: "applied", sequence: 1 }),
		);
		expect(readPiServerPendingCompact(statePath)?.observation).toMatchObject({
			kind: "applied",
			entryId: "compact-1",
		});

		acknowledgePiServerPendingCompact(statePath, "operation-1", "server_missing_after_tree_applied", 102);
		expect(readPiServerPendingCompact(statePath)).toBeUndefined();

		writePending("operation-2");
		expect(readPiServerPendingCompact(statePath)).toMatchObject({
			operationId: "operation-2",
			sequence: 0,
		});
	});

	it("truncates an incomplete crash tail before appending the next durable observation", () => {
		writePending();
		appendFileSync(statePath, '{"payload":"incomplete');

		expect(readPiServerPendingCompact(statePath)?.operationId).toBe("operation-1");
		writePiServerAppliedCompact(statePath, {
			operationId: "operation-1",
			requestHash: HASH_B,
			entryId: "compact-1",
			entryHash: HASH_E,
			updatedTreeHash: HASH_A,
			updatedLeafId: "compact-1",
			updatedRevision: 5,
			timestamp: 101,
		});

		expect(readFileSync(statePath, "utf-8")).not.toContain("incomplete");
		expect(readPiServerPendingCompact(statePath)?.observation?.kind).toBe("applied");
	});

	it("fails closed on checksum tampering", () => {
		writePending();
		const [line] = readFileSync(statePath, "utf-8").trimEnd().split("\n");
		const envelope = JSON.parse(line) as { payload: string; sha256: string };
		envelope.sha256 = "0".repeat(64);
		writeFileSync(statePath, `${JSON.stringify(envelope)}\n`, "utf-8");

		expect(() => readPiServerPendingCompact(statePath)).toThrow("checksum mismatch");
	});

	it("rejects a divergent second observation for the same operation", () => {
		writePending();
		writePiServerAppliedCompact(statePath, {
			operationId: "operation-1",
			requestHash: HASH_B,
			entryId: "compact-1",
			entryHash: HASH_E,
			updatedTreeHash: HASH_A,
			updatedLeafId: "compact-1",
			updatedRevision: 5,
		});

		expect(() =>
			writePiServerAppliedCompact(statePath, {
				operationId: "operation-1",
				requestHash: HASH_B,
				entryId: "compact-divergent",
				entryHash: HASH_C,
				updatedTreeHash: HASH_A,
				updatedLeafId: "compact-divergent",
				updatedRevision: 5,
			}),
		).toThrow("divergent durable observation");
	});

	it.each([
		["terminal", "failed", "terminal_failed_observed"],
		["not_started", "rejected", "server_rejected"],
	] as const)("records an exact %s terminal disposition", (operationDisposition, status, resolution) => {
		writePending();
		expect(
			writePiServerTerminalCompact(statePath, {
				operationId: "operation-1",
				requestHash: HASH_B,
				httpStatus: operationDisposition === "terminal" ? 502 : 409,
				error: "compact failed",
				operationDisposition,
				status,
				timestamp: 101,
			}),
		).toMatchObject({ kind: "terminal", operationDisposition, status, resolution });
	});
});
