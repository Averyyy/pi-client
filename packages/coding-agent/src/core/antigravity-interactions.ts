import { randomUUID } from "node:crypto";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { McpError } from "@earendil-works/pi-mcp";
import type { EventBus } from "./event-bus.ts";
import type { ExtensionUIContext } from "./extensions/types.ts";

export interface AcpPlanEntry {
	content: string;
	priority: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

export function antigravityPlanResult(entries: AcpPlanEntry[]): AgentToolCallOutcome {
	const tasks = entries.map(({ content, status }, index) => ({
		id: index + 1,
		subject: content,
		status: status === "cancelled" ? "deleted" : status,
	}));
	return {
		toolCall: { type: "toolCall", id: randomUUID(), name: "todo", arguments: { action: "list" } },
		result: {
			content: [{ type: "text", text: entries.map(({ content, status }) => `[${status}] ${content}`).join("\n") }],
			details: { action: "list", params: {}, tasks, nextId: tasks.length + 1 },
		},
		isError: false,
	};
}

interface AcpChoice {
	const: string;
	title: string;
	description?: string;
}

interface AcpChoices {
	enum?: string[];
	oneOf?: AcpChoice[];
	anyOf?: AcpChoice[];
}

interface AcpFormField extends AcpChoices {
	type: "string" | "boolean" | "number" | "integer" | "array";
	title?: string;
	description?: string;
	items?: AcpChoices;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
}

export interface AcpFormRequest {
	sessionId: string;
	mode: string;
	message: string;
	requestedSchema: { type: "object"; properties: Record<string, AcpFormField>; required?: string[] };
}

interface QuestionField {
	key: string;
	schema: AcpFormField;
	options: { value: string; label: string; description: string }[];
	question: string;
	header: string;
	multiSelect: boolean;
}

type AcpFormResult = { action: "accept"; content: JsonObject } | { action: "decline" | "cancel" };

type QuestionUI = Pick<ExtensionUIContext, "input" | "select" | "notify">;

export async function answerAntigravityQuestion(
	request: AcpFormRequest,
	{ ui, events }: { ui: QuestionUI; events?: EventBus },
	signal: AbortSignal,
): Promise<{
	result: AcpFormResult;
	outcome: AgentToolCallOutcome;
}> {
	if (request.mode !== "form" || request.requestedSchema?.type !== "object") {
		throw new McpError(-32602, "Pi supports Antigravity form elicitation");
	}
	const { properties, required = [] } = request.requestedSchema;
	for (const key of required) {
		if (!Object.hasOwn(properties, key)) throw new McpError(-32602, `Unknown required form property ${key}`);
	}
	const fields: QuestionField[] = [];
	for (const [key, schema] of Object.entries(properties)) {
		const source = schema.type === "array" ? schema.items : schema;
		const titled = schema.type === "array" ? source?.anyOf : source?.oneOf;
		if (source?.enum && titled) throw new McpError(-32602, `Multiple enum declarations for ${key}`);
		const options =
			titled?.map(({ const: value, title, description }) => ({
				value,
				label: title,
				description: description ?? "",
			})) ??
			source?.enum?.map((value) => ({ value, label: value, description: "" })) ??
			[];
		if (
			!["string", "boolean", "number", "integer", "array"].includes(schema.type) ||
			(schema.type === "array" && options.length === 0)
		) {
			if (required.includes(key)) throw new McpError(-32602, `Unsupported Antigravity form field ${key}`);
			continue;
		}
		fields.push({
			key,
			schema,
			options:
				schema.type === "boolean"
					? [
							{ value: "true", label: "Yes", description: "" },
							{ value: "false", label: "No", description: "" },
						]
					: options,
			question: schema.description ?? schema.title ?? request.message,
			header: schema.title ?? key,
			multiSelect: schema.type === "array",
		});
	}
	const questions = fields.map(({ question, header, multiSelect, options }) => ({
		question,
		header,
		multiSelect,
		options: options.map(({ label, description }) => ({ label, description, hasPreview: false })),
	}));
	events?.emit("rpiv:ask-user:prompt", { questions });
	events?.emit("rpiv:ask-user:blocked", { active: true });
	const values = new Map<string, JsonValue>();
	let action: "accept" | "decline" | "cancel" = "cancel";
	try {
		let dismissed = false;
		for (const field of fields) {
			const value = await readFormField(request.message, field, ui, signal, required.includes(field.key));
			if (value === undefined) {
				dismissed = true;
				break;
			}
			if (value !== null) values.set(field.key, value);
		}
		if (!dismissed && !signal.aborted) {
			while (true) {
				const summary = fields
					.filter(({ key }) => values.has(key))
					.map(({ key, header }) => `${header}: ${JSON.stringify(values.get(key))}`)
					.join("\n");
				const choices = ["Submit answers", "Decline"];
				const edits = fields.map(({ header }, index) => `Edit ${index + 1}. ${header}`);
				const selection = await ui.select(`Antigravity · ${request.message}\n${summary}`, [...choices, ...edits], {
					signal,
				});
				if (!selection || choices.includes(selection)) {
					action = selection === choices[0] ? "accept" : selection === choices[1] ? "decline" : "cancel";
					break;
				}
				const field = fields[edits.indexOf(selection)];
				const value = await readFormField(request.message, field, ui, signal, required.includes(field.key));
				if (value === undefined) break;
				if (value === null) values.delete(field.key);
				else values.set(field.key, value);
			}
		}
	} finally {
		events?.emit("rpiv:ask-user:blocked", { active: false });
	}
	if (signal.aborted) action = "cancel";
	const result: AcpFormResult = action === "accept" ? { action, content: Object.fromEntries(values) } : { action };
	const answers =
		action === "accept"
			? fields.flatMap<JsonObject>(({ key, question, options }, questionIndex) => {
					const value = values.get(key);
					if (value === undefined) return [];
					const label = (selected: JsonValue) =>
						options.find((option) => option.value === String(selected))?.label ?? String(selected);
					return Array.isArray(value)
						? [{ questionIndex, question, kind: "multi", answer: null, selected: value.map(label) }]
						: [{ questionIndex, question, kind: options.length ? "option" : "custom", answer: label(value) }];
				})
			: [];
	return {
		result,
		outcome: {
			toolCall: { type: "toolCall", id: randomUUID(), name: "ask_user_question", arguments: { questions } },
			result: {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { answers, cancelled: action !== "accept" },
				structuredContent: result,
			},
			isError: false,
		},
	};
}

async function readFormField(
	message: string,
	{ schema, question, header, options, multiSelect }: QuestionField,
	ui: QuestionUI,
	signal: AbortSignal,
	required: boolean,
): Promise<JsonValue | undefined> {
	const title = `Antigravity · ${message}\n${header}\n${question}`;
	const selected = new Set<string>();
	while (!signal.aborted) {
		if (options.length > 0) {
			const labels = options.map(
				({ value, label, description }, index) =>
					`${multiSelect && selected.has(value) ? "[x] " : ""}${index + 1}. ${label}${description ? ` — ${description}` : ""}`,
			);
			const done = "Done selecting";
			const skip = "Leave unanswered";
			const canFinish = selected.size >= (schema.minItems ?? 0) && selected.size <= (schema.maxItems ?? Infinity);
			const input = await ui.select(
				title,
				[...labels, ...(multiSelect && canFinish ? [done] : []), ...(!required ? [skip] : [])],
				{ signal },
			);
			if (!input) return undefined;
			if (input === skip) return null;
			if (input === done) return [...selected];
			const { value } = options[labels.indexOf(input)];
			if (!multiSelect) return schema.type === "boolean" ? value === "true" : value;
			if (selected.has(value)) selected.delete(value);
			else selected.add(value);
		} else {
			const input = await ui.input(title, undefined, { signal });
			if (input === undefined) return undefined;
			if (!required && input === "") return null;
			if (schema.type === "string") {
				if (input.length >= (schema.minLength ?? 0) && input.length <= (schema.maxLength ?? Infinity)) return input;
			} else {
				const value = Number(input);
				if (
					input.trim() &&
					Number.isFinite(value) &&
					(schema.type !== "integer" || Number.isInteger(value)) &&
					value >= (schema.minimum ?? -Infinity) &&
					value <= (schema.maximum ?? Infinity)
				)
					return value;
			}
			ui.notify(`Invalid value for ${header}`, "warning");
		}
	}
}
