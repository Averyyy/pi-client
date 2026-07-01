import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4227;
const DEFAULT_PI_SERVER_URL = "http://127.0.0.1:4217";

const publicDir = resolve(fileURLToPath(new URL("../public", import.meta.url)));

function envString(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}

function envPort(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`${name} must be an integer TCP port`);
	}
	return port;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(data),
	});
	res.end(data);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolveBody(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function contentTypeFor(pathname: string): string {
	switch (extname(pathname)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		default:
			return "application/octet-stream";
	}
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const decodedPath = decodeURIComponent(pathname);
	const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
	const resolvedPath = resolve(publicDir, `.${requestedPath}`);

	if (resolvedPath !== publicDir && !resolvedPath.startsWith(`${publicDir}${sep}`)) {
		sendJson(res, 403, { error: "Forbidden" });
		return;
	}

	try {
		const fileStat = await stat(resolvedPath);
		if (!fileStat.isFile()) {
			sendJson(res, 404, { error: "Not found" });
			return;
		}
		const body = await readFile(resolvedPath);
		res.writeHead(200, {
			"Content-Type": contentTypeFor(resolvedPath),
			"Content-Length": body.byteLength,
			"Cache-Control": "no-store",
		});
		res.end(body);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			sendJson(res, 404, { error: "Not found" });
			return;
		}
		throw error;
	}
}

function copyProxyResponseHeaders(headers: Headers): Record<string, string> {
	const copied: Record<string, string> = {};
	headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		if (
			lowerKey !== "connection" &&
			lowerKey !== "keep-alive" &&
			lowerKey !== "transfer-encoding" &&
			lowerKey !== "upgrade"
		) {
			copied[key] = value;
		}
	});
	return copied;
}

async function proxyPiRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const serverUrl = envString("PI_SERVER_URL", DEFAULT_PI_SERVER_URL);
	const targetPath = url.pathname.slice("/pi".length) || "/";
	const targetUrl = new URL(`${targetPath}${url.search}`, serverUrl);
	const token = process.env.PI_SERVER_AUTH_TOKEN ?? singleHeader(req.headers["x-pi-server-token"]);
	const headers = new Headers();
	const contentType = singleHeader(req.headers["content-type"]);
	const accept = singleHeader(req.headers.accept);

	if (contentType) headers.set("Content-Type", contentType);
	if (accept) headers.set("Accept", accept);
	if (token) headers.set("Authorization", token.startsWith("Bearer ") ? token : `Bearer ${token}`);

	const hasRequestBody = req.method !== "GET" && req.method !== "HEAD";
	const body = hasRequestBody ? await readBody(req) : undefined;
	const upstream = await fetch(targetUrl, {
		method: req.method,
		headers,
		body,
	});

	res.writeHead(upstream.status, copyProxyResponseHeaders(upstream.headers));
	if (!upstream.body) {
		res.end();
		return;
	}

	const reader = upstream.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		res.write(Buffer.from(value));
	}
	res.end();
}

const host = envString("PI_WEBUI_HOST", DEFAULT_HOST);
const port = envPort("PI_WEBUI_PORT", DEFAULT_PORT);

const server = createServer((req, res) => {
	(async () => {
		const url = new URL(req.url ?? "/", `http://${host}:${port}`);

		if (req.method === "GET" && url.pathname === "/config") {
			sendJson(res, 200, {
				piServerUrl: envString("PI_SERVER_URL", DEFAULT_PI_SERVER_URL),
				tokenConfigured: Boolean(process.env.PI_SERVER_AUTH_TOKEN),
			});
			return;
		}

		if (url.pathname === "/pi" || url.pathname.startsWith("/pi/")) {
			await proxyPiRequest(req, res, url);
			return;
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			sendJson(res, 405, { error: "Method not allowed" });
			return;
		}

		await serveStatic(url.pathname, res);
	})().catch((error) => {
		if (!res.headersSent) {
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		} else {
			res.end();
		}
	});
});

server.listen(port, host, () => {
	console.log(`pi-webui listening on http://${host}:${port}`);
	console.log(`pi-webui proxy target ${envString("PI_SERVER_URL", DEFAULT_PI_SERVER_URL)}`);
});
