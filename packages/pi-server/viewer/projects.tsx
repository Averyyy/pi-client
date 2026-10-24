import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadSummary, ViewerDeleteResult, ViewerProject } from "../src/viewer-types.ts";
import { Icon } from "./icons.tsx";
import type { ProjectRows } from "./use-viewer.ts";

const statusLabels = { running: "运行中", idle: "休息中", disconnected: "连接中断", unknown: "状态未知" };

export type ActionTarget = {
	kind: "project" | "thread";
	id: string;
	name: string;
	count: number;
	projectId: string;
	expanded?: boolean;
};

export interface MenuRequest {
	target: ActionTarget;
	x: number;
	y: number;
	trigger: HTMLElement;
}

export function contextMenuHandlers(target: ActionTarget, show: (request: MenuRequest) => void) {
	function open(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
		const keyboard = "key" in event;
		if (keyboard && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		event.preventDefault();
		event.stopPropagation();
		const trigger = keyboard ? (event.target as HTMLElement) : event.currentTarget;
		const rect = trigger.getBoundingClientRect();
		show({ target, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY, trigger });
	}
	return { onContextMenu: open, onKeyDown: open };
}

export function Status({ status, text = false }: { status: ThreadSummary["status"]; text?: boolean }) {
	return (
		<span className={`status ${status}`} title={statusLabels[status]}>
			<span className={`status-dot ${status}`} />
			{text ? statusLabels[status] : <span className="sr-only">{statusLabels[status]}</span>}
		</span>
	);
}

export function ThreadRow({
	thread,
	current,
	select,
	menu,
}: {
	thread: ThreadSummary;
	current: string | null;
	select: (id: string) => void;
	menu: (request: MenuRequest) => void;
}) {
	return (
		<button
			type="button"
			className={`thread-row${thread.id === current ? " selected" : ""}`}
			onClick={() => select(thread.id)}
			title={thread.title}
			aria-current={thread.id === current ? "page" : undefined}
			{...contextMenuHandlers(
				{
					kind: "thread",
					id: thread.id,
					name: thread.title || "未命名对话",
					count: 1,
					projectId: thread.projectId,
				},
				menu,
			)}
		>
			<span>{thread.title || "未命名对话"}</span>
			<Status status={thread.status} />
		</button>
	);
}

export function ProjectFolder({
	project,
	rows,
	open,
	current,
	surface,
	toggle,
	select,
	more,
	visibility,
	menu,
}: {
	project: ViewerProject;
	rows: ProjectRows | undefined;
	open: boolean;
	current: string | null;
	surface: "sidebar" | "home";
	toggle: (id: string) => void;
	select: (id: string) => void;
	more: (id: string) => void;
	visibility: (id: string, surface: string, visible: boolean) => void;
	menu: (request: MenuRequest) => void;
}) {
	const sidebar = surface === "sidebar";
	const element = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const observer = new IntersectionObserver((entries) => {
			visibility(project.id, surface, entries[0].isIntersecting && entries[0].intersectionRatio > 0);
		});
		observer.observe(element.current!);
		return () => {
			observer.disconnect();
			visibility(project.id, surface, false);
		};
	}, [project.id, surface, visibility]);
	const Container = sidebar ? "div" : "section";
	return (
		<Container
			ref={element}
			tabIndex={-1}
			className={sidebar ? "sidebar-project" : "project-card"}
			{...contextMenuHandlers(
				{
					kind: "project",
					id: project.id,
					name: project.name,
					count: project.threadCount,
					projectId: project.id,
					expanded: open,
				},
				menu,
			)}
		>
			<button
				type="button"
				className={sidebar ? "project-toggle" : "project-card-heading"}
				onClick={() => toggle(project.id)}
				aria-expanded={open}
			>
				{sidebar ? (
					<Icon name="folder" size={17} />
				) : (
					<span className="folder-tile">
						<Icon name="folder" size={21} />
					</span>
				)}
				{sidebar ? (
					<span>{project.name}</span>
				) : (
					<span className="project-card-name">
						<strong>{project.name}</strong>
						<span>{project.threadCount} 个对话</span>
					</span>
				)}
				<Icon name="chevron" size={sidebar ? 12 : 15} className={open ? "rotate" : ""} />
			</button>
			{!sidebar && project.path ? (
				<p className="project-path" title={project.path}>
					{project.path}
				</p>
			) : null}
			{open ? (
				<div className={sidebar ? "project-threads" : "card-threads"}>
					{rows?.threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} current={current} select={select} menu={menu} />
					))}
					{!rows || (rows.loading && !rows.threads.length) ? (
						<div
							className="project-placeholder"
							style={{ height: Math.min(5, project.threadCount) * (sidebar ? 35 : 39) }}
						>
							正在加载…
						</div>
					) : null}
					{rows?.nextCursor ? (
						<button
							type="button"
							className={sidebar ? "sidebar-more" : "card-more"}
							disabled={rows.loading}
							onClick={() => more(project.id)}
						>
							{rows.loading ? "正在加载…" : "展开更多"}
							{!sidebar ? <Icon name="chevron" size={12} /> : null}
						</button>
					) : null}
					{rows && !rows.loading && rows.threads.length === 0 ? (
						<p className={sidebar ? "sidebar-empty" : "card-empty"}>暂无对话</p>
					) : null}
				</div>
			) : null}
		</Container>
	);
}

export function ContextMenu({
	request,
	close,
	toggle,
	remove,
}: {
	request: MenuRequest;
	close: () => void;
	toggle: (id: string) => void;
	remove: () => void;
}) {
	const element = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: request.x, top: request.y });
	useLayoutEffect(() => {
		const node = element.current!;
		const rect = node.getBoundingClientRect();
		setPosition({
			left: Math.max(8, Math.min(request.x, window.innerWidth - rect.width - 8)),
			top: Math.max(8, Math.min(request.y, window.innerHeight - rect.height - 8)),
		});
		node.querySelector<HTMLButtonElement>("button")!.focus();
	}, [request]);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (!element.current!.contains(event.target as Node)) close();
		};
		document.addEventListener("pointerdown", outside);
		window.addEventListener("resize", close);
		document.addEventListener("scroll", close, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", close);
			document.removeEventListener("scroll", close, true);
		};
	}, [close]);
	return (
		<div
			ref={element}
			className="context-menu"
			role="menu"
			aria-label={`${request.target.name}操作`}
			style={position}
			onKeyDown={(event) => {
				const buttons = Array.from(element.current!.querySelectorAll<HTMLButtonElement>("button"));
				const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
				if (event.key === "Escape" || event.key === "Tab") {
					event.preventDefault();
					close();
				} else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
					event.preventDefault();
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? buttons.length - 1
								: (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
					buttons[next].focus();
				}
			}}
		>
			{request.target.kind === "project" ? (
				<button
					type="button"
					role="menuitem"
					onClick={() => {
						toggle(request.target.id);
						close();
					}}
				>
					{request.target.expanded ? "折叠项目" : "展开项目"}
				</button>
			) : null}
			<button type="button" role="menuitem" className="danger-text" onClick={remove}>
				{request.target.kind === "project" ? "删除项目全部服务器对话…" : "删除服务器对话…"}
			</button>
		</div>
	);
}

export function DeleteDialog({
	request,
	close,
	remove,
}: {
	request: MenuRequest;
	close: () => void;
	remove: (target: ActionTarget) => Promise<ViewerDeleteResult>;
}) {
	const element = useRef<HTMLDialogElement>(null);
	const [pending, setPending] = useState(false);
	const deleting = useRef(false);
	const [error, setError] = useState("");
	const [failed, setFailed] = useState<ViewerDeleteResult["failed"]>([]);
	useEffect(() => {
		element.current!.showModal();
		return () => {
			if (request.trigger.isConnected) request.trigger.focus();
		};
	}, [request]);
	async function confirm() {
		if (deleting.current) return;
		deleting.current = true;
		setPending(true);
		setError("");
		setFailed([]);
		try {
			const result = await remove(request.target);
			if (result.failed.length) {
				setError(`已删除 ${result.deletedCount} 个对话，${result.failed.length} 个删除失败。`);
				setFailed(result.failed);
			} else close();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "删除失败，请重试");
		} finally {
			deleting.current = false;
			setPending(false);
		}
	}
	return (
		<dialog
			ref={element}
			className="delete-dialog"
			aria-labelledby="delete-title"
			aria-describedby="delete-description"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) close();
			}}
		>
			<h2 id="delete-title">{request.target.kind === "project" ? "删除项目全部服务器对话" : "删除服务器对话"}</h2>
			<p id="delete-description">
				{request.target.kind === "project" ? (
					<>
						将从服务器永久删除项目「{request.target.name}」的全部对话，当前共 {request.target.count}{" "}
						个，包括尚未加载的对话。
					</>
				) : (
					<>将从服务器永久删除「{request.target.name}」这 1 个对话。</>
				)}{" "}
				此操作无法撤销。
			</p>
			{error ? (
				<div className="delete-error" role="alert">
					<p>{error}</p>
					{failed.length ? (
						<ul>
							{failed.map((item) => (
								<li key={item.id}>
									{item.id}：{item.error}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			{pending ? <output className="delete-progress">正在删除服务器对话…</output> : null}
			<div className="dialog-actions">
				<button type="button" className="dialog-cancel" disabled={pending} onClick={close}>
					取消
				</button>
				<button type="button" className="danger-button" disabled={pending} onClick={() => void confirm()}>
					{pending ? "正在删除…" : failed.length || error ? "重试删除" : "确认删除"}
				</button>
			</div>
		</dialog>
	);
}
