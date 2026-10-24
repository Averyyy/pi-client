export type ViewerContent =
	| { type: "text"; text: string; phase?: "commentary" | "final_answer" }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "attachment"; label: string };

export interface ViewerMessage {
	id: string;
	role: string;
	content: string | ViewerContent[];
	timestamp: number;
	stopReason?: string;
	phase?: string;
	errorMessage?: string;
}

export interface ViewerTool {
	id: string;
	name: string;
	arguments: unknown;
	result?: { content: ViewerContent[]; isError?: boolean };
	status: "running" | "completed" | "error";
}

export interface ViewerLive {
	message: ViewerMessage | null;
	tools: ViewerTool[];
}

export interface ThreadSummary {
	id: string;
	title: string;
	projectId: string;
	cwd: string | null;
	status: "running" | "idle" | "disconnected" | "unknown";
	lastActiveAt: number | null;
}

export interface ViewerThread extends ThreadSummary {
	live: ViewerLive;
	legacy: boolean;
}

export interface ViewerProject {
	id: string;
	path: string | null;
	name: string;
	threadCount: number;
	revision: string;
	lastActiveAt: number | null;
}

export interface ViewerDeleteResult {
	deletedIds: string[];
	deletedCount: number;
	failed: { id: string; error: string }[];
}

export interface ViewerCatalog {
	projects: ViewerProject[];
	running: ThreadSummary[];
	revision: string;
}

export interface ViewerRound {
	id: string;
	messages: ViewerMessage[];
}

export type ViewerUpdate = { thread: ViewerThread } & (
	| { replace: true; refresh?: true; rounds: ViewerRound[]; nextCursor: string | null }
	| { replace?: false; append?: ViewerMessage[] }
);

export interface ObserverUpdate {
	sessionId: string;
	connectionId: string;
	sequence: number;
	cwd?: string;
	title?: string;
	lastActiveAt?: number | null;
	replace?: ViewerMessage[];
	append?: ViewerMessage[];
	status?: "running" | "idle";
	live?: ViewerLive;
}
