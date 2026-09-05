/**
 * IM diagnostics log — append-only record of send-path outcomes.
 *
 * Packaged builds have no visible console, so the card-send fallbacks that
 * explain "why isn't my table rendering" were previously invisible on
 * headless servers. Outcomes (card delivered / fell back to markdown / HTTP
 * failure) land in userData/logs/im.log. A broken log sink must never break
 * the send path itself — all file errors are swallowed.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let file = "";

/** Point the diagnostics log at a file (userData/logs/im.log). Call once per boot. */
export function setDiagFile(path: string): void {
	file = path;
}

/** Log one line to the console and, when configured, the diagnostics file. */
export async function diag(channel: string, msg: string, level: "info" | "warn" = "info"): Promise<void> {
	const line = `[im:${channel}] ${msg}`;
	if (level === "warn") console.warn(line);
	else console.log(line);
	if (!file) return;
	try {
		await mkdir(dirname(file), { recursive: true });
		await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
	} catch {
		// Diagnostics must never break the send path.
	}
}
