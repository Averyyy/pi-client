import { randomUUID } from "node:crypto";
import type { Api, AuthEvent, AuthInteraction, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { ChunkRequest } from "./pi-server-request.ts";

export type PiServerAccountProviderId = "devin" | "google-antigravity";

export interface PiServerAccount {
	providerId: PiServerAccountProviderId;
	loggedIn: boolean;
	models: Model<Api>[];
	updatedAt?: number;
	error?: string;
	account?: { email?: string; projectId?: string };
}

export interface PiServerAccountsSnapshot {
	accounts: PiServerAccount[];
}

export function isPiServerAccountProvider(providerId: string): providerId is PiServerAccountProviderId {
	return providerId === "devin" || providerId === "google-antigravity";
}

function request(signal?: AbortSignal): ChunkRequest {
	return new ChunkRequest({
		serverUrl: process.env.PI_SERVER_URL ?? "http://127.0.0.1:4217",
		authToken: process.env.PI_SERVER_AUTH_TOKEN ?? "",
		signal,
	});
}

async function requireSuccess(response: Response): Promise<void> {
	if (response.ok) return;
	throw new Error(`pi-server account request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
}

export async function readPiServerAccounts(signal?: AbortSignal): Promise<PiServerAccountsSnapshot> {
	const response = await request(signal).getJson("/api/accounts");
	await requireSuccess(response);
	return response.json() as Promise<PiServerAccountsSnapshot>;
}

export async function refreshPiServerAccounts(
	providerId: PiServerAccountProviderId | undefined,
	signal?: AbortSignal,
): Promise<PiServerAccountsSnapshot> {
	const response = await request(signal).postJson("/api/accounts/refresh", { providerId });
	await requireSuccess(response);
	return response.json() as Promise<PiServerAccountsSnapshot>;
}

export async function logoutPiServerAccount(
	providerId: PiServerAccountProviderId,
	signal?: AbortSignal,
): Promise<PiServerAccountsSnapshot> {
	const response = await request(signal).postJson("/api/accounts/logout", { providerId });
	await requireSuccess(response);
	return response.json() as Promise<PiServerAccountsSnapshot>;
}

export async function loginPiServerAccount(
	providerId: PiServerAccountProviderId,
	interaction: AuthInteraction,
): Promise<PiServerAccountsSnapshot> {
	const loginId = randomUUID();
	const controller = new AbortController();
	const signal = interaction.signal ? AbortSignal.any([interaction.signal, controller.signal]) : controller.signal;
	const prompts = new Map<string, AbortController>();
	const replies = new Set<Promise<void>>();
	let snapshot: PiServerAccountsSnapshot | undefined;
	try {
		const response = await request(signal).postJson("/api/accounts/login", { providerId, loginId });
		await requireSuccess(response);
		if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
			throw new Error("pi-server account login requires an event stream");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		let eventName = "";
		let data: string[] = [];
		const dispatch = (): void => {
			if (data.length === 0) return;
			const value = JSON.parse(data.join("\n")) as unknown;
			if (eventName === "notify") interaction.notify(value as AuthEvent);
			else if (eventName === "prompt") {
				const { promptId, prompt } = value as { promptId: string; prompt: Omit<AuthPrompt, "signal"> };
				const promptController = new AbortController();
				prompts.set(promptId, promptController);
				const reply = (async () => {
					try {
						const promptSignal = AbortSignal.any([signal, promptController.signal]);
						const value = await raceWithAbortSignal(
							interaction.prompt({ ...prompt, signal: promptSignal } as AuthPrompt),
							promptSignal,
						);
						if (promptController.signal.aborted) return;
						const response = await request(signal).postJson("/api/accounts/login/reply", {
							loginId,
							promptId,
							value,
						});
						await requireSuccess(response);
					} catch (error) {
						if (!promptController.signal.aborted) controller.abort(error);
					} finally {
						prompts.delete(promptId);
					}
				})();
				replies.add(reply);
				void reply.finally(() => replies.delete(reply));
			} else if (eventName === "prompt_cancel") {
				prompts.get((value as { promptId: string }).promptId)?.abort();
			} else if (eventName === "done") snapshot = value as PiServerAccountsSnapshot;
			else if (eventName === "error") throw new Error((value as { error: string }).error);
		};
		try {
			while (snapshot === undefined) {
				const { value, done } = await reader.read();
				pending += decoder.decode(value, { stream: !done });
				let end = pending.indexOf("\n");
				while (end >= 0) {
					const line = pending.slice(0, end).replace(/\r$/u, "");
					pending = pending.slice(end + 1);
					if (line === "") {
						dispatch();
						eventName = "";
						data = [];
					} else if (line.startsWith("event:")) eventName = line.slice(6).trim();
					else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
					end = pending.indexOf("\n");
				}
				if (done) break;
			}
			if (!snapshot) throw new Error("pi-server account login ended without a result");
			return snapshot;
		} finally {
			await reader.cancel();
		}
	} catch (error) {
		const cancellation = await request(AbortSignal.timeout(15_000)).postJson("/api/accounts/login/cancel", {
			loginId,
		});
		await requireSuccess(cancellation);
		throw controller.signal.aborted ? controller.signal.reason : error;
	} finally {
		for (const prompt of prompts.values()) prompt.abort();
		await Promise.all(replies);
	}
}
