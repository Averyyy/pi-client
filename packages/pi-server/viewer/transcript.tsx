// biome-ignore-all lint/suspicious/noArrayIndexKey: Content blocks retain their positions throughout streaming.
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export type LoadMessage = (
	threadId: string,
	roundId: string,
	messageId: string,
	signal: AbortSignal,
) => Promise<ViewerMessage>;

function DeferredContent({
	message,
	threadId,
	roundId,
	loadMessage,
}: {
	message: ViewerMessage;
	threadId: string;
	roundId: string;
	loadMessage: LoadMessage;
}) {
	const [attempt, setAttempt] = useState(0);
	const [detail, setDetail] = useState<{ source: ViewerMessage; body?: ViewerMessage; error?: string }>({
		source: message,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: A retry starts a new request for the same message.
	useEffect(() => {
		const controller = new AbortController();
		setDetail({ source: message });
		loadMessage(threadId, roundId, message.id, controller.signal).then(
			(body) => {
				if (!controller.signal.aborted) setDetail({ source: message, body });
			},
			(error: unknown) => {
				if (!controller.signal.aborted)
					setDetail({ source: message, error: error instanceof Error ? error.message : "无法读取命令结果" });
			},
		);
		return () => controller.abort();
	}, [message, threadId, roundId, loadMessage, attempt]);
	if (detail.source !== message || (!detail.body && !detail.error)) return <output>正在读取命令结果…</output>;
	if (detail.error)
		return (
			<div>
				<p className="error-text" role="alert">
					{detail.error}
				</p>
				<button type="button" className="plain-button" onClick={() => setAttempt((value) => value + 1)}>
					重试
				</button>
			</div>
		);
	return <Content parts={messageParts(detail.body!)} plainText />;
}

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

function Message({
	message,
	threadId,
	roundId,
	loadMessage,
}: {
	message: ViewerMessage;
	threadId: string;
	roundId: string;
	loadMessage: LoadMessage;
}) {
	const command = message.role === "toolResult" || message.role === "bashExecution";
	if (command)
		return (
			<Detail title={message.role === "toolResult" ? "命令结果" : "终端执行"} kind="command">
				{message.contentDeferred ? (
					<DeferredContent message={message} threadId={threadId} roundId={roundId} loadMessage={loadMessage} />
				) : (
					<Content parts={messageParts(message)} plainText />
				)}
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
	threadId,
	loadMessage,
}: {
	round: ViewerRound;
	live: ViewerLive | null;
	active: boolean;
	threadId: string;
	loadMessage: LoadMessage;
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
		<article className="conversation-round" data-round-id={round.id}>
			{split.leading.map((message) => (
				<Message
					message={message}
					threadId={threadId}
					roundId={round.id}
					loadMessage={loadMessage}
					key={message.id}
				/>
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
								<Message
									message={message}
									threadId={threadId}
									roundId={round.id}
									loadMessage={loadMessage}
									key={message.id}
								/>
							))}
							{liveMessage ? (
								<Message
									message={liveMessage}
									threadId={threadId}
									roundId={round.id}
									loadMessage={loadMessage}
									key={`live:${liveMessage.id}`}
								/>
							) : null}
							{live?.tools.map((tool) => (
								<LiveTool key={tool.id} tool={tool} />
							))}
						</div>
					) : null}
				</div>
			) : null}
			{split.response ? (
				<div className="final-answer">
					<Message message={split.response} threadId={threadId} roundId={round.id} loadMessage={loadMessage} />
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
				<Message
					message={message}
					threadId={threadId}
					roundId={round.id}
					loadMessage={loadMessage}
					key={message.id}
				/>
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
	olderError,
	historyVersion,
	loadOlder,
	loadMessage,
}: {
	rounds: ViewerRound[];
	thread: ViewerThread;
	nextCursor: string | null;
	loadingOlder: boolean;
	olderError: string;
	historyVersion: number;
	loadOlder: () => Promise<boolean>;
	loadMessage: LoadMessage;
}) {
	const scroll = useRef<HTMLElement>(null);
	const nearBottom = useRef(true);
	const lastTop = useRef(0);
	const anchor = useRef<{ element: HTMLElement; top: number; firstId: string | undefined } | null>(null);
	const pending = useRef<object | null>(null);
	const failed = useRef(false);
	const previousVersion = useRef(historyVersion);
	const touchY = useRef(0);

	function captureAnchor(element: HTMLElement) {
		const top = element.getBoundingClientRect().top;
		const round = Array.from(element.querySelectorAll<HTMLElement>("[data-round-id]")).find(
			(item) => item.getBoundingClientRect().bottom > top,
		);
		return round ? { element: round, top: round.getBoundingClientRect().top, firstId: rounds[0]?.id } : null;
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: Live messages and tools resize the last round independently of committed rounds.
	useLayoutEffect(() => {
		const element = scroll.current!;
		if (previousVersion.current !== historyVersion) {
			anchor.current = null;
			pending.current = null;
			failed.current = false;
			nearBottom.current = true;
		}
		if (anchor.current && anchor.current.firstId !== rounds[0]?.id) {
			if (anchor.current.element.isConnected)
				element.scrollTop += anchor.current.element.getBoundingClientRect().top - anchor.current.top;
			anchor.current = null;
			nearBottom.current = false;
		} else if (nearBottom.current) element.scrollTop = element.scrollHeight;
		lastTop.current = element.scrollTop;
		previousVersion.current = historyVersion;
	}, [rounds, thread, historyVersion]);

	async function older(retry = false) {
		if (!nextCursor || loadingOlder || pending.current || (failed.current && !retry)) return;
		const attempt = {};
		pending.current = attempt;
		failed.current = false;
		anchor.current = captureAnchor(scroll.current!);
		nearBottom.current = false;
		const applied = await loadOlder();
		if (pending.current !== attempt) return;
		pending.current = null;
		if (!applied) {
			anchor.current = null;
			failed.current = true;
		}
	}

	return (
		<section
			aria-label="对话记录"
			className="transcript-scroll"
			ref={scroll}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region supports keyboard history navigation.
			tabIndex={0}
			onClick={(event) => {
				const toggle = (event.target as Element).closest(".detail-toggle, .process-toggle");
				if (toggle?.getAttribute("aria-expanded") === "false") nearBottom.current = false;
			}}
			onScroll={() => {
				const element = scroll.current!;
				const movingUp = element.scrollTop < lastTop.current;
				lastTop.current = element.scrollTop;
				nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
				if (pending.current) anchor.current = captureAnchor(element);
				if (movingUp && element.scrollTop <= 48) void older();
			}}
			onWheel={(event) => {
				if (event.deltaY < 0 && scroll.current!.scrollTop <= 48) void older();
			}}
			onKeyDown={(event) => {
				if (["Home", "PageUp", "ArrowUp"].includes(event.key) && scroll.current!.scrollTop <= 48) void older();
			}}
			onTouchStart={(event) => {
				touchY.current = event.touches[0].clientY;
			}}
			onTouchMove={(event) => {
				const y = event.touches[0].clientY;
				if (y > touchY.current + 4 && scroll.current!.scrollTop <= 48) void older();
				touchY.current = y;
			}}
		>
			<div className="transcript">
				{nextCursor ? (
					<div className="history-status">
						{olderError ? (
							<>
								<span role="alert">{olderError}</span>
								<button type="button" className="plain-button" onClick={() => void older(true)}>
									重试
								</button>
							</>
						) : (
							<output>{loadingOlder ? "正在加载更早的对话…" : "向上滚动加载更早的对话"}</output>
						)}
					</div>
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
						threadId={thread.id}
						loadMessage={loadMessage}
					/>
				))}
				{rounds.length === 0 && thread.live.message ? (
					<Round
						round={{ id: "live", messages: [] }}
						live={thread.live}
						active={thread.status === "running"}
						threadId={thread.id}
						loadMessage={loadMessage}
					/>
				) : null}
				<div className="transcript-end">对话记录</div>
			</div>
		</section>
	);
}
