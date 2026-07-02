import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

describe("pi-client update", () => {
	it("declares the upstream Pi version this fork is based on", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piClient).toEqual({
			basePiVersion: "0.80.3",
			basePiCommit: "85b7c247",
		});
	});

	it("routes pi-client update through the local update helper", () => {
		const binContent = readFileSync(join(pkgRoot, "bin", "pi-client.js"), "utf-8");

		expect(binContent).toContain('args[0] === "update"');
		expect(binContent).toContain('import("./update.js")');
	});

	it("updates the fork checkout and reinstalls both global binaries", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			fetch: async () => new Response("", { status: 200 }),
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("based on pi 0.80.3");
		expect(output.join("")).toContain("upstream 85b7c247");
		expect(calls).toEqual([
			{ command: "git", args: ["status", "--porcelain"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "git", args: ["config", "--get", "remote.origin.url"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "npm", args: ["config", "get", "registry"], cwd: "/repo/pi-client", stdio: "pipe" },
			{ command: "git", args: ["pull", "--ff-only"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["install", "--ignore-scripts"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-client"], cwd: "/repo/pi-client", stdio: "inherit" },
			{ command: "npm", args: ["run", "install:pi-server"], cwd: "/repo/pi-client", stdio: "inherit" },
		]);
	});

	it("refuses to update a dirty checkout", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const errors = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			return { status: 0, stdout: " M README.md\n" };
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			stdout: { write: () => {} },
			stderr: { write: (value) => errors.push(value) },
		});

		expect(exitCode).toBe(1);
		expect(calls).toHaveLength(1);
		expect(errors.join("")).toContain("working tree has uncommitted changes");
	});

	it("updates npm global installs from latest packages", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const calls = [];
		const output = [];
		const runner = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { status: 128, stderr: "fatal: not a git repository\n" };
			}
			if (command === "npm" && args.join(" ") === "config get registry") {
				return { status: 0, stdout: "https://registry.npmjs.org/\n" };
			}
			return { status: 0, stdout: "" };
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/usr/local/lib/node_modules",
			runner,
			fetch: async () => new Response("", { status: 200 }),
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("Updating npm packages");
		expect(calls).toEqual([
			{ command: "git", args: ["status", "--porcelain"], cwd: "/usr/local/lib/node_modules", stdio: "pipe" },
			{ command: "npm", args: ["config", "get", "registry"], cwd: "/usr/local/lib/node_modules", stdio: "pipe" },
			{
				command: "npm",
				args: [
					"install",
					"-g",
					"--ignore-scripts",
					"@averyyy/pi-client@latest",
					"@averyyy/pi-server@latest",
				],
				cwd: "/usr/local/lib/node_modules",
				stdio: "inherit",
			},
		]);
	});

	it("approves proxy warnings before update network steps", async () => {
		const { runPiClientUpdate } = await import("../bin/update.js");
		const warningUrl =
			"http://114.114.114.114:9421/proxycontrolwarn/httpwarning_123.html?ori_url=aHR0cHM6Ly9naXRodWIuY29tL0F2ZXJ5eXkvcGktY2xpZW50LmdpdA==&uid=0";
		const output = [];
		const fetchCalls = [];
		const runner = (command, args) => {
			if (command === "git" && args.join(" ") === "status --porcelain") return { status: 0, stdout: "" };
			if (command === "git" && args.join(" ") === "config --get remote.origin.url") {
				return { status: 0, stdout: "https://github.com/Averyyy/pi-client.git\n" };
			}
			if (command === "npm" && args.join(" ") === "config get registry") {
				return { status: 0, stdout: "https://registry.npmjs.org/\n" };
			}
			return { status: 0, stdout: "" };
		};
		const fetchImpl = async (url) => {
			fetchCalls.push(url);
			if (url === "https://github.com/Averyyy/pi-client.git") {
				return new Response("", { status: 302, headers: { Location: warningUrl } });
			}
			if (url === warningUrl) {
				return new Response(
					'<input id="sessionid" value="sid-1"><input id="pid" value="123"><input id="uid" value="0">',
					{
						status: 200,
						headers: { "Content-Type": "text/html" },
					},
				);
			}
			if (url.startsWith("http://114.114.114.114:9421/proxycontrolwarn/check?")) {
				return new Response("ok", { status: 200 });
			}
			return new Response("", { status: 200 });
		};

		const exitCode = await runPiClientUpdate([], {
			packageRoot: pkgRoot,
			repoRoot: "/repo/pi-client",
			runner,
			fetch: fetchImpl,
			stdout: { write: (value) => output.push(value) },
			stderr: { write: (value) => output.push(value) },
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain("Approved proxy warning for https://github.com/Averyyy/pi-client.git");
		expect(fetchCalls).toEqual([
			"https://github.com/Averyyy/pi-client.git",
			warningUrl,
			expect.stringMatching(/^http:\/\/114\.114\.114\.114:9421\/proxycontrolwarn\/check\?/),
			"https://registry.npmjs.org/",
		]);
	});
});
