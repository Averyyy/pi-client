/*
MIT License

Copyright (c) 2026 Kashyab Ambarani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
/**
 * Devin streams thinking as a summary (`delta_thinking`) plus an opaque
 * `delta_signature` and a `delta_signature_type`. The signature is what lets the
 * server verify and continue a reasoning trace, so it has to travel back with the
 * thinking text on the next request — the official Devin CLI does exactly that.
 *
 * Pi stores a single opaque string per thinking block (`thinkingSignature`), so
 * a versioned JSON envelope retains the signature and its exact server type.
 */

export interface ChatThinking {
	/** Thinking text as sent by the server (already summarized upstream). */
	text: string;
	/** Opaque signature for server-side verification/continuation. */
	signature: string;
	/** `signature_type` reported by the server. */
	signatureType?: string;
	/** Server flagged the trace as redacted by safety filters. */
	redacted?: boolean;
}

/** Store `signature` in pi's `thinkingSignature` without losing the type. */
export function packThinkingSignature(signature: string, signatureType?: string): string {
	return JSON.stringify({ version: 1, signature, signatureType });
}

export function unpackThinkingSignature(value: string | undefined): {
	signature?: string;
	signatureType?: string;
} {
	if (!value) return {};
	const parsed: unknown = JSON.parse(value);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("signature" in parsed) ||
		typeof parsed.signature !== "string"
	)
		throw new Error("Invalid Devin thinking signature envelope");
	const signatureType = "signatureType" in parsed ? parsed.signatureType : undefined;
	if (signatureType !== undefined && typeof signatureType !== "string")
		throw new Error("Invalid Devin thinking signature type");
	return { signature: parsed.signature, signatureType };
}
