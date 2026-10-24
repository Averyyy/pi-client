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

import type { ViewerDeleteResult } from "../src/viewer-types.ts";

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
