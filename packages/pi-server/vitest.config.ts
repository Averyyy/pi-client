import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
