/**
 * Chunk decoder that survives Chinese Windows output.
 *
 * The problem this solves (field, repeatedly): `cmd.exe` and most System32
 * tools write GBK (CP936) to a PIPE, while our decoder assumed UTF-8. Every
 * Chinese path or filename in the output turned to mojibake, and the model's
 * only documented workaround was "give up on the output and use
 * list_directory instead" — a tool making the model work around the tool.
 *
 * `chcp 65001` is NOT sufficient: it changes the console code page, but a
 * child writing to a pipe uses the ANSI locale code page. `PYTHONUTF8=1` fixes
 * python specifically, not `tasklist`, `dir`, or anything else.
 *
 * ## How it decides
 *
 * Three outcomes, not two:
 *   - `valid`      — the bytes are complete UTF-8. Lock to UTF-8.
 *   - `incomplete` — a truncated UTF-8 sequence at the tail. HOLD the bytes and
 *                    wait for the next chunk; never guess GBK here, or a UTF-8
 *                    character split across a chunk boundary becomes mojibake.
 *   - `invalid`    — cannot be UTF-8 at all. On Windows that means GBK.
 *
 * The `incomplete` case is what makes this correct rather than lucky: probing
 * a 2-byte prefix of a 3-byte character looks exactly like "not UTF-8", and the
 * naive version of this decoder therefore turned every chunk-split UTF-8 stream
 * into garbage (caught before landing).
 *
 * Once settled the encoding never changes: one program's output does not
 * alternate, and re-probing per chunk would re-split characters.
 *
 * `StringDecoder` is not used — Node's does not implement gbk/gb18030
 * (`Unknown encoding: gbk`). `TextDecoder` does, and its `stream: true`
 * carries an incomplete character to the next call.
 */
export interface ChunkDecoder {
	/** Decode the next chunk of the stream. */
	write(chunk: Buffer): string;
	/** Flush anything held back at stream end. */
	end(): string;
}

type Utf8State = "valid" | "incomplete" | "invalid";
type Encoding = "utf8" | "gbk";

/**
 * Classify `bytes` as complete UTF-8, a truncated UTF-8 tail, or not UTF-8.
 *
 * `fatal` makes invalid sequences THROW instead of yielding U+FFFD, which is
 * what makes this a probe rather than a heuristic.
 */
export function utf8State(bytes: Uint8Array): Utf8State {
	if (bytes.length === 0) return "valid";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return "valid";
	} catch {
		// Fall through: distinguish "truncated" from "wrong encoding".
	}
	// Walk back over continuation bytes (10xxxxxx) to the last lead byte.
	let i = bytes.length - 1;
	while (i >= 0 && (bytes[i] & 0xc0) === 0x80) i--;
	if (i < 0) return "invalid";
	const lead = bytes[i];
	const need =
		(lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
	if (need === 0) return "invalid"; // 0xF8+ is not a UTF-8 lead byte
	if (bytes.length - i < need) {
		// A short tail only means "truncated" if everything BEFORE it is valid.
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, i));
			return "incomplete";
		} catch {
			return "invalid";
		}
	}
	return "invalid";
}

/** True when `bytes` is valid, complete UTF-8. */
export function isUtf8(bytes: Uint8Array): boolean {
	return utf8State(bytes) === "valid";
}

/** Produce a decoder for one stream. */
export function createChunkDecoder(): ChunkDecoder {
	let pending: Buffer = Buffer.alloc(0);
	let settled: Encoding | undefined;
	const decoders: Record<Encoding, InstanceType<typeof TextDecoder>> = {
		utf8: new TextDecoder("utf-8", { fatal: false }),
		// GB18030 is a superset of GBK/CP936, which is what Chinese Windows uses.
		gbk: new TextDecoder("gb18030", { fatal: false }),
	};
	const decode = (as: Encoding, bytes: Buffer, stream = true): string =>
		decoders[as].decode(bytes, { stream });

	return {
		write(chunk: Buffer): string {
			if (chunk.length === 0) return "";
			if (settled) return decode(settled, chunk);

			const joined: Buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			// ASCII alone decides nothing — both encodings agree on it.
			if (joined.every((byte) => byte < 0x80)) return decode("utf8", joined);

			const state = utf8State(joined);
			if (state === "incomplete") {
				// Hold everything: the rest of the character is still in flight.
				pending = Buffer.from(joined);
				return "";
			}
			pending = Buffer.alloc(0);
			if (state === "valid") {
				settled = "utf8";
				return decode("utf8", joined);
			}
			settled = "gbk";
			return decode("gbk", joined);
		},
		end(): string {
			const rest = pending;
			pending = Buffer.alloc(0);
			// A tail still marked incomplete at stream end is a truncated character:
			// decode it in the settled encoding (or UTF-8) and accept the U+FFFD.
			const as: Encoding = settled ?? "utf8";
			return rest.length ? decoders[as].decode(rest) : decoders[as].decode();
		},
	};
}
