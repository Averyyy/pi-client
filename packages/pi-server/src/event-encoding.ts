import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";

export function encodeProxyEvent(event: ProxyAssistantMessageEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export function encodeErrorEvent(message: string): string {
	return `data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })}\n\n`;
}

export function parseProxyEvent(line: string): ProxyAssistantMessageEvent | undefined {
	if (!line.startsWith("data: ")) return undefined;
	const data = line.slice(6).trim();
	if (!data) return undefined;
	return JSON.parse(data) as ProxyAssistantMessageEvent;
}
