import type { AgentSession } from "./agent-session.ts";

export interface ObserverSubagent {
	agentId: string;
	sessionId: string;
	title: string;
	taskStatus: "queued" | "running" | "completed" | "steered" | "error" | "stopped" | "aborted";
}

interface SubagentRecord {
	type: string;
	description: string;
	status: ObserverSubagent["taskStatus"];
	session?: { sessionId: string };
}

interface SubagentRegistry {
	getRecord(id: string): SubagentRecord | undefined;
}

const registryKey = Symbol.for("pi-subagents:manager");
const pendingBridges = new Set<PiServerSubagents>();

/** Child sessions begin running after pi-subagents attaches them to their task record. */
export function resolvePiServerSubagents(): void {
	for (const bridge of pendingBridges) bridge.resolve();
}

/** Adapts tintinweb's exact task identities and lifecycle to viewer session identities. */
export class PiServerSubagents {
	private readonly session: AgentSession;
	private readonly onChange: () => void;
	private readonly pending = new Set<string>();
	private readonly tasks = new Map<string, ObserverSubagent>();
	private subscriptions: (() => void)[] = [];
	private sessionId?: string;
	version = 0;

	constructor(session: AgentSession, onChange: () => void) {
		this.session = session;
		this.onChange = onChange;
		this.syncSession();
	}

	syncSession(): void {
		if (this.sessionId === this.session.sessionId) return;
		this.dispose();
		this.sessionId = this.session.sessionId;
		this.restore();
		const events = this.session.resourceLoader.getEventBus?.();
		if (!events) return;
		const sessionId = this.sessionId;
		this.subscriptions = ["started", "created", "completed", "failed"].map((event) =>
			events.on(`subagents:${event}`, (data) => {
				if (this.session.sessionId !== sessionId) return;
				const { id } = data as { id: string };
				this.pending.add(id);
				pendingBridges.add(this);
				this.resolve();
			}),
		);
	}

	restore(): void {
		let snapshot: ObserverSubagent[] = [];
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "pi-server-subagent") continue;
			snapshot = (entry.data as { subagents: ObserverSubagent[] }).subagents;
		}
		if (
			snapshot.length === this.tasks.size &&
			snapshot.every((task) => {
				const current = this.tasks.get(task.sessionId);
				return (
					current?.agentId === task.agentId &&
					current.title === task.title &&
					current.taskStatus === task.taskStatus
				);
			})
		)
			return;
		this.tasks.clear();
		for (const task of snapshot) this.tasks.set(task.sessionId, task);
		this.version++;
	}

	resolve(): void {
		if (this.sessionId !== this.session.sessionId) {
			this.syncSession();
			return;
		}
		const registry = (globalThis as Record<symbol, SubagentRegistry | undefined>)[registryKey];
		let changed = false;
		for (const agentId of this.pending) {
			const record = registry?.getRecord(agentId);
			if (!record) continue;
			const active = record.status === "running" || record.status === "queued";
			if (!record.session) {
				if (!active) this.pending.delete(agentId);
				continue;
			}
			const task: ObserverSubagent = {
				agentId,
				sessionId: record.session.sessionId,
				title: record.description || record.type,
				taskStatus: record.status,
			};
			this.pending.delete(agentId);
			const previous = this.tasks.get(task.sessionId);
			if (
				previous?.agentId === task.agentId &&
				previous.title === task.title &&
				previous.taskStatus === task.taskStatus
			)
				continue;
			this.tasks.set(task.sessionId, task);
			changed = true;
		}
		if (this.pending.size === 0) pendingBridges.delete(this);
		if (!changed) return;
		this.version++;
		this.session.sessionManager.appendCustomEntry("pi-server-subagent", { subagents: this.snapshot() });
		this.onChange();
	}

	snapshot(): ObserverSubagent[] {
		return [...this.tasks.values()];
	}

	dispose(): void {
		for (const unsubscribe of this.subscriptions) unsubscribe();
		this.subscriptions = [];
		this.pending.clear();
		pendingBridges.delete(this);
	}
}
