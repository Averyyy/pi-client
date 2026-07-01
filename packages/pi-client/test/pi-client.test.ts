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
		expect(binContent).toContain('import.meta.resolve("@earendil-works/pi-coding-agent")');
		expect(binContent).toContain('PI_SERVER_MODE: "true"');
	});

	it("routes the web subcommand through the pi-web wrapper", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");
		const webContent = readFileSync(join(pkgRoot, "bin", "web.js"), "utf-8");
		expect(binContent).toContain('args[0] === "web"');
		expect(webContent).toContain("@jmfederico/pi-web/package.json");
		expect(webContent).toContain("@jmfederico/pi-web/dist/server/app.js");
		expect(webContent).toContain('PI_SERVER_MODE: "true"');
		expect(webContent).toContain('const defaultPort = "1838"');
		expect(webContent).toContain("/api/pi-client/pi-server");
		expect(webContent).toContain("/api/pi-client/global-agents");
		expect(webContent).toContain("/api/pi-client/projects");
		expect(webContent).toContain("getAgentDir");
		expect(webContent).toContain("PiClientProjectService");
		expect(webContent).toContain("PiWebPluginService");
	});

	it("bundles the pi-client pi-web plugin", () => {
		const pluginPkg = JSON.parse(
			readFileSync(join(pkgRoot, "bin", "pi-web-plugins", "pi-client", "package.json"), "utf-8"),
		);
		const pluginContent = readFileSync(
			join(pkgRoot, "bin", "pi-web-plugins", "pi-client", "pi-web-plugin.js"),
			"utf-8",
		);
		expect(pluginPkg.piWeb.plugins[0].id).toBe("pi-client");
		expect(pluginContent).toContain("Pi Server Settings");
		expect(pluginContent).toContain("Global AGENTS.md");
		expect(pluginContent).toContain("Skill Management");
		expect(pluginContent).toContain("New Conversation");
		expect(pluginContent).toContain("Project Visibility");
		expect(pluginContent).toContain("pi-client-quickbar");
		expect(pluginContent).toContain("pi-client.server");
	});

	it("publishes under the averyyy pi-client scope", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.name).toBe("@averyyy/pi-client");
		expect(pkg.publishConfig.access).toBe("public");
	});

	it("depends on the published pi-coding-agent package", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.80.3");
	});

	it("depends on pinned pi-web for the web UI", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@jmfederico/pi-web"]).toBe("1.202606.7");
	});

	it("keeps the root lockfile aligned to published runtime dependencies", () => {
		const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8"));
		expect(lock.packages["packages/pi-client"].name).toBe("@averyyy/pi-client");
		expect(lock.packages["packages/pi-client"].dependencies["@earendil-works/pi-coding-agent"]).toBe("0.80.3");
		expect(lock.packages["packages/pi-client"].dependencies["@jmfederico/pi-web"]).toBe("1.202606.7");
		expect(lock.packages["node_modules/@jmfederico/pi-web"].version).toBe("1.202606.7");
	});
});
