import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url), "utf8"));

// These job conditions use only boolean operators, strings, and context properties,
// which share JavaScript semantics for the string/boolean fixtures below.
function enabled(job, repository, eventName, publish = false, conclusion = "success", branch = "main") {
	const expression = job.if.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/)?.[1];
	assert.ok(expression, "job must have an explicit expression condition");
	return runInNewContext(expression, {
		github: {
			repository,
			event_name: eventName,
			event: { workflow_run: { conclusion, head_branch: branch } },
		},
		inputs: { publish },
	});
}

test("forks never enter the R2 publication job, including explicit manual publication", () => {
	for (const repository of ["Averyyy/pi-client", "earendil-works/another-fork", "another-owner/pi"]) {
		for (const event of ["schedule", "workflow_run", "workflow_dispatch", "pull_request"]) {
			for (const publish of [false, true]) {
				assert.equal(enabled(workflow.jobs.publish, repository, event, publish), false, `${repository}: ${event}`);
			}
		}
	}
});

test("upstream retains its publication triggers and generation dependency", () => {
	assert.equal(workflow.jobs.publish.needs, "generate");
	for (const [event, publish, expected] of [
		["schedule", false, true],
		["workflow_run", false, true],
		["workflow_dispatch", true, true],
		["workflow_dispatch", false, false],
		["pull_request", true, false],
	]) {
		assert.equal(enabled(workflow.jobs.publish, "earendil-works/pi", event, publish), expected);
	}
});

test("fork generation, validation, and upstream compatibility checks remain enabled", () => {
	const generate = workflow.jobs.generate;
	for (const event of ["schedule", "workflow_run", "workflow_dispatch", "pull_request"]) {
		assert.equal(enabled(generate, "Averyyy/pi-client", event), true, event);
	}
	assert.equal(enabled(generate, "Averyyy/pi-client", "workflow_run", false, "failure"), false);
	assert.equal(enabled(generate, "Averyyy/pi-client", "workflow_run", false, "success", "feature"), false);
	const commands = ["npm run generate:model-catalog", "npm run check:model-catalog", "npm run check:model-catalog-compat"];
	const checks = generate.steps.filter((step) => commands.includes(step.run));
	assert.deepEqual(checks.map((step) => step.run), commands);
	for (const step of checks) {
		assert.equal(step.if, undefined, `${step.name} must not skip forks`);
		assert.notEqual(step["continue-on-error"], true, `${step.name} must fail on errors`);
	}
	assert.ok(generate.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")));
});
