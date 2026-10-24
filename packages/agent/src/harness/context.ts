import type { Context, ContextKey } from "@earendil-works/chord";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	withTelemetry,
} from "@earendil-works/chord/context";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";

export {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	type ContextKey,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withTelemetry,
	withoutAbortSignal,
};

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
	return context.telemetry;
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withTelemetry(
		{
			...NOOP_TELEMETRY_CONTEXT,
			metrics: telemetryContext.metrics,
			propagation: telemetryContext.propagation,
			startSpan: telemetryContext.startSpan.bind(telemetryContext),
		},
		context,
	);
}
