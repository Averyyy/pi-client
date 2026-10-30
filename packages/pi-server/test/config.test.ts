import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("config", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of [
			"PI_SERVER_HOST",
			"PI_SERVER_PORT",
			"PI_SERVER_AUTH_TOKEN",
			"PI_SERVER_PROVIDER_API_KEY",
			"PI_SERVER_PROVIDER_BASE_URL",
			"PI_SERVER_PROVIDER_HEADERS",
			"PI_SERVER_CONFIG",
			"PI_SERVER_SESSION_STORE_DIR",
			"PI_SERVER_ACCOUNT_STORE_DIR",
			"PI_SERVER_UPLOAD_DIR",
		]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
	});

	it("loads defaults when no env or overrides", () => {
		const config = loadConfig();
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(4217);
		expect(config.authToken).toBeUndefined();
		expect(config.sessionStoreDir).toBe(resolve(".pi", "pi-server", "sessions"));
		expect(config.accountStoreDir).toBe(join(homedir(), ".pi", "pi-server", "accounts"));
		expect(config.uploadDir).toBe(join(homedir(), ".pi", "upload_files"));
	});

	it("does not load upstream provider request config", () => {
		process.env.PI_SERVER_PROVIDER_API_KEY = "sk-server";
		process.env.PI_SERVER_PROVIDER_BASE_URL = "https://server.example.com/v1";
		process.env.PI_SERVER_PROVIDER_HEADERS = "X-Server=yes";

		const config = loadConfig() as unknown as Record<string, unknown>;
		expect(config.providerApiKey).toBeUndefined();
		expect(config.providerBaseUrl).toBeUndefined();
		expect(config.providerHeaders).toBeUndefined();
	});

	it("overrides from env vars", () => {
		process.env.PI_SERVER_HOST = "0.0.0.0";
		process.env.PI_SERVER_PORT = "9999";
		process.env.PI_SERVER_AUTH_TOKEN = "test-token";
		process.env.PI_SERVER_SESSION_STORE_DIR = "env-sessions";
		process.env.PI_SERVER_ACCOUNT_STORE_DIR = "env-accounts";
		process.env.PI_SERVER_UPLOAD_DIR = "env-uploads";

		const config = loadConfig();
		expect(config.host).toBe("0.0.0.0");
		expect(config.port).toBe(9999);
		expect(config.authToken).toBe("test-token");
		expect(config.sessionStoreDir).toBe(resolve("env-sessions"));
		expect(config.accountStoreDir).toBe(resolve("env-accounts"));
		expect(config.uploadDir).toBe(resolve("env-uploads"));
	});

	it("overrides from explicit config object", () => {
		const config = loadConfig({
			host: "192.168.1.1",
			port: 8080,
			authToken: "my-token",
			sessionStoreDir: "override-sessions",
			accountStoreDir: "override-accounts",
			uploadDir: "override-uploads",
		});
		expect(config.host).toBe("192.168.1.1");
		expect(config.port).toBe(8080);
		expect(config.authToken).toBe("my-token");
		expect(config.sessionStoreDir).toBe(resolve("override-sessions"));
		expect(config.accountStoreDir).toBe(resolve("override-accounts"));
		expect(config.uploadDir).toBe(resolve("override-uploads"));
	});

	it("loads config from JSON file via PI_SERVER_CONFIG", () => {
		const tmpDir = join(tmpdir(), `pi-server-config-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				host: "10.0.0.1",
				port: 5555,
				authToken: "file-token",
				sessionStoreDir: "file-sessions",
				accountStoreDir: "file-accounts",
				uploadDir: "file-uploads",
			}),
		);

		process.env.PI_SERVER_CONFIG = configPath;
		const config = loadConfig();
		expect(config.host).toBe("10.0.0.1");
		expect(config.port).toBe(5555);
		expect(config.authToken).toBe("file-token");
		expect(config.sessionStoreDir).toBe(resolve("file-sessions"));
		expect(config.accountStoreDir).toBe(resolve("file-accounts"));
		expect(config.uploadDir).toBe(resolve("file-uploads"));

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("env vars override config file values", () => {
		const tmpDir = join(tmpdir(), `pi-server-config-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				host: "10.0.0.1",
				port: 5555,
				authToken: "file-token",
				accountStoreDir: "file-accounts",
			}),
		);

		process.env.PI_SERVER_CONFIG = configPath;
		process.env.PI_SERVER_HOST = "env-host";
		process.env.PI_SERVER_AUTH_TOKEN = "env-token";
		process.env.PI_SERVER_ACCOUNT_STORE_DIR = "env-accounts";

		const config = loadConfig();
		expect(config.host).toBe("env-host");
		expect(config.port).toBe(5555);
		expect(config.authToken).toBe("env-token");
		expect(config.accountStoreDir).toBe(resolve("env-accounts"));

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("explicit overrides take precedence over env and config file", () => {
		const tmpDir = join(tmpdir(), `pi-server-config-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				host: "file-host",
				accountStoreDir: "file-accounts",
				port: 5555,
			}),
		);

		process.env.PI_SERVER_CONFIG = configPath;
		process.env.PI_SERVER_HOST = "env-host";
		process.env.PI_SERVER_ACCOUNT_STORE_DIR = "env-accounts";

		const config = loadConfig({ host: "override-host", accountStoreDir: "override-accounts" });
		expect(config.host).toBe("override-host");
		expect(config.accountStoreDir).toBe(resolve("override-accounts"));
		expect(config.port).toBe(5555);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("throws on missing config file when PI_SERVER_CONFIG is set", () => {
		process.env.PI_SERVER_CONFIG = "/nonexistent/path/config.json";
		expect(() => loadConfig()).toThrow(/not found/i);
	});

	it("throws on invalid JSON in config file when PI_SERVER_CONFIG is set", () => {
		const tmpDir = join(tmpdir(), `pi-server-config-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "config.json");
		writeFileSync(configPath, "not valid json {{{");

		process.env.PI_SERVER_CONFIG = configPath;
		expect(() => loadConfig()).toThrow(/invalid JSON/i);

		rmSync(tmpDir, { recursive: true, force: true });
	});
});
