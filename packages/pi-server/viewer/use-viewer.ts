import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ThreadSummary,
	ViewerMessage,
	ViewerProject,
	ViewerRound,
	ViewerThread,
	ViewerUpdate,
} from "../src/viewer-types.ts";
import { ApiError, deleteSessions, readThreadEvents, request } from "./api.ts";
import { appendMessages, mergeRecentRounds } from "./rounds.ts";

interface Catalog {
	revision: string;
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
		this.controller = null;
		this.generation++;
	}
	get loading() {
		return this.controller !== null;
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
		} finally {
			if (this.controller === controller) this.controller = null;
		}
	}
}
interface Snapshot extends RoundPage {
	thread: ViewerThread;
}
export interface ProjectRows extends ThreadPage {
	revision: string;
	loading: boolean;
	pages: number;
}

export class CatalogRequest {
	private active: { controller: AbortController; dirty: boolean; promise: Promise<void> } | null = null;

	cancel() {
		this.active?.controller.abort();
		this.active = null;
	}

	load(apply: (catalog: Catalog) => void): Promise<void> {
		if (this.active) {
			this.active.dirty = true;
			return this.active.promise;
		}
		const active = { controller: new AbortController(), dirty: false, promise: Promise.resolve() };
		this.active = active;
		active.promise = (async () => {
			try {
				do {
					active.dirty = false;
					const data = await request<Catalog>("projects", active.controller.signal);
					if (active.controller.signal.aborted) return;
					apply(data);
				} while (active.dirty);
			} catch (error) {
				if (!active.controller.signal.aborted) throw error;
			} finally {
				if (this.active === active) this.active = null;
			}
		})();
		return active.promise;
	}
}

export class ProjectCache {
	rows: Record<string, ProjectRows> = {};
	readonly expanded = new Set<string>();
	private revisions = new Map<string, string>();
	private readonly visible = new Map<string, Set<string>>();
	private readonly requests = new Map<
		string,
		{ controller: AbortController; revision: string; promise: Promise<void> }
	>();
	private readonly changed: (rows: Record<string, ProjectRows>) => void;
	private readonly failed: (error: unknown) => void;

	constructor(changed: (rows: Record<string, ProjectRows>) => void, failed: (error: unknown) => void) {
		this.changed = changed;
		this.failed = failed;
	}

	clear() {
		for (const request of this.requests.values()) request.controller.abort();
		this.requests.clear();
		this.revisions.clear();
		this.expanded.clear();
		this.visible.clear();
		this.rows = {};
		this.changed(this.rows);
	}

	updateCatalog(projects: ViewerProject[]) {
		const revisions = new Map(projects.map((project) => [project.id, project.revision]));
		for (const project of projects) if (!this.revisions.has(project.id)) this.expanded.add(project.id);
		for (const [id, request] of this.requests) {
			if (request.revision === revisions.get(id)) continue;
			request.controller.abort();
			this.requests.delete(id);
			if (this.rows[id]) this.rows = { ...this.rows, [id]: { ...this.rows[id], loading: false } };
		}
		for (const id of this.revisions.keys()) {
			if (revisions.has(id)) continue;
			this.expanded.delete(id);
			this.visible.delete(id);
			const { [id]: _removed, ...remaining } = this.rows;
			this.rows = remaining;
		}
		this.revisions = revisions;
		this.changed(this.rows);
		for (const id of this.visible.keys()) this.ensure(id);
	}

	setVisible(id: string, surface: string, visible: boolean) {
		const surfaces = this.visible.get(id) ?? new Set<string>();
		if (visible) surfaces.add(surface);
		else surfaces.delete(surface);
		if (surfaces.size) this.visible.set(id, surfaces);
		else this.visible.delete(id);
		this.ensure(id);
	}

	toggle(id: string) {
		if (this.expanded.has(id)) this.expanded.delete(id);
		else this.expanded.add(id);
		this.ensure(id);
	}

	removeThreads(ids: string[], projectId: string) {
		if (!ids.length) return;
		this.requests.get(projectId)?.controller.abort();
		this.requests.delete(projectId);
		const deleted = new Set(ids);
		const rows = this.rows[projectId];
		if (rows) {
			this.rows = {
				...this.rows,
				[projectId]: {
					...rows,
					threads: rows.threads.filter((thread) => !deleted.has(thread.id)),
					revision: "",
					loading: false,
				},
			};
			this.changed(this.rows);
		}
	}

	private ensure(id: string) {
		if (this.expanded.has(id) && this.visible.has(id) && this.rows[id]?.revision !== this.revisions.get(id))
			void this.load(id);
	}

	load(id: string, more = false): Promise<void> {
		const revision = this.revisions.get(id);
		if (revision === undefined) return Promise.resolve();
		const pending = this.requests.get(id);
		if (pending?.revision === revision) return pending.promise;
		const previous = this.rows[id];
		const append = more && previous?.revision === revision;
		if (append && !previous.nextCursor) return Promise.resolve();
		const controller = new AbortController();
		this.rows = {
			...this.rows,
			[id]: {
				threads: previous?.threads ?? [],
				nextCursor: previous?.nextCursor ?? null,
				pages: previous?.pages ?? 0,
				revision: previous?.revision ?? "",
				loading: true,
			},
		};
		this.changed(this.rows);
		const promise = (async () => {
			try {
				let nextCursor = append ? previous.nextCursor : null;
				const threads = append ? [...previous.threads] : [];
				const pages = append ? 1 : Math.max(1, (previous?.pages ?? 0) + (more ? 1 : 0));
				let loaded = 0;
				for (; loaded < pages; loaded++) {
					const data = await request<ThreadPage>(
						`threads?project=${encodeURIComponent(id)}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`,
						controller.signal,
					);
					if (controller.signal.aborted) return;
					threads.push(...data.threads);
					nextCursor = data.nextCursor;
					if (!nextCursor) {
						loaded++;
						break;
					}
				}
				this.rows = {
					...this.rows,
					[id]: {
						threads,
						nextCursor,
						revision,
						pages: append ? previous.pages + loaded : loaded,
						loading: false,
					},
				};
				this.changed(this.rows);
			} catch (error) {
				if (controller.signal.aborted) return;
				this.rows = { ...this.rows, [id]: { ...this.rows[id], loading: false } };
				this.changed(this.rows);
				this.failed(error);
			} finally {
				if (this.requests.get(id)?.controller === controller) this.requests.delete(id);
			}
		})();
		this.requests.set(id, { controller, revision, promise });
		return promise;
	}
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
	const [catalog, setCatalog] = useState<Catalog>({ revision: "", projects: [], running: [] });
	const [current, setCurrent] = useState(selectedId);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [rows, setRows] = useState<Record<string, ProjectRows>>({});
	const [thread, setThread] = useState<ViewerThread | null>(null);
	const [rounds, setRounds] = useState<ViewerRound[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [olderError, setOlderError] = useState("");
	const [historyVersion, setHistoryVersion] = useState(0);
	const [loadingThread, setLoadingThread] = useState(false);
	const [error, setError] = useState("");
	const [catalogError, setCatalogError] = useState("");
	const [drawer, setDrawer] = useState(false);
	const [connected, setConnected] = useState(true);
	const [threadConnected, setThreadConnected] = useState(true);
	const [threadAttempt, setThreadAttempt] = useState(0);
	const authBlocked = useRef(false);
	const [olderHistory] = useState(() => new OlderHistoryRequest());
	const failure = useRef<(error: unknown) => void>(() => {});
	const [projects] = useState(() => new ProjectCache(setRows, (error) => failure.current(error)));
	const catalogRef = useRef(catalog);
	const [catalogRequest] = useState(() => new CatalogRequest());
	const roundsRef = useRef(rounds);
	const selectionController = useRef<AbortController | null>(null);
	const commitRounds = useCallback((next: ViewerRound[]) => {
		roundsRef.current = next;
		setRounds(next);
	}, []);
	const fail = useCallback(
		(caught: unknown) => {
			if (caught instanceof DOMException && caught.name === "AbortError") return;
			if (caught instanceof ApiError && (caught.status === 401 || caught.status === 423)) {
				authBlocked.current = true;
				selectionController.current?.abort();
				setAuth("login");
				setLocked(caught.status === 423);
				setThread(null);
				commitRounds([]);
				setCatalog({ revision: "", projects: [], running: [] });
				catalogRef.current = { revision: "", projects: [], running: [] };
				catalogRequest.cancel();
				projects.clear();
				setExpanded(new Set());
			} else setError(caught instanceof Error ? caught.message : "无法读取服务器数据");
		},
		[projects, catalogRequest, commitRounds],
	);
	failure.current = fail;
	const refreshCatalog = useCallback(async () => {
		try {
			await catalogRequest.load((data) => {
				if (authBlocked.current) return;
				catalogRef.current = data;
				projects.updateCatalog(data.projects);
				setExpanded(new Set(projects.expanded));
				setCatalog(data);
				setAuth("ready");
				setCatalogError("");
			});
		} catch (caught) {
			if (caught instanceof ApiError && (caught.status === 401 || caught.status === 423)) throw caught;
			setCatalogError(caught instanceof Error ? caught.message : "无法读取服务器数据");
		}
	}, [projects, catalogRequest]);
	useEffect(() => {
		refreshCatalog().catch(fail);
		return () => catalogRequest.cancel();
	}, [refreshCatalog, fail, catalogRequest]);
	useEffect(() => {
		const change = () => setCurrent(selectedId());
		window.addEventListener("hashchange", change);
		return () => window.removeEventListener("hashchange", change);
	}, []);
	useEffect(
		() => () => {
			projects.clear();
		},
		[projects],
	);
	const projectVisibility = useCallback(
		(id: string, surface: string, visible: boolean) => {
			projects.setVisible(id, surface, visible);
		},
		[projects],
	);
	const canWatchCatalog = auth === "ready" && catalog.revision !== "";
	useEffect(() => {
		if (!canWatchCatalog) return;
		const source = new EventSource("/viewer/api/events");
		let timer: ReturnType<typeof setTimeout> | undefined;
		let checking = false;
		source.onopen = () => {
			setConnected(true);
			checking = false;
		};
		source.addEventListener("catalog", (event: MessageEvent<string>) => {
			const { revision } = JSON.parse(event.data) as { revision: string };
			if (revision === catalogRef.current.revision) return;
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				refreshCatalog().catch(fail);
			}, 120);
		});
		source.onerror = () => {
			setConnected(false);
			if (!checking) {
				checking = true;
				refreshCatalog().catch(fail);
			}
		};
		return () => {
			source.close();
			if (timer) clearTimeout(timer);
		};
	}, [canWatchCatalog, fail, refreshCatalog]);
	const canLoadThread = auth !== "login";
	// biome-ignore lint/correctness/useExhaustiveDependencies: threadAttempt restarts the stream for an explicit retry.
	useEffect(() => {
		if (!canLoadThread || !current) {
			setThread(null);
			setThreadConnected(true);
			return;
		}
		const id = current;
		const controller = new AbortController();
		selectionController.current = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let frame = 0;
		let updates: ViewerUpdate[] = [];
		setThread(null);
		commitRounds([]);
		setCursor(null);
		setLoadingThread(true);
		setThreadConnected(true);
		setLoadingOlder(false);
		setOlderError("");
		setHistoryVersion((version) => version + 1);
		olderHistory.cancel();
		setError("");
		function flushUpdates() {
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
				const merged = mergeRecentRounds(roundsRef.current, replacement.rounds);
				if (
					!replacement.rounds.length ||
					!roundsRef.current.some((round) => round.id === replacement.rounds[0].id)
				) {
					olderHistory.cancel();
					setLoadingOlder(false);
					setOlderError("");
					setHistoryVersion((version) => version + 1);
				}
				commitRounds(appendMessages(merged.rounds, committed));
				if (!merged.preservedOlder) setCursor(replacement.nextCursor);
			} else if (committed.length) commitRounds(appendMessages(roundsRef.current, committed));
		}
		async function connect() {
			try {
				let deleted = false;
				await readThreadEvents(id, controller.signal, (event, data) => {
					if (controller.signal.aborted) return;
					if (event === "snapshot") {
						const snapshot = JSON.parse(data) as Snapshot;
						cancelAnimationFrame(frame);
						frame = 0;
						updates = [];
						const merged = mergeRecentRounds(roundsRef.current, snapshot.rounds);
						if (
							!snapshot.rounds.length ||
							!roundsRef.current.some((round) => round.id === snapshot.rounds[0].id)
						) {
							olderHistory.cancel();
							setLoadingOlder(false);
							setOlderError("");
							setHistoryVersion((version) => version + 1);
						}
						setThread(snapshot.thread);
						commitRounds(merged.rounds);
						if (!merged.preservedOlder) setCursor(snapshot.nextCursor);
						setLoadingThread(false);
						setThreadConnected(true);
						setAuth("ready");
						setError("");
					} else if (event === "update") {
						updates.push(JSON.parse(data) as ViewerUpdate);
						if (frame) return;
						frame = requestAnimationFrame(flushUpdates);
					} else if (event === "deleted") {
						deleted = true;
						cancelAnimationFrame(frame);
						updates = [];
						setThread(null);
						commitRounds([]);
						setLoadingThread(false);
						setError("");
						window.location.hash = "/";
						setCurrent(null);
						refreshCatalog().catch(fail);
						return false;
					}
				});
				if (deleted || controller.signal.aborted) return;
			} catch (caught) {
				if (controller.signal.aborted) return;
				setLoadingThread(false);
				fail(caught);
				if (caught instanceof ApiError && caught.status === 404) {
					setThread(null);
					setThreadConnected(true);
					commitRounds([]);
				}
				if (caught instanceof ApiError && [401, 423, 404].includes(caught.status)) return;
			}
			if (!controller.signal.aborted) {
				cancelAnimationFrame(frame);
				if (updates.length) flushUpdates();
				setLoadingThread(false);
				setThreadConnected(false);
				setThread((old) => (old ? { ...old, status: "disconnected" } : old));
				timer = setTimeout(() => {
					timer = undefined;
					void connect();
				}, 3000);
			}
		}
		void connect();
		return () => {
			controller.abort();
			olderHistory.cancel();
			if (timer) clearTimeout(timer);
			cancelAnimationFrame(frame);
		};
	}, [current, canLoadThread, threadAttempt, fail, refreshCatalog, olderHistory, commitRounds]);
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
		projects.toggle(id);
		setExpanded(new Set(projects.expanded));
	}
	async function loadOlder() {
		if (!current || !cursor || !selectionController.current || olderHistory.loading) return false;
		const controller = selectionController.current;
		setLoadingOlder(true);
		setOlderError("");
		try {
			const result = await olderHistory.load(
				`threads/${encodeURIComponent(current)}/rounds?before=${encodeURIComponent(cursor)}`,
				controller.signal,
			);
			if (olderHistory.isCurrent(result.generation)) {
				if (result.page) {
					const data = result.page;
					commitRounds([...data.rounds, ...roundsRef.current]);
					setCursor(data.nextCursor);
				}
				setLoadingOlder(false);
				return Boolean(result.page?.rounds.length);
			}
		} catch (caught) {
			if (!controller.signal.aborted) {
				setLoadingOlder(false);
				setOlderError(caught instanceof Error ? caught.message : "无法读取更早的对话");
				if (caught instanceof ApiError && (caught.status === 401 || caught.status === 423)) fail(caught);
			}
		}
		return false;
	}
	async function remove(kind: "project" | "thread", id: string, projectId: string) {
		try {
			const result = await deleteSessions(kind, id);
			catalogRequest.cancel();
			projects.removeThreads(result.deletedIds, projectId);
			if (current && result.deletedIds.includes(current)) home();
			refreshCatalog().catch(fail);
			return result;
		} catch (caught) {
			if (caught instanceof ApiError && (caught.status === 401 || caught.status === 423)) fail(caught);
			throw caught;
		}
	}
	async function logout() {
		try {
			const response = await fetch("/viewer/logout", { method: "POST", credentials: "same-origin" });
			if (!response.ok) throw new Error("退出登录失败");
			authBlocked.current = true;
			selectionController.current?.abort();
			setAuth("login");
			setThread(null);
			commitRounds([]);
			setCatalog({ revision: "", projects: [], running: [] });
			catalogRef.current = { revision: "", projects: [], running: [] };
			catalogRequest.cancel();
			projects.clear();
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
		olderError,
		historyVersion,
		loadingThread,
		error: error || catalogError,
		drawer,
		connected: connected && threadConnected,
		setDrawer,
		select,
		home,
		toggleProject,
		loadOlder,
		remove,
		logout,
		projectVisibility,
		more: (id: string) => projects.load(id, true),
		login: () => {
			authBlocked.current = false;
			setAuth("loading");
			refreshCatalog().catch(fail);
		},
		retry: () => {
			setError("");
			setThreadAttempt((attempt) => attempt + 1);
			refreshCatalog().catch(fail);
		},
	};
}
