import { describe, expect, it } from "vitest";
import { piClientWebEnv } from "../bin/web.js";

describe("pi-client web Tau env", () => {
	it("starts the client backend with Tau defaults", () => {
		expect(piClientWebEnv({}, { host: "127.0.0.1", port: "1838" })).toMatchObject({
			PI_CODING_AGENT: "true",
			PI_SERVER_MODE: "true",
			PI_SERVER_URL: "http://127.0.0.1:4217",
			TAU_HOST: "127.0.0.1",
			TAU_MIRROR_PORT: "1838",
		});
	});

	it("preserves explicit pi-server settings", () => {
		expect(
			piClientWebEnv(
				{
					PI_SERVER_URL: "https://pi.example.test",
					PI_SERVER_AUTH_TOKEN: "secret",
				},
				{ host: "0.0.0.0", port: "3001" },
			),
		).toMatchObject({
			PI_SERVER_URL: "https://pi.example.test",
			PI_SERVER_AUTH_TOKEN: "secret",
			TAU_HOST: "0.0.0.0",
			TAU_MIRROR_PORT: "3001",
		});
	});
});
