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

/** Commands that must bypass the per-conversation queue (see IM manager). */
export const QUEUE_BYPASS_COMMANDS = ["new", "stop"] as const;

export type CommandName = "new" | "stop" | "version" | "models" | "model" | "compact" | "help" | "perm" | "restart";

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
 * True when a message LOOKS like an attempted command but did not parse — e.g.
 * a slash word we do not know, or a mention followed by something odd. Used to
 * write one diagnostic line so the next "command doesn't work" report can be
 * answered from the log instead of guessed at.
 */
export function looksLikeCommandAttempt(raw: string): boolean {
	const line = commandLine(raw);
	return line.startsWith("/") && parseCommand(raw) === null;
}
