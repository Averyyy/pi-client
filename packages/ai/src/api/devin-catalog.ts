import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "../types.ts";
import { buildMetadata, DEVIN_BASE_URL } from "./devin-metadata.ts";
import { encodeMessage, iterFields, type ProtoField } from "./devin-wire.ts";

function bytes(fields: ProtoField[], number: number): Buffer {
	const value = fields.find((field) => field.num === number)?.value;
	return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

function integer(fields: ProtoField[], number: number): number {
	const value = fields.find((field) => field.num === number)?.value;
	return typeof value === "bigint" ? Number(value) : 0;
}

/** Decode the published ClientModelConfig/ModelInfo wire fields, never model-name guesses. */
export function decodeDevinCatalog(payload: Buffer): Model<"devin">[] {
	const models: Model<"devin">[] = [];
	const seen = new Set<string>();
	for (const field of iterFields(payload)) {
		if (field.num !== 1 || !Buffer.isBuffer(field.value)) continue;
		const config = [...iterFields(field.value)];
		if (integer(config, 4)) continue;
		const info = [...iterFields(bytes(config, 23))];
		// Router and internal slots require a separate assignment protocol.
		if (integer(info, 2) || integer(info, 25) || [3, 4, 6].includes(integer(info, 22))) continue;
		const id = bytes(config, 22).toString("utf8");
		const contextWindow = integer(config, 18);
		const maxTokens = integer(info, 13);
		const features = [...iterFields(bytes(info, 6))];
		if (!id || !contextWindow || !maxTokens || !features.length)
			throw new Error("Devin returned an incomplete model definition");
		if (seen.has(id)) throw new Error(`Devin returned duplicate model ${id}`);
		seen.add(id);
		const thinkingLevelMap: ThinkingLevelMap = {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		};
		const family = [...iterFields(bytes(config, 30))];
		for (const entry of family.filter((value) => value.num === 2)) {
			if (!Buffer.isBuffer(entry.value)) continue;
			const parts = [...iterFields(entry.value)];
			const key = bytes(parts, 1).toString("utf8").toLowerCase();
			if (key !== "effort" && key !== "reasoning effort") continue;
			const value = [...iterFields(bytes(parts, 2))];
			const label = bytes(value, 2).toString("utf8").toLowerCase();
			const level = label === "none" || label === "no thinking" ? "off" : label;
			if (Object.hasOwn(thinkingLevelMap, level)) thinkingLevelMap[level as ModelThinkingLevel] = id;
		}
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const dimension of config.filter((value) => value.num === 32)) {
			if (!Buffer.isBuffer(dimension.value)) continue;
			const values = [...iterFields(dimension.value)];
			if (![1, 2].includes(integer(values, 6))) continue;
			const label = bytes(values, 1).toString("utf8");
			const rate = bytes(values, 2);
			const denominator = bytes(values, 3).toString("utf8");
			if (denominator !== "1M tokens" || rate.length !== 4)
				throw new Error(`Unsupported Devin pricing dimension for ${id}`);
			const value = Math.round(rate.readFloatLE() * 1e6) / 1e6;
			if (!Number.isFinite(value) || value < 0) throw new Error("Invalid Devin model price");
			if (label === "Input") cost.input = value;
			else if (label === "Output") cost.output = value;
			else if (label === "Cached input") cost.cacheRead = value;
		}
		models.push({
			id,
			name: bytes(config, 1).toString("utf8"),
			provider: "devin",
			api: "devin",
			baseUrl: DEVIN_BASE_URL,
			reasoning: !!integer(features, 15),
			thinkingLevelMap,
			input: integer(features, 11) ? ["text", "image"] : ["text"],
			contextWindow,
			maxTokens,
			cost,
		});
	}
	if (!models.length) throw new Error("Devin returned no usable models; check the account and protocol version");
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverDevinModels(apiKey: string, signal: AbortSignal): Promise<Model<"devin">[]> {
	const response = await fetch(`${DEVIN_BASE_URL}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1" },
		body: new Uint8Array(
			encodeMessage(
				1,
				buildMetadata({
					apiKey,
					discovery: true,
					sessionId: crypto.randomUUID(),
					requestId: BigInt(Date.now()),
					triggerId: crypto.randomUUID(),
				}),
			),
		),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	if (!response.ok) throw new Error(`Devin model discovery failed (HTTP ${response.status})`);
	return decodeDevinCatalog(Buffer.from(await response.arrayBuffer()));
}
