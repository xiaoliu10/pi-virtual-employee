#!/usr/bin/env node
/**
 * Bridge suite: runs the python unit tests for the box-side playwright shim
 * (resources/browser-bridge/ve_pw_profile_lock.py) with any python3 on PATH.
 *
 * The shim is the enforcement half of the browser concurrency ruling
 * ("ONE browser per profile, many tab owners" — the Hermes model). Its tests
 * are stub-based python (no Chromium needed), so this suite is fast and CI-
 * safe; it must never be silently skipped: a machine without any python3 is
 * a packaging bug for the bridge resource, not a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = join(here, "..", "resources", "browser-bridge");
const testFile = join(bridge, "test_ve_pw_shim_v5.py");
const shimFile = join(bridge, "ve_pw_profile_lock.py");

if (!existsSync(testFile) || !existsSync(shimFile)) {
	console.error("[pw-shim] MISSING bridge resources — the shim or its tests are not in the tree");
	process.exit(1);
}

const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
let python = null;
for (const cmd of candidates) {
	const probe = spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)"], { stdio: "ignore" });
	if (probe.status === 0) { python = cmd; break; }
}
if (!python) {
	// A tree that ships the bridge without a way to test it is a real defect:
	// fail loudly instead of producing a green suite that never ran anything.
	console.error("[pw-shim] no python3 on PATH — cannot verify the playwright shim (refusing to silently skip)");
	process.exit(1);
}

const r = spawnSync(python, ["-B", testFile], { stdio: "inherit", encoding: "utf8" });
if (r.status !== 0) {
	console.error(`[pw-shim] python shim tests FAILED (${python})`);
	process.exit(r.status ?? 1);
}
console.log("[pw-shim] python shim tests passed");
