import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-server package", () => {
	it("depends on local workspace pi-ai and pi-agent-core packages", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.dependencies["@earendil-works/pi-ai"]).toBe("file:../ai");
		expect(pkg.dependencies["@earendil-works/pi-agent-core"]).toBe("file:../agent");
	});
});
