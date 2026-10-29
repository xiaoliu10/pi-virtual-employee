/**
 * Bounded install teardown steps (v0.2.172).
 *
 * Field incident this exists for: a box reported 「安装失败：安装前清理超过 10 秒」
 * and then 「已连续 2 次自动安装失败（跨版本）」. Root cause was NOT the box: the
 * teardown ran every step sequentially with no individual bound, and the outer
 * ceiling (10s) was smaller than the sum of plausible step durations — the
 * durable-host close alone was allowed 8s. One slow step starved the others and
 * the whole install aborted.
 *
 * Policy encoded here:
 *  - every step has its own budget, so one wedged subsystem cannot starve the
 *    rest (the remaining handles are released by process exit anyway);
 *  - a step never throws and never fails the install: teardown is best-effort.
 *    Aborting an install because OUR OWN cleanup was slow took the machine down
 *    a path where the update could never be applied automatically again;
 *  - duration is always logged, so the next slow-install report names the
 *    culprit instead of needing a fresh field repro.
 */

export type CleanupOutcome = "ok" | "timeout" | "failed";

export interface CleanupLogger {
	(message: string, detail?: unknown): void;
}

/**
 * Run one teardown step under a hard budget. Resolves with the outcome — it
 * NEVER rejects, so a caller can chain the remaining steps unconditionally.
 * A timed-out step is abandoned (not cancelled): its promise is left to settle
 * on its own, which is safe because the process exits right after teardown.
 */
export async function runCleanupStep(
	name: string,
	budgetMs: number,
	fn: () => Promise<unknown> | unknown,
	warn: CleanupLogger = (message, detail) => console.warn(message, detail ?? ""),
): Promise<CleanupOutcome> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), budgetMs);
	});
	try {
		const outcome = await Promise.race([
			Promise.resolve()
				.then(fn)
				.then(() => "ok" as const),
			budget,
		]);
		const elapsed = Date.now() - startedAt;
		if (outcome === "timeout") {
			warn(`[main] install cleanup: ${name} exceeded ${budgetMs}ms — continuing (process exit releases it)`);
			return "timeout";
		}
		// A step that finished but blew its budget is a near miss worth recording:
		// the budgets are sized to a loaded box, so a near miss predicts the next
		// field report.
		if (elapsed > budgetMs / 2) warn(`[main] install cleanup: ${name} slow (${elapsed}ms of ${budgetMs}ms budget)`);
		return "ok";
	} catch (err) {
		// Content is not logged: teardown errors can carry paths and tokens.
		warn(`[main] install cleanup: ${name} failed after ${Date.now() - startedAt}ms (continuing)`, (err as Error)?.constructor?.name ?? typeof err);
		return "failed";
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * The per-step budgets, exported so the sum is checkable against the outer
 * ceiling in updater.ts (a ceiling below the sum reintroduces the starvation
 * this module exists to prevent).
 */
export const CLEANUP_BUDGETS = {
	stopWork: 3_000,
	durableClose: 8_000,
	imStopAll: 6_000,
	browserClose: 5_000,
	computerClose: 3_000,
	httpClose: 2_000,
} as const;
