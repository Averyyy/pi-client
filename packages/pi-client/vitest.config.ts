import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-coding-agent\/pi-server-request$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/core/pi-server-request.ts", import.meta.url)),
			},
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
});
