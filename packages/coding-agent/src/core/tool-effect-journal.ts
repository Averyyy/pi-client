import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionManager, SessionMessageEntry } from "./session-manager.ts";

const TOOL_EFFECT_JOURNAL_VERSION = 1;
const TOOL_EFFECT_CHECKPOINT_VERSION = 1;
const JOURNAL_READ_BUFFER_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOOL_EFFECT_JOURNAL_SUFFIX = ".tool-effects.jsonl";
const DEFAULT_MAX_UNRESOLVED_EFFECTS = 1024;
const DEFAULT_MAX_UNRESOLVED_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHECKPOINT_RECORDS = 4096;
const DEFAULT_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const DEFAULT_WINDOWS_RENAME_RETRIES = 5;
const MAX_WINDOWS_RENAME_DELAY_MS = 100;

const TOOL_EFFECT_MAX_UNRESOLVED_EFFECTS_ENV = "PI_TOOL_EFFECT_MAX_UNRESOLVED_EFFECTS";
const TOOL_EFFECT_MAX_UNRESOLVED_BYTES_ENV = "PI_TOOL_EFFECT_MAX_UNRESOLVED_BYTES";
const TOOL_EFFECT_CHECKPOINT_RECORDS_ENV = "PI_TOOL_EFFECT_CHECKPOINT_RECORDS";
const TOOL_EFFECT_CHECKPOINT_BYTES_ENV = "PI_TOOL_EFFECT_CHECKPOINT_BYTES";
const TOOL_EFFECT_WINDOWS_RENAME_RETRIES_ENV = "PI_TOOL_EFFECT_WINDOWS_RENAME_RETRIES";

interface ToolEffectJournalConfig {
	maxUnresolvedEffects: number;
	maxUnresolvedBytes: number;
	checkpointRecords: number;
	checkpointBytes: number;
	windowsRenameRetries: number;
}

export type ToolEffectCheckpointStage =
	| "after_temp_open"
	| "after_temp_write"
	| "after_temp_fsync"
	| "before_replace"
	| "after_replace"
	| "before_directory_fsync"
	| "after_directory_fsync";

export interface ToolEffectJournalTestHooks {
	onCheckpointStage?: (stage: ToolEffectCheckpointStage) => void;
	beforeRenameAttempt?: (attempt: number) => void;
}

let toolEffectJournalTestHooks: ToolEffectJournalTestHooks | undefined;

export function setToolEffectJournalTestHooks(hooks: ToolEffectJournalTestHooks | undefined): void {
	toolEffectJournalTestHooks = hooks;
}

interface ToolEffectRecordBase {
	version: typeof TOOL_EFFECT_JOURNAL_VERSION;
	sequence: number;
	timestamp: number;
	effectId: string;
}

export interface ToolEffectIntentRecord extends ToolEffectRecordBase {
	kind: "intent";
	sessionId: string;
	assistantEntryId: string;
	toolCallId: string;
	toolName: string;
	toolCallIndex: number;
	argumentsHash: string;
}

interface ToolEffectResultRecord extends ToolEffectRecordBase {
	kind: "result";
	message: ToolResultMessage;
	finalizationPending?: true;
}

interface ToolEffectFinalizationRecord extends ToolEffectRecordBase {
	kind: "finalization";
}

interface ToolEffectFinalResultRecord extends ToolEffectRecordBase {
	kind: "final";
	message: ToolResultMessage;
}

interface ToolEffectCommitRecord extends ToolEffectRecordBase {
	kind: "commit";
	sessionEntryId: string;
}

interface ToolEffectCheckpointRecord {
	version: typeof TOOL_EFFECT_JOURNAL_VERSION;
	checkpointVersion: typeof TOOL_EFFECT_CHECKPOINT_VERSION;
	kind: "checkpoint";
	sequence: number;
	timestamp: number;
	generation: number;
	previousRecordCount: number;
	previousSha256: string;
	snapshotRecordCount: number;
	snapshotSha256: string;
}

type ToolEffectRecord =
	| ToolEffectIntentRecord
	| ToolEffectResultRecord
	| ToolEffectFinalizationRecord
	| ToolEffectFinalResultRecord
	| ToolEffectCommitRecord;

type ToolEffectJournalRecord = ToolEffectCheckpointRecord | ToolEffectRecord;

interface ToolEffectEnvelope {
	payload: string;
	sha256: string;
}

export interface DurableToolEffect {
	intent: ToolEffectIntentRecord;
	result?: ToolResultMessage;
	committedSessionEntryId?: string;
}

interface ParsedDurableToolEffect extends DurableToolEffect {
	resultRecordSeen: boolean;
	executionResult?: ToolResultMessage;
	resultFinalizationPending: boolean;
	finalizationStarted: boolean;
	finalResultWritten: boolean;
	resultTimestamp?: number;
	finalizationTimestamp?: number;
	finalResultTimestamp?: number;
}

interface ParsedToolEffectJournal {
	nextSequence: number;
	effects: Map<string, ParsedDurableToolEffect>;
	validBytes: number;
	fileBytes: number;
	recordCount: number;
	validSha256: string;
	checkpointGeneration: number;
}

export interface BeginToolEffectInput {
	sessionId: string;
	assistantEntryId: string;
	toolCallId: string;
	toolName: string;
	toolCallIndex: number;
	arguments: unknown;
	timestamp?: number;
}

export interface ToolEffectRecoveryResult {
	recoveredToolCallIds: string[];
	acknowledgedToolCallIds: string[];
}

export type ToolEffectResolutionPhase = "execution_unknown" | "finalization_unknown" | "result_durable" | "committed";

export interface ToolEffectResolutionTarget {
	sessionId: string;
	sessionPath: string;
	journalPath: string;
	effectId: string;
	toolCallId: string;
	toolName: string;
	phase: ToolEffectResolutionPhase;
}

export interface ToolEffectResolutionResult {
	target: ToolEffectResolutionTarget;
	sessionEntryId: string;
	alreadyResolved: boolean;
}

export type UnknownToolEffectResolutionTarget = ToolEffectResolutionTarget & {
	phase: "execution_unknown" | "finalization_unknown";
};

export interface SessionToolExecutionStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface RecoverableToolEffect {
	effect: ParsedDurableToolEffect;
	assistantIndex: number;
	persisted?: SessionMessageEntry;
}

export class ToolEffectUnknownOutcomeError extends Error {
	readonly code = "unknown_outcome";
	readonly toolCallIds: string[];
	readonly effects: UnknownToolEffectResolutionTarget[];

	constructor(effects: UnknownToolEffectResolutionTarget[], message?: string) {
		const details = effects
			.map(
				(effect) =>
					`sessionPath=${effect.sessionPath}\njournalPath=${effect.journalPath}\nsessionId=${effect.sessionId}\neffectId=${effect.effectId}\ntoolCallId=${effect.toolCallId}\ntoolName=${effect.toolName}\nphase=${effect.phase}`,
			)
			.join("\n\n");
		super(
			[
				message ?? "Cannot safely continue: tool effects may have occurred but their final outcomes are unknown.",
				details,
				"Resolve explicitly with `tool-effects mark-failed` or `tool-effects accept-result`; the tool will not be re-executed automatically.",
			].join("\n"),
		);
		this.name = "ToolEffectUnknownOutcomeError";
		this.toolCallIds = effects.map((effect) => effect.toolCallId);
		this.effects = effects.map((effect) => ({ ...effect }));
	}
}

export class ToolEffectRecoveryRequiredError extends Error {
	readonly code = "recovery_required";
	readonly toolCallId: string;

	constructor(toolCallId: string) {
		super(`Cannot execute tool call ${toolCallId}: a durable result is waiting to be recovered into session history`);
		this.name = "ToolEffectRecoveryRequiredError";
		this.toolCallId = toolCallId;
	}
}

export class ToolEffectJournalCapacityError extends Error {
	readonly code = "tool_effect_journal_capacity";

	constructor(message: string) {
		super(message);
		this.name = "ToolEffectJournalCapacityError";
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function readPositiveIntegerEnvironment(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined) return defaultValue;
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} must be a safe integer`);
	}
	return value;
}

function readNonNegativeIntegerEnvironment(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined) return defaultValue;
	if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} must be a safe integer`);
	}
	return value;
}

function getToolEffectJournalConfig(): ToolEffectJournalConfig {
	return {
		maxUnresolvedEffects: readPositiveIntegerEnvironment(
			TOOL_EFFECT_MAX_UNRESOLVED_EFFECTS_ENV,
			DEFAULT_MAX_UNRESOLVED_EFFECTS,
		),
		maxUnresolvedBytes: readPositiveIntegerEnvironment(
			TOOL_EFFECT_MAX_UNRESOLVED_BYTES_ENV,
			DEFAULT_MAX_UNRESOLVED_BYTES,
		),
		checkpointRecords: readPositiveIntegerEnvironment(TOOL_EFFECT_CHECKPOINT_RECORDS_ENV, DEFAULT_CHECKPOINT_RECORDS),
		checkpointBytes: readPositiveIntegerEnvironment(TOOL_EFFECT_CHECKPOINT_BYTES_ENV, DEFAULT_CHECKPOINT_BYTES),
		windowsRenameRetries: readNonNegativeIntegerEnvironment(
			TOOL_EFFECT_WINDOWS_RENAME_RETRIES_ENV,
			DEFAULT_WINDOWS_RENAME_RETRIES,
		),
	};
}

function canonicalizeJson(value: unknown, ancestors: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Tool effect identity cannot contain non-finite numbers");
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) {
			throw new Error("Tool effect identity cannot contain circular values");
		}
		ancestors.add(value);
		try {
			return value.map((item) => (item === undefined ? null : canonicalizeJson(item, ancestors)));
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value === "object") {
		if (ancestors.has(value)) {
			throw new Error("Tool effect identity cannot contain circular values");
		}
		ancestors.add(value);
		try {
			const canonical: Record<string, unknown> = {};
			for (const key of Object.keys(value).sort()) {
				const item = (value as Record<string, unknown>)[key];
				if (item !== undefined) {
					canonical[key] = canonicalizeJson(item, ancestors);
				}
			}
			return canonical;
		} finally {
			ancestors.delete(value);
		}
	}
	throw new Error(`Tool effect identity cannot contain ${typeof value} values`);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalizeJson(value, new Set()));
}

function canonicalPersistedJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error("Tool effect result is not JSON serializable");
	}
	return canonicalJson(JSON.parse(serialized) as unknown);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

function assertHash(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${path} must be a 64-character lowercase hex digest`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative safe integer`);
	}
}

function assertToolResultMessage(value: unknown, path: string): asserts value is ToolResultMessage {
	assertObject(value, path);
	if (value.role !== "toolResult") {
		throw new Error(`${path}.role must be toolResult`);
	}
	assertNonEmptyString(value.toolCallId, `${path}.toolCallId`);
	assertNonEmptyString(value.toolName, `${path}.toolName`);
	if (!Array.isArray(value.content)) {
		throw new Error(`${path}.content must be an array`);
	}
	for (const [index, content] of value.content.entries()) {
		assertObject(content, `${path}.content[${index}]`);
		if (content.type === "text") {
			if (typeof content.text !== "string") {
				throw new Error(`${path}.content[${index}].text must be a string`);
			}
			if (content.textSignature !== undefined && typeof content.textSignature !== "string") {
				throw new Error(`${path}.content[${index}].textSignature must be a string when present`);
			}
			continue;
		}
		if (content.type === "image") {
			if (typeof content.data !== "string") {
				throw new Error(`${path}.content[${index}].data must be a string`);
			}
			if (typeof content.mimeType !== "string") {
				throw new Error(`${path}.content[${index}].mimeType must be a string`);
			}
			continue;
		}
		throw new Error(`${path}.content[${index}].type must be text or image`);
	}
	if (typeof value.isError !== "boolean") {
		throw new Error(`${path}.isError must be a boolean`);
	}
	assertNonNegativeSafeInteger(value.timestamp, `${path}.timestamp`);
	if (value.addedToolNames !== undefined) {
		if (!Array.isArray(value.addedToolNames)) {
			throw new Error(`${path}.addedToolNames must be an array when present`);
		}
		for (const [index, toolName] of value.addedToolNames.entries()) {
			assertNonEmptyString(toolName, `${path}.addedToolNames[${index}]`);
		}
	}
	if (value.usage !== undefined) {
		assertObject(value.usage, `${path}.usage`);
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			assertNonNegativeSafeInteger(value.usage[key], `${path}.usage.${key}`);
		}
		for (const key of ["cacheWrite1h", "reasoning"] as const) {
			if (value.usage[key] !== undefined) {
				assertNonNegativeSafeInteger(value.usage[key], `${path}.usage.${key}`);
			}
		}
		assertObject(value.usage.cost, `${path}.usage.cost`);
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
			const cost = value.usage.cost[key];
			if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
				throw new Error(`${path}.usage.cost.${key} must be a non-negative finite number`);
			}
		}
	}
}

function parseRecord(payload: string, lineNumber: number): ToolEffectJournalRecord {
	let value: unknown;
	try {
		value = JSON.parse(payload) as unknown;
	} catch (error) {
		throw new Error(`Tool effect journal payload is invalid JSON at line ${lineNumber}`, { cause: error });
	}
	assertObject(value, `Tool effect journal line ${lineNumber}`);
	if (value.version !== TOOL_EFFECT_JOURNAL_VERSION) {
		throw new Error(`Unsupported tool effect journal version at line ${lineNumber}`);
	}
	assertNonNegativeSafeInteger(value.sequence, `Tool effect journal line ${lineNumber}.sequence`);
	assertNonNegativeSafeInteger(value.timestamp, `Tool effect journal line ${lineNumber}.timestamp`);
	if (value.kind === "checkpoint") {
		if (value.checkpointVersion !== TOOL_EFFECT_CHECKPOINT_VERSION) {
			throw new Error(`Unsupported tool effect checkpoint version at line ${lineNumber}`);
		}
		assertNonNegativeSafeInteger(value.generation, `Tool effect journal line ${lineNumber}.generation`);
		if (value.generation === 0) {
			throw new Error(`Tool effect journal line ${lineNumber}.generation must be positive`);
		}
		assertNonNegativeSafeInteger(
			value.previousRecordCount,
			`Tool effect journal line ${lineNumber}.previousRecordCount`,
		);
		assertHash(value.previousSha256, `Tool effect journal line ${lineNumber}.previousSha256`);
		assertNonNegativeSafeInteger(
			value.snapshotRecordCount,
			`Tool effect journal line ${lineNumber}.snapshotRecordCount`,
		);
		assertHash(value.snapshotSha256, `Tool effect journal line ${lineNumber}.snapshotSha256`);
		return {
			version: TOOL_EFFECT_JOURNAL_VERSION,
			checkpointVersion: TOOL_EFFECT_CHECKPOINT_VERSION,
			kind: "checkpoint",
			sequence: value.sequence,
			timestamp: value.timestamp,
			generation: value.generation,
			previousRecordCount: value.previousRecordCount,
			previousSha256: value.previousSha256,
			snapshotRecordCount: value.snapshotRecordCount,
			snapshotSha256: value.snapshotSha256,
		};
	}
	assertHash(value.effectId, `Tool effect journal line ${lineNumber}.effectId`);

	const base: ToolEffectRecordBase = {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		sequence: value.sequence,
		timestamp: value.timestamp,
		effectId: value.effectId,
	};
	if (value.kind === "intent") {
		assertNonEmptyString(value.sessionId, `Tool effect journal line ${lineNumber}.sessionId`);
		assertNonEmptyString(value.assistantEntryId, `Tool effect journal line ${lineNumber}.assistantEntryId`);
		assertNonEmptyString(value.toolCallId, `Tool effect journal line ${lineNumber}.toolCallId`);
		assertNonEmptyString(value.toolName, `Tool effect journal line ${lineNumber}.toolName`);
		assertNonNegativeSafeInteger(value.toolCallIndex, `Tool effect journal line ${lineNumber}.toolCallIndex`);
		assertHash(value.argumentsHash, `Tool effect journal line ${lineNumber}.argumentsHash`);
		return {
			...base,
			kind: "intent",
			sessionId: value.sessionId,
			assistantEntryId: value.assistantEntryId,
			toolCallId: value.toolCallId,
			toolName: value.toolName,
			toolCallIndex: value.toolCallIndex,
			argumentsHash: value.argumentsHash,
		};
	}
	if (value.kind === "result") {
		assertToolResultMessage(value.message, `Tool effect journal line ${lineNumber}.message`);
		if (value.finalizationPending !== undefined && value.finalizationPending !== true) {
			throw new Error(`Tool effect journal line ${lineNumber}.finalizationPending must be true when present`);
		}
		return {
			...base,
			kind: "result",
			message: value.message,
			finalizationPending: value.finalizationPending,
		};
	}
	if (value.kind === "finalization") {
		return { ...base, kind: "finalization" };
	}
	if (value.kind === "final") {
		assertToolResultMessage(value.message, `Tool effect journal line ${lineNumber}.message`);
		return { ...base, kind: "final", message: value.message };
	}
	if (value.kind === "commit") {
		assertNonEmptyString(value.sessionEntryId, `Tool effect journal line ${lineNumber}.sessionEntryId`);
		return { ...base, kind: "commit", sessionEntryId: value.sessionEntryId };
	}
	throw new Error(`Unsupported tool effect journal record kind at line ${lineNumber}`);
}

function applyRecord(
	effects: Map<string, ParsedDurableToolEffect>,
	record: ToolEffectRecord,
	lineNumber: number,
): void {
	if (record.kind === "intent") {
		if (effects.has(record.effectId)) {
			throw new Error(`Duplicate tool effect intent at line ${lineNumber}`);
		}
		for (const effect of effects.values()) {
			if (
				effect.intent.assistantEntryId === record.assistantEntryId &&
				effect.intent.toolCallIndex === record.toolCallIndex
			) {
				throw new Error(`Conflicting tool effect intent slot at line ${lineNumber}`);
			}
		}
		effects.set(record.effectId, {
			intent: record,
			resultRecordSeen: false,
			resultFinalizationPending: false,
			finalizationStarted: false,
			finalResultWritten: false,
		});
		return;
	}
	const effect = effects.get(record.effectId);
	if (!effect) {
		throw new Error(`Tool effect ${record.kind} has no matching intent at line ${lineNumber}`);
	}
	if (effect.committedSessionEntryId) {
		throw new Error(`Tool effect record follows commit at line ${lineNumber}`);
	}
	if (record.kind === "result") {
		if (
			record.message.toolCallId !== effect.intent.toolCallId ||
			record.message.toolName !== effect.intent.toolName
		) {
			throw new Error(`Tool effect result identity mismatch at line ${lineNumber}`);
		}
		if (effect.resultRecordSeen) {
			throw new Error(`Duplicate tool effect result at line ${lineNumber}`);
		}
		effect.resultRecordSeen = true;
		effect.executionResult = record.message;
		effect.resultFinalizationPending = record.finalizationPending === true;
		effect.finalizationStarted = record.finalizationPending === true;
		effect.result = record.message;
		effect.resultTimestamp = record.timestamp;
		if (record.finalizationPending === true) {
			effect.finalizationTimestamp = record.timestamp;
		}
		return;
	}
	if (record.kind === "finalization") {
		if (!effect.resultRecordSeen || !effect.result) {
			throw new Error(`Tool effect finalization precedes its durable result at line ${lineNumber}`);
		}
		if (effect.finalizationStarted) {
			throw new Error(`Duplicate tool effect finalization at line ${lineNumber}`);
		}
		effect.finalizationStarted = true;
		effect.finalizationTimestamp = record.timestamp;
		return;
	}
	if (record.kind === "final") {
		if (!effect.finalizationStarted) {
			throw new Error(`Tool effect final result has no matching finalization at line ${lineNumber}`);
		}
		if (effect.finalResultWritten) {
			throw new Error(`Duplicate tool effect final result at line ${lineNumber}`);
		}
		if (
			record.message.toolCallId !== effect.intent.toolCallId ||
			record.message.toolName !== effect.intent.toolName
		) {
			throw new Error(`Tool effect final result identity mismatch at line ${lineNumber}`);
		}
		effect.finalResultWritten = true;
		effect.result = record.message;
		effect.finalResultTimestamp = record.timestamp;
		return;
	}
	if (!effect.result) {
		throw new Error(`Tool effect commit precedes its durable result at line ${lineNumber}`);
	}
	if (effect.finalizationStarted && !effect.finalResultWritten) {
		throw new Error(`Tool effect commit precedes its final result at line ${lineNumber}`);
	}
	effect.committedSessionEntryId = record.sessionEntryId;
}

function findLastCompleteRecordBytes(path: string, fileBytes: number): number {
	if (fileBytes === 0) return 0;
	const handle = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(Math.min(JOURNAL_READ_BUFFER_BYTES, fileBytes));
		let end = fileBytes;
		while (end > 0) {
			const start = Math.max(0, end - buffer.byteLength);
			const length = end - start;
			const bytesRead = readSync(handle, buffer, 0, length, start);
			if (bytesRead !== length) {
				throw new Error(`Could not read tool effect journal tail: ${path}`);
			}
			const newlineIndex = buffer.lastIndexOf(0x0a, length - 1);
			if (newlineIndex !== -1) {
				return start + newlineIndex + 1;
			}
			end = start;
		}
		return 0;
	} finally {
		closeSync(handle);
	}
}

function createEmptyParsedJournal(fileBytes = 0): ParsedToolEffectJournal {
	return {
		nextSequence: 0,
		effects: new Map(),
		validBytes: 0,
		fileBytes,
		recordCount: 0,
		validSha256: sha256(""),
		checkpointGeneration: 0,
	};
}

function parseJournal(path: string): ParsedToolEffectJournal {
	if (!existsSync(path)) {
		return createEmptyParsedJournal();
	}
	const fileBytes = statSync(path).size;
	const validBytes = findLastCompleteRecordBytes(path, fileBytes);
	if (validBytes === 0) {
		return createEmptyParsedJournal(fileBytes);
	}

	const effects = new Map<string, ParsedDurableToolEffect>();
	const handle = openSync(path, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const validFileHash = createHash("sha256");
		const snapshotHash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(Math.min(JOURNAL_READ_BUFFER_BYTES, validBytes));
		let pending = "";
		let position = 0;
		let lineNumber = 0;
		let expectedSequence = 0;
		let checkpoint: ToolEffectCheckpointRecord | undefined;
		let snapshotRecordsSeen = 0;

		const consumeLine = (line: string): void => {
			lineNumber++;
			if (line.length === 0) {
				throw new Error(`Tool effect journal contains an empty record at line ${lineNumber}`);
			}
			let envelopeValue: unknown;
			try {
				envelopeValue = JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(`Tool effect journal envelope is invalid JSON at line ${lineNumber}`, { cause: error });
			}
			assertObject(envelopeValue, `Tool effect journal envelope line ${lineNumber}`);
			if (typeof envelopeValue.payload !== "string") {
				throw new Error(`Tool effect journal envelope payload must be a string at line ${lineNumber}`);
			}
			assertHash(envelopeValue.sha256, `Tool effect journal envelope line ${lineNumber}.sha256`);
			if (sha256(envelopeValue.payload) !== envelopeValue.sha256) {
				throw new Error(`Tool effect journal checksum mismatch at line ${lineNumber}`);
			}
			const record = parseRecord(envelopeValue.payload, lineNumber);
			if (record.sequence !== expectedSequence) {
				throw new Error(
					`Tool effect journal sequence mismatch at line ${lineNumber}: expected ${expectedSequence}, received ${record.sequence}`,
				);
			}
			expectedSequence++;
			if (record.kind === "checkpoint") {
				if (lineNumber !== 1 || checkpoint) {
					throw new Error(`Tool effect checkpoint must be the first and only checkpoint record`);
				}
				checkpoint = record;
				return;
			}
			if (checkpoint && snapshotRecordsSeen < checkpoint.snapshotRecordCount) {
				if (record.kind === "commit") {
					throw new Error(`Tool effect checkpoint snapshot contains a committed effect at line ${lineNumber}`);
				}
				snapshotHash.update(envelopeValue.payload);
				snapshotHash.update("\n");
				snapshotRecordsSeen++;
			}
			applyRecord(effects, record, lineNumber);
		};

		while (position < validBytes) {
			const length = Math.min(buffer.byteLength, validBytes - position);
			const bytesRead = readSync(handle, buffer, 0, length, position);
			if (bytesRead === 0) {
				throw new Error(`Tool effect journal ended before its last complete record: ${path}`);
			}
			position += bytesRead;
			validFileHash.update(buffer.subarray(0, bytesRead));
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				consumeLine(pending.slice(lineStart, newlineIndex));
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}
		pending += decoder.end();
		if (pending.length !== 0) {
			throw new Error(`Tool effect journal complete prefix does not end on a record boundary: ${path}`);
		}
		if (checkpoint && snapshotRecordsSeen !== checkpoint.snapshotRecordCount) {
			throw new Error(
				`Tool effect checkpoint snapshot is incomplete: expected ${checkpoint.snapshotRecordCount} records, received ${snapshotRecordsSeen}`,
			);
		}
		if (checkpoint && snapshotHash.digest("hex") !== checkpoint.snapshotSha256) {
			throw new Error(`Tool effect checkpoint snapshot checksum mismatch`);
		}
		return {
			nextSequence: expectedSequence,
			effects,
			validBytes,
			fileBytes,
			recordCount: lineNumber,
			validSha256: validFileHash.digest("hex"),
			checkpointGeneration: checkpoint?.generation ?? 0,
		};
	} finally {
		closeSync(handle);
	}
}

function encodeRecord(record: ToolEffectJournalRecord): { payload: string; encoded: Buffer } {
	const payload = JSON.stringify(record);
	const envelope: ToolEffectEnvelope = { payload, sha256: sha256(payload) };
	return { payload, encoded: Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8") };
}

function appendRecord(path: string, state: ParsedToolEffectJournal, record: ToolEffectRecord): void {
	if (state.validBytes !== state.fileBytes) {
		truncateSync(path, state.validBytes);
	}
	const { encoded } = encodeRecord(record);
	const fileExisted = existsSync(path);
	const handle = openSync(path, "a", 0o600);
	try {
		let written = 0;
		while (written < encoded.byteLength) {
			const bytesWritten = writeSync(handle, encoded, written, encoded.byteLength - written);
			if (bytesWritten === 0) {
				throw new Error(`Failed to make progress writing tool effect journal: ${path}`);
			}
			written += bytesWritten;
		}
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	if (!fileExisted && process.platform !== "win32") {
		const directoryHandle = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
	}
}

function requireRecordTimestamp(value: number | undefined, label: string): number {
	if (value === undefined) {
		throw new Error(`Tool effect journal lost ${label} timestamp`);
	}
	return value;
}

function buildUnresolvedSnapshotRecords(
	effects: Iterable<ParsedDurableToolEffect>,
	startSequence: number,
): ToolEffectRecord[] {
	const records: ToolEffectRecord[] = [];
	let sequence = startSequence;
	for (const effect of effects) {
		if (effect.committedSessionEntryId !== undefined) continue;
		records.push({ ...effect.intent, sequence: sequence++ });
		if (!effect.resultRecordSeen) continue;
		if (!effect.executionResult) {
			throw new Error(`Tool effect ${effect.intent.effectId} has a result marker without an execution result`);
		}
		records.push({
			version: TOOL_EFFECT_JOURNAL_VERSION,
			kind: "result",
			sequence: sequence++,
			timestamp: requireRecordTimestamp(effect.resultTimestamp, "result"),
			effectId: effect.intent.effectId,
			message: effect.executionResult,
			...(effect.resultFinalizationPending ? { finalizationPending: true as const } : {}),
		});
		if (effect.finalizationStarted && !effect.resultFinalizationPending) {
			records.push({
				version: TOOL_EFFECT_JOURNAL_VERSION,
				kind: "finalization",
				sequence: sequence++,
				timestamp: requireRecordTimestamp(effect.finalizationTimestamp, "finalization"),
				effectId: effect.intent.effectId,
			});
		}
		if (effect.finalResultWritten) {
			if (!effect.result) {
				throw new Error(`Tool effect ${effect.intent.effectId} has a final marker without a final result`);
			}
			records.push({
				version: TOOL_EFFECT_JOURNAL_VERSION,
				kind: "final",
				sequence: sequence++,
				timestamp: requireRecordTimestamp(effect.finalResultTimestamp, "final result"),
				effectId: effect.intent.effectId,
				message: effect.result,
			});
		}
	}
	return records;
}

function hashSnapshotPayloads(payloads: readonly string[]): string {
	const hash = createHash("sha256");
	for (const payload of payloads) {
		hash.update(payload);
		hash.update("\n");
	}
	return hash.digest("hex");
}

function checkpointStateProjection(effects: Iterable<ParsedDurableToolEffect>): string {
	return canonicalPersistedJson(
		[...effects]
			.filter((effect) => effect.committedSessionEntryId === undefined)
			.map((effect) => ({
				intent: { ...effect.intent, sequence: 0 },
				resultRecordSeen: effect.resultRecordSeen,
				executionResult: effect.executionResult,
				resultFinalizationPending: effect.resultFinalizationPending,
				finalizationStarted: effect.finalizationStarted,
				finalResultWritten: effect.finalResultWritten,
				result: effect.result,
				resultTimestamp: effect.resultTimestamp,
				finalizationTimestamp: effect.finalizationTimestamp,
				finalResultTimestamp: effect.finalResultTimestamp,
			})),
	);
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function waitForWindowsRenameRetry(attempt: number): void {
	const delay = Math.min(2 ** attempt * 5, MAX_WINDOWS_RENAME_DELAY_MS);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function replaceCheckpointFile(tempPath: string, path: string, windowsRenameRetries: number): void {
	for (let attempt = 0; ; attempt++) {
		try {
			toolEffectJournalTestHooks?.beforeRenameAttempt?.(attempt);
			renameSync(tempPath, path);
			return;
		} catch (error) {
			if (process.platform !== "win32" || getErrorCode(error) !== "EPERM" || attempt >= windowsRenameRetries) {
				throw error;
			}
			waitForWindowsRenameRetry(attempt);
		}
	}
}

function fsyncCheckpointDirectory(path: string): void {
	if (process.platform === "win32") {
		// libuv cannot fsync a Windows directory handle. Re-open and fsync the
		// replaced file so MoveFileEx/rename metadata and file contents are flushed.
		const handle = openSync(path, "r+");
		try {
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		return;
	}
	const handle = openSync(dirname(path), "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function writeCheckpointAtomically(
	path: string,
	encoded: Buffer,
	expectedProjection: string,
	config: ToolEffectJournalConfig,
): ParsedToolEffectJournal {
	const tempPath = `${path}.checkpoint-${process.pid}-${randomUUID()}.tmp`;
	let tempHandle: number | undefined;
	let replaced = false;
	let primaryError: unknown;
	let result: ParsedToolEffectJournal | undefined;
	const cleanupErrors: unknown[] = [];
	try {
		tempHandle = openSync(tempPath, "wx", 0o600);
		chmodSync(tempPath, 0o600);
		toolEffectJournalTestHooks?.onCheckpointStage?.("after_temp_open");
		let written = 0;
		while (written < encoded.byteLength) {
			const bytesWritten = writeSync(tempHandle, encoded, written, encoded.byteLength - written);
			if (bytesWritten === 0) {
				throw new Error(`Failed to make progress writing tool effect checkpoint: ${tempPath}`);
			}
			written += bytesWritten;
		}
		toolEffectJournalTestHooks?.onCheckpointStage?.("after_temp_write");
		fsyncSync(tempHandle);
		toolEffectJournalTestHooks?.onCheckpointStage?.("after_temp_fsync");
		closeSync(tempHandle);
		tempHandle = undefined;

		const checkpointState = parseJournal(tempPath);
		if (checkpointStateProjection(checkpointState.effects.values()) !== expectedProjection) {
			throw new Error(`Tool effect checkpoint verification did not preserve unresolved state`);
		}

		toolEffectJournalTestHooks?.onCheckpointStage?.("before_replace");
		replaceCheckpointFile(tempPath, path, config.windowsRenameRetries);
		replaced = true;
		toolEffectJournalTestHooks?.onCheckpointStage?.("after_replace");
		toolEffectJournalTestHooks?.onCheckpointStage?.("before_directory_fsync");
		fsyncCheckpointDirectory(path);
		toolEffectJournalTestHooks?.onCheckpointStage?.("after_directory_fsync");
		result = checkpointState;
	} catch (error) {
		primaryError = error;
	} finally {
		if (tempHandle !== undefined) {
			try {
				closeSync(tempHandle);
			} catch (closeError) {
				cleanupErrors.push(closeError);
			}
		}
		if (!replaced && existsSync(tempPath)) {
			try {
				unlinkSync(tempPath);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
	}
	if (primaryError !== undefined && cleanupErrors.length === 0) {
		throw primaryError;
	}
	if (primaryError !== undefined || cleanupErrors.length > 0) {
		throw new AggregateError(
			primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
			`Failed to write tool effect checkpoint`,
		);
	}
	if (!result) {
		throw new Error(`Tool effect checkpoint did not produce a verified state`);
	}
	return result;
}

function checkpointJournal(
	path: string,
	state: ParsedToolEffectJournal,
	config: ToolEffectJournalConfig,
): ParsedToolEffectJournal {
	if (state.recordCount === 0) return state;
	const snapshotRecords = buildUnresolvedSnapshotRecords(state.effects.values(), 1);
	const snapshotEncodings = snapshotRecords.map((record) => encodeRecord(record));
	const checkpoint: ToolEffectCheckpointRecord = {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		checkpointVersion: TOOL_EFFECT_CHECKPOINT_VERSION,
		kind: "checkpoint",
		sequence: 0,
		timestamp: Date.now(),
		generation: state.checkpointGeneration + 1,
		previousRecordCount: state.recordCount,
		previousSha256: state.validSha256,
		snapshotRecordCount: snapshotRecords.length,
		snapshotSha256: hashSnapshotPayloads(snapshotEncodings.map(({ payload }) => payload)),
	};
	const encoded = Buffer.concat([
		encodeRecord(checkpoint).encoded,
		...snapshotEncodings.map(({ encoded }) => encoded),
	]);
	return writeCheckpointAtomically(path, encoded, checkpointStateProjection(state.effects.values()), config);
}

function checkpointIfNeeded(
	path: string,
	state: ParsedToolEffectJournal,
	config: ToolEffectJournalConfig,
): ParsedToolEffectJournal {
	if (state.recordCount < config.checkpointRecords && state.validBytes < config.checkpointBytes) {
		return state;
	}
	return checkpointJournal(path, state, config);
}

export function checkpointToolEffectJournal(path: string): boolean {
	const state = parseJournal(path);
	if (state.recordCount === 0) return false;
	checkpointJournal(path, state, getToolEffectJournalConfig());
	return true;
}

function buildEffectIdentity(input: BeginToolEffectInput): {
	effectId: string;
	argumentsHash: string;
} {
	assertNonEmptyString(input.sessionId, "Tool effect sessionId");
	assertNonEmptyString(input.assistantEntryId, "Tool effect assistantEntryId");
	assertNonEmptyString(input.toolCallId, "Tool effect toolCallId");
	assertNonEmptyString(input.toolName, "Tool effect toolName");
	assertNonNegativeSafeInteger(input.toolCallIndex, "Tool effect toolCallIndex");
	const argumentsHash = sha256(canonicalJson(input.arguments));
	const effectId = sha256(
		canonicalJson({
			sessionId: input.sessionId,
			assistantEntryId: input.assistantEntryId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			toolCallIndex: input.toolCallIndex,
			argumentsHash,
		}),
	);
	return { effectId, argumentsHash };
}

function getUncommittedEffects(state: ParsedToolEffectJournal): ParsedDurableToolEffect[] {
	return [...state.effects.values()].filter((effect) => effect.committedSessionEntryId === undefined);
}

function getSnapshotEncodedBytes(effects: Iterable<ParsedDurableToolEffect>): number {
	return buildUnresolvedSnapshotRecords(effects, 1).reduce(
		(total, record) => total + encodeRecord(record).encoded.byteLength,
		0,
	);
}

export function getToolEffectJournalPath(sessionFile: string): string {
	return `${sessionFile}${TOOL_EFFECT_JOURNAL_SUFFIX}`;
}

function getToolEffectResolutionPhase(effect: ParsedDurableToolEffect): ToolEffectResolutionPhase {
	if (effect.committedSessionEntryId) return "committed";
	if (!effect.resultRecordSeen) return "execution_unknown";
	if (effect.finalizationStarted && !effect.finalResultWritten) return "finalization_unknown";
	return "result_durable";
}

function getToolEffectResolutionTarget(
	effect: ParsedDurableToolEffect,
	journalPath: string,
): ToolEffectResolutionTarget {
	if (!journalPath.endsWith(TOOL_EFFECT_JOURNAL_SUFFIX)) {
		throw new Error(`Tool effect journal path must end with ${TOOL_EFFECT_JOURNAL_SUFFIX}`);
	}
	return {
		sessionId: effect.intent.sessionId,
		sessionPath: journalPath.slice(0, -TOOL_EFFECT_JOURNAL_SUFFIX.length),
		journalPath,
		effectId: effect.intent.effectId,
		toolCallId: effect.intent.toolCallId,
		toolName: effect.intent.toolName,
		phase: getToolEffectResolutionPhase(effect),
	};
}

function getUnknownToolEffectResolutionTarget(
	effect: ParsedDurableToolEffect,
	journalPath: string,
): UnknownToolEffectResolutionTarget {
	const target = getToolEffectResolutionTarget(effect, journalPath);
	if (target.phase !== "execution_unknown" && target.phase !== "finalization_unknown") {
		throw new Error(`Tool effect ${effect.intent.effectId} does not have an unknown outcome`);
	}
	return { ...target, phase: target.phase };
}

export function beginToolEffect(path: string, input: BeginToolEffectInput): ToolEffectIntentRecord {
	const config = getToolEffectJournalConfig();
	let state = parseJournal(path);
	const { effectId, argumentsHash } = buildEffectIdentity(input);
	const existing = state.effects.get(effectId);
	if (existing) {
		if (existing.result) {
			throw new ToolEffectRecoveryRequiredError(existing.intent.toolCallId);
		}
		throw new ToolEffectUnknownOutcomeError([getUnknownToolEffectResolutionTarget(existing, path)]);
	}
	for (const effect of state.effects.values()) {
		if (
			effect.intent.assistantEntryId === input.assistantEntryId &&
			effect.intent.toolCallIndex === input.toolCallIndex
		) {
			throw new Error(
				`Tool effect slot ${input.assistantEntryId}:${input.toolCallIndex} already belongs to ${effect.intent.toolCallId}`,
			);
		}
	}

	state = checkpointIfNeeded(path, state, config);
	const timestamp = input.timestamp ?? Date.now();
	assertNonNegativeSafeInteger(timestamp, "Tool effect timestamp");
	const record: ToolEffectIntentRecord = {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		kind: "intent",
		sequence: state.nextSequence,
		timestamp,
		effectId,
		sessionId: input.sessionId,
		assistantEntryId: input.assistantEntryId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		toolCallIndex: input.toolCallIndex,
		argumentsHash,
	};
	const unresolvedEffects = getUncommittedEffects(state);
	if (unresolvedEffects.length + 1 > config.maxUnresolvedEffects) {
		throw new ToolEffectJournalCapacityError(
			`Cannot execute tool ${input.toolCallId}: unresolved tool effects would exceed ${config.maxUnresolvedEffects}`,
		);
	}
	const projectedEffect: ParsedDurableToolEffect = {
		intent: record,
		resultRecordSeen: false,
		resultFinalizationPending: false,
		finalizationStarted: false,
		finalResultWritten: false,
	};
	const projectedBytes = getSnapshotEncodedBytes([...unresolvedEffects, projectedEffect]);
	if (projectedBytes > config.maxUnresolvedBytes) {
		throw new ToolEffectJournalCapacityError(
			`Cannot execute tool ${input.toolCallId}: unresolved tool effect state would exceed ${config.maxUnresolvedBytes} bytes`,
		);
	}
	appendRecord(path, state, record);
	return record;
}

export function writeToolEffectResult(
	path: string,
	effectId: string,
	message: ToolResultMessage,
	options?: { finalizationPending?: boolean },
): void {
	assertHash(effectId, "Tool effect id");
	assertToolResultMessage(message, "Tool effect result");
	const state = parseJournal(path);
	const effect = state.effects.get(effectId);
	if (!effect) {
		throw new Error(`Cannot write result for unknown tool effect ${effectId}`);
	}
	if (effect.committedSessionEntryId) {
		throw new Error(`Cannot replace committed tool effect ${effectId}`);
	}
	if (message.toolCallId !== effect.intent.toolCallId || message.toolName !== effect.intent.toolName) {
		throw new Error(`Tool effect result identity does not match intent ${effectId}`);
	}
	if (effect.resultRecordSeen) {
		if (
			effect.executionResult &&
			canonicalPersistedJson(effect.executionResult) === canonicalPersistedJson(message) &&
			effect.resultFinalizationPending === (options?.finalizationPending === true)
		) {
			return;
		}
		throw new Error(`Divergent duplicate result for tool effect ${effectId}`);
	}
	appendRecord(path, state, {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		kind: "result",
		sequence: state.nextSequence,
		timestamp: Date.now(),
		effectId,
		message,
		...(options?.finalizationPending === true ? { finalizationPending: true as const } : {}),
	});
}

export function beginToolEffectFinalization(path: string, effectId: string, timestamp = Date.now()): void {
	assertHash(effectId, "Tool effect id");
	assertNonNegativeSafeInteger(timestamp, "Tool effect finalization timestamp");
	const state = parseJournal(path);
	const effect = state.effects.get(effectId);
	if (!effect) {
		throw new Error(`Cannot finalize unknown tool effect ${effectId}`);
	}
	if (effect.committedSessionEntryId) {
		throw new Error(`Cannot finalize committed tool effect ${effectId}`);
	}
	if (!effect.resultRecordSeen || !effect.result) {
		throw new Error(`Cannot finalize tool effect ${effectId} before its durable result`);
	}
	if (effect.finalizationStarted) {
		if (effect.finalResultWritten) {
			throw new ToolEffectRecoveryRequiredError(effect.intent.toolCallId);
		}
		throw new ToolEffectUnknownOutcomeError(
			[getUnknownToolEffectResolutionTarget(effect, path)],
			`Cannot safely continue: final tool result transformation is incomplete (${effect.intent.toolCallId})`,
		);
	}
	appendRecord(path, state, {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		kind: "finalization",
		sequence: state.nextSequence,
		timestamp,
		effectId,
	});
}

export function writeToolEffectFinalResult(
	path: string,
	effectId: string,
	message: ToolResultMessage,
	timestamp = Date.now(),
): void {
	assertHash(effectId, "Tool effect id");
	assertToolResultMessage(message, "Tool effect final result");
	assertNonNegativeSafeInteger(timestamp, "Tool effect final result timestamp");
	const state = parseJournal(path);
	const effect = state.effects.get(effectId);
	if (!effect) {
		throw new Error(`Cannot write final result for unknown tool effect ${effectId}`);
	}
	if (effect.committedSessionEntryId) {
		throw new Error(`Cannot replace committed tool effect ${effectId}`);
	}
	if (!effect.finalizationStarted) {
		throw new Error(`Cannot write final result for tool effect ${effectId} before finalization`);
	}
	if (message.toolCallId !== effect.intent.toolCallId || message.toolName !== effect.intent.toolName) {
		throw new Error(`Tool effect final result identity does not match intent ${effectId}`);
	}
	if (effect.finalResultWritten) {
		if (effect.result && canonicalPersistedJson(effect.result) === canonicalPersistedJson(message)) {
			return;
		}
		throw new Error(`Divergent duplicate final result for tool effect ${effectId}`);
	}
	appendRecord(path, state, {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		kind: "final",
		sequence: state.nextSequence,
		timestamp,
		effectId,
		message,
	});
}

export function commitToolEffect(path: string, effectId: string, sessionEntryId: string, timestamp = Date.now()): void {
	assertHash(effectId, "Tool effect id");
	assertNonEmptyString(sessionEntryId, "Tool effect sessionEntryId");
	assertNonNegativeSafeInteger(timestamp, "Tool effect commit timestamp");
	const state = parseJournal(path);
	const effect = state.effects.get(effectId);
	if (!effect) {
		throw new Error(`Cannot commit unknown tool effect ${effectId}`);
	}
	if (effect.committedSessionEntryId) {
		if (effect.committedSessionEntryId !== sessionEntryId) {
			throw new Error(`Tool effect ${effectId} is already committed to ${effect.committedSessionEntryId}`);
		}
		return;
	}
	if (!effect.result) {
		throw new Error(`Cannot commit tool effect ${effectId} before its durable result`);
	}
	if (effect.finalizationStarted && !effect.finalResultWritten) {
		throw new Error(`Cannot commit tool effect ${effectId} before its final result`);
	}
	appendRecord(path, state, {
		version: TOOL_EFFECT_JOURNAL_VERSION,
		kind: "commit",
		sequence: state.nextSequence,
		timestamp,
		effectId,
		sessionEntryId,
	});
}

function checkpointAfterSessionCommit(path: string): void {
	const config = getToolEffectJournalConfig();
	checkpointIfNeeded(path, parseJournal(path), config);
}

export function readDurableToolEffects(path: string): DurableToolEffect[] {
	return [...parseJournal(path).effects.values()].map((effect) => ({
		intent: { ...effect.intent },
		result: effect.result ? structuredClone(effect.result) : undefined,
		committedSessionEntryId: effect.committedSessionEntryId,
	}));
}

function getJournalPathForSession(sessionManager: SessionManager): string | undefined {
	const sessionFile = sessionManager.getSessionFile();
	return sessionFile ? getToolEffectJournalPath(sessionFile) : undefined;
}

function findUncommittedEffectForToolCall(
	state: ParsedToolEffectJournal,
	sessionId: string,
	toolCallId: string,
	toolName: string,
): ParsedDurableToolEffect | undefined {
	let matchingEffect: ParsedDurableToolEffect | undefined;
	for (const effect of getUncommittedEffects(state)) {
		if (
			effect.intent.sessionId !== sessionId ||
			effect.intent.toolCallId !== toolCallId ||
			effect.intent.toolName !== toolName
		) {
			continue;
		}
		if (matchingEffect) {
			throw new Error(`Multiple pending tool effects match tool call ${toolCallId}`);
		}
		matchingEffect = effect;
	}
	return matchingEffect;
}

export function beginSessionToolEffect(
	sessionManager: SessionManager,
	event: SessionToolExecutionStart,
): ToolEffectIntentRecord | undefined {
	if (!sessionManager.isPersisted()) return undefined;
	const path = getJournalPathForSession(sessionManager);
	if (!path) {
		throw new Error("Persistent session has no file for durable tool effect intent");
	}
	const branch = sessionManager.getBranch();
	for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex--) {
		const entry = branch[entryIndex];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const toolCalls = entry.message.content.filter((content) => content.type === "toolCall");
		const toolCallIndex = toolCalls.findIndex(
			(toolCall) => toolCall.id === event.toolCallId && toolCall.name === event.toolName,
		);
		if (toolCallIndex === -1) continue;
		const toolCall = toolCalls[toolCallIndex];
		if (canonicalJson(toolCall.arguments) !== canonicalJson(event.args)) {
			throw new Error(`Tool execution start arguments do not match assistant tool call ${event.toolCallId}`);
		}
		sessionManager.flushSessionFile();
		return beginToolEffect(path, {
			sessionId: sessionManager.getSessionId(),
			assistantEntryId: entry.id,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			toolCallIndex,
			arguments: event.args,
		});
	}
	throw new Error(`Cannot find assistant entry for tool execution ${event.toolCallId}`);
}

export function writeSessionToolEffectResult(
	sessionManager: SessionManager,
	message: ToolResultMessage,
	options?: { finalizationPending?: boolean },
): void {
	if (!sessionManager.isPersisted()) return;
	const path = getJournalPathForSession(sessionManager);
	if (!path || !existsSync(path)) {
		throw new Error(`Missing durable tool effect intent for result ${message.toolCallId}`);
	}
	const effect = findUncommittedEffectForToolCall(
		parseJournal(path),
		sessionManager.getSessionId(),
		message.toolCallId,
		message.toolName,
	);
	if (!effect) {
		throw new Error(`Missing pending tool effect intent for result ${message.toolCallId}`);
	}
	writeToolEffectResult(path, effect.intent.effectId, message, options);
}

export function beginSessionToolEffectFinalization(sessionManager: SessionManager, message: ToolResultMessage): void {
	if (!sessionManager.isPersisted()) return;
	const path = getJournalPathForSession(sessionManager);
	if (!path || !existsSync(path)) {
		throw new Error(`Missing durable tool effect result for finalization ${message.toolCallId}`);
	}
	const effect = findUncommittedEffectForToolCall(
		parseJournal(path),
		sessionManager.getSessionId(),
		message.toolCallId,
		message.toolName,
	);
	if (!effect) {
		throw new Error(`Missing pending tool effect result for finalization ${message.toolCallId}`);
	}
	beginToolEffectFinalization(path, effect.intent.effectId);
}

export function writeSessionToolEffectFinalResult(sessionManager: SessionManager, message: ToolResultMessage): void {
	if (!sessionManager.isPersisted()) return;
	const path = getJournalPathForSession(sessionManager);
	if (!path || !existsSync(path)) {
		throw new Error(`Missing durable tool effect finalization for result ${message.toolCallId}`);
	}
	const effect = findUncommittedEffectForToolCall(
		parseJournal(path),
		sessionManager.getSessionId(),
		message.toolCallId,
		message.toolName,
	);
	if (!effect) {
		throw new Error(`Missing pending tool effect finalization for result ${message.toolCallId}`);
	}
	writeToolEffectFinalResult(path, effect.intent.effectId, message);
}

export function commitSessionToolEffect(
	sessionManager: SessionManager,
	message: ToolResultMessage,
	sessionEntryId: string,
): void {
	if (!sessionManager.isPersisted()) return;
	const path = getJournalPathForSession(sessionManager);
	if (!path || !existsSync(path)) {
		throw new Error(`Missing durable tool effect result for session entry ${sessionEntryId}`);
	}
	const state = parseJournal(path);
	const effect = findUncommittedEffectForToolCall(
		state,
		sessionManager.getSessionId(),
		message.toolCallId,
		message.toolName,
	);
	if (effect) {
		if (!effect.result || canonicalPersistedJson(effect.result) !== canonicalPersistedJson(message)) {
			throw new Error(`Session tool result does not match durable effect ${effect.intent.effectId}`);
		}
		commitToolEffect(path, effect.intent.effectId, sessionEntryId);
		checkpointAfterSessionCommit(path);
		return;
	}
	const committed = [...state.effects.values()].find(
		(candidate) =>
			candidate.intent.sessionId === sessionManager.getSessionId() &&
			candidate.intent.toolCallId === message.toolCallId &&
			candidate.intent.toolName === message.toolName &&
			candidate.committedSessionEntryId === sessionEntryId,
	);
	if (!committed) {
		throw new Error(`Missing pending tool effect result for session entry ${sessionEntryId}`);
	}
	if (!committed.result || canonicalPersistedJson(committed.result) !== canonicalPersistedJson(message)) {
		throw new Error(`Session tool result does not match committed durable effect ${committed.intent.effectId}`);
	}
	checkpointIfNeeded(path, state, getToolEffectJournalConfig());
}

function getAssistantToolCalls(entry: SessionMessageEntry): AssistantMessage["content"] {
	if (entry.message.role !== "assistant") {
		throw new Error(`Tool effect assistant entry ${entry.id} is not an assistant message`);
	}
	return entry.message.content;
}

function validateEffectAgainstAssistant(effect: DurableToolEffect, entry: SessionMessageEntry): void {
	const toolCalls = getAssistantToolCalls(entry).filter((content) => content.type === "toolCall");
	const toolCall = toolCalls[effect.intent.toolCallIndex];
	if (
		!toolCall ||
		toolCall.id !== effect.intent.toolCallId ||
		toolCall.name !== effect.intent.toolName ||
		sha256(canonicalJson(toolCall.arguments)) !== effect.intent.argumentsHash
	) {
		throw new Error(
			`Tool effect ${effect.intent.effectId} does not match assistant entry ${effect.intent.assistantEntryId}`,
		);
	}
}

function findPersistedToolResult(
	branch: ReturnType<SessionManager["getBranch"]>,
	assistantIndex: number,
	effect: DurableToolEffect,
): SessionMessageEntry | undefined {
	for (let index = assistantIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === effect.intent.toolCallId
		) {
			if (entry.message.toolName !== effect.intent.toolName) {
				throw new Error(`Persisted tool result name does not match effect ${effect.intent.effectId}`);
			}
			return entry;
		}
	}
	return undefined;
}

function assertSafeRecoveryTail(
	branch: ReturnType<SessionManager["getBranch"]>,
	effects: RecoverableToolEffect[],
): void {
	if (effects.length === 0) return;
	const firstAssistantIndex = Math.min(...effects.map((candidate) => candidate.assistantIndex));
	const firstAssistantEntry = branch[firstAssistantIndex];
	if (firstAssistantEntry.type !== "message" || firstAssistantEntry.message.role !== "assistant") {
		throw new Error(`Tool effect recovery entry ${firstAssistantEntry.id} is not an assistant message`);
	}
	const allowedToolCallIds = new Set(
		firstAssistantEntry.message.content
			.filter((content) => content.type === "toolCall")
			.map((toolCall) => toolCall.id),
	);
	for (let index = firstAssistantIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message") {
			if (entry.message.role === "toolResult" && allowedToolCallIds.has(entry.message.toolCallId)) {
				continue;
			}
			if (entry.message.role === "bashExecution") {
				continue;
			}
			throw new Error(`Cannot recover tool effects after later model-visible history at session entry ${entry.id}`);
		}
		if (entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") {
			throw new Error(`Cannot recover tool effects after later model-visible history at session entry ${entry.id}`);
		}
	}
}

function loadToolEffectResolutionTarget(
	sessionManager: SessionManager,
	effectId: string,
): {
	path: string;
	state: ParsedToolEffectJournal;
	effect: ParsedDurableToolEffect;
	target: ToolEffectResolutionTarget;
} {
	assertHash(effectId, "Tool effect id");
	if (!sessionManager.isPersisted()) {
		throw new Error("Tool effect resolution requires a persisted session");
	}
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Persistent session has no session file");
	}
	const path = getToolEffectJournalPath(sessionFile);
	if (!existsSync(path)) {
		throw new Error(`Tool effect journal does not exist: ${path}`);
	}
	const state = parseJournal(path);
	const effect = state.effects.get(effectId);
	if (!effect) {
		throw new Error(`Tool effect ${effectId} does not exist in ${path}`);
	}
	if (effect.intent.sessionId !== sessionManager.getSessionId()) {
		throw new Error(`Tool effect ${effectId} does not belong to session ${sessionManager.getSessionId()}`);
	}
	const assistantEntry = sessionManager.getEntry(effect.intent.assistantEntryId);
	if (!assistantEntry || assistantEntry.type !== "message") {
		throw new Error(`Tool effect ${effectId} references a missing assistant entry`);
	}
	validateEffectAgainstAssistant(effect, assistantEntry);
	return {
		path,
		state,
		effect,
		target: getToolEffectResolutionTarget(effect, path),
	};
}

export function inspectToolEffect(sessionManager: SessionManager, effectId: string): ToolEffectResolutionTarget {
	return loadToolEffectResolutionTarget(sessionManager, effectId).target;
}

function resolveToolEffectWithResult(
	sessionManager: SessionManager,
	effectId: string,
	message: ToolResultMessage,
): ToolEffectResolutionResult {
	assertToolResultMessage(message, "Accepted tool result");
	const serializedMessage = JSON.stringify(message);
	if (serializedMessage === undefined) {
		throw new Error("Accepted tool result is not JSON serializable");
	}
	const durableMessage: unknown = JSON.parse(serializedMessage);
	assertToolResultMessage(durableMessage, "Accepted tool result");

	const { path, state, effect, target } = loadToolEffectResolutionTarget(sessionManager, effectId);
	if (durableMessage.toolCallId !== effect.intent.toolCallId || durableMessage.toolName !== effect.intent.toolName) {
		throw new Error(`Accepted tool result identity does not match tool effect ${effectId}`);
	}

	if (effect.committedSessionEntryId) {
		const committedEntry = sessionManager.getEntry(effect.committedSessionEntryId);
		if (
			!committedEntry ||
			committedEntry.type !== "message" ||
			committedEntry.message.role !== "toolResult" ||
			canonicalPersistedJson(committedEntry.message) !== canonicalPersistedJson(durableMessage) ||
			!effect.result ||
			canonicalPersistedJson(effect.result) !== canonicalPersistedJson(durableMessage)
		) {
			throw new Error(`Committed tool effect ${effectId} does not match the accepted result`);
		}
		checkpointIfNeeded(path, state, getToolEffectJournalConfig());
		return {
			target,
			sessionEntryId: effect.committedSessionEntryId,
			alreadyResolved: true,
		};
	}

	const branch = sessionManager.getBranch();
	const assistantIndex = branch.findIndex((entry) => entry.id === effect.intent.assistantEntryId);
	if (assistantIndex === -1) {
		throw new Error(`Tool effect ${effectId} is not on the active session branch`);
	}
	const persisted = findPersistedToolResult(branch, assistantIndex, effect);
	if (persisted && canonicalPersistedJson(persisted.message) !== canonicalPersistedJson(durableMessage)) {
		throw new Error(`Persisted tool result ${persisted.id} does not match the accepted result`);
	}

	if (target.phase === "result_durable") {
		if (!effect.result || canonicalPersistedJson(effect.result) !== canonicalPersistedJson(durableMessage)) {
			throw new Error(`Durable tool effect ${effectId} does not match the accepted result`);
		}
	} else if (target.phase !== "execution_unknown" && target.phase !== "finalization_unknown") {
		throw new Error(`Tool effect ${effectId} cannot be resolved from phase ${target.phase}`);
	}

	let sessionEntryId = persisted?.id;
	if (!sessionEntryId) {
		for (const candidate of getUncommittedEffects(state)) {
			if (
				candidate.intent.assistantEntryId !== effect.intent.assistantEntryId ||
				candidate.intent.toolCallIndex >= effect.intent.toolCallIndex
			) {
				continue;
			}
			if (!findPersistedToolResult(branch, assistantIndex, candidate)) {
				throw new Error(
					`Resolve earlier tool effect ${candidate.intent.effectId} before ${effect.intent.effectId}`,
				);
			}
		}
		assertSafeRecoveryTail(branch, [{ effect, assistantIndex }]);
		sessionEntryId = sessionManager.appendMessage(durableMessage);
		sessionManager.flushSessionFile();
	} else {
		sessionManager.flushSessionFile();
	}

	if (!effect.resultRecordSeen) {
		writeToolEffectResult(path, effectId, durableMessage, { finalizationPending: true });
	}
	const refreshed = parseJournal(path).effects.get(effectId);
	if (!refreshed) {
		throw new Error(`Tool effect ${effectId} disappeared during resolution`);
	}
	if (refreshed.finalizationStarted && !refreshed.finalResultWritten) {
		writeToolEffectFinalResult(path, effectId, durableMessage);
	}
	commitToolEffect(path, effectId, sessionEntryId);
	checkpointAfterSessionCommit(path);
	return { target, sessionEntryId, alreadyResolved: persisted !== undefined };
}

export function markToolEffectFailed(sessionManager: SessionManager, effectId: string): ToolEffectResolutionResult {
	const { effect } = loadToolEffectResolutionTarget(sessionManager, effectId);
	return resolveToolEffectWithResult(sessionManager, effectId, {
		role: "toolResult",
		toolCallId: effect.intent.toolCallId,
		toolName: effect.intent.toolName,
		content: [
			{
				type: "text",
				text: "Tool execution outcome was explicitly marked failed during recovery. The interrupted tool was not re-executed; external side effects may already have occurred.",
			},
		],
		isError: true,
		timestamp: effect.intent.timestamp,
	});
}

export function acceptToolEffectResult(
	sessionManager: SessionManager,
	effectId: string,
	message: unknown,
): ToolEffectResolutionResult {
	assertToolResultMessage(message, "Accepted tool result");
	return resolveToolEffectWithResult(sessionManager, effectId, message);
}

export function recoverToolEffects(sessionManager: SessionManager, journalPath?: string): ToolEffectRecoveryResult {
	const sessionFile = sessionManager.getSessionFile();
	const path = journalPath ?? (sessionFile ? getToolEffectJournalPath(sessionFile) : undefined);
	if (!path || !existsSync(path)) {
		return { recoveredToolCallIds: [], acknowledgedToolCallIds: [] };
	}
	const state = parseJournal(path);
	const branch = sessionManager.getBranch();
	const branchIndexes = new Map(branch.map((entry, index) => [entry.id, index]));
	const activeEffects: RecoverableToolEffect[] = [];

	for (const effect of state.effects.values()) {
		if (!effect.committedSessionEntryId) continue;
		const result = effect.result;
		if (!result) {
			throw new Error(`Committed tool effect ${effect.intent.effectId} has no durable result`);
		}
		const sessionEntry = sessionManager.getEntry(effect.committedSessionEntryId);
		if (
			!sessionEntry ||
			sessionEntry.type !== "message" ||
			sessionEntry.message.role !== "toolResult" ||
			canonicalPersistedJson(sessionEntry.message) !== canonicalPersistedJson(result)
		) {
			throw new Error(
				`Committed tool effect ${effect.intent.effectId} does not match session entry ${effect.committedSessionEntryId}`,
			);
		}
	}

	for (const effect of getUncommittedEffects(state)) {
		if (effect.intent.sessionId !== sessionManager.getSessionId()) {
			throw new Error(`Tool effect journal session id does not match ${sessionManager.getSessionId()}`);
		}
		const assistantIndex = branchIndexes.get(effect.intent.assistantEntryId);
		if (assistantIndex === undefined) {
			continue;
		}
		const assistantEntry = branch[assistantIndex];
		if (assistantEntry.type !== "message") {
			throw new Error(`Tool effect assistant entry ${assistantEntry.id} is not a message`);
		}
		validateEffectAgainstAssistant(effect, assistantEntry);
		const persisted = findPersistedToolResult(branch, assistantIndex, effect);
		if (persisted) {
			const result = effect.result;
			if (
				result &&
				(!effect.finalizationStarted || effect.finalResultWritten) &&
				canonicalPersistedJson(persisted.message) !== canonicalPersistedJson(result)
			) {
				throw new Error(
					`Persisted tool result ${persisted.id} does not match durable effect ${effect.intent.effectId}`,
				);
			}
		}
		activeEffects.push({ effect, assistantIndex, persisted });
	}

	const unknownEffects = activeEffects
		.filter(
			(candidate) =>
				candidate.effect.result === undefined ||
				(candidate.effect.finalizationStarted && !candidate.effect.finalResultWritten),
		)
		.map((candidate) => getUnknownToolEffectResolutionTarget(candidate.effect, path));
	if (unknownEffects.length > 0) {
		throw new ToolEffectUnknownOutcomeError(
			unknownEffects,
			"Cannot safely continue: tool effects may have occurred but their final outcomes are unknown.",
		);
	}

	const acknowledgedToolCallIds: string[] = [];
	for (const candidate of activeEffects) {
		if (!candidate.persisted) continue;
		sessionManager.flushSessionFile();
		commitToolEffect(path, candidate.effect.intent.effectId, candidate.persisted.id);
		acknowledgedToolCallIds.push(candidate.effect.intent.toolCallId);
	}

	const recoverable = activeEffects.filter((candidate) => candidate.persisted === undefined);
	assertSafeRecoveryTail(branch, recoverable);
	recoverable.sort(
		(left, right) =>
			left.assistantIndex - right.assistantIndex ||
			left.effect.intent.toolCallIndex - right.effect.intent.toolCallIndex,
	);
	const recoveredToolCallIds: string[] = [];
	for (const candidate of recoverable) {
		const result = candidate.effect.result;
		if (!result) {
			throw new Error(`Tool effect ${candidate.effect.intent.effectId} lost its durable result during recovery`);
		}
		const sessionEntryId = sessionManager.appendMessage(structuredClone(result));
		sessionManager.flushSessionFile();
		commitToolEffect(path, candidate.effect.intent.effectId, sessionEntryId);
		recoveredToolCallIds.push(candidate.effect.intent.toolCallId);
	}
	checkpointAfterSessionCommit(path);
	return { recoveredToolCallIds, acknowledgedToolCallIds };
}
