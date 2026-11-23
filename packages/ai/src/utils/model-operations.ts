import type { ProviderCompat } from "../providers/compat-schema.ts";
import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** Configurable chat model metadata, independent of its provider, route, and headers. */
export type ModelOverride = Partial<
	Pick<
		Model<Api>,
		| "name"
		| "reasoning"
		| "thinkingLevelMap"
		| "input"
		| "inputLimits"
		| "promptCache"
		| "contextWindow"
		| "maxTokens"
		| "samplingParams"
		| "samplingParamsByThinkingLevel"
	>
> & {
	cost?: Partial<Model<Api>["cost"]>;
	compat?: ProviderCompat;
};

/** Apply user metadata over a catalog model while retaining its provider-specific fields. */
export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: override.input ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
			model.samplingParamsByThinkingLevel,
			override.samplingParamsByThinkingLevel,
		),
		compat: mergeModelCompat(model.compat, override.compat),
	};
}

/** Merge compatibility metadata, including per-key routing and template configuration. */
export function mergeModelCompat(
	base: Model<Api>["compat"],
	override: ProviderCompat | undefined,
): Model<Api>["compat"] {
	if (!override) return base;
	const baseCompat: ProviderCompat | undefined = base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const nested: Record<string, unknown> = merged;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		if (override[key]) nested[key] = { ...baseCompat?.[key], ...override[key] };
	}
	return merged;
}

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function mergeSamplingParamsByThinkingLevel(
	base: Model<Api>["samplingParamsByThinkingLevel"],
	override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
	if (!override) return base;
	const merged = { ...base };
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const params = override[level];
		if (params) merged[level] = { ...base?.[level], ...params };
	}
	return merged;
}

/** The type of a model. Models without `type` are chat models. */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** Rejects classifier images for models whose catalog entry does not accept image input. */
export function assertClassifierInputSupported(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
): void {
	if (context.images?.length && !model.input.includes("image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
	}
}

export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
