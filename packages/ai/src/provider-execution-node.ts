import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PI_PROVIDER_EXECUTION_CONTRACT_VERSION, type ProviderExecutionRoute } from "./provider-execution.ts";
import type { Api, Model } from "./types.ts";

type RemoteProviderExecutionRoute = Extract<ProviderExecutionRoute, { kind: "builtin_provider" | "builtin_api" }>;

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
if (
	typeof packageMetadata !== "object" ||
	packageMetadata === null ||
	!("version" in packageMetadata) ||
	typeof packageMetadata.version !== "string" ||
	packageMetadata.version.length === 0
) {
	throw new Error("pi-ai package metadata did not contain a valid version");
}

export const PI_AI_RUNTIME_VERSION = packageMetadata.version;

export function hashRemoteProviderExecution(
	model: Pick<Model<Api>, "provider" | "id" | "api">,
	route: RemoteProviderExecutionRoute,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: PI_PROVIDER_EXECUTION_CONTRACT_VERSION,
				piAiVersion: PI_AI_RUNTIME_VERSION,
				providerId: model.provider,
				modelId: model.id,
				api: model.api,
				executor: route,
			}),
		)
		.digest("hex");
}
