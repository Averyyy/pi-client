import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { createPiServer } from "../../pi-server/src/server.ts";
import { clearAllSessions } from "../../pi-server/src/session-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const sourceLoader = pathToFileURL(join(pkgRoot, "src", "experimental", "source-resolver.ts")).href;

describe("coding-agent bins", () => {
	it("package.json exposes only pi bin, not pi-client", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin.pi).toBe("dist/bundle/cli.js");
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

	it("source pi-client entry renders fork help without installing anything", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-help-"));
		try {
			const extensionPath = join(root, "help-extension.ts");
			writeFileSync(
				extensionPath,
				'export default function (pi) { pi.registerFlag("remote-help-fixture", { type: "boolean", description: "Offline extension help" }); }',
			);
			const stdoutPath = join(root, "stdout");
			const stderrPath = join(root, "stderr");
			const stdoutFd = openSync(stdoutPath, "w");
			const stderrFd = openSync(stderrPath, "w");
			let result: ReturnType<typeof spawnSync>;
			try {
				result = spawnSync(
					process.execPath,
					["--import", sourceLoader, join(pkgRoot, "src", "pi-client-cli.ts"), "-e", extensionPath, "--help"],
					{
						env: {
							...process.env,
							HOME: join(root, "home"),
							PI_CODING_AGENT_DIR: join(root, "agent"),
							PI_OFFLINE: "true",
							PI_SERVER_URL: "http://127.0.0.1:1",
						},
						stdio: ["ignore", stdoutFd, stderrFd],
						timeout: 5_000,
					},
				);
			} finally {
				closeSync(stdoutFd);
				closeSync(stderrFd);
			}
			const stdout = readFileSync(stdoutPath, "utf-8");
			const stderr = readFileSync(stderrPath, "utf-8");

			expect(result.status).toBe(0);
			expect(stdout).toContain("pi-client - AI coding assistant");
			expect(stdout).toContain("pi-client web");
			expect(stdout).toContain("pi-client send <path>");
			expect(stdout).toContain("PI_SERVER_URL");
			expect(stdout).toContain("PI_SERVER_AUTH_TOKEN");
			expect(stdout).toContain("PI_CLIENT_MAX_REQUEST_KB");
			expect(stdout).toContain("/reload");
			expect(stdout).toContain("--remote-help-fixture");
			expect(`${stdout}\n${stderr}`).not.toMatch(/npm (install|update)|Installing|Updating/);
			expect(existsSync(join(root, "agent", "node_modules"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the upstream pi config directory so existing extensions and skills are shared", () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

		expect(pkg.piConfig?.configDir).toBe(".pi");
		expect(pkg.piConfig?.name).toBeUndefined();
	});

	it("lists client models and sends client auth through a server with only Hugging Face models", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-owned-catalog-"));
		const providerRequests: { authorization: string | undefined; body: { model: string } }[] = [];
		const provider = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			providerRequests.push({
				authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString()) as { model: string },
			});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const chunk of [
				{
					choices: [
						{ index: 0, delta: { role: "assistant", content: "CLIENT_MODEL_REMOTE_OK" }, finish_reason: null },
					],
				},
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			])
				response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", ...chunk })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
		const serverModels = createModels();
		serverModels.setProvider(
			createProvider({
				id: "huggingface",
				models: [
					{
						id: "server-hf-only",
						name: "Server HF",
						provider: "huggingface",
						api: "openai-completions",
						baseUrl: "https://unused.invalid",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
				auth: { apiKey: { name: "HF", resolve: async () => ({ auth: { apiKey: "server-hf-key" } }) } },
				api: {
					stream: () => {
						throw new Error("HF inference is not selected");
					},
					streamSimple: () => {
						throw new Error("HF inference is not selected");
					},
				},
			}),
		);
		clearAllSessions();
		const catalog = vi.spyOn(builtinProviderCatalog, "builtinModels").mockReturnValue(serverModels);
		const server = createPiServer({ authToken: "fixture-server-token", sessionStoreDir: join(root, "sessions") });
		const serverPaths: string[] = [];
		server.on("request", (request) => serverPaths.push(request.url ?? ""));
		try {
			await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const providerAddress = provider.address();
			const serverAddress = server.address();
			if (
				!providerAddress ||
				typeof providerAddress === "string" ||
				!serverAddress ||
				typeof serverAddress === "string"
			) {
				throw new Error("Missing fixture listeners");
			}
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						"client-owned": {
							baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
							api: "openai-completions",
							apiKey: "client-fixture-key",
							models: [
								{
									id: "client-non-hf",
									name: "Client model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 32768,
									maxTokens: 1024,
								},
							],
						},
					},
				}),
			);
			const env = {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				COMSPEC: process.env.COMSPEC,
				PATHEXT: process.env.PATHEXT,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
				HOME: join(root, "home"),
				USERPROFILE: join(root, "home"),
				APPDATA: join(root, "appdata"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "true",
				PI_SERVER_AUTH_TOKEN: "fixture-server-token",
				PI_SERVER_URL: `http://127.0.0.1:${serverAddress.port}`,
			};
			async function runCli(args: string[]) {
				const child = spawn(
					process.execPath,
					["--import", sourceLoader, join(pkgRoot, "src", "pi-client-cli.ts"), ...args],
					{
						cwd: root,
						env,
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 15000,
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (data: Buffer) => {
					stdout += data.toString();
				});
				child.stderr.on("data", (data: Buffer) => {
					stderr += data.toString();
				});
				const status = await new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", resolve);
				});
				return { status, stdout, stderr };
			}
			const listed = await runCli(["--list-models", "-ne", "--no-mcp", "--no-context-files"]);
			expect(listed.status, listed.stderr).toBe(0);
			expect(listed.stdout).toContain("client-owned");
			expect(listed.stdout).toContain("client-non-hf");
			expect(listed.stdout).toContain("32.8K");
			expect(listed.stdout).not.toContain("server-hf-only");
			expect(serverPaths).toEqual([]);
			const prompted = await runCli([
				"-p",
				"--no-session",
				"-ne",
				"--no-mcp",
				"--no-context-files",
				"--model",
				"client-owned/client-non-hf",
				"hello",
			]);
			expect(prompted.status, JSON.stringify({ prompted, serverPaths, providerRequests })).toBe(0);
			expect(prompted.stdout, JSON.stringify({ prompted, serverPaths, providerRequests })).toContain(
				"CLIENT_MODEL_REMOTE_OK",
			);
			expect(serverPaths).toContain("/api/stream");
			expect(serverPaths).not.toContain("/api/models");
			expect(providerRequests.length).toBeGreaterThan(0);
			for (const request of providerRequests) {
				expect(request).toMatchObject({
					authorization: "Bearer client-fixture-key",
					body: { model: "client-non-hf" },
				});
			}
		} finally {
			catalog.mockRestore();
			for (const fixture of [server, provider]) {
				fixture.closeAllConnections();
				await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
			}
			clearAllSessions();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);

	it("rejects a provider selection without a model in the pi-client entrypoint", () => {
		// #10236: an incomplete provider selection must not run another provider's default model.
		const root = mkdtempSync(join(tmpdir(), "pi-client-provider-"));
		try {
			const result = spawnSync(
				process.execPath,
				["--import", sourceLoader, join(pkgRoot, "src", "pi-client-cli.ts"), "--provider", "anthropic"],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: join(root, "agent"),
						PI_OFFLINE: "true",
						PI_SERVER_URL: "http://127.0.0.1:1",
					},
					encoding: "utf8",
					timeout: 5_000,
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--provider requires --model");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ selection: "without an explicit model", args: [] },
		{ selection: "with an explicit model", args: ["--model", "unavailable/model"] },
	])("reports unavailable client models $selection without a server catalog error", ({ args }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-unavailable-server-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					sourceLoader,
					join(pkgRoot, "src", "pi-client-cli.ts"),
					"-p",
					"--no-session",
					"-ne",
					"--no-mcp",
					"--no-context-files",
					...args,
					"hello",
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						COMSPEC: process.env.COMSPEC,
						PATHEXT: process.env.PATHEXT,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						HOME: join(root, "home"),
						USERPROFILE: join(root, "home"),
						APPDATA: join(root, "appdata"),
						PI_CODING_AGENT_DIR: join(root, "agent"),
						PI_OFFLINE: "true",
						PI_SERVER_URL: "http://127.0.0.1:0",
					},
					encoding: "utf8",
					input: "",
					timeout: 5_000,
				},
			);

			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("pi-server model catalog:");
			if (args.length > 0) {
				expect(result.stderr).toContain("unavailable/model");
			} else {
				expect(result.stderr).toContain("No models available");
			}
			expect(result.stderr).not.toMatch(/UnhandledPromiseRejection|node:internal|\n\s+at /i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs an unrelated command when extensions have tool and flag conflicts", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-extension-conflicts-"));
		try {
			const firstPath = join(root, "first.ts");
			const secondPath = join(root, "second.ts");
			const toolRegistration = `
	pi.registerTool({
		name: "shared_fixture_tool",
		label: "Fixture",
		description: "Fixture tool",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
	});`;
			writeFileSync(
				firstPath,
				`export default function(pi) {${toolRegistration}
	pi.registerFlag("shared-fixture-flag", { type: "boolean", default: false });
	pi.registerProvider("conflict-fixture", {
		api: "openai-completions", baseUrl: "http://127.0.0.1:0", apiKey: "fixture",
		models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	});
	pi.registerCommand("unrelated-fixture", { handler: async () => {
		if (pi.getFlag("shared-fixture-flag") !== true) throw new Error("First flag must be boolean true");
		console.error("UNRELATED_COMMAND_RAN");
	} });
}`,
			);
			writeFileSync(
				secondPath,
				`export default function(pi) {${toolRegistration}
	pi.registerFlag("shared-fixture-flag", { type: "string" });
}`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					sourceLoader,
					join(pkgRoot, "src", "pi-client-cli.ts"),
					"-p",
					"--no-session",
					"-ne",
					"--no-mcp",
					"--no-context-files",
					"-e",
					firstPath,
					"-e",
					secondPath,
					"--shared-fixture-flag",
					"--model",
					"conflict-fixture/model",
					"/unrelated-fixture",
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						COMSPEC: process.env.COMSPEC,
						PATHEXT: process.env.PATHEXT,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						HOME: join(root, "home"),
						USERPROFILE: join(root, "home"),
						APPDATA: join(root, "appdata"),
						PI_CODING_AGENT_DIR: join(root, "agent"),
						PI_OFFLINE: "true",
						PI_SERVER_URL: "http://127.0.0.1:0",
					},
					encoding: "utf8",
					input: "",
					timeout: 5_000,
				},
			);

			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('Tool "shared_fixture_tool" conflicts with');
			expect(result.stderr).toContain('Flag "--shared-fixture-flag" conflicts with');
			expect(result.stderr).toContain("first registration wins");
			expect(result.stderr).toContain("UNRELATED_COMMAND_RAN");
			expect(result.stderr).not.toContain("Failed to load extension");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ state: "with conversation history", hasMessages: true, args: [] },
		{ state: "before its first prompt", hasMessages: false, args: [] },
		{
			state: "before its first prompt with another scoped model first",
			hasMessages: false,
			args: ["--models", "authenticated-other/other,resume-fixture/model"],
		},
	])(
		"restores model, thinking, and API key $state while another provider is authenticated",
		({ hasMessages, args }) => {
			const root = mkdtempSync(join(tmpdir(), "pi-client-resumed-api-key-"));
			try {
				const sessionPath = join(root, "session.jsonl");
				writeFileSync(
					sessionPath,
					`${[
						{
							type: "session",
							version: 3,
							id: "11111111-1111-4111-8111-111111111111",
							timestamp: "2026-10-18T00:00:00Z",
							cwd: root,
						},
						{
							type: "model_change",
							id: "model",
							parentId: null,
							timestamp: "2026-10-18T00:00:00Z",
							provider: "resume-fixture",
							modelId: "model",
						},
						{
							type: "thinking_level_change",
							id: "thinking",
							parentId: "model",
							timestamp: "2026-10-18T00:00:00Z",
							thinkingLevel: "high",
						},
						...(hasMessages
							? [
									{
										type: "message",
										id: "user",
										parentId: "thinking",
										timestamp: "2026-10-18T00:00:00Z",
										message: { role: "user", content: "Previous prompt", timestamp: 1 },
									},
								]
							: []),
					]
						.map((entry) => JSON.stringify(entry))
						.join("\n")}\n`,
				);
				const extensionPath = join(root, "resume.ts");
				writeFileSync(
					extensionPath,
					`export default function(pi) {
	pi.registerProvider("authenticated-other", {
		api: "openai-completions", baseUrl: "http://127.0.0.1:0", apiKey: "other-key",
		models: [{ id: "other", name: "Other", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	});
	pi.registerProvider("resume-fixture", {
		api: "openai-completions", baseUrl: "http://127.0.0.1:0",
		models: [{ id: "model", name: "Fixture", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	});
	pi.registerCommand("check-resumed-key", { handler: async (_args, ctx) => {
		if (ctx.model.provider !== "resume-fixture" || ctx.model.id !== "model") throw new Error("Wrong resumed model");
		if (pi.getThinkingLevel() !== "high") throw new Error("Wrong resumed thinking level");
		const auth = await ctx.modelRegistry.getProviderAuth(ctx.model.provider);
		if (auth?.auth.apiKey !== "resumed-key") throw new Error("API key override missing");
		const otherAuth = await ctx.modelRegistry.getProviderAuth("authenticated-other");
		if (otherAuth?.auth.apiKey !== "other-key") throw new Error("Other provider key was changed");
		console.error("RESUMED_KEY_APPLIED");
	} });
}`,
				);
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						sourceLoader,
						join(pkgRoot, "src", "pi-client-cli.ts"),
						"-p",
						"-ne",
						"--no-mcp",
						"--no-context-files",
						"-e",
						extensionPath,
						"--session",
						sessionPath,
						"--api-key",
						"resumed-key",
						...args,
						"/check-resumed-key",
					],
					{
						cwd: root,
						env: {
							PATH: process.env.PATH,
							SystemRoot: process.env.SystemRoot,
							WINDIR: process.env.WINDIR,
							COMSPEC: process.env.COMSPEC,
							PATHEXT: process.env.PATHEXT,
							TEMP: process.env.TEMP,
							TMP: process.env.TMP,
							HOME: join(root, "home"),
							USERPROFILE: join(root, "home"),
							APPDATA: join(root, "appdata"),
							PI_CODING_AGENT_DIR: join(root, "agent"),
							PI_OFFLINE: "true",
							PI_SERVER_URL: "http://127.0.0.1:0",
						},
						encoding: "utf8",
						input: "",
						timeout: 5_000,
					},
				);

				expect(result.error, result.stderr).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				expect(result.stderr).toContain("RESUMED_KEY_APPLIED");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("prints a local provider credential without fetching the pi-server catalog", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-client-local-credential-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			writeFileSync(
				join(agentDir, "auth.json"),
				JSON.stringify({ anthropic: { type: "api_key", key: "fixture-local-key" } }),
			);
			const fetchMarker = join(root, "fetch-called");
			const preloadPath = join(root, "fetch-trap.mjs");
			writeFileSync(
				preloadPath,
				`import { writeFileSync } from "node:fs";
globalThis.fetch = () => { writeFileSync(${JSON.stringify(fetchMarker)}, "fetch"); throw new Error("Unexpected catalog request"); };`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					sourceLoader,
					"--import",
					pathToFileURL(preloadPath).href,
					join(pkgRoot, "src", "pi-client-cli.ts"),
					"auth",
					"print-api-key",
					"--provider",
					"anthropic",
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						COMSPEC: process.env.COMSPEC,
						PATHEXT: process.env.PATHEXT,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						HOME: join(root, "home"),
						USERPROFILE: join(root, "home"),
						APPDATA: join(root, "appdata"),
						PI_CODING_AGENT_DIR: agentDir,
						PI_SERVER_URL: "http://127.0.0.1:0",
					},
					encoding: "utf8",
					input: "",
					timeout: 5_000,
				},
			);
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("fixture-local-key\n");
			expect(existsSync(fetchMarker)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
