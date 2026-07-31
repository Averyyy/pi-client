import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { ChunkRequest } from "@earendil-works/pi-coding-agent/pi-server-request";

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
	const request = new ChunkRequest({
		serverUrl: process.env.PI_SERVER_URL ?? "http://127.0.0.1:4217",
		authToken: process.env.PI_SERVER_AUTH_TOKEN ?? "",
	});
	const response = await request.postJson("/api/receive", createUploadBody(args[0]));
	const body = await response.json();
	if (!response.ok) {
		console.error(`pi-client send failed (${response.status}): ${body.error ?? response.statusText}`);
		return 1;
	}
	console.log(`Saved to ${body.path}`);
	return 0;
}
