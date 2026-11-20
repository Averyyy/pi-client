/**
 * Wire identity of the official Antigravity CLI, shared by catalog and inference requests so
 * the backend sees the same client for both.
 */

import { createHash } from "node:crypto";
import { arch, platform } from "node:process";

export const ANTIGRAVITY_CLIENT_VERSION = "1.5.9";
export const ANTIGRAVITY_CLIENT_BUILD = "1021519450";

const OS_TYPE = platform === "win32" ? "windows" : platform;

/** The official CLI User-Agent for this platform and architecture. */
export const ANTIGRAVITY_USER_AGENT = `antigravity/cli/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client; os_type=${OS_TYPE}; arch=${arch === "x64" ? "amd64" : arch}; cl=${ANTIGRAVITY_CLIENT_BUILD}; auth_method=consumer)`;

/** The conversation id the official CLI sends: FNV-1a of its empty seed as a signed decimal. */
export const ANTIGRAVITY_SESSION_ID = fnv1a64("");

export interface AntigravityRequestIdentity {
	/** Conversation id shared by every request of one session and used in the request id. */
	cascadeId: string;
	rootCascadeId: string;
	trajectoryId: string;
	/** Unique id of this request; the request id and its label both carry it. */
	requestUuid: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the ids the official CLI derives per conversation; a missing session id stays random. */
export function antigravityRequestIdentity(sessionId: string | undefined): AntigravityRequestIdentity {
	const requestUuid = crypto.randomUUID();
	if (!sessionId) {
		return { cascadeId: requestUuid, rootCascadeId: requestUuid, trajectoryId: crypto.randomUUID(), requestUuid };
	}
	// pi session ids are UUIDs already; other callers get a stable derived cascade id.
	const cascadeId = UUID_PATTERN.test(sessionId) ? sessionId : derivedUuid("cascade", sessionId);
	return { cascadeId, rootCascadeId: cascadeId, trajectoryId: derivedUuid("trajectory", sessionId), requestUuid };
}

/** Unsigned FNV-1a 64-bit over UTF-8 bytes, printed as the signed 64-bit decimal the CLI sends. */
function fnv1a64(seed: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(seed)) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	}
	return BigInt.asIntN(64, hash).toString();
}

/** Deterministic RFC 9562 UUIDv8 for values the CLI would have generated per conversation. */
function derivedUuid(scope: string, key: string): string {
	const bytes = createHash("sha256")
		.update("antigravity/identity/v1\0")
		.update(scope)
		.update("\0")
		.update(key)
		.digest();
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
