import { DEVIN_BASE_URL } from "./devin-constants.ts";
import { encodeMessage, encodeString, encodeTimestampBody, encodeVarintField } from "./devin-wire.ts";

export { DEVIN_BASE_URL };

/** Protocol client identity required by Devin Local; no installed CLI dependency. */
export function buildMetadata(input: {
	apiKey: string;
	userJwt?: string;
	sessionId: string;
	requestId: bigint;
	triggerId: string;
	discovery?: boolean;
}): Buffer {
	const name = input.discovery ? "chisel" : "devin-cli";
	const version = input.discovery ? "0.0.0-dev" : "3000.6.2";
	const token = input.apiKey.startsWith("devin-session-token$") ? input.apiKey : `devin-session-token$${input.apiKey}`;
	return Buffer.concat([
		encodeString(1, name),
		encodeString(2, version),
		encodeString(3, token),
		encodeString(4, "en"),
		encodeString(5, process.platform === "win32" ? "windows" : process.platform),
		encodeString(7, version),
		encodeVarintField(9, input.requestId),
		encodeString(10, input.sessionId),
		encodeString(12, "chisel"),
		encodeMessage(16, encodeTimestampBody()),
		...(input.userJwt ? [encodeString(21, input.userJwt)] : []),
		encodeString(25, input.triggerId),
		encodeString(28, "chisel"),
		...[3, 4, 6, 7, 8].map((value) => encodeVarintField(30, value)),
	]);
}
