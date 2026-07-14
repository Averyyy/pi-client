import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface UploadEntry {
	path: string;
	type: "file" | "directory";
	data?: Buffer;
}

export class ReceiveUploadError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function invalid(message: string): never {
	throw new ReceiveUploadError(400, message);
}

function validatePath(path: unknown): string {
	if (typeof path !== "string") invalid("entry path must be a string");
	if (path.includes("\\") || path.includes("\0")) invalid(`invalid entry path: ${path}`);
	if (path !== "" && path.split("/").some((part) => part === "" || part === "." || part === "..")) {
		invalid(`invalid entry path: ${path}`);
	}
	return path;
}

function validateBody(body: unknown): { name: string; entries: UploadEntry[] } {
	if (typeof body !== "object" || body === null) invalid("upload body must be an object");
	const upload = body as { name?: unknown; entries?: unknown };
	if (
		typeof upload.name !== "string" ||
		upload.name === "" ||
		upload.name === "." ||
		upload.name === ".." ||
		upload.name.includes("/") ||
		upload.name.includes("\\") ||
		upload.name.includes("\0")
	) {
		invalid("invalid upload name");
	}
	if (!Array.isArray(upload.entries) || upload.entries.length === 0) invalid("entries must be a non-empty array");

	const entries: UploadEntry[] = [];
	const entryTypes = new Map<string, "file" | "directory">();
	for (const value of upload.entries) {
		if (typeof value !== "object" || value === null) invalid("each entry must be an object");
		const entry = value as { path?: unknown; type?: unknown; data?: unknown };
		const path = validatePath(entry.path);
		if (entry.type !== "file" && entry.type !== "directory") invalid(`invalid entry type: ${String(entry.type)}`);
		if (entryTypes.has(path)) invalid(`duplicate entry path: ${path}`);
		entryTypes.set(path, entry.type);
		if (entry.type === "directory") {
			if (entry.data !== undefined) invalid(`directory entry must not contain data: ${path}`);
			entries.push({ path, type: "directory" });
			continue;
		}
		if (typeof entry.data !== "string") invalid(`file entry data must be base64: ${path}`);
		const data = Buffer.from(entry.data, "base64");
		if (data.toString("base64") !== entry.data) invalid(`file entry data must be valid base64: ${path}`);
		entries.push({ path, type: "file", data });
	}

	const rootType = entryTypes.get("");
	if (!rootType) invalid("entries must include the root path");
	if (rootType === "file" && entries.length !== 1) invalid("a file upload cannot contain child entries");
	for (const entry of entries) {
		if (entry.path === "") continue;
		const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
		if (entryTypes.get(parent) !== "directory") invalid(`missing directory entry: ${parent}`);
	}
	return { name: upload.name, entries };
}

export function receiveUpload(uploadDir: string, body: unknown): { path: string; files: number } {
	const upload = validateBody(body);
	mkdirSync(uploadDir, { recursive: true });
	const destination = join(uploadDir, upload.name);
	if (existsSync(destination)) throw new ReceiveUploadError(409, `destination already exists: ${destination}`);
	const temporaryDir = mkdtempSync(join(uploadDir, ".upload-"));
	const temporaryRoot = join(temporaryDir, upload.name);
	try {
		for (const entry of upload.entries.filter((entry) => entry.type === "directory")) {
			mkdirSync(join(temporaryRoot, entry.path), { recursive: true });
		}
		for (const entry of upload.entries.filter((entry) => entry.type === "file")) {
			const path = join(temporaryRoot, entry.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, entry.data!);
		}
		renameSync(temporaryRoot, destination);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
	return { path: destination, files: upload.entries.filter((entry) => entry.type === "file").length };
}
