import { buildMetadata } from "./devin-metadata.ts";
import { encodeMessage, iterFields } from "./devin-wire.ts";

export async function mintUserJwt(
	apiKey: string,
	host: string,
	signal?: AbortSignal,
	fetchImpl = fetch,
): Promise<string> {
	const response = await fetchImpl(`${host}/exa.auth_pb.AuthService/GetUserJwt`, {
		method: "POST",
		headers: { "content-type": "application/proto", "connect-protocol-version": "1" },
		body: new Uint8Array(
			encodeMessage(
				1,
				buildMetadata({
					apiKey,
					sessionId: crypto.randomUUID(),
					requestId: BigInt(Date.now()),
					triggerId: crypto.randomUUID(),
				}),
			),
		),
		signal,
	});
	if (!response.ok)
		throw new Error(
			`Devin authentication failed (HTTP ${response.status}); run /login devin if the session was revoked`,
		);
	for (const field of iterFields(Buffer.from(await response.arrayBuffer()))) {
		if (field.num === 1 && Buffer.isBuffer(field.value) && field.value.length) return field.value.toString("utf8");
	}
	throw new Error("Devin authentication returned no user JWT");
}
