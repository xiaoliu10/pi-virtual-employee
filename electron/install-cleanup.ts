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

/** One teardown step: a name, its own budget, and the work. */
export interface CleanupStep {
	name: string;
	budgetMs: number;
	run(): Promise<unknown> | unknown;
}

/** The teardown in the order it must run (DB close stays last, outside this list). */
export interface TeardownDeps {
	stopWork: () => Promise<unknown> | unknown;
	closeDurable?: () => Promise<unknown> | unknown;
	stopScheduler: () => unknown;
	disposeShell: () => unknown;
	stopIm: () => Promise<unknown> | unknown;
	closeBrowser: () => Promise<unknown> | unknown;
	closeComputer: () => Promise<unknown> | unknown;
	closeHttp: () => Promise<unknown> | unknown;
}

/**
 * The install teardown, in order, as data. Extracted from main.ts so the
 * sequence itself is testable: the defect this file fixes was precisely
 * "one unbounded step in a fixed sequence", and a sequence no test can drive is
 * a sequence that regresses silently (subagent review P2-4, v0.2.172).
 *
 * Ordering is load-bearing: durable closes before the DB (its close writes the
 * final checkpoint through the DB), and every listener/process closes before
 * NSIS starts so the installer can overwrite resources.
 */
export function installTeardownSteps(deps: TeardownDeps): { steps: CleanupStep[]; syncSteps: { name: string; run(): unknown }[] } {
	const steps: CleanupStep[] = [
		{ name: "stop work windows", budgetMs: CLEANUP_BUDGETS.stopWork, run: deps.stopWork },
	];
	if (deps.closeDurable) steps.push({ name: "durable host close", budgetMs: CLEANUP_BUDGETS.durableClose, run: deps.closeDurable });
	steps.push(
		{ name: "im stopAll", budgetMs: CLEANUP_BUDGETS.imStopAll, run: deps.stopIm },
		{ name: "browser close", budgetMs: CLEANUP_BUDGETS.browserClose, run: deps.closeBrowser },
		{ name: "computer close", budgetMs: CLEANUP_BUDGETS.computerClose, run: deps.closeComputer },
		{ name: "http server close", budgetMs: CLEANUP_BUDGETS.httpClose, run: deps.closeHttp },
	);
	// Cheap, synchronous, and not part of the starvation problem: keep them out
	// of the budgeted list but still in the sequence so they cannot be dropped.
	const syncSteps = [
		{ name: "scheduler stop", run: deps.stopScheduler },
		{ name: "dispose shell commands", run: deps.disposeShell },
	];
	return { steps, syncSteps };
}

/**
 * Run the whole teardown. Never rejects: every step is bounded, and a failure in
 * one must not skip the rest (the remaining handles still need releasing).
 * `syncSteps` run between the first step and the durable close — see
 * installTeardownSteps for why they are sync.
 */
export async function runInstallTeardown(
	deps: TeardownDeps,
	warn: CleanupLogger = (message, detail) => console.warn(message, detail ?? ""),
	info: CleanupLogger = (message) => console.log(message),
): Promise<{ outcomes: Record<string, CleanupOutcome>; elapsedMs: number }> {
	const startedAt = Date.now();
	const outcomes: Record<string, CleanupOutcome> = {};
	const { steps, syncSteps } = installTeardownSteps(deps);
	// stopWork first (it may still be writing), then the sync stops, then the
	// durable close, then the resource closers in declared order.
	const head = steps.slice(0, 1);
	const tail = steps.slice(1);
	for (const step of head) outcomes[step.name] = await runCleanupStep(step.name, step.budgetMs, step.run, warn, info);
	for (const step of syncSteps) {
		try {
			step.run();
			outcomes[step.name] = "ok";
		} catch (err) {
			// Same rule as the async steps: log and continue.
			warn(`[main] install cleanup: ${step.name} failed (continuing)`, (err as Error)?.constructor?.name ?? typeof err);
			outcomes[step.name] = "failed";
		}
	}
	for (const step of tail) outcomes[step.name] = await runCleanupStep(step.name, step.budgetMs, step.run, warn, info);
	return { outcomes, elapsedMs: Date.now() - startedAt };
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
	info: CleanupLogger = (message) => console.log(message),
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
		// EVERY step logs its duration, not just the slow ones: the whole point is
		// that the next "install was slow" report names the culprit instead of
		// needing a fresh field repro (and normal steps are the baseline the slow
		// ones are read against).
		if (elapsed > budgetMs / 2) warn(`[main] install cleanup: ${name} slow (${elapsed}ms of ${budgetMs}ms budget)`);
		else info(`[main] install cleanup: ${name} ok (${elapsed}ms)`);
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
