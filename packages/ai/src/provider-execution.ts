import type { Api } from "./types.ts";

export const PI_PROVIDER_EXECUTION_CONTRACT_VERSION = 1;

export type ProviderExecutionRoute =
	| { kind: "builtin_provider"; id: string }
	| { kind: "builtin_api"; id: Api }
	| { kind: "custom_api"; id: Api }
	| { kind: "missing_api"; id: Api };
