import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { withAnthropicSubscription } from "../src/anthropic-subscription.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Haiku fixture",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 1024,
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const piPreamble =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const nativePrompt = `${piPreamble}\n\n<tools>\nRead files with read.\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nKeep commands precise.\n</tools>\n\n<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\nlocal docs\n</docs>\n\n<project_context>\nKeep pi project values verbatim.\n</project_context>\n\n<custom>\nHere is some useful information about the environment you are running in:\n</custom>`;

async function capture(payload: Record<string, unknown>, version = "2.1.280") {
	let body: Record<string, unknown> | undefined;
	const transport = vi.fn<typeof fetch>(async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response("{}");
	});
	const options = withAnthropicSubscription(model, { apiKey: "sk-ant-oat01-fixture", fetch: transport });
	await options.fetch("https://api.anthropic.com/v1/messages?beta=true", {
		method: "POST",
		headers: { "user-agent": `claude-cli/${version}` },
		body: JSON.stringify(payload),
	});
	return { body, transport };
}

describe("Anthropic subscription shaping", () => {
	it("uses the version and the first user text in the billing fingerprint", async () => {
		const { body } = await capture({ system: [], messages: [{ role: "user", content: "Reply with the word ok." }] });
		expect(body?.system).toEqual([
			{
				type: "text",
				text: "x-anthropic-billing-header: cc_version=2.1.280.9d3; cc_entrypoint=sdk-cli; cch=d4940;",
			},
		]);
	});

	it("replaces native Pi framing while retaining project and custom instructions", async () => {
		const { body } = await capture({
			system: [{ type: "text", text: nativePrompt, cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: "hello" }],
		});
		const system = body?.system as Array<{ text: string; cache_control?: unknown }>;
		expect(system[1].text).toBe(
			"You are an expert coding assistant.\nBe concise and helpful.\nUse the available tools to answer the user's request.\nShow file paths clearly when working with files.\n\n<tools>\nRead files with read.\n\nKeep commands precise.\n</tools>\n\n<project_context>\nKeep pi project values verbatim.\n</project_context>\n\n<custom>\nHere is some useful information about the environment you are running in:\n</custom>",
		);
		expect(system[1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("retains custom preambles and extension messages with Pi-related prose", async () => {
		const custom = `${piPreamble} Additional custom policy.\n\n<rules>\nKeep this policy.\n</rules>`;
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "system", content: [{ type: "text", text: "Extension: Pi documentation must stay." }] },
		];
		const { body } = await capture({ system: [{ type: "text", text: custom }], messages });
		expect(body?.messages).toEqual(messages);
		expect((body?.system as Array<{ text: string }>)[1].text).toBe(custom);
	});

	it("retains quoted documentation and extended tool instructions", async () => {
		const text = `${piPreamble}\n\n<tools>\nIn addition to the tools above, you may have access to other custom tools depending on the project. Always keep the audit tool enabled.\n</tools>\n\n<docs>\nProject documentation quote:\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\nKeep this project note.\n</docs>`;
		const { body } = await capture({
			system: [{ type: "text", text }],
			messages: [{ role: "user", content: "hello" }],
		});
		const shaped = (body?.system as Array<{ text: string }>)[1].text;
		expect(shaped.slice(shaped.indexOf("<tools>"))).toBe(text.slice(text.indexOf("<tools>")));
	});

	it("retains a custom prompt containing native section content", async () => {
		const text = nativePrompt.replace(piPreamble, "Custom project assistant.");
		const { body } = await capture({
			system: [{ type: "text", text }],
			messages: [{ role: "user", content: "hello" }],
		});
		expect((body?.system as Array<{ text: string }>)[1].text).toBe(text);
	});

	it("removes native docs updates while retaining effort and signed assistant/tool content", async () => {
		const signed = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", signature: "signed" },
				{ type: "tool_use", id: "call_1", name: "read", input: { path: "pi.txt" } },
			],
		};
		const tool = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call_1", content: "Pi documentation output" }],
		};
		const { body } = await capture({
			system: [],
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "system",
					content: [
						{
							type: "text",
							text: 'Updated system prompt section "docs":\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\nupdated',
						},
					],
				},
				{ role: "system", content: [], output_config: { effort: "low" } },
				signed,
				tool,
			],
		});
		expect(body?.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "system", content: [], output_config: { effort: "low" } },
			signed,
			tool,
		]);
	});

	it("retains project-context update content verbatim", async () => {
		const update =
			'Extension prefix  \nUpdated system prompt section "project_context":\n\n<project_context>\nPolicy with trailing spaces  \n</project_context>  \n\n';
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "system", content: [{ type: "text", text: update }] },
		];
		const { body } = await capture({ system: [], messages });
		expect(body?.messages).toEqual(messages);
	});

	it("retains removal notices for custom docs", async () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "system", content: 'Removed system prompt section "docs".\n\n' },
		];
		const { body } = await capture({ system: [], messages });
		expect(body?.messages).toEqual(messages);
	});

	it("rejects an unknown CLI version before sending", async () => {
		const transport = vi.fn<typeof fetch>();
		const options = withAnthropicSubscription(model, { apiKey: "sk-ant-oat01-fixture", fetch: transport });
		const response = await options.fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "user-agent": "unknown-client" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: expect.stringContaining("requires a claude-cli/X.Y.Z User-Agent"),
			},
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		{ provider: "custom", api: "anthropic-messages", key: "sk-ant-oat01-fixture" },
		{ provider: "anthropic", api: "custom-api", key: "sk-ant-oat01-fixture" },
		{ provider: "anthropic", api: "anthropic-messages", key: "sk-ant-api03-fixture" },
	])("keeps unrelated auth/provider route $provider/$api unchanged", ({ provider, api, key }) => {
		const options: StreamOptions = { apiKey: key, fetch: vi.fn<typeof fetch>() };
		expect(withAnthropicSubscription({ ...model, provider, api, compat: undefined }, options)).toBe(options);
	});

	it.each([[], [{ type: "image", source: { type: "base64", data: "fixture" } }], ""])(
		"rejects a textless first user before sending",
		async (content) => {
			const transport = vi.fn<typeof fetch>();
			const options = withAnthropicSubscription(model, { apiKey: "sk-ant-oat01-fixture", fetch: transport });
			const response = await options.fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "user-agent": "claude-cli/2.1.280" },
				body: JSON.stringify({
					messages: [
						{ role: "user", content },
						{ role: "user", content: "later text" },
					],
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: expect.stringContaining("requires text in first user message"),
				},
			});
			expect(transport).not.toHaveBeenCalled();
		},
	);

	it("retains an upstream network rejection", async () => {
		const error = new TypeError("fixture network failure");
		const transport = vi.fn<typeof fetch>().mockRejectedValue(error);
		const options = withAnthropicSubscription(model, { apiKey: "sk-ant-oat01-fixture", fetch: transport });
		await expect(
			options.fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "user-agent": "claude-cli/2.1.280" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
			}),
		).rejects.toBe(error);
	});
});
