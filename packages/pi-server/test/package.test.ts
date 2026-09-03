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

	it("routes the bin through the pi-server wrapper", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-server.js"), "utf-8");

		expect(pkg.bin["pi-server"]).toBe("bin/pi-server.js");
		expect(pkg.files).toContain("bin");
		expect(binContent).toContain('args[0] === "update"');
		expect(binContent).toContain('join(packageRoot, "dist", "cli.js")');
	});

	it("depends on published runtime packages", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		const aiDependency = pkg.dependencies["@earendil-works/pi-ai"];
		const agentCoreDependency = pkg.dependencies["@earendil-works/pi-agent-core"];
		expect(aiDependency).toMatch(/^npm:@averyyy\/pi-ai@\d+\.\d+\.\d+-piclient\.\d+$/);
		expect(agentCoreDependency).toMatch(/^npm:@averyyy\/pi-agent-core@\d+\.\d+\.\d+-piclient\.\d+$/);
		expect(agentCoreDependency.replace("@averyyy/pi-agent-core", "@averyyy/pi-ai")).toBe(aiDependency);
	});
});
