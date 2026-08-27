/** Structured error codes for the pi-server HTTP protocol. */

export const PiServerErrorCode = {
	SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
	SESSION_NO_STATIC_CONTEXT: "SESSION_NO_STATIC_CONTEXT",
	PARENT_ENTRY_NOT_FOUND: "PARENT_ENTRY_NOT_FOUND",
	LEAF_ID_NOT_FOUND: "LEAF_ID_NOT_FOUND",
	ENTRY_ALREADY_EXISTS: "ENTRY_ALREADY_EXISTS",
	INVALID_REQUEST: "INVALID_REQUEST",
	REQUIRED_FIELD_MISSING: "REQUIRED_FIELD_MISSING",
	RUN_NOT_FOUND: "RUN_NOT_FOUND",
	RUN_IN_PROGRESS: "RUN_IN_PROGRESS",
	INTERNAL_ERROR: "INTERNAL_ERROR",
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

export function isRecoverableTreeDivergenceCode(code: PiServerErrorCode | undefined): boolean {
	return (
		code === PiServerErrorCode.PARENT_ENTRY_NOT_FOUND ||
		code === PiServerErrorCode.LEAF_ID_NOT_FOUND ||
		code === PiServerErrorCode.ENTRY_ALREADY_EXISTS
	);
}

export function isRecoverableMissingServerStateCode(code: PiServerErrorCode | undefined): boolean {
	return (
		code === PiServerErrorCode.SESSION_NOT_FOUND ||
		code === PiServerErrorCode.SESSION_NO_STATIC_CONTEXT ||
		code === PiServerErrorCode.PARENT_ENTRY_NOT_FOUND ||
		code === PiServerErrorCode.LEAF_ID_NOT_FOUND ||
		code === PiServerErrorCode.ENTRY_ALREADY_EXISTS
	);
}
