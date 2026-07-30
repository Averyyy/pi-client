import type { Api, Model } from "@earendil-works/pi-ai";
import { getCompatProviderExecutionRoute } from "@earendil-works/pi-ai/compat";
import { hashRemoteProviderExecution } from "@earendil-works/pi-ai/provider-execution-node";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProviderExecutionContract } from "./provider-execution-contract.ts";

const PI_SERVER_UNSUPPORTED_PROVIDER_HOOKS = [
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
] as const;

interface ProviderHookRegistry {
	hasHandlers(eventType: string): boolean;
}

export interface PiServerProviderExecutionPreflight {
	contract: ProviderExecutionContract;
	providerExecutionFingerprint: string;
}

/**
 * Reject execution paths that pi-server cannot reproduce exactly.
 *
 * This preflight is synchronous and credential-free so callers can run it
 * before extension hooks, auth resolution, session mutation, or network I/O.
 */
export function assertPiServerProviderExecution(
	modelRuntime: ModelRuntime,
	model: Model<Api>,
	hooks?: ProviderHookRegistry,
): PiServerProviderExecutionPreflight {
	const contract = modelRuntime.getProviderExecutionContract(model);
	if (!contract.descriptor.piServerCompatible) {
		throw new Error(
			`pi-server mode cannot preserve native pi provider execution for ${model.provider}/${model.id}: ` +
				`mode=${contract.descriptor.mode}, executor=${contract.descriptor.executor.kind}. ` +
				"Run this model with plain pi or remove the custom provider executor.",
		);
	}

	const activeHooks = PI_SERVER_UNSUPPORTED_PROVIDER_HOOKS.filter((eventType) => hooks?.hasHandlers(eventType));
	if (activeHooks.length > 0) {
		throw new Error(
			`pi-server mode cannot preserve native pi provider hooks for ${model.provider}/${model.id}: ` +
				`${activeHooks.join(", ")}. Run this model with plain pi or disable these hooks.`,
		);
	}
	const executor = contract.descriptor.executor;
	if (executor.kind !== "builtin_provider" && executor.kind !== "builtin_api") {
		throw new Error(
			`pi-server mode cannot serialize provider executor ${executor.kind} for ${model.provider}/${model.id}`,
		);
	}
	const activeRoute = getCompatProviderExecutionRoute(model);
	if (
		(activeRoute.kind !== "builtin_provider" && activeRoute.kind !== "builtin_api") ||
		activeRoute.kind !== executor.kind ||
		activeRoute.id !== executor.id
	) {
		throw new Error(
			`pi-server mode cannot preserve native pi provider execution for ${model.provider}/${model.id}: ` +
				`model runtime selected ${executor.kind}/${executor.id}, but active pi-ai compat route is ` +
				`${activeRoute.kind}/${activeRoute.id}. Remove the runtime API override or use plain pi.`,
		);
	}

	return {
		contract,
		providerExecutionFingerprint: hashRemoteProviderExecution(model, activeRoute),
	};
}
