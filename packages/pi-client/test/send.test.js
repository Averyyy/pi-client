import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createUploadBody } from "../bin/send.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-client.js");

function runSend(sourcePath, serverUrl, authToken = "secret-token") {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "send", sourcePath], {
			env: { ...process.env, PI_SERVER_URL: serverUrl, PI_SERVER_AUTH_TOKEN: authToken },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
		child.once("error", reject);
		child.once("close", (status, signal) => {
			clearTimeout(timeout);
			resolve({ status, signal, stdout, stderr });
		});
	});
}

async function withResponse(status, contentType, body, callback) {
	const server = createServer((_req, res) => {
		res.writeHead(status, { "content-type": contentType });
		res.end(body);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to allocate test server port");
	try {
		return await callback(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

async function withBrokenResponse(callback) {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
		res.flushHeaders();
		res.write('{"path":"/uploads/file.txt"');
		setTimeout(() => res.destroy(), 100);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to allocate broken-response test port");
	try {
		return await callback(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

async function getUnusedPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to allocate test port");
	const port = address.port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function withSource(callback) {
	const directory = mkdtempSync(join(tmpdir(), "pi-client-send-cli-"));
	const source = join(directory, "file.txt");
	writeFileSync(source, "hello");
	try {
		return await callback(source);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("pi-client send", () => {
	it("encodes a file", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-client-send-"));
		const source = join(directory, "file.txt");
		writeFileSync(source, "hello");
		try {
			expect(createUploadBody(source)).toEqual({
				name: "file.txt",
				entries: [{ path: "", type: "file", data: Buffer.from("hello").toString("base64") }],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("encodes a folder with stable relative paths", () => {
		const source = mkdtempSync(join(tmpdir(), "pi-client-send-"));
		mkdirSync(join(source, "nested"));
		writeFileSync(join(source, "nested", "file.txt"), "hello");
		try {
			expect(createUploadBody(source)).toEqual({
				name: basename(source),
				entries: [
					{ path: "", type: "directory" },
					{ path: "nested", type: "directory" },
					{ path: "nested/file.txt", type: "file", data: Buffer.from("hello").toString("base64") },
				],
			});
		} finally {
			rmSync(source, { recursive: true, force: true });
		}
	});

	it("reports an HTML gateway response with bounded diagnostics", async () => {
		await withSource((source) =>
			withResponse(
				502,
				"text/html",
				`<html><body>Bad Gateway secret-token ${"x".repeat(1_000)}</body></html>`,
				async (baseUrl) => {
					const serverUrl = `${baseUrl}/gateway`;
					const result = await runSend(source, serverUrl);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`${serverUrl}/api/receive`);
				expect(result.stderr).toContain("status 502");
				expect(result.stderr).toContain("content-type: text/html");
				expect(result.stderr).toContain("Bad Gateway");
				expect(result.stderr).not.toContain("secret-token");
				expect(result.stderr.split("body excerpt: ")[1].trim()).toHaveLength(303);
				expect(result.stdout).toBe("");
				},
			),
		);
	});

	it.each([
		[401, "Unauthorized"],
		[409, "Destination already exists"],
	])("reports JSON HTTP %s failures", async (status, message) => {
		await withSource((source) =>
			withResponse(status, "application/json", JSON.stringify({ error: message, token: "secret-token" }), async (serverUrl) => {
				const result = await runSend(source, serverUrl);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`${serverUrl}/api/receive`);
				expect(result.stderr).toContain(`status ${status}`);
				expect(result.stderr).toContain("content-type: application/json");
				expect(result.stderr).toContain(message);
				expect(result.stderr).not.toContain("secret-token");
			}),
		);
	});

	it("rejects a successful response that is not JSON", async () => {
		await withSource((source) =>
			withResponse(200, "text/plain", "saved by proxy but response was malformed", async (serverUrl) => {
				const result = await runSend(source, serverUrl);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`${serverUrl}/api/receive`);
				expect(result.stderr).toContain("status 200");
				expect(result.stderr).toContain("content-type: text/plain");
				expect(result.stderr).toContain("expected JSON upload response");
				expect(result.stderr).toContain("response was malformed");
			}),
		);
	});

	it("reports a response body read failure with known response metadata", async () => {
		await withSource((source) =>
			withBrokenResponse(async (serverUrl) => {
				const result = await runSend(source, serverUrl);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`${serverUrl}/api/receive`);
				expect(result.stderr).toContain("status 200");
				expect(result.stderr).toContain("content-type: application/json");
				expect(result.stderr).toContain("response body read failed");
				expect(result.stderr).toMatch(/terminated|other side closed|network error/i);
				expect(result.stderr).not.toContain("at process.processTicksAndRejections");
			}),
		);
	});

	it("reports connection failures without throwing a fetch stack", async () => {
		const port = await getUnusedPort();
		await withSource(async (source) => {
			const result = await runSend(source, `http://127.0.0.1:${port}`);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`http://127.0.0.1:${port}/api/receive`);
			expect(result.stderr).toContain("status unavailable");
			expect(result.stderr).toContain("content-type: unavailable");
			expect(result.stderr).toMatch(/fetch failed|ECONNREFUSED/);
			expect(result.stderr).not.toContain("secret-token");
			expect(result.stderr).not.toContain("at process.processTicksAndRejections");
		});
	});

	it("keeps the successful upload output", async () => {
		await withSource((source) =>
			withResponse(200, "application/json", JSON.stringify({ path: "/uploads/file.txt" }), async (serverUrl) => {
				const result = await runSend(source, serverUrl);
				expect(result.status).toBe(0);
				expect(result.stdout).toBe("Saved to /uploads/file.txt\n");
				expect(result.stderr).toBe("");
			}),
		);
	});
});
