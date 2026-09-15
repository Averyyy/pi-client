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
import * as zlib from "node:zlib";

export function encodeVarint(value: number | bigint): Buffer {
	const bytes: number[] = [];
	let v = BigInt(value);
	if (v < 0n) throw new RangeError(`encodeVarint: negative input (${value})`);
	while (v > 127n) {
		bytes.push(Number(v & 0x7fn) | 0x80);
		v >>= 7n;
	}
	bytes.push(Number(v));
	return Buffer.from(bytes);
}

export function encodeTag(fieldNum: number, wire: number): Buffer {
	return encodeVarint((fieldNum << 3) | wire);
}

export function encodeString(fieldNum: number, s: string): Buffer {
	const buf = Buffer.from(s, "utf8");
	return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}

export function encodeMessage(fieldNum: number, body: Buffer): Buffer {
	return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body]);
}

export function encodeVarintField(fieldNum: number, v: number | bigint): Buffer {
	return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(v)]);
}

export function encodeFixed64Field(fieldNum: number, v: number): Buffer {
	const b = Buffer.alloc(8);
	b.writeDoubleLE(v, 0);
	return Buffer.concat([encodeTag(fieldNum, 1), b]);
}

export function encodeTimestampBody(): Buffer {
	const now = Date.now();
	const seconds = Math.floor(now / 1000);
	const nanos = (now % 1000) * 1_000_000;
	return Buffer.concat([encodeVarintField(1, seconds), nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0)]);
}

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
	let res = 0n;
	let shift = 0n;
	let i = offset;
	while (i < buf.length) {
		const b = buf[i++];
		res |= BigInt(b & 0x7f) << shift;
		if (!(b & 0x80)) return [res, i];
		shift += 7n;
		if (shift >= 70n) throw new Error("Oversized protobuf varint");
	}
	throw new Error("truncated varint");
}

export interface ProtoField {
	num: number;
	wire: number;
	value: bigint | Buffer;
}

export function* iterFields(buf: Buffer): Generator<ProtoField> {
	let i = 0;
	while (i < buf.length) {
		const [tagBig, next] = decodeVarint(buf, i);
		i = next;
		const tag = Number(tagBig);
		const num = tag >> 3;
		if (num <= 0) throw new Error("Invalid protobuf field number");
		const wire = tag & 0x7;
		if (wire === 0) {
			const [v, after] = decodeVarint(buf, i);
			i = after;
			yield { num, wire, value: v };
		} else if (wire === 1) {
			if (i + 8 > buf.length) throw new Error("Truncated protobuf fixed64");
			yield { num, wire, value: buf.subarray(i, i + 8) };
			i += 8;
		} else if (wire === 2) {
			const [n, after] = decodeVarint(buf, i);
			i = after;
			const len = Number(n);
			if (!Number.isSafeInteger(len) || len < 0 || i + len > buf.length)
				throw new Error("Truncated protobuf message");
			yield { num, wire, value: buf.subarray(i, i + len) };
			i += len;
		} else if (wire === 5) {
			if (i + 4 > buf.length) throw new Error("Truncated protobuf fixed32");
			yield { num, wire, value: buf.subarray(i, i + 4) };
			i += 4;
		} else {
			throw new Error(`Unsupported protobuf wire type ${wire}`);
		}
	}
}

export function frameConnectStream(body: Buffer, compress = true): Buffer {
	let payload = body;
	let flags = 0;
	if (compress) {
		payload = zlib.gzipSync(body);
		flags |= 0x01;
	}
	const header = Buffer.alloc(5);
	header[0] = flags;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}
