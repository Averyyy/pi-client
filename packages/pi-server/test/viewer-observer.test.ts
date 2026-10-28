import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { PiServerObserver } from "../../coding-agent/src/core/pi-server-observer.ts";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { createPiServer } from "../src/server.ts";
import { clearAllSessions, getOrCreateSession } from "../src/session-store.ts";
import { ViewerStore } from "../src/viewer-store.ts";
import type { ViewerRound, ViewerThread } from "../src/viewer-types.ts";

it("publishes a client tool run through the real observer transport and server viewer", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-viewer-observer-"));
	const server = createPiServer({ authToken: "integration-token", sessionStoreDir: directory }, createModels());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	const base = `http://127.0.0.1:${address.port}`;
	let finishTool: () => void = () => {};
	const toolGate = new Promise<void>((resolve) => {
		finishTool = resolve;
	});
	const tool: AgentTool = {
		name: "inspect",
		label: "Inspect",
		description: "Inspect project state",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, _arguments, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "Inspection started" }], details: {} });
			await toolGate;
			return { content: [{ type: "text", text: "Inspection complete" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [tool] });
	const original = getOrCreateSession(harness.session.sessionId);
	vi.stubEnv("PI_SERVER_URL", base);
	vi.stubEnv("PI_SERVER_AUTH_TOKEN", "integration-token");
	const observer = new PiServerObserver(harness.session);
	let run: Promise<void> | undefined;
	try {
		const login = await fetch(`${base}/viewer/login`, {
			method: "POST",
			headers: { Authorization: "Bearer integration-token", Origin: base },
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("Missing viewer cookie");
		const threadUrl = `${base}/viewer/api/threads/${encodeURIComponent(harness.session.sessionId)}`;
		async function thread(): Promise<ViewerThread> {
			const response = await fetch(threadUrl, { headers: { Cookie: cookie! } });
			expect(response.status).toBe(200);
			return ((await response.json()) as { thread: ViewerThread }).thread;
		}
		await vi.waitFor(async () => expect((await thread()).status).toBe("idle"));
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "thinking", thinking: "Check the project" }, fauxToolCall("inspect", { path: "src" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([{ type: "text", text: "The project is ready." }]),
		]);
		run = harness.session.prompt("Inspect the project.");
		await vi.waitFor(async () => {
			const current = await thread();
			expect(current.status).toBe("running");
			expect(current.live.tools[0]).toMatchObject({
				name: "inspect",
				status: "running",
				arguments: { path: "src" },
				result: { content: [{ type: "text", text: "Inspection started" }] },
			});
		});
		finishTool();
		await run;
		await vi.waitFor(async () => expect((await thread()).status).toBe("idle"));
		const response = await fetch(`${threadUrl}/rounds`, { headers: { Cookie: cookie } });
		const history = (await response.json()) as { rounds: ViewerRound[] };
		expect(history.rounds).toHaveLength(1);
		expect(history.rounds[0].messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(history.rounds[0].messages.at(-1)?.content).toEqual([{ type: "text", text: "The project is ready." }]);
		expect(original.entries).toEqual([]);
		expect(original.revision).toBe(0);
		observer.dispose();
		await vi.waitFor(async () => expect((await thread()).status).toBe("disconnected"));
		const restored = new ViewerStore(directory);
		expect(await restored.rounds(harness.session.sessionId, null)).toEqual(history);
	} finally {
		finishTool();
		await run;
		observer.dispose();
		harness.cleanup();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		clearAllSessions();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true });
	}
});
