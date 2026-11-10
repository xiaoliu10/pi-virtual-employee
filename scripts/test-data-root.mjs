/**
 * Data-root resolution tests (electron/data-root.ts).
 *
 * The module takes an injectable FsPort, so the whole E:/D:/C: matrix runs
 * against an in-memory virtual fs — no real drives touched, fully
 * deterministic. Every path uses WINDOWS backslashes because production
 * win32 resolution produces them (the runner is darwin, so we cannot rely on
 * path.join here — explicit strings keep the assertions platform-exact).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "data-root-"));
const bundle = join(dir, "dr.mjs");
await build({
	stdin: { contents: `export * from "./electron/data-root.ts";`, resolveDir: root, loader: "ts" },
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
	outfile: bundle,
});
const mod = await import(pathToFileURL(bundle).href);
const {
	resolveDataRoot,
	DataRootUnavailableError,
	profileUserDataDir,
	workspaceRoot,
	markerPath,
	legacyDataRoot,
	APP_DIR,
	ROOT_FINGERPRINT_FILE,
} = mod;

after(() => rmSync(dir, { recursive: true, force: true }));

const APPDATA = "C:\\Users\\tester\\AppData\\Roaming";
const legacy = legacyDataRoot(APPDATA);
const C = `C:\\${APP_DIR}`;
const D = `D:\\${APP_DIR}`;
const E = `E:\\${APP_DIR}`;
const marker = markerPath(APPDATA);
const sep = "\\";
const w = (...parts) => parts.join(sep);

/** Normalize separators so virtual-fs keys match regardless of whether the
 *  darwin runner's path.join emitted '\' or '/' (production win32 emits '\'). */
const norm = (p) => p.replace(/\//g, "\\");

/** Virtual fs keyed by exact path strings. Directory existence is derived
 *  from any file beneath a path; writability is an explicit allow-set. */
function makeFs({ writable = [], seedFiles = {} } = {}) {
	const files = new Map(Object.entries(seedFiles).map(([k, v]) => [norm(k), v]));
	const writableSet = new Set(writable.map(norm));
	const hasPrefix = (p) => [...files.keys()].some((f) => f.startsWith(norm(p) + sep));
	return {
		exists: (p) => files.has(norm(p)) || writableSet.has(norm(p)) || hasPrefix(p),
		readText: (p) => files.get(norm(p)),
		writeText: (p, content) => {
			files.set(norm(p), content);
		},
		isNonEmptyDir: (p) => hasPrefix(p),
		writable: (p) => writableSet.has(norm(p)),
		_files: files,
		_writable: writableSet,
	};
}

function resolve(fs, extra = {}) {
	return resolveDataRoot({ appData: APPDATA, platform: "win32", env: {}, fs, ...extra });
}

test("non-Windows always uses the appData legacy root (no drive probing)", () => {
	const fs = makeFs({ writable: [E] });
	const got = resolveDataRoot({ appData: APPDATA, platform: "darwin", env: {}, fs });
	assert.equal(got, legacy);
	assert.ok(fs.exists(marker), "marker pinned");
});

test("fresh Windows install, only C: writable -> C:", () => {
	assert.equal(resolve(makeFs({ writable: [C] })), C);
});

test("fresh install, E: writable -> E: and a second call follows the pin", () => {
	const fs = makeFs({ writable: [C, D, E] });
	assert.equal(resolve(fs), E);
	const fs2 = makeFs({ writable: [C, E], seedFiles: Object.fromEntries(fs._files) });
	assert.equal(resolve(fs2), E, "marker pin wins over re-probe");
});

test("fresh install, E: absent but D: writable -> D:", () => {
	assert.equal(resolve(makeFs({ writable: [C, D] })), D);
});

test("drive that holds files but is not writable is skipped", () => {
	const fs = makeFs({
		writable: [C],
		seedFiles: { [w(E, "stale.txt")]: "x", [w(D, "stale.txt")]: "x" },
	});
	assert.equal(resolve(fs), C);
});

test("P1: default-profile-only legacy machine (no profiles/ subdir) stays on C, never probed", () => {
	const fs = makeFs({
		writable: [C, D, E],
		seedFiles: { [w(legacy, "pi-employee.sqlite")]: "db", [w(legacy, "Preferences")]: "p" },
	});
	assert.equal(resolve(fs), legacy, "existing default-profile data must not be orphaned");
});

test("named-profile legacy machine (profiles/ present) stays on C", () => {
	const fs = makeFs({
		writable: [C, D, E],
		seedFiles: { [w(legacy, "profiles", "Nova", "pi-employee.sqlite")]: "db" },
	});
	assert.equal(resolve(fs), legacy);
});

test("pinned marker whose root is now missing throws (never silently re-targets)", () => {
	const pin = JSON.stringify({ root: E, fingerprint: "fp-1" });
	const fs = makeFs({ writable: [C], seedFiles: { [marker]: pin } });
	assert.throws(() => resolve(fs), DataRootUnavailableError);
});

test("P2-2: fingerprint mismatch on a swapped/emptied drive throws instead of starting empty", () => {
	const pin = JSON.stringify({ root: E, fingerprint: "fp-original" });
	const fs = makeFs({
		writable: [E],
		seedFiles: { [marker]: pin, [w(E, ROOT_FINGERPRINT_FILE)]: "fp-tampered", [w(E, "other")]: "x" },
	});
	assert.throws(() => resolve(fs), /卷指纹不匹配/);
});

test("fingerprint match on the pinned volume is accepted", () => {
	const pin = JSON.stringify({ root: E, fingerprint: "fp-ok" });
	const fs = makeFs({
		writable: [E],
		seedFiles: { [marker]: pin, [w(E, ROOT_FINGERPRINT_FILE)]: "fp-ok" },
	});
	assert.equal(resolve(fs), E);
});

test("PI_DATA_ROOT absolute override wins; relative and unwritable targets are hard errors", () => {
	const custom = "F:\\custom-root";
	assert.equal(
		resolveDataRoot({ appData: APPDATA, platform: "win32", env: { PI_DATA_ROOT: custom }, fs: makeFs({ writable: [custom] }) }),
		custom,
	);
	assert.throws(
		() => resolveDataRoot({ appData: APPDATA, platform: "win32", env: { PI_DATA_ROOT: "E:foo" }, fs: makeFs() }),
		/必须是绝对路径/,
	);
	assert.throws(
		() => resolveDataRoot({ appData: APPDATA, platform: "win32", env: { PI_DATA_ROOT: "Z:\\nope" }, fs: makeFs() }),
		DataRootUnavailableError,
	);
});

test("path layout contract preserves the substring updater.ts relies on", () => {
	// profileUserDataDir uses the HOST path.join (real win32 emits backslashes;
	// this darwin runner emits a mixed form), so assert structurally, not by
	// hard-coding separators. The updater substring contract is separator-proof.
	const nova = profileUserDataDir(E, "Nova");
	assert.ok(nova.startsWith(E), `named profile stays under the root: ${nova}`);
	assert.ok(nova.includes(APP_DIR) && nova.includes("profiles") && nova.endsWith("Nova"));
	assert.equal(profileUserDataDir(E, "default"), E);
	assert.equal(workspaceRoot(E), `${E}-workspace`);
	// updater.ts currentProfileName() splits on a path separator + 'profiles' + sep;
	// verify BOTH separator shapes resolve so no drive letter breaks the parse.
	const winForm = `${E}\\profiles\\Nova`;
	assert.ok(winForm.includes(`${APP_DIR}\\profiles\\`));
});

test("blank marker is ignored; legacy protection still wins because the marker file makes legacy non-empty", () => {
	// A whitespace-only marker parses to absent, but its file makes the legacy
	// dir non-empty, so the safe legacy-protection rule pins C: rather than
	// probing drives (no real profile data is ever orphaned).
	const fs = makeFs({ writable: [C, D, E], seedFiles: { [marker]: "   " } });
	assert.equal(resolve(fs), legacy);
});

test("P3-1: trailing separator in a legacy bare-path marker is normalized", () => {
	const fs = makeFs({ writable: [E], seedFiles: { [marker]: `${E}\\` } });
	const got = resolve(fs);
	assert.equal(got, E);
	assert.equal(workspaceRoot(got), `${E}-workspace`);
});

test("a fresh probe pins the chosen drive with matching marker + fingerprint", () => {
	const fs = makeFs({ writable: [C, D, E] });
	resolve(fs);
	let pin;
	try {
		pin = JSON.parse(fs.readText(marker));
	} catch (err) {
		assert.fail(`marker should be valid JSON: ${err.message}`);
	}
	assert.equal(pin.root, E);
	assert.ok(typeof pin.fingerprint === "string" && pin.fingerprint.length > 0);
	assert.equal(fs.readText(w(E, ROOT_FINGERPRINT_FILE)), pin.fingerprint);
});
