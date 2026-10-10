/**
 * Inbound slash-command recognition, in ONE place.
 *
 * Why this is its own module: command detection used to be an exact-match
 * comparison (`text.trim() === "/new"`) against text that the adapter had
 * already tried to clean up. Every real-world variation then failed silently —
 * the message fell through to the model as ordinary chat, so the user saw the
 * employee "talking about" /new instead of clearing the session. Reported twice
 * for group chats. The variations that matter, all seen in the field or implied
 * by how clients serialize a mention:
 *
 *   "@机器人 /new"      mention token + the command          → must work
 *   "@机器人/new"       mention glued to the command          → must work
 *   "@机器人　/new"     ideographic space after the mention   → must work
 *   "@机器人 @张三 /new" two mentions                          → must work
 *   "／new"             FULL-WIDTH slash (Chinese IME default) → must work
 *   "/new\n"            trailing newline from a paste          → must work
 *   "/new 一下"         extra words after the command          → must work, the
 *                                                                word is ignored
 *   "/news", "把这个 /new 用起来", "请/new"                     → must NOT be a command
 *
 * The rule is therefore: strip mention tokens (with or without a following
 * space), normalize a leading full-width slash, then require the FIRST token to
 * be a known command. Anything else is ordinary text — including a slash in the
 * middle of a sentence.
 */

/** Commands that must bypass the per-conversation queue (see IM manager).
 * `steer` joins them: a steer has to reach a LIVE turn, and the queue is
 * exactly what a long-running task blocks (field 2026-10-10). */
export const QUEUE_BYPASS_COMMANDS = ["new", "stop", "steer"] as const;

export type CommandName = "new" | "stop" | "steer" | "version" | "models" | "model" | "compact" | "help" | "perm" | "restart";

export interface ParsedCommand {
	name: CommandName;
	/** Everything after the command word, trimmed (used by /model <n|id>). */
	arg?: string;
}

/**
 * Remove leading @mention tokens, with or without whitespace after them, and
 * normalize a leading full-width slash. Only the START of the text is touched:
 * an "@" later in a sentence is content, not a mention.
 */
export function normalizeInboundText(raw: string): string {
	let t = (raw ?? "").replace(/^\s+/, "");
	// Mentions: "@name" optionally followed by whitespace. Repeated (one per
	// mentioned person/robot). `[^\s@]+` keeps us from swallowing a whole line.
	// The mention NAME stops at a slash as well as at whitespace: "@小派/new" (a
	// client that glues the chip to the text) must leave "/new", not swallow it.
	while (/^@[^\s@/\uFF0F]+/.test(t)) t = t.replace(/^@[^\s@/\uFF0F]+\s*/, "");
	// A Chinese IME turns "/" into "／" without the user noticing.
	t = t.replace(/^\uFF0F/, "/");
	return t.trim();
}

/** The first non-empty line, with mentions/slash normalized. */
export function commandLine(raw: string): string {
	const first = normalizeInboundText(raw).split(/\r?\n/, 1)[0] ?? "";
	return first.trim();
}

/**
 * Parse a command, or null when the message is ordinary text.
 * `/new` and `/stop` are included: the manager intercepts them before the queue,
 * but they must be recognised here too so that both paths agree.
 */
export function parseCommand(raw: string): ParsedCommand | null {
	const line = commandLine(raw);
	if (!line.startsWith("/")) return null;
	const [word, ...rest] = line.slice(1).split(/\s+/);
	if (!word) return null;
	const arg = rest.join(" ").trim();
	switch (word.toLowerCase()) {
		case "new":
			return { name: "new" };
		case "stop":
			return { name: "stop" };
		case "steer": {
			// Only /steer preserves the full payload, including following lines.
			// Bare /steer still parses — the manager answers with usage.
			const payload = normalizeInboundText(raw).slice(1 + word.length).trim();
			return { name: "steer", arg: payload || undefined };
		}
		case "version":
		case "ver":
			return { name: "version" };
		case "models":
			return { name: "models" };
		case "model":
			// Bare /model lists models; /model <n|id> switches.
			return arg ? { name: "model", arg } : { name: "models" };
		case "compact":
			return { name: "compact" };
		case "perm":
		case "whoami":
		case "me":
			return { name: "perm" };
		case "restart":
			return { name: "restart" };
		case "help":
		case "?":
			return { name: "help" };
		default:
			return null;
	}
}

/**
 * Natural-language cancel phrases that, while a turn is running, should be
 * STEERED into it instead of queueing behind it (field 2026-10-10: a long task
 * made "取消任务" unreachable in the strict per-conversation queue).
 *
 * Deliberately NARROW — this is a cancel/stop heuristic, not a general "the
 * user said something mid-turn" rule: a false positive steers a message that
 * would have been handled fine as the next queued turn, which is visible but
 * recoverable; a false NEGATIVE reintroduces the reported dead end. The phrase
 * must contain a cancel/stop word; a bare "停" inside a longer sentence is not
 * enough (checked as a whole-message pattern below).
 */
const CANCEL_PHRASE_RE =
	/^(?:请|麻烦|给我|现在|先|赶紧|赶快|快点|立即|马上)?\s*(?:取消|停止|停下|终止|中止|停下来|停一下|先停|别再?|不要|不用)\s*(?:再|做|干|执行|跑)?\s*(?:了|这个|这个任务|当前任务|手上的|手上的事|任务|工作|手上的活|活|事情|事|执行|操作|流程)?\s*[。！!，,.\s]*$/;

/** True when the text is a plain cancel/stop request (no other instruction). */
export function isCancelPhrase(raw: string): boolean {
	const text = normalizeInboundText(raw);
	if (!text) return false;
	// Match the entire message: following lines may contain other instructions.
	// A slash command is never a "cancel phrase" — it has its own path.
	if (text.startsWith("/")) return false;
	return CANCEL_PHRASE_RE.test(text);
}

/**
 * True when a message LOOKS like an attempted command but did not parse — e.g.
 * a slash word we do not know, or a mention followed by something odd. Used to
 * write one diagnostic line so the next "command doesn't work" report can be
 * answered from the log instead of guessed at.
 */
export function looksLikeCommandAttempt(raw: string): boolean {
	const line = commandLine(raw);
	return line.startsWith("/") && parseCommand(raw) === null;
}
