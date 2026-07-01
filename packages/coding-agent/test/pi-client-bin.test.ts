import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("coding-agent bins", () => {
	it("package.json exposes only pi bin, not pi-client", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin.pi).toBe("dist/cli.js");
		expect(pkg.bin["pi-client"]).toBeUndefined();
	});

	it("pi-client cli delegates to the original main entry so extensions and skills still load normally", () => {
		const source = readFileSync(join(pkgRoot, "src", "pi-client-cli.ts"), "utf-8");

		expect(source).toContain('import { main } from "./main.ts";');
		expect(source).toContain("main(process.argv.slice(2));");
		expect(source).toContain('process.env.PI_SERVER_MODE = "true";');
		expect(source).not.toContain("PI_CODING_AGENT_DIR");
		expect(source).not.toContain("CONFIG_DIR_NAME");
	});

	it("keeps the upstream pi config directory so existing extensions and skills are shared", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piConfig?.configDir).toBe(".pi");
		expect(pkg.piConfig?.name).toBeUndefined();
	});
});
