import type { ViewerContent, ViewerMessage, ViewerRound } from "../src/viewer-types.ts";

export type Outcome = "pending" | "complete" | "failed" | "stopped" | "incomplete";

export function messageParts(message: ViewerMessage): ViewerContent[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

export function outcome(message: ViewerMessage | undefined): Outcome {
	switch (message?.stopReason) {
		case "stop":
			return "complete";
		case "error":
			return "failed";
		case "aborted":
			return "stopped";
		case "length":
			return "incomplete";
		default:
			return "pending";
	}
}

export function isFinal(message: ViewerMessage): boolean {
	if (message.role !== "assistant") return false;
	const parts = messageParts(message);
	if (parts.some((part) => part.type === "toolCall")) return false;
	const hasFinalPhase = parts.some((part) => part.type === "text" && part.phase === "final_answer");
	if (message.phase === "commentary" && !hasFinalPhase) return false;
	const hasOutput = parts.some(
		(part) =>
			part.type === "attachment" ||
			(part.type === "text" && part.phase !== "commentary" && part.text.trim().length > 0),
	);
	if (!hasOutput && !message.errorMessage && message.stopReason !== "aborted") return false;
	return hasFinalPhase || message.phase === "final_answer" || outcome(message) !== "pending";
}

export function partitionRound(messages: readonly ViewerMessage[]) {
	const userIndex = messages.findIndex((message) => message.role === "user");
	const leading = userIndex < 0 ? [] : messages.slice(0, userIndex + 1);
	const content = messages.slice(userIndex + 1);
	const lastAssistant = content.findLastIndex((message) => message.role === "assistant");
	const candidate = content[lastAssistant];
	const result = outcome(candidate);
	if (!candidate || !isFinal(candidate))
		return { leading, process: content, response: undefined, trailing: [], outcome: result };
	const process = content.slice(0, lastAssistant);
	const activity = messageParts(candidate).filter(
		(part) =>
			part.type === "thinking" || part.type === "toolCall" || (part.type === "text" && part.phase === "commentary"),
	);
	if (activity.length) process.push({ ...candidate, content: activity });
	return {
		leading,
		process,
		response: {
			...candidate,
			content: messageParts(candidate).filter(
				(part) =>
					part.type !== "thinking" &&
					part.type !== "toolCall" &&
					!(part.type === "text" && part.phase === "commentary"),
			),
		},
		trailing: content.slice(lastAssistant + 1),
		outcome: result,
	};
}

export function appendMessages(rounds: readonly ViewerRound[], messages: readonly ViewerMessage[]): ViewerRound[] {
	const next = [...rounds];
	const known = new Set(next.flatMap((round) => round.messages.map((message) => message.id)));
	for (const message of messages) {
		if (known.has(message.id)) continue;
		if (next.length === 0 || message.role === "user") next.push({ id: message.id, messages: [message] });
		else {
			const last = next[next.length - 1];
			next[next.length - 1] = { ...last, messages: [...last.messages, message] };
		}
		known.add(message.id);
	}
	return next;
}

export function mergeRecentRounds(previous: readonly ViewerRound[], recent: ViewerRound[]) {
	const anchor = recent.length ? previous.findIndex((round) => round.id === recent[0].id) : -1;
	return { rounds: anchor > 0 ? [...previous.slice(0, anchor), ...recent] : recent, preservedOlder: anchor > 0 };
}
