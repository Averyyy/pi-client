const assert = require("node:assert/strict");
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const lines = createInterface({ input: process.stdin });
if (process.argv.includes("--login")) {
	console.log("https://accounts.google.com/mock-antigravity");
	lines.once("line", (code) => {
		assert.equal(code, "mock-code");
		writeFileSync("signed-in", "");
		lines.close();
	});
} else {
	startAcp();
}

function startAcp() {
	const sessionId = "mock-agy-session";
	const models = [
		{ value: "gemini-test", name: "Gemini Test" },
		{ options: [{ value: "orchestrator-test", name: "Orchestrator (Argon)" }] },
	];
	let model = models[0].value;
	let effort = "medium";
	let mcp;
	let cancelId;
	let permission;
	const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
	const trace = (message) => appendFileSync("trace.jsonl", `${JSON.stringify(message)}\n`);
	const update = (sessionUpdate, text) =>
		send({ method: "session/update", params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } } });
	const configs = () => [
		{ id: "model", type: "select", currentValue: model, options: models },
		...(model === "gemini-test" ? [{
			id: "effort", category: "thought_level", type: "select", currentValue: effort,
			options: ["medium", "high"].map((value) => ({ value, name: value })),
		}] : []),
	];
	const callMcp = async (method, params) => {
		const response = await fetch(mcp.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		assert.equal(response.status, 200);
		const message = await response.json();
		assert.equal(message.error, undefined);
		trace({ method: `mock/${method}`, result: message.result });
		return message.result;
	};
	lines.on("line", async (line) => {
		const message = JSON.parse(line);
		const { id, method, params } = message;
		assert.equal(message.jsonrpc, "2.0");
		trace(message);
		const reply = (result) => send({ id, result });
		switch (method) {
			case "initialize":
				assert.equal(params.protocolVersion, 2);
				reply({
					protocolVersion: 2, agentInfo: { name: "antigravity-acp", version: "1.5.9" },
					agentCapabilities: { auth: { logout: {} }, mcpCapabilities: { http: true },
						promptCapabilities: { image: true }, _meta: { antigravity: { systemPrompt: { append: true } } } },
				});
				break;
			case "session/new":
				if (!existsSync("signed-in")) {
					send({ id, error: { code: -32000, message: "Authentication required" } });
					break;
				}
				[mcp] = params.mcpServers;
				if (mcp) assert.ok(process.argv.includes("--process-per-session"));
				reply({ sessionId, configOptions: configs() });
				break;
			case "session/set_config_option":
				assert.equal(params.sessionId, sessionId);
				if (params.configId === "model") model = params.value;
				else if (params.configId === "effort") effort = params.value;
				else throw new Error(`Unexpected ACP configuration ${params.configId}`);
				reply({ configOptions: configs() });
				break;
			case "session/prompt": {
				assert.equal(params.sessionId, sessionId);
				const text = params.prompt.filter((part) => part.type === "text").at(-1)?.text;
				if (text === "cancel") {
					cancelId = id;
					break;
				}
				update("agent_thought_chunk", "Planning");
				if (text === "custom") {
					await callMcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agy", version: "1.5.9" } });
					const { tools } = await callMcp("tools/list");
					assert.ok(tools.some((tool) => tool.name === "lookup"));
					const tool = await callMcp("tools/call", { name: "lookup", arguments: { key: "答案" } });
					update("agent_message_chunk", tool.content[0].text);
				} else if (text === "permission") {
					const outcome = new Promise((resolve) => { permission = resolve; });
					send({ id: "permission", method: "session/request_permission", params: {
						sessionId, toolCall: { title: "Run native tool" }, options: [{ optionId: "allow", name: "Allow once" }],
					} });
					update("agent_message_chunk", (await outcome).outcome);
				} else {
					update("agent_message_chunk", `${model}: `);
					update("agent_message_chunk", text);
				}
				reply({ stopReason: "end_turn" });
				break;
			}
			case "session/cancel":
				assert.equal(params.sessionId, sessionId);
				send({ id: cancelId, result: { stopReason: "cancelled" } });
				break;
			case "logout":
				if (existsSync("signed-in")) unlinkSync("signed-in");
				reply({});
				break;
			case undefined:
				assert.equal(id, "permission");
				permission(message.result.outcome);
				break;
			default:
				throw new Error(`Unexpected ACP method ${method}`);
		}
	});
}
