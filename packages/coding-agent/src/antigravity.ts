import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AcpFormRequest } from "./core/antigravity-interactions.ts";

export { ANTIGRAVITY_PROVIDER, logoutAntigravity, readAntigravityModels } from "./core/antigravity-acp.ts";
export { type AntigravityClient, AntigravityRuntime } from "./core/antigravity-runtime.ts";

export type AntigravityCallback =
	| { kind: "tool"; call: ToolCall; assistant: AssistantMessage }
	| { kind: "permission"; title: string; choices: string[] }
	| { kind: "question"; request: AcpFormRequest };
