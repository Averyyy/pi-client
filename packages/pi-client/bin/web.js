#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { effectivePiWebConfig, maxUploadBytes, piWebDataDir } from "@jmfederico/pi-web/dist/config.js";
import { buildApp } from "@jmfederico/pi-web/dist/server/app.js";
import { PiWebPluginService } from "@jmfederico/pi-web/dist/server/piWebPluginService.js";
import { ProjectService } from "@jmfederico/pi-web/dist/server/projects/projectService.js";
import { ProjectStore } from "@jmfederico/pi-web/dist/server/storage/projectStore.js";

const require = createRequire(import.meta.url);
const piWebRoot = dirname(require.resolve("@jmfederico/pi-web/package.json"));
const binDir = dirname(fileURLToPath(import.meta.url));
const defaultPort = "1838";
const defaultPiServerUrl = "http://127.0.0.1:4217";

export async function runPiClientWeb(args = process.argv.slice(2)) {
	const parsed = parseArgs(args);
	if (parsed.help) {
		printHelp();
		return 0;
	}

	process.title = "pi-client web";
	const piServer = await effectivePiServerSettings(process.env);
	const childEnv = {
		...process.env,
		PI_CODING_AGENT: "true",
		PI_SERVER_MODE: "true",
		PI_SERVER_URL: piServer.serverUrl,
		PI_WEB_HOST: process.env.PI_WEB_HOST ?? "127.0.0.1",
		PI_WEB_PORT: parsed.port,
	};
	const sessiond = spawn(process.execPath, [join(piWebRoot, "dist", "server", "sessiond.js")], { env: childEnv, stdio: "inherit" });
	const { config } = effectivePiWebConfig({ env: childEnv });
	const projects = new PiClientProjectService(new ProjectService(new ProjectStore()), process.env);
	const app = await buildApp({
		bodyLimit: maxUploadBytes(childEnv, config),
		projects,
		piWebPlugins: new PiWebPluginService({
			roots: [
				{ path: join(piWebRoot, "dist", "pi-web-plugins"), source: "bundled", scope: "bundled" },
				{ path: join(binDir, "pi-web-plugins"), source: "pi-client", scope: "bundled" },
				{ path: join(piWebDataDir(childEnv), "plugins"), source: "local", scope: "local" },
			],
		}),
	});
	registerPiClientRoutes(app, { env: process.env, startupPiServerUrl: piServer.serverUrl, projects });
	await app.listen({ port: config.port ?? Number.parseInt(defaultPort, 10), host: config.host ?? "127.0.0.1" });
	console.log(`pi-client web listening on http://${config.host ?? "127.0.0.1"}:${config.port ?? defaultPort}`);

	let shuttingDown = false;
	return await new Promise((resolve) => {
		const shutdown = (exitCode) => {
			if (shuttingDown) return;
			shuttingDown = true;
			sessiond.kill();
			void app.close().finally(() => {
				resolve(exitCode);
			});
		};

		sessiond.once("error", (error) => {
			console.error(error);
			shutdown(1);
		});
		sessiond.once("exit", (code, signal) => {
			shutdown(code ?? (signal === "SIGINT" ? 130 : 1));
		});
		process.once("SIGINT", () => shutdown(130));
		process.once("SIGTERM", () => shutdown(143));
	});
}

function registerPiClientRoutes(app, state) {
	app.get("/api/pi-client/pi-server", async (_request, _reply) => piServerStatus(state));
	app.put("/api/pi-client/pi-server", async (request, reply) => {
		const body = request.body;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({ error: "pi-server settings update must be an object" });
		}
		const piServerUrl = validatePiServerUrl(body.piServerUrl);
		await savePiClientWebConfig({ piServerUrl }, state.env);
		return piServerStatus(state);
	});
	app.get("/api/pi-client/global-agents", async () => globalAgentsFile());
	app.put("/api/pi-client/global-agents", async (request, reply) => {
		const body = request.body;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({ error: "global AGENTS.md update must be an object" });
		}
		const content = validateGlobalAgentsContent(body.content);
		await saveGlobalAgentsFile(content);
		return globalAgentsFile();
	});
	app.get("/api/pi-client/projects", async () => state.projects.listWithVisibility());
	app.put("/api/pi-client/projects/:projectId/visibility", async (request, reply) => {
		const body = request.body;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({ error: "project visibility update must be an object" });
		}
		if (typeof body.visible !== "boolean") return reply.code(400).send({ error: "visible must be a boolean" });
		await state.projects.setVisibility(request.params.projectId, body.visible);
		return state.projects.listWithVisibility();
	});
}

async function piServerStatus(state) {
	const settings = await effectivePiServerSettings(state.env);
	const publicSettings = { ...settings };
	delete publicSettings.authToken;
	return {
		...publicSettings,
		restartRequired: settings.serverUrl !== state.startupPiServerUrl,
		...(await checkPiServer(settings)),
	};
}

async function checkPiServer(settings) {
	const headers =
		settings.authToken === undefined || settings.authToken === ""
			? {}
			: { authorization: `Bearer ${settings.authToken}` };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);
	try {
		const health = await fetch(new URL("/health", settings.serverUrl), { headers, signal: controller.signal });
		const sessions = await fetch(new URL("/api/sessions", settings.serverUrl), { headers, signal: controller.signal });
		return {
			reachable: health.ok,
			authenticated: sessions.status !== 401 && sessions.status !== 403,
			status: sessions.status,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			reachable: false,
			authenticated: false,
			error: error instanceof Error ? error.message : String(error),
			checkedAt: new Date().toISOString(),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function effectivePiServerSettings(env) {
	const config = await loadPiClientWebConfig(env);
	const envUrl = env.PI_SERVER_URL;
	const configUrl = config.piServerUrl;
	return {
		serverUrl:
			envUrl !== undefined && envUrl !== ""
				? validatePiServerUrl(envUrl)
				: configUrl !== undefined && configUrl !== ""
					? validatePiServerUrl(configUrl)
					: defaultPiServerUrl,
		urlSource: envUrl !== undefined && envUrl !== "" ? "environment" : configUrl !== undefined ? "config" : "default",
		tokenConfigured: env.PI_SERVER_AUTH_TOKEN !== undefined && env.PI_SERVER_AUTH_TOKEN !== "",
		authToken: env.PI_SERVER_AUTH_TOKEN,
		configPath: piClientWebConfigPath(env),
	};
}

async function loadPiClientWebConfig(env) {
	const configPath = piClientWebConfigPath(env);
	if (!existsSync(configPath)) return {};
	const parsed = JSON.parse(await readFile(configPath, "utf-8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`pi-client web config must be a JSON object: ${configPath}`);
	}
	return parsed;
}

async function savePiClientWebConfig(update, env) {
	const configPath = piClientWebConfigPath(env);
	const existing = await loadPiClientWebConfig(env);
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`, "utf-8");
}

function piClientWebConfigPath(env) {
	if (env.PI_CLIENT_WEB_CONFIG !== undefined && env.PI_CLIENT_WEB_CONFIG !== "") return env.PI_CLIENT_WEB_CONFIG;
	const xdgConfigHome = env.XDG_CONFIG_HOME;
	return join(xdgConfigHome !== undefined && xdgConfigHome !== "" ? xdgConfigHome : join(homedir(), ".config"), "pi-client", "web.json");
}

function validatePiServerUrl(value) {
	if (typeof value !== "string" || value.trim() === "") throw new Error("piServerUrl must be a non-empty string");
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("piServerUrl must be http or https");
	return url.toString().replace(/\/$/u, "");
}

async function globalAgentsFile() {
	const filePath = globalAgentsPath();
	const exists = existsSync(filePath);
	return {
		path: filePath,
		exists,
		content: exists ? await readFile(filePath, "utf-8") : "",
	};
}

async function saveGlobalAgentsFile(content) {
	const filePath = globalAgentsPath();
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}

function globalAgentsPath() {
	return join(getAgentDir(), "AGENTS.md");
}

function validateGlobalAgentsContent(value) {
	if (typeof value !== "string") throw new Error("content must be a string");
	return value;
}

class PiClientProjectService {
	constructor(projects, env) {
		this.projects = projects;
		this.env = env;
	}

	async list() {
		const [projects, hiddenProjectIds] = await Promise.all([this.projects.list(), loadHiddenProjectIds(this.env)]);
		return projects.filter((project) => !hiddenProjectIds.has(project.id));
	}

	add(input) {
		return this.projects.add(input);
	}

	close(id) {
		return this.projects.close(id);
	}

	requireProject(id) {
		return this.projects.requireProject(id);
	}

	async listWithVisibility() {
		const [projects, hiddenProjectIds] = await Promise.all([this.projects.list(), loadHiddenProjectIds(this.env)]);
		return projects.map((project) => ({ ...project, hidden: hiddenProjectIds.has(project.id) }));
	}

	async setVisibility(projectId, visible) {
		await this.projects.requireProject(projectId);
		const hiddenProjectIds = await loadHiddenProjectIds(this.env);
		if (visible) {
			hiddenProjectIds.delete(projectId);
		} else {
			hiddenProjectIds.add(projectId);
		}
		await savePiClientWebConfig({ hiddenProjectIds: [...hiddenProjectIds].sort() }, this.env);
	}
}

async function loadHiddenProjectIds(env) {
	const config = await loadPiClientWebConfig(env);
	if (config.hiddenProjectIds === undefined) return new Set();
	if (!Array.isArray(config.hiddenProjectIds) || !config.hiddenProjectIds.every((id) => typeof id === "string")) {
		throw new Error("hiddenProjectIds must be an array of strings");
	}
	return new Set(config.hiddenProjectIds);
}

function parseArgs(args) {
	let port = process.env.PI_WEB_PORT ?? defaultPort;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { help: true, port };
		if (arg === "--port" || arg === "-p") {
			port = requireValue(args, (i += 1), arg);
			continue;
		}
		if (arg.startsWith("--port=")) {
			port = arg.slice("--port=".length);
			continue;
		}
		throw new Error(`Unknown pi-client web argument: ${arg}`);
	}
	validatePort(port);
	return { help: false, port };
}

function requireValue(args, index, name) {
	const value = args[index];
	if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
	return value;
}

function validatePort(port) {
	const parsed = Number(port);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`--port must be an integer from 1 to 65535: ${port}`);
	}
}

function printHelp() {
	console.log(`Usage: pi-client web [--port <port>]

Start the pi-client web UI.

Options:
  -p, --port <port>  Port to listen on (default: ${defaultPort})
  -h, --help         Show this help

Environment:
  PI_SERVER_URL          pi-server URL used by browser sessions
  PI_SERVER_AUTH_TOKEN   pi-server auth token
  PI_CLIENT_WEB_CONFIG   pi-client web settings file
`);
}
