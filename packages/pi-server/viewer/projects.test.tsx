import type { KeyboardEvent, MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, contextMenuHandlers, DeleteDialog, type MenuRequest } from "./projects.tsx";

const trigger = { getBoundingClientRect: () => ({ left: 30, bottom: 70 }) } as HTMLElement;
const project: MenuRequest = {
	target: { kind: "project", id: "project", name: "服务端项目", count: 17, projectId: "project", expanded: true },
	x: 50,
	y: 100,
	trigger,
};

describe("project and conversation actions", () => {
	it("opens the project menu through ContextMenu and Shift+F10 without activating the project", () => {
		const show = vi.fn();
		const handlers = contextMenuHandlers(project.target, show);
		for (const key of ["ContextMenu", "F10"]) {
			const event = {
				key,
				shiftKey: key === "F10",
				target: trigger,
				currentTarget: trigger,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			} as unknown as KeyboardEvent<HTMLElement>;
			handlers.onKeyDown(event);
			expect(event.preventDefault).toHaveBeenCalledOnce();
			expect(event.stopPropagation).toHaveBeenCalledOnce();
		}
		expect(show).toHaveBeenLastCalledWith({ target: project.target, x: 30, y: 70, trigger });
		handlers.onKeyDown({ key: "Enter", shiftKey: false } as KeyboardEvent<HTMLElement>);
		expect(show).toHaveBeenCalledTimes(2);
	});

	it("keeps a thread right-click from opening the surrounding project menu", () => {
		const show = vi.fn();
		const target = { kind: "thread" as const, id: "a", name: "会话 A", count: 1, projectId: "project" };
		const event = {
			currentTarget: trigger,
			clientX: 120,
			clientY: 180,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as MouseEvent<HTMLElement>;
		contextMenuHandlers(target, show).onContextMenu(event);
		expect(event.stopPropagation).toHaveBeenCalledOnce();
		expect(show).toHaveBeenCalledWith({ target, x: 120, y: 180, trigger });
	});

	it("offers project folding and confirms all server conversations including unloaded pages", () => {
		const menu = renderToStaticMarkup(
			<ContextMenu request={project} close={vi.fn()} toggle={vi.fn()} remove={vi.fn()} />,
		);
		expect(menu).toContain("折叠项目");
		expect(menu).toContain("删除项目全部服务器对话");
		const dialog = renderToStaticMarkup(
			<DeleteDialog
				request={project}
				close={vi.fn()}
				remove={async () => ({ deletedIds: [], deletedCount: 0, failed: [] })}
			/>,
		);
		expect(dialog).toContain("服务端项目");
		expect(dialog).toContain("当前共 17 个");
		expect(dialog).toContain("包括尚未加载的对话");
		expect(dialog).toContain("取消");
		expect(dialog).toContain("确认删除");
	});
});
