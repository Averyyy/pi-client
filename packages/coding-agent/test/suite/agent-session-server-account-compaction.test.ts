import { afterEach, describe, expect, it, vi } from "vitest";
import * as piServerClient from "../../src/core/pi-server-client.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession server-account compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([
		["devin", "manual"],
		["devin", "auto"],
		["google-antigravity", "manual"],
		["google-antigravity", "auto"],
	] as const)("routes %s %s compaction with server account auth", async (provider, mode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.stubEnv("PI_SERVER_MODE", "true");
		const model = { ...harness.getModel(), provider, headers: { Authorization: "client-header" } };
		harness.session.agent.state.model = model;
		vi.spyOn(harness.session.modelRuntime, "isServerAccountProvider").mockReturnValue(true);
		const getAuth = vi
			.spyOn(harness.session.modelRuntime, "getAuth")
			.mockRejectedValue(new Error("client auth read"));
		const compact = vi.spyOn(piServerClient, "compactPiServer").mockRejectedValue(new Error("summary stopped"));

		if (mode === "manual") {
			await expect(harness.session.compact()).rejects.toThrow("summary stopped");
		} else {
			const session = harness.session as unknown as {
				_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
			};
			await expect(session._runAutoCompaction("threshold", false)).resolves.toBe(false);
		}

		expect(getAuth).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledOnce();
		const [requestModel, , options] = compact.mock.calls[0];
		expect(requestModel.headers).toBeUndefined();
		expect(options).toMatchObject({ authSource: "server-account" });
		expect(options?.apiKey).toBeUndefined();
		expect(options?.headers).toBeUndefined();
		expect(options?.env).toBeUndefined();
	});
});
