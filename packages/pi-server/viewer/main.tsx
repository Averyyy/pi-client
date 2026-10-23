import { type FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./icons.tsx";
import { ProjectFolder, Status, ThreadRow } from "./projects.tsx";
import { Transcript } from "./transcript.tsx";
import { useViewer } from "./use-viewer.ts";
import "./style.css";

function Login({ onLogin, locked }: { onLogin: () => void; locked: boolean }) {
	const input = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(locked ? "登录已锁定。累计 10 次验证失败，仅可在服务器端解锁。" : "");
	const [isLocked, setLocked] = useState(locked);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!input.current) return;
		let token = input.current.value;
		input.current.value = "";
		setPending(true);
		setError("");
		try {
			const pendingResponse = fetch("/viewer/login", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				credentials: "same-origin",
			});
			token = "";
			const response = await pendingResponse;
			if (response.ok) {
				onLogin();
				return;
			}
			const detail = (await response.json()) as { error: string; remainingAttempts: number };
			if (response.status === 423) {
				setLocked(true);
				setError("登录已锁定。累计 10 次验证失败，仅可在服务器端解锁。");
			} else if (response.status === 401) setError(`Token 无效，还可尝试 ${detail.remainingAttempts} 次。`);
			else setError(response.status === 503 ? "服务器尚未配置查看器访问。" : "登录失败，请重试。");
		} catch {
			setError("无法连接服务器，请重试。");
		} finally {
			token = "";
			setPending(false);
			input.current?.focus();
		}
	}
	return (
		<main className="login-screen">
			<div className="login-card">
				<div className="login-brand">π</div>
				<h1>pi-server</h1>
				<p className="login-description">使用 Bearer Token 查看对话</p>
				<form onSubmit={submit}>
					<label htmlFor="token">访问令牌</label>
					<input
						ref={input}
						id="token"
						name="token"
						type="password"
						autoComplete="off"
						required
						disabled={pending || isLocked}
						placeholder="输入服务器 Token"
						spellCheck={false}
					/>
					<button className="primary-button" type="submit" disabled={pending || isLocked}>
						{pending ? "正在登录…" : "登录"}
					</button>
					{error ? (
						<p className="login-error" role="alert">
							{error}
						</p>
					) : null}
				</form>
				<p className="login-note">
					<Icon name="lock" size={13} />
					只读访问 · Token 仅用于本次验证
				</p>
				<p className="login-lock-note">连续 10 次失败后锁定，需在服务器解锁。</p>
			</div>
		</main>
	);
}

function Viewer() {
	const {
		auth,
		locked,
		catalog,
		current,
		expanded,
		rows,
		thread,
		rounds,
		cursor,
		loadingOlder,
		loadingThread,
		error,
		drawer,
		connected,
		setDrawer,
		select,
		home,
		toggleProject,
		loadOlder,
		logout,
		more,
		login,
		retry,
	} = useViewer();
	const sidebar = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!drawer || !sidebar.current) return;
		const previous = document.activeElement;
		const element = sidebar.current;
		element.querySelector<HTMLButtonElement>("button")?.focus();
		function keyboard(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				setDrawer(false);
			}
			if (event.key !== "Tab") return;
			const buttons = element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
			const first = buttons[0];
			const last = buttons[buttons.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		}
		element.addEventListener("keydown", keyboard);
		return () => {
			element.removeEventListener("keydown", keyboard);
			if (previous instanceof HTMLElement) previous.focus();
		};
	}, [drawer, setDrawer]);
	if (auth === "login") return <Login locked={locked} onLogin={login} />;
	if (auth === "loading")
		return (
			<div className="initial-loading">
				<div className="wordmark">
					π <span>pi-server</span>
				</div>
				<p>{error || "正在连接服务器…"}</p>
				{error ? (
					<button type="button" className="plain-button" onClick={retry}>
						重新连接
					</button>
				) : null}
			</div>
		);
	const project = catalog.projects.find((item) => item.id === thread?.projectId);
	return (
		<div className="app-shell">
			{drawer ? (
				<button type="button" className="drawer-scrim" aria-label="关闭项目列表" onClick={() => setDrawer(false)} />
			) : null}
			<aside ref={sidebar} className={`sidebar${drawer ? " is-open" : ""}`} aria-label="项目与对话">
				<div className="sidebar-brand">
					<button type="button" onClick={home} className="wordmark">
						π <span>pi-server</span>
					</button>
					<button
						type="button"
						className="icon-button mobile-only"
						onClick={() => setDrawer(false)}
						aria-label="关闭项目列表"
					>
						<Icon name="close" />
					</button>
				</div>
				<div className="sidebar-scroll">
					<button type="button" className={`all-projects${!current ? " selected" : ""}`} onClick={home}>
						<Icon name="home" size={17} />
						所有项目
					</button>
					<div className="nav-section-label">
						进行中 <span>{catalog.running.length}</span>
					</div>
					{catalog.running.length ? (
						catalog.running.map((item) => (
							<ThreadRow key={item.id} thread={item} current={current} select={select} />
						))
					) : (
						<p className="sidebar-empty">暂无运行中的对话</p>
					)}
					<div className="nav-section-label projects-label">
						项目 <span>{catalog.projects.length}</span>
					</div>
					{catalog.projects.map((item) => (
						<ProjectFolder
							key={item.id}
							project={item}
							rows={rows[item.id]}
							open={expanded.has(item.id)}
							current={current}
							surface="sidebar"
							toggle={toggleProject}
							select={select}
							more={more}
						/>
					))}
				</div>
				<div className="sidebar-footer">
					<span>
						<Icon name="lock" size={13} />
						只读访问
					</span>
					<button type="button" className="icon-button" onClick={logout} aria-label="退出登录" title="退出登录">
						<Icon name="logout" size={16} />
					</button>
				</div>
			</aside>
			<main className="workspace" inert={drawer}>
				<header className="workspace-header">
					<button
						type="button"
						className="icon-button mobile-only"
						onClick={() => setDrawer(true)}
						aria-label="打开项目列表"
					>
						<Icon name="menu" />
					</button>
					{current ? (
						<>
							<button type="button" className="icon-button back-button" onClick={home} aria-label="返回所有项目">
								<Icon name="arrow" size={17} />
							</button>
							<Icon name="folder" size={17} />
							<div className="breadcrumb">
								<span>{project?.name ?? "对话"}</span>
								<span className="breadcrumb-divider">/</span>
								<strong>{thread?.title ?? "加载中…"}</strong>
							</div>
							{thread ? <Status status={thread.status} text /> : null}
						</>
					) : (
						<span className="header-caption mobile-only">pi-server</span>
					)}
					<span className="readonly-label">只读</span>
				</header>
				{error ? (
					<div className="error-banner" role="alert">
						{error}
						<button type="button" className="plain-button" onClick={retry}>
							重试
						</button>
					</div>
				) : null}
				{!connected ? <output className="connection-banner">服务器连接已中断，正在重新连接…</output> : null}
				{current ? (
					loadingThread ? (
						<div className="content-loading">正在读取对话…</div>
					) : thread ? (
						<Transcript
							rounds={rounds}
							thread={thread}
							nextCursor={cursor}
							loadingOlder={loadingOlder}
							loadOlder={loadOlder}
						/>
					) : (
						<div className="content-loading">{error ? "请选择其他对话" : "此对话不可用"}</div>
					)
				) : (
					<div className="home-scroll">
						<div className="home-content">
							<div className="home-title">
								<div>
									<h1>所有项目</h1>
								</div>
								<div className="project-total">
									{catalog.projects.length}
									<span>个项目</span>
								</div>
							</div>
							{catalog.running.length ? (
								<section className="active-section">
									<div className="section-heading">
										<h2>
											<span className="status-dot running" />
											正在运行
										</h2>
										<span>{catalog.running.length} 个对话</span>
									</div>
									<div className="active-grid">
										{catalog.running.map((item) => (
											<button
												type="button"
												className="active-card"
												onClick={() => select(item.id)}
												key={item.id}
											>
												<span className="active-project">
													{catalog.projects.find((entry) => entry.id === item.projectId)?.name ?? "项目"}
												</span>
												<strong>{item.title || "未命名对话"}</strong>
												<span className="active-card-footer">
													<Status status={item.status} text />
													<Icon name="chevron" size={14} />
												</span>
											</button>
										))}
									</div>
								</section>
							) : null}
							<div className="section-heading">
								<h2>项目</h2>
							</div>
							{catalog.projects.length === 0 ? (
								<div className="empty-projects">
									<Icon name="folder" size={30} />
									<h2>还没有项目</h2>
									<p>pi-client 连接服务器后，对话会显示在这里。</p>
								</div>
							) : (
								<div className="project-grid">
									{catalog.projects.map((item) => (
										<ProjectFolder
											key={item.id}
											project={item}
											rows={rows[item.id]}
											open={expanded.has(item.id)}
											current={current}
											surface="home"
											toggle={toggleProject}
											select={select}
											more={more}
										/>
									))}
								</div>
							)}
						</div>
					</div>
				)}
			</main>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Viewer />);
