import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

class FakeElement {
	constructor(tagName = "div") {
		this.tagName = tagName;
		this.children = [];
		this.listeners = new Map();
		this.value = "";
		this.textContent = "";
		this.className = "";
		this.disabled = false;
		this.scrollTop = 0;
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type, event = {}) {
		const listeners = this.listeners.get(type) ?? [];
		for (const listener of listeners) listener({ target: this, preventDefault() {}, ...event });
	}

	append(...children) {
		this.children.push(...children);
	}

	replaceChildren(...children) {
		this.children = children;
	}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function response(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		text: async () => JSON.stringify(body),
	};
}

function streamResponse(events) {
	const chunks = events.map((event) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
	let index = 0;
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		body: {
			getReader() {
				return {
					read: async () =>
						index < chunks.length
							? { done: false, value: chunks[index++] }
							: { done: true, value: undefined },
				};
			},
		},
	};
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function messageTexts(element) {
	return element.children.map((article) => article.children.at(-1)?.textContent ?? "");
}

function createHarness() {
	const elementIds = [
		"serverLabel",
		"healthDot",
		"serverToken",
		"saveTokenButton",
		"manualSessionId",
		"loadSessionButton",
		"refreshSessionsButton",
		"sessionList",
		"sessionTitle",
		"sessionMeta",
		"refreshHistoryButton",
		"statusBar",
		"messages",
		"modelJson",
		"providerApiKey",
		"reasoning",
		"maxTokens",
		"temperature",
		"providerHeaders",
		"prompt",
		"sendButton",
	];
	const elements = Object.fromEntries(elementIds.map((id) => [id, new FakeElement()]));
	const storage = new Map();
	const appendGate = deferred();
	const streamGate = deferred();
	const bHistoryGate = deferred();
	const cHistoryGate = deferred();
	let bHistoryStarted;
	let cHistoryStarted;
	const bHistoryReady = new Promise((resolve) => {
		bHistoryStarted = resolve;
	});
	const cHistoryReady = new Promise((resolve) => {
		cHistoryStarted = resolve;
	});
	let appendStarted;
	const appendReady = new Promise((resolve) => {
		appendStarted = resolve;
	});
	let streamStarted;
	const streamReady = new Promise((resolve) => {
		streamStarted = resolve;
	});
	let failC = false;
	const sessions = {
		"review-A": {
			sessionId: "review-A",
			messages: [{ role: "user", content: "INITIAL_A", timestamp: 1000 }],
			leafId: "leaf-A",
			revision: 1,
		},
		"review-B": {
			sessionId: "review-B",
			messages: [{ role: "user", content: "INITIAL_B", timestamp: 1000 }],
			leafId: "leaf-B",
			revision: 1,
		},
	};
	const appendRequests = [];
	const streamRequests = [];
	const authoritativeUsage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function sessionSummary(session) {
		return {
			sessionId: session.sessionId,
			messageCount: session.messages.length,
			entryCount: session.messages.length,
			leafId: session.leafId,
			revision: session.revision,
			createdAt: 1000,
			updatedAt: 1000,
		};
	}

	async function fakeFetch(url, init = {}) {
		if (url === "/config") return response({ tokenConfigured: false, piServerUrl: "http://fake" });
		const path = url.replace("/pi", "");
		if (path === "/health") return response({ status: "ok" });
		if (path === "/api/sessions") {
			return response({ sessions: Object.values(sessions).map(sessionSummary) });
		}
		const historyMatch = /^\/api\/session\/([^/]+)\/history$/.exec(path);
		if (historyMatch) {
			const sessionId = decodeURIComponent(historyMatch[1]);
			if (sessionId === "review-B") {
				bHistoryStarted();
				await bHistoryGate.promise;
			}
			if (sessionId === "review-C") {
				cHistoryStarted();
				await cHistoryGate.promise;
				if (failC) return response({ error: "session not found" }, 404);
			}
			const session = sessions[sessionId];
			if (!session) return response({ error: "session not found" }, 404);
			return response({
				...sessionSummary(session),
				staticContext: { systemPrompt: sessionId },
				entries: [],
				messages: [...session.messages],
			});
		}
		if (path === "/api/session/append") {
			const body = JSON.parse(init.body);
			appendRequests.push(body);
			appendStarted();
			if (appendRequests.length === 1) await appendGate.promise;
			const session = sessions[body.sessionId];
			if (!session) return response({ error: "session not found" }, 404);
			session.messages.push(...body.messages);
			session.revision += body.messages.length;
			return response(sessionSummary(session));
		}
		if (path === "/api/stream") {
			const body = JSON.parse(init.body);
			streamRequests.push(body);
			streamStarted();
			await streamGate.promise;
			return streamResponse([
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "ANSWER_FOR_A_ONLY" },
				{ type: "text_end", contentIndex: 0 },
				{ type: "done", reason: "stop", usage: authoritativeUsage },
			]);
		}
		throw new Error(`Unexpected fetch ${url}`);
	}

	const document = {
		querySelector(selector) {
			if (!selector.startsWith("#")) return undefined;
			return elements[selector.slice(1)];
		},
		createElement(tagName) {
			return new FakeElement(tagName);
		},
	};
	const context = vm.createContext({
		console,
		document,
		fetch: fakeFetch,
		Headers,
		TextDecoder,
		TextEncoder,
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, String(value)),
		},
		setTimeout,
		clearTimeout,
		Date,
	});
	vm.runInContext(appSource, context, { filename: "packages/pi-webui/public/app.js" });

	function sessionButton(sessionId) {
		return elements.sessionList.children.find((button) => button.children[0]?.textContent === sessionId);
	}

	async function load(sessionId) {
		elements.manualSessionId.value = sessionId;
		elements.loadSessionButton.dispatch("click");
		await waitFor(() => elements.statusBar.textContent === "Session loaded", `session ${sessionId} did not load`);
	}

	return {
		elements,
		sessions,
		appendGate,
		appendReady,
		streamGate,
		streamReady,
		bHistoryGate,
		bHistoryReady,
		cHistoryGate,
		cHistoryReady,
		setFailC(value) {
			failC = value;
		},
		appendRequests,
		streamRequests,
		sessionButton,
		load,
		waitFor,
	};
}

const modelJson = JSON.stringify({
	id: "faux-1",
	name: "Faux",
	api: "faux",
	provider: "faux",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

describe("pi-webui session ownership", () => {
	it("keeps a gated A send on A while B is loading, and blocks keyboard sends until B is loaded", async () => {
		const harness = createHarness();
		await harness.waitFor(() => harness.sessionButton("review-A") !== undefined, "sessions did not load");
		await harness.load("review-A");

		harness.elements.modelJson.value = modelJson;
		harness.elements.prompt.value = "Please answer for review-A only";
		harness.elements.prompt.dispatch("input");
		harness.elements.sendButton.dispatch("click");
		await harness.appendReady;

		harness.elements.manualSessionId.value = "review-B";
		harness.elements.loadSessionButton.dispatch("click");
		await harness.bHistoryReady;

		harness.appendGate.resolve();
		await harness.streamReady;
		harness.streamGate.resolve();
		await harness.waitFor(() => harness.sessions["review-A"].messages.length === 3, "A send did not finish");

		harness.elements.prompt.value = "must wait for B";
		harness.elements.prompt.dispatch("input");
		harness.elements.prompt.dispatch("keydown", { key: "Enter", ctrlKey: true });
		expect(harness.elements.sendButton.disabled).toBe(true);
		expect(harness.appendRequests).toHaveLength(2);
		expect(harness.streamRequests).toHaveLength(1);

		harness.bHistoryGate.resolve();
		await harness.load("review-B");
		expect(harness.elements.sessionTitle.textContent).toBe("review-B");
		expect(messageTexts(harness.elements.messages)).toEqual(["INITIAL_B"]);
		expect(harness.elements.sendButton.disabled).toBe(false);
		expect(harness.appendRequests.every((request) => request.sessionId === "review-A")).toBe(true);
		expect(harness.streamRequests[0].sessionId).toBe("review-A");
		expect(harness.sessions["review-B"].messages).toEqual([
			{ role: "user", content: "INITIAL_B", timestamp: 1000 },
		]);
		expect(harness.sessions["review-B"].leafId).toBe("leaf-B");
		expect(harness.sessions["review-B"].revision).toBe(1);

		harness.elements.manualSessionId.value = "review-C";
		harness.elements.loadSessionButton.dispatch("click");
		await harness.cHistoryReady;
		harness.elements.prompt.value = "still B";
		harness.elements.prompt.dispatch("input");
		harness.elements.prompt.dispatch("keydown", { key: "Enter", ctrlKey: true });
		expect(harness.elements.sendButton.disabled).toBe(true);
		expect(harness.appendRequests).toHaveLength(2);

		harness.setFailC(true);
		harness.cHistoryGate.resolve();
		await harness.waitFor(() => harness.elements.statusBar.textContent === "session not found", "failed C load did not settle");
		expect(harness.elements.sessionTitle.textContent).toBe("review-B");
		expect(messageTexts(harness.elements.messages)).toEqual(["INITIAL_B"]);
		expect(harness.elements.sendButton.disabled).toBe(false);
	});
});
