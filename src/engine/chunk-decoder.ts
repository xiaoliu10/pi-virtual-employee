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
	// Evidence for each side, in decisive (non-ASCII) bytes. One chunk can be
	// wrong (a single "→" in a banner, or a GBK character whose bytes happen to
	// form a valid UTF-8 sequence), so the latch waits until one side is clearly
	// ahead instead of trusting the first non-ASCII chunk.
	let utf8Votes = 0;
	let gbkVotes = 0;
	/** Set once output has been produced; from then on the encoding is final. */
	let emitted: Encoding | undefined;
	/** Consecutive decisive chunks agreeing before the stream latches for good. */
	const DECISIVE_MARGIN = 2;
	// Count CHUNKS, not bytes: a 12-byte banner with one arrow must not outweigh a
	// 4-byte GBK payload just because it is longer. A run of agreement is the
	// signal, and a single contradicting chunk resets the run.
	const vote = (encoding: Encoding): void => {
		if (encoding === "utf8") {
			utf8Votes += 1;
			gbkVotes = 0;
		} else {
			gbkVotes += 1;
			utf8Votes = 0;
		}
		// Latch only on a RUN of agreement; a contradicting chunk resets the run, so
		// one misleading banner cannot poison the stream.
		if (utf8Votes >= DECISIVE_MARGIN) settled = "utf8";
		else if (gbkVotes >= DECISIVE_MARGIN) settled = "gbk";
	};
	const makeDecoders = (): Record<Encoding, InstanceType<typeof TextDecoder>> => ({
		utf8: new TextDecoder("utf-8", { fatal: false }),
		// GB18030 is a superset of GBK/CP936, which is what Chinese Windows uses.
		gbk: new TextDecoder("gb18030", { fatal: false }),
	});
	let decoders = makeDecoders();
	const decode = (as: Encoding, bytes: Buffer, stream = true): string =>
		decoders[as].decode(bytes, { stream });

	return {
		write(chunk: Buffer): string {
			if (chunk.length === 0) return "";
			if (settled) return decode(settled, chunk);
			// Once anything has been EMITTED the encoding is fixed: the TextDecoder
			// bound to it holds internal state, and flipping later would leave the
			// emitted prefix and the coming bytes in different encodings.
			if (emitted) return decode(emitted, chunk);

			const joined: Buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			// ASCII alone decides nothing — both encodings agree on it, so this must
			// NOT fix the encoding (an English banner precedes GBK output all the
			// time). It is emitted straight through; the decision still waits.
			if (joined.every((byte) => byte < 0x80)) return decode("utf8", joined);

			const state = utf8State(joined);
			// "Incomplete" only means anything while we are still deciding between
			// UTF-8 and GBK. Once GBK is established a trailing byte that LOOKS like
			// a truncated UTF-8 lead is just the first half of a GBK character, and
			// holding it would swallow the byte (field: a GBK stream split mid
			// character emitted its first character and then nothing).
			// Hold only while the encoding is still undecided: an incomplete tail there
			// is a UTF-8 character in flight. Once latched, GB18030 reassembles split
			// GBK characters on its own, so holding would swallow the byte.
			const holding = settled === undefined && state === "incomplete";
			if (holding) {
				// Hold everything: the rest of the character is still in flight.
				pending = Buffer.from(joined);
				return "";
			}
			pending = Buffer.alloc(0);
			// Record evidence, then choose. Until the margin is met we decode with the
			// leading side WITHOUT latching, so a later chunk can still flip it — this
			// is what stops one misleading chunk from poisoning the whole stream.
			vote(state === "valid" ? "utf8" : "gbk");
			if (!settled) {
				// Not latched yet: emit with the CURRENT leaning so a genuinely UTF-8
				// stream is readable from its first chunk. If the lean later proves
				// wrong the latch switches and REBUILDS the decoder; the already
				// emitted prefix keeps whatever it decoded to (it cannot be rewritten),
				// which is the accepted boundary of a single-decoder design.
				emitted = gbkVotes > 0 && gbkVotes >= utf8Votes ? "gbk" : "utf8";
				pending = Buffer.alloc(0);
				return decode(emitted, joined);
			}
			// Latched. If the leaning we were emitting with was the OTHER encoding, the
			// decoder in use is holding state for it (possibly half a character) —
			// start clean so that state cannot glue onto the new encoding's bytes.
			if (emitted !== settled) {
				decoders = makeDecoders();
				emitted = settled;
			}
			pending = Buffer.alloc(0);
			return decode(settled, joined);
		},
		end(): string {
			const rest = pending;
			pending = Buffer.alloc(0);
			// A tail still marked incomplete at stream end is a truncated character:
			// decode it in the settled encoding (or UTF-8) and accept the U+FFFD.
			// Undecided at end: prefer GBK. The two mistakes are NOT symmetric —
			// GBK bytes read as UTF-8 produce a run of U+FFFD (content destroyed),
			// while UTF-8 bytes read as GB18030 produce visible mojibake the caller
			// can still recognise and retry.
			const as: Encoding = settled ?? (gbkVotes > 0 ? "gbk" : "utf8");
			return rest.length ? decoders[as].decode(rest) : decoders[as].decode();
		},
	};
}
