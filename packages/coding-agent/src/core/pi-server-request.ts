import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_REQUEST_KB = 512;
const CHUNK_ENDPOINT = "/api/request/chunk";
const H_PROXY_WARNING_URL_PATTERN =
	/https?:\/\/114\.114\.114\.114:\d+\/proxycontrolwarn\/httpwarning_\d+\.html\?ori_url=[A-Za-z0-9+/=]+(?:&uid=\d+)?/;
const H_PROXY_WARNING_HOST = "114.114.114.114:9421";
const H_PROXY_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
} satisfies Record<string, string>;

export interface PiServerRequestOptions {
	serverUrl: string;
	authToken: string;
	signal?: AbortSignal;
}

interface ChunkBody {
	requestId: string;
	target: string;
	index: number;
	total: number;
	chunk: string;
}

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

export function getMaxRequestBytes(): number {
	const raw = process.env.PI_CLIENT_MAX_REQUEST_KB;
	if (raw === undefined || raw === "") return DEFAULT_MAX_REQUEST_KB * 1024;

	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("PI_CLIENT_MAX_REQUEST_KB must be a positive number");
	}
	return Math.floor(value * 1024);
}

function makeHeaders(authToken: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
	};
}

function responseStatus(response: Response): string {
	return response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
}

function getQueryValue(url: string, name: string): string {
	const match = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
	return match?.[1] ?? "";
}

function getInputValue(html: string, id: string): string {
	const match = new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html);
	return match?.[1] ?? "";
}

function bitReverse(value: number): number {
	return (
		((1 & value) << 7) |
		((2 & value) << 5) |
		((4 & value) << 3) |
		((8 & value) << 1) |
		((16 & value) >> 1) |
		((32 & value) >> 3) |
		((64 & value) >> 5) |
		((128 & value) >> 7)
	);
}

function encodeWarningByte(value: number): string {
	if (value === 32) return "+";
	if (
		(value < 48 && value !== 45 && value !== 46) ||
		(value < 65 && value > 57) ||
		(value > 90 && value < 97 && value !== 95) ||
		value > 122
	) {
		return `%${value.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return String.fromCharCode(value);
}

function md6(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		result += encodeWarningByte(53 ^ bitReverse(value.charCodeAt(index)) ^ (255 & index));
	}
	return result;
}

function b64(value: string): string {
	return Buffer.from(value, "utf-8").toString("base64");
}

async function findHProxyWarningUrl(response: Response): Promise<string | undefined> {
	const location = response.headers.get("location") ?? "";
	if (response.status === 302 && H_PROXY_WARNING_URL_PATTERN.test(location)) return location;
	if (H_PROXY_WARNING_URL_PATTERN.test(response.url)) return response.url;

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("text/html")) return undefined;

	const body = await response.clone().text();
	return H_PROXY_WARNING_URL_PATTERN.exec(body)?.[0];
}

async function approveHProxyWarning(warningUrl: string, signal?: AbortSignal): Promise<void> {
	const warningResponse = await fetch(warningUrl, {
		method: "GET",
		headers: H_PROXY_HEADERS,
		redirect: "manual",
		signal,
	});
	const html = await warningResponse.text();
	if (!warningResponse.ok) {
		throw new Error(`Proxy warning page fetch failed: ${responseStatus(warningResponse)}`);
	}

	const oriUrl = getQueryValue(warningUrl, "ori_url");
	const sessionId = getInputValue(html, "sessionid");
	if (!oriUrl || !sessionId) {
		throw new Error("Proxy warning page did not include approval fields");
	}

	const pid = getInputValue(html, "pid");
	const uid = getInputValue(html, "uid");
	const payload = `ori_url=${oriUrl}&sessionid=${sessionId}&pid=${pid}&uid=${uid}`;
	const checkUrl = `http://${H_PROXY_WARNING_HOST}/proxycontrolwarn/check?${b64(md6(b64(payload)))}`;
	const checkResponse = await fetch(checkUrl, {
		method: "GET",
		headers: H_PROXY_HEADERS,
		redirect: "manual",
		signal,
	});
	const checkBody = await checkResponse.text();
	if (!checkResponse.ok) {
		throw new Error(`Proxy approval failed: ${responseStatus(checkResponse)} ${checkBody.slice(0, 80)}`);
	}
}

async function fetchWithHProxyApproval(url: string, init: RequestInit): Promise<Response> {
	const response = await fetch(url, { ...init, redirect: "manual" });
	const warningUrl = await findHProxyWarningUrl(response);
	if (!warningUrl) return response;

	await approveHProxyWarning(warningUrl, init.signal ?? undefined);
	return fetch(url, { ...init, redirect: "manual" });
}

function chunkBodyFits(
	target: string,
	requestId: string,
	encodedLength: number,
	chunkLength: number,
	maxBytes: number,
): boolean {
	const total = Math.ceil(encodedLength / chunkLength);
	const body: ChunkBody = {
		requestId,
		target,
		index: Math.max(0, total - 1),
		total,
		chunk: "x".repeat(Math.min(chunkLength, encodedLength)),
	};
	return jsonByteLength(body) <= maxBytes;
}

function splitEncodedBody(target: string, requestId: string, encoded: string, maxBytes: number): string[] {
	if (!chunkBodyFits(target, requestId, encoded.length, 1, maxBytes)) {
		throw new Error("PI_CLIENT_MAX_REQUEST_KB is too small for pi-server chunk envelopes");
	}

	let low = 1;
	let high = encoded.length;
	let best = 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (chunkBodyFits(target, requestId, encoded.length, mid, maxBytes)) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	const chunks: string[] = [];
	for (let offset = 0; offset < encoded.length; offset += best) {
		chunks.push(encoded.slice(offset, offset + best));
	}
	return chunks;
}

export class ChunkRequest {
	options: PiServerRequestOptions;

	constructor(options: PiServerRequestOptions) {
		this.options = options;
	}

	async getJson(endpoint: string): Promise<Response> {
		return fetchWithHProxyApproval(`${this.options.serverUrl}${endpoint}`, {
			method: "GET",
			headers: makeHeaders(this.options.authToken),
			signal: this.options.signal,
		});
	}

	async postJson(endpoint: string, body: unknown): Promise<Response> {
		const rawJson = JSON.stringify(body);
		const maxBytes = getMaxRequestBytes();
		if (Buffer.byteLength(rawJson, "utf-8") <= maxBytes) {
			return this.#postRawJson(endpoint, rawJson);
		}

		const requestId = randomUUID();
		const encoded = Buffer.from(rawJson, "utf-8").toString("base64");
		const chunks = splitEncodedBody(endpoint, requestId, encoded, maxBytes);
		let response: Response | undefined;

		for (let index = 0; index < chunks.length; index++) {
			const chunkBody: ChunkBody = {
				requestId,
				target: endpoint,
				index,
				total: chunks.length,
				chunk: chunks[index],
			};
			response = await this.#postRawJson(CHUNK_ENDPOINT, JSON.stringify(chunkBody));
			if (!response.ok || index === chunks.length - 1) {
				return response;
			}
		}

		throw new Error("No chunk response received from pi-server");
	}

	async #postRawJson(endpoint: string, rawJson: string): Promise<Response> {
		return fetchWithHProxyApproval(`${this.options.serverUrl}${endpoint}`, {
			method: "POST",
			headers: makeHeaders(this.options.authToken),
			body: rawJson,
			signal: this.options.signal,
		});
	}
}
