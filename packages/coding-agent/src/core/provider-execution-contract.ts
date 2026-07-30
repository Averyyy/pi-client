import { createHash } from "node:crypto";
import type { Api } from "@earendil-works/pi-ai";

export type ProviderExecutionMode =
	| "builtin"
	| "serializable_overlay"
	| "provider_config_stream_simple"
	| "native_provider";

export type ProviderExecutionKind =
	| "builtin_provider"
	| "builtin_api"
	| "provider_config_stream_simple"
	| "native_provider";

export type ProviderExecutionExecutor =
	| { kind: "builtin_provider"; id: string }
	| { kind: "builtin_api"; id: Api }
	| { kind: "provider_config_stream_simple"; id: string }
	| { kind: "native_provider"; id: string };

export interface ProviderExecutionContractDescriptor {
	version: 1;
	mode: ProviderExecutionMode;
	providerId: string;
	modelId: string;
	api: Api;
	executor: ProviderExecutionExecutor;
	overlays: {
		modelsJson: boolean;
		extensionConfig: boolean;
	};
	piServerCompatible: boolean;
}

export interface ProviderExecutionContract {
	descriptor: ProviderExecutionContractDescriptor;
	fingerprint: string;
}

function canonicalJson(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const properties: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const serialized = canonicalJson(record[key]);
			if (serialized !== undefined) properties.push(`${JSON.stringify(key)}:${serialized}`);
		}
		return `{${properties.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function hashProviderExecutionContract(descriptor: ProviderExecutionContractDescriptor): string {
	const serialized = canonicalJson(descriptor);
	if (serialized === undefined) throw new Error("Failed to serialize provider execution contract");
	return createHash("sha256").update(serialized).digest("hex");
}

export function createProviderExecutionContract(
	descriptor: ProviderExecutionContractDescriptor,
): ProviderExecutionContract {
	return {
		descriptor,
		fingerprint: hashProviderExecutionContract(descriptor),
	};
}
