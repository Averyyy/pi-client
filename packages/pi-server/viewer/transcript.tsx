// biome-ignore-all lint/suspicious/noArrayIndexKey: Content blocks retain their positions throughout streaming.
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type {
	ViewerContent,
	ViewerLive,
	ViewerMessage,
	ViewerRound,
	ViewerThread,
	ViewerTool,
} from "../src/viewer-types.ts";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { messageParts, partitionRound } from "./rounds.ts";

function Detail({ title, children, kind = "process" }: { title: string; children: ReactNode; kind?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`detail detail-${kind}`}>
			<button type="button" className="detail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name={kind === "command" ? "terminal" : "spark"} size={15} />
				<span>{title}</span>
				<Icon name="chevron" size={13} className={open ? "rotate" : ""} />
			</button>
			{open ? <div className="detail-content">{children}</div> : null}
		</div>
	);
}

function Content({ parts, plainText = false }: { parts: ViewerContent[]; plainText?: boolean }) {
	return parts.map((part, index) => {
		switch (part.type) {
			case "text":
				return plainText ? <pre key={index}>{part.text}</pre> : <Markdown text={part.text} key={index} />;
			case "thinking":
				return (
					<Detail title="思考过程" key={index}>
						<Markdown text={part.thinking} />
					</Detail>
				);
			case "toolCall":
				return (
					<Detail title={part.name} kind="command" key={part.id}>
						<pre>{JSON.stringify(part.arguments, null, 2)}</pre>
					</Detail>
				);
			case "attachment":
				return (
					<div className="attachment" key={index}>
						{part.label}
					</div>
				);
		}
		return null;
	});
}

function Message({ message }: { message: ViewerMessage }) {
	const command = message.role === "toolResult" || message.role === "bashExecution";
	if (command)
		return (
			<Detail title={message.role === "toolResult" ? "命令结果" : "终端执行"} kind="command">
				<Content parts={messageParts(message)} plainText />
				{message.errorMessage ? <p className="error-text">{message.errorMessage}</p> : null}
			</Detail>
		);
	return (
		<div className={message.role === "user" ? "user-message" : "assistant-message"}>
			<Content parts={messageParts(message)} />
			{message.errorMessage ? <p className="error-text">{message.errorMessage}</p> : null}
		</div>
	);
}

function LiveTool({ tool }: { tool: ViewerTool }) {
	return (
		<Detail
			title={`${tool.name} · ${tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "已完成"}`}
			kind="command"
		>
			<pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
			{tool.result ? (
				<div className="tool-output">
					<Content parts={tool.result.content} plainText />
				</div>
			) : null}
		</Detail>
	);
}

const Round = memo(function Round({
	round,
	live,
	active,
}: {
	round: ViewerRound;
	live: ViewerLive | null;
	active: boolean;
}) {
	const split = partitionRound(round.messages);
	const [processChoice, setProcessOpen] = useState<boolean | undefined>();
	const processOpen = processChoice ?? active;
	const liveToolIds = new Set(live?.tools.map((tool) => tool.id));
	const liveMessage = live?.message
		? {
				...live.message,
				content: messageParts(live.message).filter((part) => part.type !== "toolCall" || !liveToolIds.has(part.id)),
			}
		: null;
	const processCount = split.process.length + (live?.message ? 1 : 0) + (live?.tools.length ?? 0);
	const terminalLabel =
		split.outcome === "failed"
			? "运行失败"
			: split.outcome === "stopped"
				? "已停止"
				: split.outcome === "incomplete"
					? "输出达到长度限制"
					: undefined;
	return (
		<article className="conversation-round">
			{split.leading.map((message) => (
				<Message message={message} key={message.id} />
			))}
			{processCount > 0 ? (
				<div className="round-process">
					<button
						className="process-toggle"
						type="button"
						aria-expanded={processOpen}
						onClick={() => setProcessOpen(!processOpen)}
					>
						{active ? <span className="status-dot running" /> : <Icon name="spark" size={15} />}
						<span>{active ? "正在处理" : "处理过程"}</span>
						<Icon name="chevron" size={13} className={processOpen ? "rotate" : ""} />
					</button>
					{processOpen ? (
						<div className="process-body">
							{split.process.map((message) => (
								<Message message={message} key={message.id} />
							))}
							{liveMessage ? <Message message={liveMessage} key={`live:${liveMessage.id}`} /> : null}
							{live?.tools.map((tool) => (
								<LiveTool key={tool.id} tool={tool} />
							))}
						</div>
					) : null}
				</div>
			) : null}
			{split.response ? (
				<div className="final-answer">
					<Message message={split.response} />
				</div>
			) : null}
			{terminalLabel ? (
				<output className="terminal-state">
					{terminalLabel}
					{!split.response && round.messages.findLast((message) => message.role === "assistant")?.errorMessage ? (
						<p className="error-text">
							{round.messages.findLast((message) => message.role === "assistant")?.errorMessage}
						</p>
					) : null}
				</output>
			) : null}
			{split.trailing.map((message) => (
				<Message message={message} key={message.id} />
			))}
			{active && processCount === 0 ? (
				<div className="waiting">
					<span className="status-dot running" />
					正在处理
				</div>
			) : null}
		</article>
	);
});

export function Transcript({
	rounds,
	thread,
	nextCursor,
	loadingOlder,
	loadOlder,
}: {
	rounds: ViewerRound[];
	thread: ViewerThread;
	nextCursor: string | null;
	loadingOlder: boolean;
	loadOlder: () => Promise<void>;
}) {
	const scroll = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);
	const prepended = useRef<{ height: number; top: number; firstId: string | undefined } | null>(null);
	const previousThread = useRef(thread.id);
	useLayoutEffect(() => {
		const element = scroll.current;
		if (!element) return;
		if (prepended.current && prepended.current.firstId !== rounds[0]?.id) {
			element.scrollTop = prepended.current.top + element.scrollHeight - prepended.current.height;
			prepended.current = null;
		} else if (previousThread.current !== thread.id || nearBottom.current) element.scrollTop = element.scrollHeight;
		previousThread.current = thread.id;
	}, [rounds, thread]);
	async function older() {
		const element = scroll.current;
		if (element) prepended.current = { height: element.scrollHeight, top: element.scrollTop, firstId: rounds[0]?.id };
		await loadOlder();
	}
	return (
		<div
			className="transcript-scroll"
			ref={scroll}
			onScroll={() => {
				const element = scroll.current;
				if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
			}}
		>
			<div className="transcript">
				{nextCursor ? (
					<button type="button" className="load-older" onClick={older} disabled={loadingOlder}>
						{loadingOlder ? "正在加载…" : "加载更早的 5 轮对话"}
					</button>
				) : null}
				{rounds.length === 0 && !thread.live.message ? (
					<div className="empty-conversation">
						<Icon name="spark" size={26} />
						<p>服务器尚未保存此会话的消息</p>
					</div>
				) : null}
				{rounds.map((round, index) => (
					<Round
						key={`${thread.id}:${round.id}`}
						round={round}
						live={index === rounds.length - 1 ? thread.live : null}
						active={index === rounds.length - 1 && thread.status === "running"}
					/>
				))}
				{rounds.length === 0 && thread.live.message ? (
					<Round round={{ id: "live", messages: [] }} live={thread.live} active={thread.status === "running"} />
				) : null}
				<div className="transcript-end">只读对话</div>
			</div>
		</div>
	);
}
