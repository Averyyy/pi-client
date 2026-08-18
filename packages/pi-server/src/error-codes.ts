/**
 * Structured error codes for pi-server protocol.
 * Replaces fragile regex matching of English error messages.
 */

export const PiServerErrorCode = {
	// Session errors
	SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
	SESSION_NO_STATIC_CONTEXT: "SESSION_NO_STATIC_CONTEXT",

	// Tree errors (recoverable divergence)
	PARENT_ENTRY_NOT_FOUND: "PARENT_ENTRY_NOT_FOUND",
	LEAF_ID_NOT_FOUND: "LEAF_ID_NOT_FOUND",
	ENTRY_ALREADY_EXISTS: "ENTRY_ALREADY_EXISTS",

	// Validation errors
	INVALID_REQUEST: "INVALID_REQUEST",
	REQUIRED_FIELD_MISSING: "REQUIRED_FIELD_MISSING",

	// Run errors
	RUN_NOT_FOUND: "RUN_NOT_FOUND",

	// Transient errors (network/upstream)
	TRANSIENT_ERROR: "TRANSIENT_ERROR",
	UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
	UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const;

export type PiServerErrorCode = (typeof PiServerErrorCode)[keyof typeof PiServerErrorCode];

export interface PiServerErrorResponse {
	error: string;
	code?: PiServerErrorCode;
	details?: Record<string, unknown>;
}

export class PiServerError extends Error {
	public readonly code: PiServerErrorCode;
	public readonly details?: Record<string, unknown>;

	constructor(message: string, code: PiServerErrorCode, details?: Record<string, unknown>) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
		this.details = details;
	}
}

/**
 * Check if an error code indicates recoverable tree divergence.
 */
export function isRecoverableTreeDivergenceCode(code: PiServerErrorCode | undefined): boolean {
	return (
		code === PiServerErrorCode.PARENT_ENTRY_NOT_FOUND ||
		code === PiServerErrorCode.LEAF_ID_NOT_FOUND ||
		code === PiServerErrorCode.ENTRY_ALREADY_EXISTS
	);
}

/**
 * Check if an error code indicates missing server state that can be recovered.
 */
export function isRecoverableMissingServerStateCode(code: PiServerErrorCode | undefined): boolean {
	return (
		code === PiServerErrorCode.SESSION_NO_STATIC_CONTEXT ||
		code === PiServerErrorCode.PARENT_ENTRY_NOT_FOUND ||
		code === PiServerErrorCode.LEAF_ID_NOT_FOUND ||
		code === PiServerErrorCode.ENTRY_ALREADY_EXISTS
	);
}
