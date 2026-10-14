import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(join(tmpdir(), "ve-update-retry-test-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "retry.mjs");
await build({
	entryPoints: [join(root, "electron/update-download-retry.ts")],
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
});
const { DownloadRetryController, MAX_DOWNLOAD_RETRIES, DOWNLOAD_RETRY_BACKOFF_MS } = await import(pathToFileURL(bundle).href);

function fakeTimers() {
	const timers = [];
	let nextId = 1;
	return {
		timers,
		schedule(callback, delayMs) {
			const id = nextId++;
			timers.push({ id, callback, delayMs, cancelled: false });
			return id;
		},
		cancel(timer) {
			const hit = timers.find((item) => item.id === timer);
			if (hit) hit.cancelled = true;
		},
		runLast() {
			const pending = timers.filter((item) => !item.cancelled && !item.ran);
			assert.ok(pending.length, "expected a scheduled retry");
			const timer = pending.at(-1);
			timer.ran = true;
			timer.callback();
			return timer;
		},
	};
}

test("only transient download errors enter the bounded retry ladder", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	let downloads = 0;
	assert.deepEqual(controller.handleFailure("0.2.147", "feed 404", () => downloads++), { action: "ignore" });
	assert.equal(downloads, 0);
	assert.equal(timers.timers.length, 0);
});

test("retries use the exact 30s/2min/10min ladder and then stop", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	let downloads = 0;
	const expected = DOWNLOAD_RETRY_BACKOFF_MS;
	for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
		const decision = controller.handleFailure("0.2.147", "ENOENT rename temp installer", () => downloads++);
		assert.equal(decision.action, "retry");
		assert.equal(decision.attempt, attempt);
		assert.equal(decision.delayMs, expected[attempt - 1]);
		const timer = timers.runLast();
		assert.equal(timer.delayMs, expected[attempt - 1]);
		assert.equal(downloads, attempt, "each scheduled timer triggers exactly one download");
	}
	const stop = controller.handleFailure("0.2.147", "ENOENT rename temp installer", () => downloads++);
	assert.deepEqual(stop, { action: "stop", attempts: MAX_DOWNLOAD_RETRIES, maxAttempts: MAX_DOWNLOAD_RETRIES });
	assert.equal(downloads, MAX_DOWNLOAD_RETRIES);
});

test("a successful download clears the pending timer and attempts for that version", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	let downloads = 0;
	const first = controller.handleFailure("0.2.147", "EBUSY", () => downloads++);
	assert.equal(first.action, "retry");
	assert.equal(timers.timers.at(-1).cancelled, false);
	controller.reset("0.2.147");
	assert.equal(timers.timers.at(-1).cancelled, true);
	assert.equal(controller.attemptsFor("0.2.147"), 0);
	timers.runLast = () => { throw new Error("cancelled retry must not run"); };
	const second = controller.handleFailure("0.2.147", "EBUSY", () => downloads++);
	assert.equal(second.attempt, 1, "successful reset starts a fresh ladder");
});

test("a fresh update-available check resets the same version and clears an older pending retry", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	assert.equal(controller.handleFailure("0.2.147", "ENOENT", () => {}).action, "retry");
	controller.versionAvailable("0.2.147");
	assert.equal(timers.timers.at(-1).cancelled, true);
	assert.equal(controller.attemptsFor("0.2.147"), 0, "each scheduled check is a fresh bounded retry window");
	assert.equal(controller.handleFailure("0.2.147", "ENOENT", () => {}).attempt, 1);
});


test("network/abort error -4082 is not treated as a file-lock retry", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	const decision = controller.handleFailure("0.2.147", "CURL network failure (-4082)", () => {});
	assert.equal(decision.action, "ignore");
	assert.equal(timers.timers.length, 0, "network failures wait for the next scheduled check, not a 97MB re-download");
});

test("hasPendingRetry reports only the bounded waiting window", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	assert.equal(controller.hasPendingRetry(), false);
	assert.equal(controller.handleFailure("0.2.147", "ENOENT", () => {}).action, "retry");
	assert.equal(controller.hasPendingRetry(), true);
	timers.runLast();
	assert.equal(controller.hasPendingRetry(), false);
});

test("the retry policy contains no shared-cache filesystem deletion", () => {
	// A failed instance cannot prove that a temp file in Nova/Orion's shared cache
	// does not belong to another in-flight instance. electron-updater owns cleanup.
	const source = readFileSync(join(root, "electron/update-download-retry.ts"), "utf8");
	assert.doesNotMatch(source, /\brmSync\b/);
	assert.doesNotMatch(source, /\bunlink\b/);
	assert.doesNotMatch(source, /\breaddirSync\b/);
});

test("stop cancels a pending retry without scheduling a later download", () => {
	const timers = fakeTimers();
	const controller = new DownloadRetryController(timers.schedule, timers.cancel);
	let downloads = 0;
	assert.equal(controller.handleFailure("0.2.147", "ENOENT", () => downloads++).action, "retry");
	controller.stop();
	assert.equal(timers.timers.at(-1).cancelled, true);
	assert.equal(downloads, 0);
});
