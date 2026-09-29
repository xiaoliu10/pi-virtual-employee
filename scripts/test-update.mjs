/**
 * manage_update status wording tests. Run with `node --test scripts/test-update.mjs`.
 *
 * Field incident this file exists for: a 0.2.66 box kept answering "已是最新版
 * 本，没有更高版本可下载" while 0.2.67/0.2.68 were already on the feed — status
 * was a cached conclusion from a check hours earlier, with no indicator of how
 * old that conclusion was, and the model presented it as a live fact.
 *
 * Pinned properties: the age of the last completed check is always visible
 * next to a "no update" verdict, a stale one carries an explicit warning to
 * re-check (action=check) instead of trusting the cache, and a fresh check does
 * not get spammed with the warning.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.update-test-"));
process.on("exit", () => { void rm(workDir, { recursive: true, force: true }); });
const bundle = join(workDir, "update.mjs");
await build({
	stdin: {
		contents: `
			export { describeStatus, normalizeAutoUpdate, createManageUpdateTool } from "./src/engine/tools/update.ts";
			export { ConfigStore } from "./src/db/config-store.ts";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { describeStatus, normalizeAutoUpdate, createManageUpdateTool, ConfigStore } = await import(pathToFileURL(bundle).href);

const base = (phase, extra = {}) => ({
	currentVersion: "0.2.66",
	phase,
	...extra,
});

test("a fresh 'no update' verdict carries the check time and no warning", () => {
	const now = Date.now();
	const text = describeStatus(base("none", { lastCheckAt: now - 5 * 60_000 }), "full");
	assert.match(text, /上次检查（5 分钟前）/);
	assert.doesNotMatch(text, /注意：/, "a freshly confirmed status must not be padded with the stale-warning");
});

test("an old 'no update' verdict is flagged instead of presented as current truth", () => {
	// The box in the field incident: checked ~9h earlier, two releases shipped since.
	const now = Date.now();
	const text = describeStatus(base("none", { lastCheckAt: now - 6 * 3_600_000 }), "full");
	assert.match(text, /上次检查（6 小时前）/);
	assert.match(text, /注意：/, "stale verdict must carry a warning");
	assert.match(text, /action=check 实时检查/, "the warning must point at the real check");
	assert.doesNotMatch(text, /已是最新版本/, "the old unconditional claim must be gone");
});

test("never-checked status cannot be used to claim anything about being latest", () => {
	const text = describeStatus(base("none"), "full");
	assert.match(text, /尚未完成过更新检查/);
	assert.match(text, /action=check/);
});

test("idle phase gets the same staleness treatment", () => {
	const text = describeStatus(base("idle"), "full");
	assert.match(text, /注意：/);
});

test("actionable phases are not padded with staleness noise", () => {
	for (const [phase, extra] of [
		["checking", {}],
		["available", { targetVersion: "0.2.69" }],
		["downloading", { targetVersion: "0.2.69", percent: 40 }],
		["ready", { targetVersion: "0.2.69" }],
		["error", { error: "network down" }],
	]) {
		const text = describeStatus(base(phase, extra), "full");
		assert.doesNotMatch(text, /注意：/, `${phase} output must not warn about staleness`);
	}
});

test("existing wording contracts keep their shape", () => {
	assert.match(describeStatus(base("available", { targetVersion: "0.2.69" }), "full"), /发现新版本 v0.2.69/);
	assert.match(describeStatus(base("ready", { targetVersion: "0.2.69" }), "download_only"), /回复「确认更新到最新版」/);
	assert.match(describeStatus(base("error", { error: "boom" }), "off"), /失败（boom）/);
});

// Field incident 2026-09-20: 「确认更新到最新版」 was promised in the ready
// status text and the admin notification, but NO code path implemented it —
// download_only mode had no install route at all, and even auto mode had no
// way to install now instead of waiting for the idle poll. The status text
// must now map the phrase to action=install_now explicitly.
test("ready status text maps the confirmation phrase to install_now", () => {
	const now = Date.now();
	const dl = describeStatus(base("ready", { targetVersion: "0.2.88", lastCheckAt: now }), "download_only");
	assert.match(dl, /确认更新到最新版/);
	assert.match(dl, /install_now/, "download_only ready text must point at the install_now action");

	const auto = describeStatus(base("ready", { targetVersion: "0.2.88", lastCheckAt: now }), "full");
	assert.match(auto, /install_now/, "auto-mode ready text must offer install_now for 立刻安装 requests");
});

// User rulings 2026-09-23 + 2026-09-29 applied to manage_update: a platform-
// verified admin in ANY chat is authorized without a per-message 「确认」 —
// action=update schedules an idle restart (non-destructive, mirrors the
// unattended auto-update flow) so "和 Nova 对话就能让它自己升级重启" works.
// install_now still demands an explicit 「确认」: it kills in-flight tasks and
// restarts the app immediately. Non-admins are refused outright.
test("manage_update gates: group admin runs update directly; install_now keeps its confirmation", async (t) => {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	config.replaceAll({ security: { adminStaffIds: ["boss"] } });
	const actor = { channel: "dingtalk", chatType: "group", senderId: "boss", text: "升级到最新版" };
	const updates = {
		isSupported: () => ({ supported: true }),
		getStatus: () => base("ready", { targetVersion: "0.2.101" }),
		checkNow: async () => base("idle"),
		requestUpdateAndInstall: () => ({ started: true, mode: "checking", status: base("checking") }),
		installNow: () => ({ started: true, status: base("ready", { targetVersion: "0.2.101" }) }),
	};
	const tool = createManageUpdateTool({ config, resolveActor: () => actor, onConfigChanged: () => {}, conversationId: "dt:group:ops", updates });

	// Admin in a GROUP without 「确认」: update schedules an idle restart.
	const upd = await tool.execute("u1", { action: "update" });
	assert.equal(upd.details.started, true, "group admin runs update directly — no confirmation needed");
	assert.match(upd.content[0].text, /已安排更新/);

	// install_now is destructive (kills in-flight tasks): still needs 「确认」.
	actor.text = "马上装";
	const refused = await tool.execute("u2", { action: "install_now" });
	assert.equal(refused.details.refused, true);
	assert.match(refused.content[0].text, /包含「确认」/);

	// Non-admin in the same group is refused outright, even with the phrase.
	actor.senderId = "peasant";
	actor.text = "确认更新到最新版";
	const denied = await tool.execute("u3", { action: "update" });
	assert.match(denied.content[0].text, /不是本系统的管理员/);

	// install_now with an explicit confirmation proceeds.
	actor.senderId = "boss";
	const now = await tool.execute("u4", { action: "install_now" });
	assert.equal(now.details.started, true);
	assert.match(now.content[0].text, /已开始立即安装/);
});
