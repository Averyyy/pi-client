import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("initial model resolution errors", () => {
	it("rejects an invalid provider without terminating the host process", async () => {
		vi.stubEnv("PI_SERVER_MODE", "false");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Unexpected process exit");
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});

		await expect(
			findInitialModel({
				cliProvider: "missing-provider",
				cliModel: "model",
				scopedModels: [],
				isContinuing: false,
				modelRuntime: runtime,
			}),
		).rejects.toThrow('Unknown provider "missing-provider"');
		expect(exit).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});
});
