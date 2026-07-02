import { describe, expect, it } from "vitest";
import { piClientWebSessiondEnv } from "../bin/web.js";

describe("pi-client web session daemon env", () => {
	it("uses TCP for the session daemon on Windows", async () => {
		await expect(piClientWebSessiondEnv({ PI_WEB_SESSIOND_PORT: "1840" }, "win32")).resolves.toEqual({
			PI_WEB_SESSIOND_HOST: "127.0.0.1",
			PI_WEB_SESSIOND_PORT: "1840",
			PI_WEB_SESSIOND_URL: "http://127.0.0.1:1840",
		});
		await expect(
			piClientWebSessiondEnv({ PI_WEB_SESSIOND_SOCKET: "\\\\.\\pipe\\pi-web-sessiond" }, "win32"),
		).resolves.toEqual({});
		await expect(piClientWebSessiondEnv({}, "darwin")).resolves.toEqual({});
	});
});
