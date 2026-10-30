/*
 * Billing and prompt shaping adapted from https://github.com/gotgenes/pi-anthropic-auth.
 * MIT License
 * Copyright (c) 2026 Christopher D. Lasher
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash } from "node:crypto";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";

const PI_PREAMBLE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const SUBSCRIPTION_PREAMBLE = [
	"You are an expert coding assistant.",
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");
const BILLING_MARKER = "x-anthropic-billing-header:";
const SECTION_PATTERN = /(^|\n\n)<([a-z][a-z0-9_-]*)>\n([\s\S]*?)\n<\/\2>(?=\n\n|$)/g;
const UPDATE_PATTERN =
	/^(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.$)/gm;

interface ContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface PayloadMessage {
	role: string;
	content: string | ContentBlock[];
	output_config?: unknown;
	[key: string]: unknown;
}

interface MessagesPayload {
	messages: PayloadMessage[];
	system?: string | ContentBlock[];
	[key: string]: unknown;
}

function shapeSection(name: string, text: string): string | undefined {
	if (name === "preamble") return text === PI_PREAMBLE ? SUBSCRIPTION_PREAMBLE : text;
	if (
		name === "docs" &&
		text.startsWith(
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n",
		)
	) {
		return undefined;
	}
	if (name === "tools") {
		text = text.replace(
			/(^|\n\n)In addition to the tools above, you may have access to other custom tools depending on the project\.(?=\n\n|$)/g,
			"",
		);
	}
	return text;
}

function shapeSystemPrompt(text: string): string {
	const sections = [...text.matchAll(SECTION_PATTERN)];
	if (
		sections.length === 0 ||
		text.slice(0, sections[0].index) !== PI_PREAMBLE ||
		!sections.some((section) => ["tools", "rules", "docs"].includes(section[2]))
	) {
		return text;
	}
	const parts: string[] = [];
	let position = 0;
	for (const section of sections) {
		const before = text.slice(position, section.index);
		parts.push(position === 0 ? SUBSCRIPTION_PREAMBLE : before);
		const body = shapeSection(section[2], section[3]);
		if (body !== undefined) parts.push(`${section[1]}<${section[2]}>\n${body}\n</${section[2]}>`);
		position = section.index + section[0].length;
	}
	if (position < text.length) parts.push(text.slice(position));
	return parts.join("");
}

function shapeSystemUpdate(text: string): string | undefined {
	const updates = [...text.matchAll(UPDATE_PATTERN)];
	if (updates.length === 0) return text;
	const parts: string[] = [text.slice(0, updates[0].index)];
	for (const [index, update] of updates.entries()) {
		const part = text.slice(update.index, updates[index + 1]?.index ?? text.length);
		if (update[2] !== undefined) {
			parts.push(part);
			continue;
		}
		const name = update[1];
		const rawValue = part.slice(update[0].length);
		const value = rawValue.trimEnd();
		const section = [...value.matchAll(SECTION_PATTERN)];
		const tagged = section.length === 1 && section[0][2] === name && section[0][0] === value;
		const body = shapeSection(name, tagged ? section[0][3] : value);
		if (body !== undefined) {
			parts.push(`${update[0]}${tagged ? `<${name}>\n${body}\n</${name}>` : body}${rawValue.slice(value.length)}`);
		}
	}
	return parts.join("") || undefined;
}

function shapePayload(payload: MessagesPayload, version: string): MessagesPayload {
	const messages = payload.messages.flatMap((message) => {
		if (message.role !== "system") return [message];
		if (typeof message.content === "string") {
			const content = shapeSystemUpdate(message.content);
			return content !== undefined || message.output_config !== undefined
				? [{ ...message, content: content ?? [] }]
				: [];
		}
		const content = message.content.flatMap((block) => {
			if (block.type !== "text" || block.text === undefined) return [block];
			const text = shapeSystemUpdate(block.text);
			return text === undefined ? [] : [{ ...block, text }];
		});
		return content.length > 0 || message.output_config !== undefined ? [{ ...message, content }] : [];
	});
	const system = (
		typeof payload.system === "string" ? [{ type: "text", text: payload.system }] : (payload.system ?? [])
	)
		.filter((block) => block.type !== "text" || !block.text?.startsWith(BILLING_MARKER))
		.map((block) =>
			block.type === "text" && block.text !== undefined ? { ...block, text: shapeSystemPrompt(block.text) } : block,
		);
	const user = messages.find((message) => message.role === "user");
	const firstUserText =
		typeof user?.content === "string"
			? user.content
			: user?.content.find((block) => block.type === "text" && block.text !== undefined)?.text;
	if (!firstUserText) throw new Error("Anthropic subscription request requires text in first user message");
	const cch = createHash("sha256").update(firstUserText).digest("hex").slice(0, 5);
	const sampledCharacters = [4, 7, 20].map((index) => firstUserText[index] || "0").join("");
	const suffix = createHash("sha256").update(`59cf53e54c78${sampledCharacters}${version}`).digest("hex").slice(0, 3);
	system.unshift({
		type: "text",
		text: `${BILLING_MARKER} cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`,
	});
	return { ...payload, system, messages };
}

/** Apply subscription shaping after native auth and caller payload callbacks. */
export function withAnthropicSubscription<T extends StreamOptions>(model: Model<string>, options: T): T {
	if (
		model.provider !== "anthropic" ||
		model.api !== "anthropic-messages" ||
		!options.apiKey?.startsWith("sk-ant-oat")
	) {
		return options;
	}
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		...options,
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (init?.method !== "POST" || !url.pathname.endsWith("/v1/messages")) return fetch(input, init);
			let body: string;
			try {
				const userAgent = new Headers(init.headers).get("user-agent");
				const version = /^claude-cli\/(\d+\.\d+\.\d+)$/.exec(userAgent ?? "")?.[1];
				if (!version) throw new Error("Anthropic subscription requires a claude-cli/X.Y.Z User-Agent");
				if (typeof init.body !== "string")
					throw new Error("Anthropic messages request requires a JSON string body");
				const payload = JSON.parse(init.body) as MessagesPayload;
				body = JSON.stringify(shapePayload(payload, version));
			} catch (error) {
				// The SDK wraps thrown fetch errors as connection failures.
				return Response.json(
					{
						type: "error",
						error: {
							type: "invalid_request_error",
							message: `pi-server Anthropic subscription: ${error instanceof Error ? error.message : String(error)}`,
						},
					},
					{ status: 400 },
				);
			}
			return fetch(input, { ...init, body });
		},
	};
}
