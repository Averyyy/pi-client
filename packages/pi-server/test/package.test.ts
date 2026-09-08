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
		const piAi = pkg.dependencies["@earendil-works/pi-ai"];
		const piAgentCore = pkg.dependencies["@earendil-works/pi-agent-core"];
		const aliasPattern = /^npm:@averyyy\/(pi-ai|pi-agent-core)@(\d+\.\d+\.\d+-piclient\.\d+)$/;

		expect(piAi).toMatch(aliasPattern);
		expect(piAgentCore).toMatch(aliasPattern);
		expect(piAi).not.toMatch(/^(?:workspace:|file:)/);
		expect(piAgentCore).not.toMatch(/^(?:workspace:|file:)/);

		const piAiMatch = aliasPattern.exec(piAi);
		const piAgentCoreMatch = aliasPattern.exec(piAgentCore);
		if (!piAiMatch || !piAgentCoreMatch) throw new Error("Expected published pi runtime aliases");
		expect(piAiMatch[1]).toBe("pi-ai");
		expect(piAgentCoreMatch[1]).toBe("pi-agent-core");
		expect(piAgentCoreMatch[2]).toBe(piAiMatch[2]);
	});
});
