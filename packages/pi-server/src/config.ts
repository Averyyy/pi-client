import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ServerConfig {
	host: string;
	port: number;
	authToken: string | undefined;
	providerApiKey: string | undefined;
	providerBaseUrl: string | undefined;
	providerHeaders: Record<string, string>;
}

const DEFAULT_CONFIG: ServerConfig = {
	host: "127.0.0.1",
	port: 4217,
	authToken: undefined,
	providerApiKey: undefined,
	providerBaseUrl: undefined,
	providerHeaders: {},
};

function loadConfigFile(): Partial<ServerConfig> {
	const configPath = process.env.PI_SERVER_CONFIG;
	if (!configPath) return {};
	const resolved = resolve(configPath);
	if (!existsSync(resolved)) {
		throw new Error(`PI_SERVER_CONFIG file not found: ${resolved}`);
	}
	try {
		const content = readFileSync(resolved, "utf-8");
		return JSON.parse(content) as Partial<ServerConfig>;
	} catch (err) {
		throw new Error(`PI_SERVER_CONFIG file contains invalid JSON: ${resolved}`, { cause: err });
	}
}

function parseHeadersEnv(value: string | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	const headers: Record<string, string> = {};
	for (const pair of value.split(",")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		const key = pair.slice(0, eq).trim();
		const val = pair.slice(eq + 1).trim();
		if (key) headers[key] = val;
	}
	return headers;
}

export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
	const fileConfig = loadConfigFile();

	return {
		host: overrides?.host ?? process.env.PI_SERVER_HOST ?? fileConfig.host ?? DEFAULT_CONFIG.host,
		port:
			overrides?.port ??
			(process.env.PI_SERVER_PORT ? parseInt(process.env.PI_SERVER_PORT, 10) : undefined) ??
			fileConfig.port ??
			DEFAULT_CONFIG.port,
		authToken:
			overrides?.authToken ?? process.env.PI_SERVER_AUTH_TOKEN ?? fileConfig.authToken ?? DEFAULT_CONFIG.authToken,
		providerApiKey:
			overrides?.providerApiKey ??
			process.env.PI_SERVER_PROVIDER_API_KEY ??
			fileConfig.providerApiKey ??
			DEFAULT_CONFIG.providerApiKey,
		providerBaseUrl:
			overrides?.providerBaseUrl ??
			process.env.PI_SERVER_PROVIDER_BASE_URL ??
			fileConfig.providerBaseUrl ??
			DEFAULT_CONFIG.providerBaseUrl,
		providerHeaders:
			overrides?.providerHeaders ??
			parseHeadersEnv(process.env.PI_SERVER_PROVIDER_HEADERS) ??
			fileConfig.providerHeaders ??
			DEFAULT_CONFIG.providerHeaders,
	};
}
