import type { AnyModel, AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";

interface ProviderFailure {
	operation: "stream" | "compact" | "image" | "classifier" | "deferred-cancel";
	phase: "dispatch" | "stream" | "result";
	sessionId: string;
	runId?: string;
	model: Pick<AnyModel, "id" | "provider" | "api">;
	elapsedMs: number;
	requestKind?: "api" | "simple" | "deferred";
	authSource?: "server-account";
	reasoning?: string;
	maxTokens?: number;
	messageCount?: number;
	toolCount?: number;
	upstreamStatus?: number;
	upstreamResponses?: number;
	code?: string;
	error?: unknown;
	assistant?: Pick<AssistantMessage, "rawStopReason" | "diagnostics">;
}

/** Write correlation and structured error fields to stderr without logging request or error text. */
export function logProviderFailure(failure: ProviderFailure): void {
	const { model, error, assistant, upstreamStatus } = failure;
	const diagnostics = assistant?.diagnostics;
	const diagnosticCode = diagnostics?.find((entry) => entry.error?.code !== undefined)?.error?.code;
	const thrown = error instanceof Error ? error : undefined;
	const cause = thrown?.cause instanceof Error ? thrown.cause : undefined;
	const transportCode = ((cause ?? thrown) as (Error & { code?: unknown }) | undefined)?.code;
	console.error(
		JSON.stringify({
			event: "provider_failure",
			timestamp: new Date().toISOString(),
			operation: failure.operation,
			phase: failure.phase,
			sessionId: failure.sessionId,
			runId: failure.runId,
			provider: model.provider,
			model: model.id,
			api: model.api,
			elapsedMs: Math.round(failure.elapsedMs),
			requestKind: failure.requestKind,
			authSource: failure.authSource,
			reasoning: failure.reasoning,
			maxTokens: failure.maxTokens,
			messageCount: failure.messageCount,
			toolCount: failure.toolCount,
			code: failure.code,
			upstreamStatus: upstreamStatus ?? (thrown && normalizeProviderError(thrown).status),
			upstreamResponses: failure.upstreamResponses,
			providerCode: errorCode(diagnosticCode),
			stopReason: errorCode(assistant?.rawStopReason),
			diagnosticTypes: diagnostics?.map((entry) => entry.type),
			errorName: errorCode(thrown?.name),
			transportCode: errorCode(transportCode),
		}),
	);
}

function errorCode(value: unknown): string | number | undefined {
	if (typeof value === "number") return value;
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : undefined;
}
