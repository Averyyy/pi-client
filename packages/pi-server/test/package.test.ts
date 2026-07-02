import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-server package", () => {
	it("publishes under the averyyy pi-server scope", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.name).toBe("@averyyy/pi-server");
	});

	it("depends on published runtime packages", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@earendil-works/pi-ai"]).toBe("npm:@averyyy/pi-ai@0.80.3-piclient.2");
		expect(pkg.dependencies["@earendil-works/pi-agent-core"]).toBe("npm:@averyyy/pi-agent-core@0.80.3-piclient.2");
	});
});
