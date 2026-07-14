import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
	host: string;
	port: number;
	authToken: string | undefined;
	sessionStoreDir: string;
	uploadDir: string;
}

const DEFAULT_CONFIG: ServerConfig = {
	host: "127.0.0.1",
	port: 4217,
	authToken: undefined,
	sessionStoreDir: resolve(".pi", "pi-server", "sessions"),
	uploadDir: join(homedir(), ".pi", "upload_files"),
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
		sessionStoreDir: resolve(
			overrides?.sessionStoreDir ??
				process.env.PI_SERVER_SESSION_STORE_DIR ??
				fileConfig.sessionStoreDir ??
				DEFAULT_CONFIG.sessionStoreDir,
		),
		uploadDir: resolve(
			overrides?.uploadDir ?? process.env.PI_SERVER_UPLOAD_DIR ?? fileConfig.uploadDir ?? DEFAULT_CONFIG.uploadDir,
		),
	};
}
