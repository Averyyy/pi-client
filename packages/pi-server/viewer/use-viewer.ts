import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ThreadSummary,
	ViewerMessage,
	ViewerProject,
	ViewerRound,
	ViewerThread,
	ViewerUpdate,
} from "../src/viewer-types.ts";
import { ApiError, request } from "./api.ts";
import { appendMessages, mergeRecentRounds } from "./rounds.ts";

interface Catalog {
	projects: ViewerProject[];
	running: ThreadSummary[];
}
interface ThreadPage {
	threads: ThreadSummary[];
	nextCursor: string | null;
}
interface RoundPage {
	rounds: ViewerRound[];
	nextCursor: string | null;
}

export class OlderHistoryRequest {
	private controller: AbortController | null = null;
	private generation = 0;

	cancel() {
		this.controller?.abort();
		this.generation++;
	}
	isCurrent(generation: number) {
		return generation === this.generation;
	}

	async load(path: string, selectionSignal: AbortSignal) {
		this.cancel();
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		const signal = AbortSignal.any([controller.signal, selectionSignal]);
		try {
			const page = await request<RoundPage>(path, signal);
			return { page: this.isCurrent(generation) && !signal.aborted ? page : null, generation };
		} catch (error) {
			if (signal.aborted) return { page: null, generation };
			throw error;
		}
	}
}
interface Snapshot extends RoundPage {
	thread: ViewerThread;
}
export interface ProjectRows extends ThreadPage {
	loading: boolean;
	pages: number;
}

function selectedId() {
	const match = /^#\/thread\/(.+)$/.exec(window.location.hash);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

export function useViewer() {
	const [auth, setAuth] = useState<"loading" | "login" | "ready">("loading");
	const [locked, setLocked] = useState(false);
	const [catalog, setCatalog] = useState<Catalog>({ projects: [], running: [] });
	const [current, setCurrent] = useState(selectedId);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [rows, setRows] = useState<Record<string, ProjectRows>>({});
	const [thread, setThread] = useState<ViewerThread | null>(null);
	const [rounds, setRounds] = useState<ViewerRound[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loadingThread, setLoadingThread] = useState(false);
	const [error, setError] = useState("");
	const [drawer, setDrawer] = useState(false);
	const [connected, setConnected] = useState(true);
	const [olderHistory] = useState(() => new OlderHistoryRequest());
	const rowsRef = useRef(rows);
	const expandedRef = useRef(expanded);
	const roundsRef = useRef(rounds);
	const initializedProjects = useRef(new Set<string>());
	const projectRequests = useRef(new Map<string, AbortController>());
	const selectionController = useRef<AbortController | null>(null);
	rowsRef.current = rows;
	expandedRef.current = expanded;
	roundsRef.current = rounds;
	const fail = useCallback((caught: unknown) => {
		if (caught instanceof DOMException && caught.name === "AbortError") return;
		if (caught instanceof ApiError && (caught.status === 401 || caught.status === 423)) {
			setAuth("login");
			setLocked(caught.status === 423);
			setThread(null);
			setRounds([]);
			setCatalog({ projects: [], running: [] });
			setRows({});
			setExpanded(new Set());
		} else setError(caught instanceof Error ? caught.message : "无法读取服务器数据");
	}, []);
	const refreshCatalog = useCallback(async (signal?: AbortSignal) => {
		const data = await request<Catalog>("projects", signal);
		if (signal?.aborted) return;
		setCatalog(data);
		setAuth("ready");
		setError("");
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		refreshCatalog(controller.signal).catch(fail);
		return () => controller.abort();
	}, [refreshCatalog, fail]);
	useEffect(() => {
		const change = () => setCurrent(selectedId());
		window.addEventListener("hashchange", change);
		return () => window.removeEventListener("hashchange", change);
	}, []);
	const loadProject = useCallback(
		async (id: string, more = false, signal?: AbortSignal, pages = 1) => {
			projectRequests.current.get(id)?.abort();
			const controller = new AbortController();
			projectRequests.current.set(id, controller);
			const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
			const previous = rowsRef.current[id];
			setRows((old) => ({
				...old,
				[id]: {
					threads: previous?.threads ?? [],
					nextCursor: previous?.nextCursor ?? null,
					pages: previous?.pages ?? 0,
					loading: true,
				},
			}));
			try {
				let nextCursor = more ? previous?.nextCursor : undefined;
				let threads = more ? [...(previous?.threads ?? [])] : [];
				for (let page = 0; page < pages; page++) {
					const data = await request<ThreadPage>(
						`threads?project=${encodeURIComponent(id)}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`,
						requestSignal,
					);
					threads = [...threads, ...data.threads];
					nextCursor = data.nextCursor;
					if (!nextCursor) break;
				}
				if (requestSignal.aborted) return;
				setRows((old) => ({
					...old,
					[id]: {
						threads,
						nextCursor: nextCursor ?? null,
						pages: more ? (previous?.pages ?? 0) + 1 : pages,
						loading: false,
					},
				}));
			} catch (caught) {
				if (requestSignal.aborted) return;
				setRows((old) => (old[id] ? { ...old, [id]: { ...old[id], loading: false } } : old));
				fail(caught);
			}
		},
		[fail],
	);
	useEffect(() => {
		if (auth === "ready") return;
		for (const controller of projectRequests.current.values()) controller.abort();
		projectRequests.current.clear();
		initializedProjects.current.clear();
	}, [auth]);
	useEffect(() => {
		if (auth !== "ready") return;
		const added = catalog.projects.filter((project) => !initializedProjects.current.has(project.id));
		if (!added.length) return;
		for (const project of added) {
			initializedProjects.current.add(project.id);
			loadProject(project.id);
		}
		setExpanded((old) => new Set([...old, ...added.map((project) => project.id)]));
	}, [catalog.projects, auth, loadProject]);
	useEffect(() => {
		if (auth !== "ready") return;
		const controller = new AbortController();
		const source = new EventSource("/viewer/api/events");
		let timer: ReturnType<typeof setTimeout> | undefined;
		let checking = false;
		source.onopen = () => {
			setConnected(true);
			checking = false;
		};
		source.addEventListener("catalog", () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				refreshCatalog(controller.signal).catch(fail);
				for (const id of expandedRef.current)
					loadProject(id, false, controller.signal, rowsRef.current[id]?.pages || 1);
			}, 120);
		});
		source.onerror = () => {
			setConnected(false);
			if (!checking) {
				checking = true;
				request<Catalog>("projects", controller.signal).catch(fail);
			}
		};
		return () => {
			source.close();
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [auth, fail, refreshCatalog, loadProject]);
	useEffect(() => {
		if (auth !== "ready" || !current) {
			setThread(null);
			return;
		}
		const controller = new AbortController();
		selectionController.current = controller;
		let source: EventSource | undefined;
		let frame = 0;
		let updates: ViewerUpdate[] = [];
		setThread(null);
		setRounds([]);
		roundsRef.current = [];
		setCursor(null);
		setLoadingThread(true);
		setLoadingOlder(false);
		olderHistory.cancel();
		setError("");
		request<{ thread: ViewerThread }>(`threads/${encodeURIComponent(current)}`, controller.signal)
			.then((data) => {
				if (controller.signal.aborted) return;
				setThread(data.thread);
				source = new EventSource(`/viewer/api/threads/${encodeURIComponent(current)}/events`);
				source.addEventListener("snapshot", (event: MessageEvent<string>) => {
					const snapshot = JSON.parse(event.data) as Snapshot;
					if (controller.signal.aborted) return;
					cancelAnimationFrame(frame);
					frame = 0;
					updates = [];
					const merged = mergeRecentRounds(roundsRef.current, snapshot.rounds);
					if (!snapshot.rounds.length || !roundsRef.current.some((round) => round.id === snapshot.rounds[0].id)) {
						olderHistory.cancel();
						setLoadingOlder(false);
					}
					setThread(snapshot.thread);
					setRounds(merged.rounds);
					if (!merged.preservedOlder) setCursor(snapshot.nextCursor);
					setLoadingThread(false);
				});
				source.addEventListener("update", (event: MessageEvent<string>) => {
					updates.push(JSON.parse(event.data) as ViewerUpdate);
					if (frame) return;
					frame = requestAnimationFrame(() => {
						frame = 0;
						if (controller.signal.aborted) return;
						const pending = updates;
						updates = [];
						setThread(pending[pending.length - 1].thread);
						let replacement: Extract<ViewerUpdate, { replace: true }> | undefined;
						let committed: ViewerMessage[] = [];
						for (const update of pending) {
							if (update.replace) {
								replacement = update;
								committed = [];
							} else if (update.append) committed.push(...update.append);
						}
						if (replacement) {
							olderHistory.cancel();
							setLoadingOlder(false);
							setRounds(appendMessages(replacement.rounds, committed));
							setCursor(replacement.nextCursor);
						} else if (committed.length) setRounds((old) => appendMessages(old, committed));
					});
				});
				source.addEventListener("deleted", () => {
					if (controller.signal.aborted) return;
					source?.close();
					cancelAnimationFrame(frame);
					updates = [];
					setThread(null);
					setRounds([]);
					setLoadingThread(false);
					setError("");
					window.location.hash = "/";
					setCurrent(null);
					refreshCatalog().catch(fail);
				});
				source.onerror = () => {
					if (controller.signal.aborted) return;
					setThread((old) => (old ? { ...old, status: "disconnected" } : old));
					request<Catalog>("projects", controller.signal).catch(fail);
				};
			})
			.catch((caught) => {
				if (!controller.signal.aborted) {
					setLoadingThread(false);
					fail(caught);
				}
			});
		return () => {
			controller.abort();
			olderHistory.cancel();
			source?.close();
			cancelAnimationFrame(frame);
		};
	}, [current, auth, fail, refreshCatalog, olderHistory]);
	function select(id: string) {
		window.location.hash = `/thread/${encodeURIComponent(id)}`;
		setDrawer(false);
	}
	function home() {
		window.location.hash = "/";
		setCurrent(null);
		setDrawer(false);
	}
	function toggleProject(id: string) {
		setExpanded((old) => {
			const next = new Set(old);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
		if (!expanded.has(id) && !rows[id]) loadProject(id);
	}
	async function loadOlder() {
		if (!current || !cursor || !selectionController.current) return;
		const controller = selectionController.current;
		setLoadingOlder(true);
		try {
			const result = await olderHistory.load(
				`threads/${encodeURIComponent(current)}/rounds?before=${encodeURIComponent(cursor)}`,
				controller.signal,
			);
			if (olderHistory.isCurrent(result.generation)) {
				if (result.page) {
					const data = result.page;
					setRounds((old) => [...data.rounds, ...old]);
					setCursor(data.nextCursor);
				}
				setLoadingOlder(false);
			}
		} catch (caught) {
			setLoadingOlder(false);
			fail(caught);
		}
	}
	async function logout() {
		try {
			const response = await fetch("/viewer/logout", { method: "POST", credentials: "same-origin" });
			if (!response.ok) throw new Error("退出登录失败");
			setAuth("login");
			setThread(null);
			setRounds([]);
			setCatalog({ projects: [], running: [] });
			setRows({});
			setExpanded(new Set());
		} catch (caught) {
			fail(caught);
		}
	}

	return {
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
		more: (id: string) => loadProject(id, true),
		login: () => {
			refreshCatalog().catch(fail);
		},
		retry: () => {
			setAuth("loading");
			refreshCatalog().catch(fail);
		},
	};
}
