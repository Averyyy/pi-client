/*
MIT License

Copyright (c) 2026 Kashyab Ambarani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import type { Context, Message, Tool } from "../index.ts";
import { type ChatThinking, unpackThinkingSignature } from "./devin-thinking.ts";

export interface ContentPart {
	type: "text" | "image";
	text?: string;
	mimeType?: string;
	base64Data?: string;
}

export interface ChatHistoryItem {
	role: "user" | "assistant" | "tool";
	content: string | ContentPart[];
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; name: string; arguments: string }>;
	/** Prior reasoning, replayed so the server can verify and continue it. */
	thinking?: ChatThinking;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

export interface MappedChat {
	/** Goes into GetChatMessageRequest.prompt, the server's system slot. */
	systemPrompt?: string;
	messages: ChatHistoryItem[];
	tools: ToolDef[];
}

function userContent(content: Message["content"]): string | ContentPart[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: ContentPart[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text") parts.push({ type: "text", text: part.text });
		if (part.type === "image") {
			parts.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
		}
	}
	return parts;
}

export function mapContextToChat(context: Context, modelId?: string): MappedChat {
	const messages: ChatHistoryItem[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: userContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const texts: string[] = [];
			const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
			let thinking: ChatThinking | undefined;
			for (const part of message.content) {
				if (part.type === "text") texts.push(part.text);
				if (part.type === "toolCall") {
					toolCalls.push({
						id: part.id,
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
					});
				}
				if (
					part.type === "thinking" &&
					message.provider === "devin" &&
					message.api === "devin" &&
					(!modelId || message.model === modelId)
				) {
					const decoded = unpackThinkingSignature(part.thinkingSignature);
					// One thinking slot per message on the wire, and an unsigned trace is
					// not replayable — keep the newest block that the server can verify.
					if (decoded.signature) {
						thinking = {
							text: part.thinking,
							signature: decoded.signature,
							signatureType: decoded.signatureType,
							redacted: part.redacted,
						};
					}
				}
			}
			messages.push({
				role: "assistant",
				content: texts.join("\n"),
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				thinking,
			});
			continue;
		}
		if (message.role === "toolResult") {
			messages.push({
				role: "tool",
				content: userContent(message.content),
				tool_call_id: message.toolCallId,
			});
		}
	}

	const tools: ToolDef[] = (context.tools ?? []).map((tool: Tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));

	return { systemPrompt: context.systemPrompt || undefined, messages, tools };
}
