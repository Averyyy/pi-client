import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { JsonObject, Tool, ToolCall } from "@earendil-works/pi-ai";
import {
	LATEST_PROTOCOL_VERSION,
	McpError,
	parseJsonRpcMessage,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@earendil-works/pi-mcp";

export type AntigravityToolExecutor = (toolCall: ToolCall) => Promise<AgentToolCallOutcome>;

/** Serve the Pi session's tools to the local Antigravity ACP worker over Streamable HTTP. */
export async function openAntigravityTools(
	tools: readonly Tool[],
	getExecutor: () => AntigravityToolExecutor | undefined,
) {
	const path = `/${randomUUID()}`;
	const definitions = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		_meta: { "antigravity/alwaysLoad": true },
	}));
	const server = createServer(async (request, response) => {
		if (request.url !== path || request.headers.origin !== undefined) {
			response.writeHead(403).end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { Allow: "POST" }).end();
			return;
		}
		let id: string | number | null = null;
		try {
			let body = "";
			request.setEncoding("utf8");
			for await (const chunk of request) body += chunk;
			const message = parseJsonRpcMessage(JSON.parse(body));
			if (!("id" in message) || !("method" in message)) {
				response.writeHead(202).end();
				return;
			}
			id = message.id;
			const result = await dispatch(message.method, message.params, definitions, getExecutor());
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
		} catch (error) {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: error instanceof McpError ? error.code : -32603, message: String(error) },
				}),
			);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as { port: number };
	return {
		config: { type: "http", name: "pi", url: `http://127.0.0.1:${port}${path}`, headers: [] },
		close: () => {
			server.close();
			server.closeAllConnections();
		},
	};
}

async function dispatch(
	method: string,
	params: unknown,
	tools: { name: string; description: string; inputSchema: Tool["parameters"]; _meta: object }[],
	execute: AntigravityToolExecutor | undefined,
): Promise<unknown> {
	switch (method) {
		case "initialize": {
			const { protocolVersion } = params as { protocolVersion: (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] };
			return {
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
					? protocolVersion
					: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "pi", version: "1.0.0" },
			};
		}
		case "ping":
			return {};
		case "tools/list":
			return { tools };
		case "tools/call": {
			const { name, arguments: args = {} } = params as { name: string; arguments?: JsonObject };
			if (!tools.some((tool) => tool.name === name)) throw new McpError(-32602, `Unknown Pi tool ${name}`);
			if (!execute) throw new McpError(-32000, "Pi has no active Antigravity turn");
			const { result, isError } = await execute({ type: "toolCall", id: randomUUID(), name, arguments: args });
			return {
				content: result.content,
				structuredContent: result.structuredContent,
				isError,
			};
		}
		default:
			throw new McpError(-32601, `Unsupported Pi MCP method ${method}`);
	}
}
