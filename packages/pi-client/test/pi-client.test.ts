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
		expect(binContent).toContain("PI_CLIENT_RELOAD_STATE_PATH");
		expect(binContent).toContain("result.status !== 75");
	});

	it("routes the web subcommand through the Tau wrapper", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");
		const webContent = readFileSync(join(pkgRoot, "bin", "web.js"), "utf-8");
		expect(binContent).toContain('args[0] === "web"');
		expect(webContent).toContain("TAU_MIRROR_PORT: options.port");
		expect(webContent).toContain("TAU_HOST: options.host");
		expect(webContent).toContain('PI_SERVER_MODE: "true"');
		expect(webContent).toContain('const defaultPort = "1838"');
		expect(webContent).toContain("pi install npm:@averyyy/pi-tau-codex");
		expect(webContent).toContain("pi-client install npm:@averyyy/pi-tau-codex");
		expect(webContent).toContain("pi-client install git:github.com/Averyyy/pi-tau-codex");
		expect(webContent).toContain("请安装");
	});

	it("routes the send subcommand through the chunked pi-server request", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");
		const sendContent = readFileSync(join(pkgRoot, "bin", "send.js"), "utf-8");
		expect(binContent).toContain('args[0] === "send"');
		expect(sendContent).toContain('request.postJson("/api/receive"');
		expect(sendContent).toContain("ChunkRequest");
	});

	it("publishes under the averyyy pi-client scope", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.name).toBe("@averyyy/pi-client");
		expect(pkg.publishConfig.access).toBe("public");
	});

	it("depends on the published pi-coding-agent package", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(
			"npm:@averyyy/pi-coding-agent@0.80.3-piclient.3",
		);
	});

	it("does not bundle a separate web UI dependency", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.dependencies["@jmfederico/pi-web"]).toBeUndefined();
		expect(pkg.dependencies["tau-mirror"]).toBeUndefined();
		expect(pkg.dependencies["@averyyy/pi-tau-codex"]).toBeUndefined();
	});

	it("keeps the root lockfile aligned to published runtime dependencies", () => {
		const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8"));
		expect(lock.packages["packages/pi-client"].name).toBe("@averyyy/pi-client");
		expect(lock.packages["packages/pi-client"].dependencies["@earendil-works/pi-coding-agent"]).toBe(
			"npm:@averyyy/pi-coding-agent@0.80.3-piclient.3",
		);
		expect(lock.packages["packages/pi-client"].dependencies["@jmfederico/pi-web"]).toBeUndefined();
		expect(lock.packages["node_modules/@jmfederico/pi-web"]).toBeUndefined();
	});
});
