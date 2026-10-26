import type { ViewerDeleteResult } from "../src/viewer-types.ts";

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`/viewer/api/${path}`, { signal, credentials: "same-origin" });
	if (!response.ok)
		throw new ApiError(response.status, response.status === 404 ? "对话不存在或已被移除" : "暂时无法读取对话");
	return response.json() as Promise<T>;
}

export async function readThreadEvents(
	id: string,
	signal: AbortSignal,
	receive: (event: string, data: string) => boolean | undefined,
): Promise<void> {
	const response = await fetch(`/viewer/api/threads/${encodeURIComponent(id)}/events`, {
		signal,
		credentials: "same-origin",
	});
	if (!response.ok)
		throw new ApiError(response.status, response.status === 404 ? "对话不存在或已被移除" : "暂时无法读取对话");
	if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream")
		throw new Error("服务器返回了无效的对话事件流");
	if (!response.body) throw new Error("对话事件流为空");
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel);
	const decoder = new TextDecoder();
	let lineParts: string[] = [];
	let event = "";
	let data = "";
	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done || signal.aborted) return;
			const chunk = decoder.decode(value, { stream: true });
			let start = 0;
			let end = chunk.indexOf("\n");
			while (end !== -1) {
				lineParts.push(chunk.slice(start, end));
				const line = lineParts.join("");
				lineParts = [];
				if (line === "") {
					if (event && receive(event, data) === false) return;
					event = "";
					data = "";
				} else if (line.startsWith("event: ")) event = line.slice(7);
				else if (line.startsWith("data: ")) data = line.slice(6);
				start = end + 1;
				end = chunk.indexOf("\n", start);
			}
			if (start < chunk.length) lineParts.push(chunk.slice(start));
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel();
		reader.releaseLock();
	}
}

export async function deleteSessions(kind: "project" | "thread", id: string): Promise<ViewerDeleteResult> {
	const response = await fetch(
		`/viewer/api/${kind === "project" ? "projects" : "threads"}/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
			credentials: "same-origin",
		},
	);
	if (!response.ok) throw new ApiError(response.status, "无法删除服务器对话，请重试");
	return response.json() as Promise<ViewerDeleteResult>;
}
