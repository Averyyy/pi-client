import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { hashPiServerStaticContext as hashServerStaticContext } from "../../pi-server/src/pi-server-protocol.ts";
import { hashPiServerStaticContext as hashClientStaticContext } from "../src/core/pi-server-protocol.ts";

type ConstrainedSampling = Tool["constrainedSampling"];

function makeTool(constrainedSampling: ConstrainedSampling, reverseObjectKeys = false): Tool {
	const parameters = reverseObjectKeys
		? {
				required: ["code"],
				properties: {
					code: {
						description: "Code to execute",
						type: "string",
					},
				},
				type: "object",
			}
		: {
				type: "object",
				properties: {
					code: {
						type: "string",
						description: "Code to execute",
					},
				},
				required: ["code"],
			};

	return {
		name: "exec",
		description: "Execute code",
		parameters: parameters as Tool["parameters"],
		constrainedSampling,
	};
}

describe("pi-server static context protocol hash", () => {
	it("matches between client and server for every constrained sampling representation", () => {
		const configurations: ConstrainedSampling[] = [
			undefined,
			false,
			{ type: "json_schema", strict: "prefer" },
			{ type: "json_schema", strict: "require" },
			{
				type: "grammar",
				variants: {
					openai_lark: "start: CODE",
					openai_regex: "[\\s\\S]+",
				},
			},
		];

		for (const constrainedSampling of configurations) {
			const context = {
				systemPrompt: "System prompt",
				tools: [makeTool(constrainedSampling)],
			};
			expect(hashClientStaticContext(context)).toBe(hashServerStaticContext(context));
		}
	});

	it("changes when false, JSON-schema strictness, or grammar variants change", () => {
		const configurations: ConstrainedSampling[] = [
			undefined,
			false,
			{ type: "json_schema", strict: "prefer" },
			{ type: "json_schema", strict: "require" },
			{ type: "grammar", variants: { openai_lark: "start: CODE" } },
			{ type: "grammar", variants: { openai_lark: "start: OTHER" } },
			{
				type: "grammar",
				variants: {
					openai_lark: "start: CODE",
					openai_regex: "[\\s\\S]+",
				},
			},
		];

		const hashes = configurations.map((constrainedSampling) =>
			hashClientStaticContext({
				systemPrompt: "System prompt",
				tools: [makeTool(constrainedSampling)],
			}),
		);

		expect(new Set(hashes).size).toBe(configurations.length);
	});

	it("is stable when parameter, config, and grammar variant keys are reordered", () => {
		const normal: ConstrainedSampling = {
			type: "grammar",
			variants: {
				openai_lark: "start: CODE",
				openai_regex: "[\\s\\S]+",
			},
		};
		const reordered = {
			variants: {
				openai_regex: "[\\s\\S]+",
				openai_lark: "start: CODE",
			},
			type: "grammar",
		} satisfies ConstrainedSampling;
		const normalContext = {
			systemPrompt: "System prompt",
			tools: [makeTool(normal)],
		};
		const reorderedContext = {
			systemPrompt: "System prompt",
			tools: [makeTool(reordered, true)],
		};

		expect(hashClientStaticContext(normalContext)).toBe(hashClientStaticContext(reorderedContext));
		expect(hashServerStaticContext(normalContext)).toBe(hashServerStaticContext(reorderedContext));
	});
});
