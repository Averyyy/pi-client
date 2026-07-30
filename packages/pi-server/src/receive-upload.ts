import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

interface UploadEntry {
	path: string;
	type: "file" | "directory";
	data?: Buffer;
}

export const RECEIVE_UPLOAD_MAX_ENTRIES = 10_000;
export const RECEIVE_UPLOAD_MAX_NAME_CHARS = 255;
export const RECEIVE_UPLOAD_MAX_PATH_CHARS = 4096;
export const RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS = 255;
export const RECEIVE_UPLOAD_MAX_DECODED_BYTES = 64 * 1024 * 1024;

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
	if (path.length > RECEIVE_UPLOAD_MAX_PATH_CHARS) {
		invalid(`entry path must not exceed ${RECEIVE_UPLOAD_MAX_PATH_CHARS} characters`);
	}
	if (path.includes("\\") || path.includes("\0")) invalid(`invalid entry path: ${path}`);
	if (path !== "" && path.split("/").some((part) => part === "" || part === "." || part === "..")) {
		invalid(`invalid entry path: ${path}`);
	}
	if (path.split("/").some((part) => part.length > RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS)) {
		invalid(`entry path segment must not exceed ${RECEIVE_UPLOAD_MAX_PATH_SEGMENT_CHARS} characters`);
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
		upload.name.includes("\0") ||
		upload.name.length > RECEIVE_UPLOAD_MAX_NAME_CHARS
	) {
		invalid("invalid upload name");
	}
	if (!Array.isArray(upload.entries) || upload.entries.length === 0) invalid("entries must be a non-empty array");
	if (upload.entries.length > RECEIVE_UPLOAD_MAX_ENTRIES) {
		invalid(`entries must not exceed ${RECEIVE_UPLOAD_MAX_ENTRIES}`);
	}

	const entries: UploadEntry[] = [];
	const entryTypes = new Map<string, "file" | "directory">();
	let decodedBytes = 0;
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
		decodedBytes += data.byteLength;
		if (decodedBytes > RECEIVE_UPLOAD_MAX_DECODED_BYTES) {
			invalid(`decoded upload data must not exceed ${RECEIVE_UPLOAD_MAX_DECODED_BYTES} bytes`);
		}
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

function fileMatches(path: string, expected: Buffer): boolean {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size !== expected.byteLength) return false;
	const handle = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.byteLength)));
	let offset = 0;
	try {
		while (offset < expected.byteLength) {
			const bytesRead = readSync(
				handle,
				buffer,
				0,
				Math.min(buffer.byteLength, expected.byteLength - offset),
				offset,
			);
			if (bytesRead === 0 || !buffer.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) {
				return false;
			}
			offset += bytesRead;
		}
		return true;
	} finally {
		closeSync(handle);
	}
}

function existingDestinationMatches(destination: string, entries: UploadEntry[]): boolean {
	const expected = new Map(entries.map((entry) => [entry.path, entry]));
	const root = expected.get("");
	if (!root) return false;
	const destinationStat = lstatSync(destination);
	if (root.type === "file") {
		return !destinationStat.isSymbolicLink() && fileMatches(destination, root.data!);
	}
	if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) return false;

	let visited = 1;
	const visitDirectory = (directory: string): boolean => {
		for (const child of readdirSync(directory, { withFileTypes: true })) {
			if (child.isSymbolicLink()) return false;
			const childPath = join(directory, child.name);
			const entryPath = relative(destination, childPath).split(sep).join("/");
			const entry = expected.get(entryPath);
			if (!entry) return false;
			visited++;
			if (visited > expected.size) return false;
			if (entry.type === "directory") {
				if (!child.isDirectory() || !visitDirectory(childPath)) return false;
			} else if (!child.isFile() || !fileMatches(childPath, entry.data!)) {
				return false;
			}
		}
		return true;
	};

	return visitDirectory(destination) && visited === expected.size;
}

export function receiveUpload(uploadDir: string, body: unknown): { path: string; files: number } {
	const upload = validateBody(body);
	mkdirSync(uploadDir, { recursive: true });
	const destination = join(uploadDir, upload.name);
	const fileCount = upload.entries.filter((entry) => entry.type === "file").length;
	if (existsSync(destination)) {
		if (existingDestinationMatches(destination, upload.entries)) {
			return { path: destination, files: fileCount };
		}
		throw new ReceiveUploadError(409, `destination already exists with different contents: ${destination}`);
	}
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
	return { path: destination, files: fileCount };
}
