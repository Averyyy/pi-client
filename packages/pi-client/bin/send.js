import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { ChunkRequest } from "@earendil-works/pi-coding-agent/pi-server-request";

const MAX_ERROR_BODY_CHARS = 300;

function addDirectoryEntries(root, directory, entries) {
	const path = relative(root, directory).split(sep).join("/");
	entries.push({ path, type: "directory" });
	for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const childPath = join(directory, child.name);
		if (child.isDirectory()) addDirectoryEntries(root, childPath, entries);
		else if (child.isFile()) {
			entries.push({ path: relative(root, childPath).split(sep).join("/"), type: "file", data: readFileSync(childPath).toString("base64") });
		} else {
			throw new Error(`Unsupported file type: ${childPath}`);
		}
	}
}

export function createUploadBody(sourcePath) {
	const source = resolve(sourcePath);
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${source}`);
	if (stat.isFile()) {
		return { name: basename(source), entries: [{ path: "", type: "file", data: readFileSync(source).toString("base64") }] };
	}
	if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${source}`);
	const entries = [];
	addDirectoryEntries(source, source, entries);
	return { name: basename(source), entries };
}

export async function runPiClientSend(args) {
	if (args.length !== 1) {
		console.error("Usage: pi-client send /path/to/file-or-folder");
		return 1;
	}
	const serverUrl = process.env.PI_SERVER_URL ?? "http://127.0.0.1:4217";
	const authToken = process.env.PI_SERVER_AUTH_TOKEN ?? "";
	const request = new ChunkRequest({
		serverUrl,
		authToken,
	});
	let response;
	try {
		response = await request.postJson("/api/receive", createUploadBody(args[0]));
	} catch (error) {
		console.error(formatRequestFailure(serverUrl, error, authToken));
		return 1;
	}

	let bodyText;
	try {
		bodyText = await response.text();
	} catch (error) {
		console.error(formatResponseFailure(serverUrl, response, error, authToken, "response body read failed"));
		return 1;
	}
	if (!response.ok) {
		console.error(formatResponseFailure(serverUrl, response, bodyText, authToken));
		return 1;
	}

	let body;
	try {
		body = JSON.parse(bodyText);
	} catch {
		console.error(formatResponseFailure(serverUrl, response, bodyText, authToken, "expected JSON upload response"));
		return 1;
	}
	if (!body || typeof body !== "object" || typeof body.path !== "string") {
		console.error(
			formatResponseFailure(
				serverUrl,
				response,
				bodyText,
				authToken,
				"invalid upload payload; expected JSON response with a string path",
			),
		);
		return 1;
	}
	console.log(`Saved to ${body.path}`);
	return 0;
}

function formatResponseFailure(serverUrl, response, body, authToken, detail) {
	const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
	const contentType = response.headers.get("content-type") ?? "unknown";
	const detailText = detail ? `; ${detail}` : "";
	return `pi-client send failed for ${formatTarget(serverUrl)}: status ${status}; content-type: ${contentType}${detailText}; body excerpt: ${formatBodyExcerpt(body, authToken)}`;
}

function formatRequestFailure(serverUrl, error, authToken) {
	const message = error instanceof Error ? error.message : String(error);
	return `pi-client send failed for ${formatTarget(serverUrl)}: status unavailable; content-type: unavailable; body excerpt: ${formatBodyExcerpt(message, authToken)}`;
}

function formatTarget(serverUrl) {
	try {
		const target = new URL(`${serverUrl}/api/receive`);
		target.username = "";
		target.password = "";
		target.search = "";
		target.hash = "";
		return target.toString();
	} catch {
		return "/api/receive";
	}
}

function formatBodyExcerpt(body, authToken) {
	const compacted = String(body ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const redacted = authToken ? compacted.replaceAll(authToken, "[redacted]") : compacted;
	if (redacted.length <= MAX_ERROR_BODY_CHARS) return redacted || "(empty)";
	return `${redacted.slice(0, MAX_ERROR_BODY_CHARS)}...`;
}
