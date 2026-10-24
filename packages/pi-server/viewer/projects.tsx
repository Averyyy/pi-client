import { useEffect, useRef } from "react";
import type { ThreadSummary, ViewerProject } from "../src/viewer-types.ts";
import { Icon } from "./icons.tsx";
import type { ProjectRows } from "./use-viewer.ts";

const statusLabels = { running: "运行中", idle: "休息中", disconnected: "连接中断", unknown: "状态未知" };

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
}: {
	thread: ThreadSummary;
	current: string | null;
	select: (id: string) => void;
}) {
	return (
		<button
			type="button"
			className={`thread-row${thread.id === current ? " selected" : ""}`}
			onClick={() => select(thread.id)}
			title={thread.title}
			aria-current={thread.id === current ? "page" : undefined}
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
		<Container ref={element} className={sidebar ? "sidebar-project" : "project-card"}>
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
						<ThreadRow key={thread.id} thread={thread} current={current} select={select} />
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
