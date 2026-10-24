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
	let buffer = "";
	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done || signal.aborted) return;
			buffer += decoder.decode(value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end !== -1) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				let event = "";
				let data = "";
				for (const line of frame.split("\n")) {
					if (line.startsWith("event: ")) event = line.slice(7);
					else if (line.startsWith("data: ")) data = line.slice(6);
				}
				if (event && receive(event, data) === false) return;
				end = buffer.indexOf("\n\n");
			}
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
