import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const H_PROXY_WARNING_URL_PATTERN =
	/https?:\/\/114\.114\.114\.114:\d+\/proxycontrolwarn\/httpwarning_\d+\.html\?ori_url=[A-Za-z0-9+/=]+(?:&uid=\d+)?/;
const H_PROXY_WARNING_HOST = "114.114.114.114:9421";
const H_PROXY_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
};

function defaultPackageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultRepoRoot() {
	return resolve(defaultPackageRoot(), "..", "..");
}

function readPackageMetadata(packageRoot) {
	return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8"));
}

function runStep(runner, command, args, cwd, stdio = "inherit") {
	return runner(command, args, { cwd, stdio, encoding: "utf-8" });
}

function responseStatus(response) {
	return response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
}

function getQueryValue(url, name) {
	const match = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
	return match?.[1] ?? "";
}

function getInputValue(html, id) {
	const match = new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html);
	return match?.[1] ?? "";
}

function bitReverse(value) {
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

function encodeWarningByte(value) {
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

function md6(value) {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		result += encodeWarningByte(53 ^ bitReverse(value.charCodeAt(index)) ^ (255 & index));
	}
	return result;
}

function b64(value) {
	return Buffer.from(value, "utf-8").toString("base64");
}

async function findHProxyWarningUrl(response) {
	const location = response.headers.get("location") ?? "";
	if (response.status === 302 && H_PROXY_WARNING_URL_PATTERN.test(location)) return location;
	if (H_PROXY_WARNING_URL_PATTERN.test(response.url)) return response.url;

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("text/html")) return undefined;

	const body = await response.clone().text();
	return H_PROXY_WARNING_URL_PATTERN.exec(body)?.[0];
}

async function approveHProxyWarning(warningUrl, fetchImpl) {
	const warningResponse = await fetchImpl(warningUrl, {
		method: "GET",
		headers: H_PROXY_HEADERS,
		redirect: "manual",
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
	const checkResponse = await fetchImpl(checkUrl, {
		method: "GET",
		headers: H_PROXY_HEADERS,
		redirect: "manual",
	});
	const checkBody = await checkResponse.text();
	if (!checkResponse.ok) {
		throw new Error(`Proxy approval failed: ${responseStatus(checkResponse)} ${checkBody.slice(0, 80)}`);
	}
}

async function approveHProxyTarget(url, fetchImpl) {
	let response;
	try {
		response = await fetchImpl(url, { method: "GET", headers: H_PROXY_HEADERS, redirect: "manual" });
	} catch {
		return false;
	}

	const warningUrl = await findHProxyWarningUrl(response);
	if (!warningUrl) return false;

	await approveHProxyWarning(warningUrl, fetchImpl);
	return true;
}

function maybeGitHttpUrl(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
	const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	return undefined;
}

function maybeHttpUrl(value) {
	const trimmed = value.trim();
	return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : undefined;
}

function getProxyApprovalTargets(runner, repoRoot) {
	const targets = [];
	const remote = runStep(runner, "git", ["config", "--get", "remote.origin.url"], repoRoot, "pipe");
	if (remote.status === 0) {
		const url = maybeGitHttpUrl(String(remote.stdout ?? ""));
		if (url) targets.push(url);
	}

	const registry = runStep(runner, "npm", ["config", "get", "registry"], repoRoot, "pipe");
	if (registry.status === 0) {
		const url = maybeHttpUrl(String(registry.stdout ?? ""));
		if (url) targets.push(url);
	}

	return [...new Set(targets)];
}

async function approveUpdateProxyTargets(runner, repoRoot, stdout, fetchImpl) {
	for (const target of getProxyApprovalTargets(runner, repoRoot)) {
		if (await approveHProxyTarget(target, fetchImpl)) {
			stdout.write(`Approved proxy warning for ${target}\n`);
		}
	}
}

export async function runPiServerUpdate(_args = [], options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const repoRoot = options.repoRoot ?? defaultRepoRoot();
	const runner = options.runner ?? spawnSync;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const pkg = readPackageMetadata(packageRoot);

	stdout.write(`pi-server ${pkg.version}\n`);
	stdout.write(`Updating checkout: ${repoRoot}\n`);

	const status = runStep(runner, "git", ["status", "--porcelain"], repoRoot, "pipe");
	if (status.status !== 0) {
		stderr.write("pi-server update failed: unable to inspect git status\n");
		return status.status ?? 1;
	}
	if (String(status.stdout ?? "").trim().length > 0) {
		stderr.write("pi-server update failed: working tree has uncommitted changes\n");
		return 1;
	}

	await approveUpdateProxyTargets(runner, repoRoot, stdout, fetchImpl);

	const steps = [
		["git", ["pull", "--ff-only"]],
		["npm", ["install", "--ignore-scripts"]],
		["npm", ["run", "install:pi-client"]],
		["npm", ["run", "install:pi-server"]],
	];

	for (const [command, args] of steps) {
		const result = runStep(runner, command, args, repoRoot);
		if (result.status !== 0) {
			stderr.write(`pi-server update failed: ${command} ${args.join(" ")}\n`);
			return result.status ?? 1;
		}
	}

	stdout.write("pi-server update complete\n");
	return 0;
}
