const assert = require("node:assert/strict");
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

const lines = createInterface({ input: process.stdin });
assert.ok(!process.argv.includes("--login"));
// Every agy process of a test shares one trace and sign-in state, whatever its working directory.
const dir = process.env.PI_ACP_FIXTURE_DIR ?? process.cwd();
startAcp();

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
	let elicitation;
	let supportsForm;
	let clientCapabilities;
	let sessionCwd;
	let nextClientRequest = 0;
	const clientRequests = new Map();
	const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
	const trace = (message) => appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(message)}\n`);
	const clientRequest = (method, params) =>
		new Promise((resolve) => {
			const id = `client-${++nextClientRequest}`;
			clientRequests.set(id, resolve);
			send({ id, method, params: { sessionId, ...params } });
		});
	const update = (sessionUpdate, text) =>
		send({ method: "session/update", params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } } });
	const updateNative = (update) => send({ method: "session/update", params: { sessionId, update } });
	const configs = () => [
		{ id: "model", type: "select", currentValue: model, options: models },
		...(model === "gemini-test" ? [{
			id: "effort", category: "thought_level", type: "select", currentValue: effort,
			options: ["off", "medium", "high"].map((value) => ({ value, name: value })),
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
				assert.equal(params.protocolVersion, 1);
				clientCapabilities = params.clientCapabilities;
				supportsForm = clientCapabilities.elicitation?.form;
				reply({
					protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.5.17" },
					agentCapabilities: { auth: { logout: {} }, loadSession: true, mcpCapabilities: { http: true },
						promptCapabilities: { image: true }, _meta: { antigravity: { systemPrompt: { append: true } } } },
				});
				break;
			case "session/new":
				if (!existsSync(join(dir, "signed-in"))) {
					send({ id, error: { code: -32000, message: "Authentication required" } });
					break;
				}
				[mcp] = params.mcpServers;
				// Pi launches agy the way editors do, `agy acp` and nothing else. The test runs `node acp`,
				// where Node takes `acp` as this script, so any further argument would be an extra flag.
				assert.deepEqual(process.argv.slice(2), []);
				sessionCwd = params.cwd;
				writeFileSync(join(dir, `session-${sessionId}`), "");
				reply({ sessionId, configOptions: configs() });
				break;
			case "session/load":
				if (params.sessionId !== sessionId || !existsSync(join(dir, `session-${sessionId}`))) {
					send({ id, error: { code: -32002, message: "Session not found" } });
					break;
				}
				[mcp] = params.mcpServers;
				sessionCwd = params.cwd;
				send({ method: "session/update", params: { sessionId, update: {
					sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed" } } } });
				reply({ configOptions: configs(), modes: null });
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
				if (text === "custom" || text === "custom-error" || text === "custom-cancel" || text === "interactions") {
					await callMcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agy", version: "1.5.9" } });
					const { tools } = await callMcp("tools/list");
					assert.ok(tools.some((tool) => tool.name === "lookup"));
					assert.ok(tools.every(({ name }) => name !== "todo" && name !== "ask_user_question"));
					const tool = await callMcp("tools/call", { name: "lookup", arguments: { key: text === "custom-error" ? "fail" : "答案" } });
					if (text === "custom-error") {
						assert.equal(tool.isError, true);
						send({ id, error: { code: -32603, message: "Antigravity prompt failed" } });
						break;
					}
					if (text === "custom-cancel") {
						cancelId = id;
						break;
					}
					if (text === "interactions") {
						assert.ok(supportsForm);
						updateNative({ sessionUpdate: "plan", entries: [{ content: "Review choices", priority: "high", status: "in_progress" }] });
						updateNative({ sessionUpdate: "tool_call", toolCallId: "native-1", name: "read_file", title: "Read a file", status: "in_progress" });
						updateNative({ sessionUpdate: "tool_call_update", toolCallId: "native-1",
							content: [{ type: "content", content: { type: "text", text: "first chunk" } }] });
						updateNative({ sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "completed", rawOutput: { lines: 2 } });
						const answer = new Promise((resolve) => { elicitation = resolve; });
						send({ id: "elicitation", method: "elicitation/create", params: {
							sessionId, mode: "form", message: "Pick a strategy", requestedSchema: {
								type: "object", properties: {
									choice: { type: "string", oneOf: [{ const: "balanced", title: "Balanced" }, { const: "fast", title: "Fast" }] },
									features: { type: "array", items: { enum: ["Audit", "Metrics"] }, minItems: 1 },
									note: { type: "string" },
								}, required: ["choice", "features"],
							},
						} });
						update("agent_message_chunk", JSON.stringify(await answer));
						updateNative({ sessionUpdate: "plan", entries: [] });
						updateNative({ sessionUpdate: "plan_update", plan: { type: "items", planId: "steps",
							entries: [{ content: "Review choices", priority: "high", status: "completed" }] } });
					} else {
						update("agent_message_chunk", tool.content[0].text);
					}
				} else if (text === "native-choice") {
					const toolCallId = "named-question";
					updateNative({ sessionUpdate: "tool_call", toolCallId, name: "ask_question", title: "Pick the scope" });
					const outcome = new Promise((resolve) => { permission = resolve; });
					send({ id: "permission", method: "session/request_permission", params: {
						sessionId, toolCall: { toolCallId, title: "Pick the scope" },
						options: [{ optionId: "repo", name: "Repo" }, { optionId: "file", name: "File" }],
					} });
					update("agent_message_chunk", (await outcome).optionId);
				} else if (text === "compact") {
					assert.ok(clientCapabilities.session?.compaction);
					updateNative({ sessionUpdate: "compaction_update", compactionId: "compaction-1", status: "in_progress" });
					updateNative({ sessionUpdate: "compaction_summary_chunk", compactionId: "compaction-1",
						content: { type: "text", text: "agy summary" } });
					updateNative({ sessionUpdate: "compaction_update", compactionId: "compaction-1", status: "completed" });
					update("agent_message_chunk", "compacted");
				} else if (text === "parallel") {
					await callMcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agy", version: "1.5.17" } });
					const [first, second] = await Promise.all(
						["first", "second"].map((key) => callMcp("tools/call", { name: "lookup", arguments: { key } })),
					);
					update("agent_message_chunk", `${first.content[0].text}+${second.content[0].text}`);
				} else if (text === "workspace") {
					assert.ok(clientCapabilities.fs.readTextFile && clientCapabilities.fs.writeTextFile && clientCapabilities.terminal);
					const read = await clientRequest("fs/read_text_file", { path: `${sessionCwd}/notes.txt`, line: 2, limit: 1 });
					await clientRequest("fs/write_text_file", { path: `${sessionCwd}/out/result.txt`, content: "written" });
					const { terminalId } = await clientRequest("terminal/create", {
						command: process.execPath, args: ["-e", "process.stdout.write('terminal ok')"], outputByteLimit: 8,
					});
					const exit = await clientRequest("terminal/wait_for_exit", { terminalId });
					const output = await clientRequest("terminal/output", { terminalId });
					await clientRequest("terminal/release", { terminalId });
					update("agent_message_chunk", JSON.stringify({ read: read.content, exit, output }));
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
				if (existsSync(join(dir, "signed-in"))) unlinkSync(join(dir, "signed-in"));
				reply({});
				break;
			case undefined:
				if (clientRequests.has(id)) {
					clientRequests.get(id)(message.result ?? { error: message.error });
					clientRequests.delete(id);
				} else if (id === "elicitation") elicitation(message.result ?? message.error);
				else {
					assert.equal(id, "permission");
					permission(message.result.outcome);
				}
				break;
			default:
				throw new Error(`Unexpected ACP method ${method}`);
		}
	});
}
