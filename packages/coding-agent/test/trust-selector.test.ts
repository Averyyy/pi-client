import { join, resolve } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const projectPath = resolve("/project");
const parentPath = resolve("/parent");

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("marks the saved trusted decision", () => {
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: { path: projectPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (${projectPath})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("Trust ✓");
		expect(output).not.toContain("Do not trust ✓");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: projectPath, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: join(parentPath, "project", "nested"),
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const nestedProjectPath = join(parentPath, "project");
		const selector = new TrustSelectorComponent({
			cwd: nestedProjectPath,
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
		expect(output).toContain(`Trust parent folder (${parentPath})`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: nestedProjectPath, decision: null },
			],
		});
	});
});
