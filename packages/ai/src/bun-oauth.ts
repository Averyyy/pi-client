import * as devinRuntime from "./api/devin.ts";
import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { devinOAuth } from "./auth/oauth/devin.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import * as googleAntigravity from "./auth/oauth/google-antigravity.ts";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { metaOAuth } from "./auth/oauth/meta.ts";
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "./auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		devin: () => devinOAuth,
		devinRuntime: () => devinRuntime,
		googleAntigravity: () => googleAntigravity.googleAntigravityOAuth,
		googleAntigravityCatalog: () => googleAntigravity,
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiChatGPT: () => openaiChatGPTOAuth,
		githubCopilot: () => githubCopilotOAuth,
		openrouter: () => openRouterOAuth,
		kimiCoding: () => kimiCodingOAuth,
		meta: () => metaOAuth,
		xai: () => xaiOAuth,
		radius: createRadiusOAuth,
	});
}
