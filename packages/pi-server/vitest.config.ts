import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			env: { PI_SERVER_ACCOUNT_STORE_DIR: join(tmpdir(), `pi-server-test-accounts-${randomUUID()}`) },
		},
	}),
);
