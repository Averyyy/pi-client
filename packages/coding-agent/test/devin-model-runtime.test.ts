import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { encodeMessage, encodeString, encodeVarintField } from "../../ai/src/api/devin-wire.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => vi.unstubAllGlobals());

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
