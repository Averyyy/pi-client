const state = {
	config: { tokenConfigured: false, piServerUrl: "" },
	currentSessionId: "",
	currentHistory: undefined,
	streaming: false,
};

const elements = {
	serverLabel: document.querySelector("#serverLabel"),
	healthDot: document.querySelector("#healthDot"),
	serverToken: document.querySelector("#serverToken"),
	saveTokenButton: document.querySelector("#saveTokenButton"),
	manualSessionId: document.querySelector("#manualSessionId"),
	loadSessionButton: document.querySelector("#loadSessionButton"),
	refreshSessionsButton: document.querySelector("#refreshSessionsButton"),
	sessionList: document.querySelector("#sessionList"),
	sessionTitle: document.querySelector("#sessionTitle"),
	sessionMeta: document.querySelector("#sessionMeta"),
	refreshHistoryButton: document.querySelector("#refreshHistoryButton"),
	statusBar: document.querySelector("#statusBar"),
	messages: document.querySelector("#messages"),
	modelJson: document.querySelector("#modelJson"),
	providerApiKey: document.querySelector("#providerApiKey"),
	reasoning: document.querySelector("#reasoning"),
	maxTokens: document.querySelector("#maxTokens"),
	temperature: document.querySelector("#temperature"),
	providerHeaders: document.querySelector("#providerHeaders"),
	prompt: document.querySelector("#prompt"),
	sendButton: document.querySelector("#sendButton"),
};

function requiredElement(element, name) {
	if (!element) throw new Error(`Missing element ${name}`);
	return element;
}

for (const [name, element] of Object.entries(elements)) {
	requiredElement(element, name);
}

function setStatus(message, kind = "") {
	elements.statusBar.textContent = message;
	elements.statusBar.className = kind ? `status-bar ${kind}` : "status-bar";
}

function setHealth(kind) {
	elements.healthDot.className = `health-dot ${kind}`;
}

function getUiToken() {
	return localStorage.getItem("pi-webui.serverToken") || "";
}

function saveTextSetting(key, value) {
	localStorage.setItem(`pi-webui.${key}`, value);
}

function loadTextSetting(key) {
	return localStorage.getItem(`pi-webui.${key}`) || "";
}

async function piFetch(path, init = {}) {
	const headers = new Headers(init.headers || {});
	const token = getUiToken();
	if (!state.config.tokenConfigured && token) {
		headers.set("X-Pi-Server-Token", token);
	}
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	return fetch(`/pi${path}`, { ...init, headers });
}

async function readJsonResponse(response) {
	const text = await response.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(text);
	}
}

function formatTime(timestamp) {
	if (!timestamp) return "";
	return new Date(timestamp).toLocaleString();
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			if (item.type === "thinking") return `Thinking:\n${item.thinking}`;
			if (item.type === "image") return `[image ${item.mimeType}]`;
			if (item.type === "toolCall") return `Tool call: ${item.name}\n${JSON.stringify(item.arguments, null, 2)}`;
			return JSON.stringify(item, null, 2);
		})
		.join("\n\n");
}

function renderMessage(message, index) {
	const article = document.createElement("article");
	article.className = `message ${message.role}${message.stopReason === "error" ? " error" : ""}`;

	const meta = document.createElement("div");
	meta.className = "message-meta";
	const parts = [`#${index + 1}`, message.role, formatTime(message.timestamp)];
	if (message.role === "assistant") {
		parts.push(`${message.provider}/${message.model}`);
		parts.push(message.stopReason);
	}
	if (message.role === "toolResult") {
		parts.push(message.toolName);
		parts.push(message.isError ? "error" : "ok");
	}
	meta.textContent = parts.filter(Boolean).join(" | ");

	const content = document.createElement("div");
	content.className = "message-content";
	if (message.role === "assistant" && message.errorMessage) {
		content.textContent = `${contentToText(message.content)}\n\nError: ${message.errorMessage}`.trim();
	} else {
		content.textContent = contentToText(message.content);
	}

	article.append(meta, content);
	return article;
}

function renderMessages(messages) {
	elements.messages.replaceChildren(...messages.map((message, index) => renderMessage(message, index)));
	elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateSendState() {
	elements.sendButton.disabled = !state.currentSessionId || state.streaming || elements.prompt.value.trim().length === 0;
}

async function loadConfig() {
	const response = await fetch("/config");
	const config = await readJsonResponse(response);
	state.config = {
		tokenConfigured: Boolean(config.tokenConfigured),
		piServerUrl: String(config.piServerUrl || ""),
	};
	elements.serverLabel.textContent = state.config.piServerUrl;
	elements.serverToken.value = getUiToken();
	elements.serverToken.disabled = state.config.tokenConfigured;
	elements.saveTokenButton.disabled = state.config.tokenConfigured;
}

async function checkHealth() {
	try {
		const response = await piFetch("/health");
		if (!response.ok) {
			const body = await readJsonResponse(response);
			throw new Error(body.error || `${response.status} ${response.statusText}`);
		}
		setHealth("ok");
		setStatus("Connected", "ok");
	} catch (error) {
		setHealth("error");
		setStatus(error instanceof Error ? error.message : String(error), "error");
	}
}

function renderSessions(sessions) {
	if (sessions.length === 0) {
		elements.sessionList.textContent = "";
		return;
	}

	const buttons = sessions.map((session) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `session-button ${session.sessionId === state.currentSessionId ? "active" : ""}`;

		const id = document.createElement("span");
		id.className = "session-id";
		id.textContent = session.sessionId;

		const counts = document.createElement("span");
		counts.className = "session-counts";
		counts.textContent = `${session.messageCount} messages | ${session.entryCount} entries | rev ${session.revision}`;

		button.append(id, counts);
		button.addEventListener("click", () => {
			elements.manualSessionId.value = session.sessionId;
			void loadSession(session.sessionId);
		});
		return button;
	});

	elements.sessionList.replaceChildren(...buttons);
}

async function refreshSessions() {
	try {
		const response = await piFetch("/api/sessions");
		if (response.status === 404) {
			setStatus("pi-server does not expose /api/sessions. Enter a session ID.", "error");
			elements.sessionList.textContent = "";
			return;
		}
		const body = await readJsonResponse(response);
		if (!response.ok) {
			throw new Error(body.error || `${response.status} ${response.statusText}`);
		}
		if (!Array.isArray(body.sessions)) {
			throw new Error("/api/sessions response is missing sessions");
		}
		renderSessions(body.sessions);
		setStatus("Sessions loaded", "ok");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), "error");
	}
}

async function loadSession(sessionId) {
	const trimmed = sessionId.trim();
	if (!trimmed) {
		setStatus("Session ID is required", "error");
		return;
	}

	try {
		const response = await piFetch(`/api/session/${encodeURIComponent(trimmed)}/history`);
		const body = await readJsonResponse(response);
		if (!response.ok) {
			throw new Error(body.error || `${response.status} ${response.statusText}`);
		}
		if (!Array.isArray(body.messages)) {
			throw new Error("Session history response is missing messages");
		}
		state.currentSessionId = trimmed;
		state.currentHistory = body;
		elements.sessionTitle.textContent = trimmed;
		elements.sessionMeta.textContent = `${body.messageCount} messages | ${body.entryCount} entries | leaf ${body.leafId || "none"}`;
		elements.refreshHistoryButton.disabled = false;
		renderMessages(body.messages);
		updateSendState();
		await refreshSessions();
		setStatus("Session loaded", "ok");
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), "error");
	}
}

function parseModel() {
	const raw = elements.modelJson.value.trim();
	if (!raw) throw new Error("Model JSON is required");
	const parsed = JSON.parse(raw);
	const requiredStrings = ["id", "name", "api", "provider", "baseUrl"];
	for (const key of requiredStrings) {
		if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
			throw new Error(`Model JSON requires string field ${key}`);
		}
	}
	if (typeof parsed.reasoning !== "boolean") throw new Error("Model JSON requires boolean field reasoning");
	if (!Array.isArray(parsed.input)) throw new Error("Model JSON requires input array");
	if (typeof parsed.contextWindow !== "number") throw new Error("Model JSON requires numeric contextWindow");
	if (typeof parsed.maxTokens !== "number") throw new Error("Model JSON requires numeric maxTokens");
	if (typeof parsed.cost !== "object" || parsed.cost === null) throw new Error("Model JSON requires cost object");
	return parsed;
}

function parseOptions() {
	const options = {};
	const apiKey = elements.providerApiKey.value.trim();
	const reasoning = elements.reasoning.value;
	const maxTokens = elements.maxTokens.value.trim();
	const temperature = elements.temperature.value.trim();
	const headersRaw = elements.providerHeaders.value.trim();

	if (apiKey) options.apiKey = apiKey;
	if (reasoning) options.reasoning = reasoning;
	if (maxTokens) options.maxTokens = Number(maxTokens);
	if (temperature) options.temperature = Number(temperature);
	if (headersRaw) {
		const headers = JSON.parse(headersRaw);
		if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
			throw new Error("Provider headers JSON must be an object");
		}
		options.headers = headers;
	}
	if (options.maxTokens !== undefined && (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0)) {
		throw new Error("Max tokens must be positive");
	}
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
	) {
		throw new Error("Temperature must be between 0 and 2");
	}
	return options;
}

function makeAssistantMessage(model) {
	return {
		role: "assistant",
		stopReason: "stop",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		timestamp: Date.now(),
	};
}

function parseStreamingJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function applyProxyEvent(event, partial) {
	switch (event.type) {
		case "start":
			return;
		case "text_start":
			partial.content[event.contentIndex] = { type: "text", text: "" };
			return;
		case "text_delta": {
			const content = partial.content[event.contentIndex];
			if (!content || content.type !== "text") throw new Error("Received text_delta for non-text content");
			content.text += event.delta;
			return;
		}
		case "text_end": {
			const content = partial.content[event.contentIndex];
			if (!content || content.type !== "text") throw new Error("Received text_end for non-text content");
			content.textSignature = event.contentSignature;
			return;
		}
		case "thinking_start":
			partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
			return;
		case "thinking_delta": {
			const content = partial.content[event.contentIndex];
			if (!content || content.type !== "thinking") throw new Error("Received thinking_delta for non-thinking content");
			content.thinking += event.delta;
			return;
		}
		case "thinking_end": {
			const content = partial.content[event.contentIndex];
			if (!content || content.type !== "thinking") throw new Error("Received thinking_end for non-thinking content");
			content.thinkingSignature = event.contentSignature;
			return;
		}
		case "toolcall_start":
			partial.content[event.contentIndex] = {
				type: "toolCall",
				id: event.id,
				name: event.toolName,
				arguments: {},
				partialJson: "",
			};
			return;
		case "toolcall_delta": {
			const content = partial.content[event.contentIndex];
			if (!content || content.type !== "toolCall") throw new Error("Received toolcall_delta for non-toolCall content");
			content.partialJson += event.delta;
			content.arguments = parseStreamingJson(content.partialJson);
			return;
		}
		case "toolcall_end": {
			const content = partial.content[event.contentIndex];
			if (content && content.type === "toolCall") delete content.partialJson;
			return;
		}
		case "done":
			partial.stopReason = event.reason;
			partial.usage = event.usage;
			return;
		case "error":
			partial.stopReason = event.reason;
			partial.errorMessage = event.errorMessage;
			partial.usage = event.usage;
			return;
		default:
			throw new Error(`Unhandled stream event ${event.type}`);
	}
}

async function appendMessages(messages) {
	const response = await piFetch("/api/session/append", {
		method: "POST",
		body: JSON.stringify({
			sessionId: state.currentSessionId,
			messages,
		}),
	});
	const body = await readJsonResponse(response);
	if (!response.ok) {
		throw new Error(body.error || `${response.status} ${response.statusText}`);
	}
}

async function streamAssistant(model, options) {
	const partial = makeAssistantMessage(model);
	const response = await piFetch("/api/stream", {
		method: "POST",
		headers: { Accept: "text/event-stream" },
		body: JSON.stringify({
			sessionId: state.currentSessionId,
			model,
			options,
		}),
	});

	if (!response.ok) {
		const body = await readJsonResponse(response);
		throw new Error(body.error || `${response.status} ${response.statusText}`);
	}
	if (!response.body) throw new Error("Stream response body is missing");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let terminalEvent = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const data = line.slice(6).trim();
			if (!data) continue;
			const event = JSON.parse(data);
			applyProxyEvent(event, partial);
			renderMessages([...(state.currentHistory?.messages || []), partial]);
			if (event.type === "done" || event.type === "error") {
				terminalEvent = true;
			}
		}
	}

	if (!terminalEvent) {
		partial.stopReason = "error";
		partial.errorMessage = "Stream ended without done or error event";
	}
	await appendMessages([partial]);
	return partial;
}

async function sendMessage() {
	if (!state.currentSessionId || state.streaming) return;
	const prompt = elements.prompt.value.trim();
	if (!prompt) return;

	try {
		const model = parseModel();
		const options = parseOptions();
		state.streaming = true;
		updateSendState();
		setStatus("Sending");

		const userMessage = { role: "user", content: prompt, timestamp: Date.now() };
		await appendMessages([userMessage]);
		state.currentHistory = {
			...(state.currentHistory || {}),
			messages: [...(state.currentHistory?.messages || []), userMessage],
		};
		renderMessages(state.currentHistory.messages);
		elements.prompt.value = "";

		const assistant = await streamAssistant(model, options);
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			setStatus(assistant.errorMessage || assistant.stopReason, "error");
		} else {
			setStatus("Response appended", "ok");
		}
		await loadSession(state.currentSessionId);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), "error");
	} finally {
		state.streaming = false;
		updateSendState();
	}
}

function loadSavedSettings() {
	elements.modelJson.value = loadTextSetting("modelJson");
	elements.providerApiKey.value = loadTextSetting("providerApiKey");
	elements.providerHeaders.value = loadTextSetting("providerHeaders");
	elements.reasoning.value = loadTextSetting("reasoning");
	elements.maxTokens.value = loadTextSetting("maxTokens");
	elements.temperature.value = loadTextSetting("temperature");
}

function bindEvents() {
	elements.saveTokenButton.addEventListener("click", () => {
		localStorage.setItem("pi-webui.serverToken", elements.serverToken.value);
		void checkHealth();
	});
	elements.refreshSessionsButton.addEventListener("click", () => {
		void refreshSessions();
	});
	elements.loadSessionButton.addEventListener("click", () => {
		void loadSession(elements.manualSessionId.value);
	});
	elements.refreshHistoryButton.addEventListener("click", () => {
		void loadSession(state.currentSessionId);
	});
	elements.sendButton.addEventListener("click", () => {
		void sendMessage();
	});
	elements.prompt.addEventListener("input", updateSendState);
	elements.prompt.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void sendMessage();
		}
	});

	for (const [key, element] of [
		["modelJson", elements.modelJson],
		["providerApiKey", elements.providerApiKey],
		["providerHeaders", elements.providerHeaders],
		["reasoning", elements.reasoning],
		["maxTokens", elements.maxTokens],
		["temperature", elements.temperature],
	]) {
		element.addEventListener("input", () => saveTextSetting(key, element.value));
	}
}

async function main() {
	loadSavedSettings();
	bindEvents();
	await loadConfig();
	await checkHealth();
	await refreshSessions();
	updateSendState();
}

void main();
