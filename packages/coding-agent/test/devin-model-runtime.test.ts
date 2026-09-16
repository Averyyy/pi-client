import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { encodeMessage, encodeString, encodeVarintField } from "../../ai/src/api/devin-wire.ts";
import { resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => vi.unstubAllGlobals());

function encodeCatalogModel(id: string): Buffer {
	return encodeMessage(
		1,
		Buffer.concat([
			encodeString(1, id),
			encodeString(22, id),
			encodeVarintField(18, 262000),
			encodeMessage(23, Buffer.concat([encodeVarintField(13, 128000), encodeMessage(6, encodeVarintField(15, 1))])),
		]),
	);
}

it("keeps native account discovery instead of replacing it with pi.dev catalogs", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("devin", async () => ({
		type: "oauth",
		access: "test",
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	}));
	const config = Buffer.concat([
		encodeString(1, "SWE-2 Medium"),
		encodeString(22, "swe-2-medium"),
		encodeVarintField(18, 262000),
		encodeMessage(23, Buffer.concat([encodeVarintField(13, 128000), encodeMessage(6, encodeVarintField(15, 1))])),
	]);
	const fetchMock = vi.fn(async (input: unknown) => {
		expect(String(input)).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
		return new Response(new Uint8Array(encodeMessage(1, config)));
	});
	vi.stubGlobal("fetch", fetchMock);
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	const refreshed = await runtime.refresh({ providers: ["devin"], allowNetwork: true });
	expect(refreshed.errors.size).toBe(0);
	expect((await runtime.getAvailable("devin")).map((model) => model.id)).toEqual(["swe-2-medium"]);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps the four exact configured Devin models scoped when the live catalog expands", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("devin", async () => ({
		type: "oauth",
		access: "test",
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	}));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const patterns = ["devin/claude-opus-5-max", "devin/swe-2-high", "devin/swe-2-max", "devin/swe-2-medium"];
	await runtime.refresh({ providers: ["devin"], allowNetwork: false });
	const startupScope = resolveModelScopeFromModels(patterns, await runtime.getAvailable("devin"));
	expect(startupScope.diagnostics).toEqual([]);
	expect(startupScope.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual(patterns);

	const discoveredIds = [...patterns.map((pattern) => pattern.slice("devin/".length))];
	discoveredIds.push(...Array.from({ length: 32 }, (_, index) => `discovered-only-${index}`));
	const payload = Buffer.concat(discoveredIds.map(encodeCatalogModel));
	const fetchMock = vi.fn(async (input: unknown) => {
		expect(String(input)).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
		return new Response(new Uint8Array(payload));
	});
	vi.stubGlobal("fetch", fetchMock);
	const refreshed = await runtime.refresh({ providers: ["devin"], allowNetwork: true });

	expect(refreshed.errors.size).toBe(0);
	expect(runtime.getModels("devin")).toHaveLength(discoveredIds.length);
	expect(startupScope.scopedModels).toHaveLength(patterns.length);
	expect(startupScope.scopedModels.every(({ model }) => runtime.getModel("devin", model.id) !== undefined)).toBe(true);
});
