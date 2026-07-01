import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const repoRoot = join(pkgRoot, "..", "..");

describe("pi-client package", () => {
	it("exposes only pi-client bin, not pi", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin["pi-client"]).toBeDefined();
		expect(pkg.bin.pi).toBeUndefined();
		expect(Object.keys(pkg.bin)).toHaveLength(1);
	});

	it("bin entry point file exists", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");
		expect(binContent).toContain("@earendil-works/pi-coding-agent/pi-client-cli");
	});

	it("depends on pi-coding-agent via local file reference", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe("file:../coding-agent");
	});

	it("keeps the root lockfile aligned to the local pi-coding-agent fork", () => {
		const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8"));
		expect(lock.packages["packages/pi-client"].dependencies["@earendil-works/pi-coding-agent"]).toBe(
			"file:../coding-agent",
		);
	});
});
