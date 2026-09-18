/**
 * Beijing clock tool tests. Field 2026-09-18: a daily report was titled
 * 2026-09-19 on the real date 2026-09-18 — the model has no real clock. The
 * pinned properties are: date/time in UTC+8 regardless of host TZ, weekday
 * mapping, and the scheduled-task prefix carrying the real fire date.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.time-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { beijingNow, scheduledTimePrefix, createCurrentTimeTool } from "./src/engine/tools/time.ts";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(workDir, "time.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { beijingNow, scheduledTimePrefix, createCurrentTimeTool } = await import(pathToFileURL(join(workDir, "time.mjs")).href);

test("Beijing time is UTC+8 regardless of host timezone", () => {
	// 2026-09-18 17:30 UTC = 2026-09-19 01:30 Beijing.
	const t = beijingNow(new Date("2026-09-18T17:30:00Z"));
	assert.equal(t.date, "2026-09-19");
	assert.equal(t.time, "01:30:00");
	assert.equal(t.weekdayName, "周六");
	assert.equal(t.weekday, 6);
});

test("weekday map covers the full week", () => {
	// 2026-09-14 is a Monday through 2026-09-20 Sunday.
	const names = [];
	for (let d = 14; d <= 20; d += 1) names.push(beijingNow(new Date(`2026-09-${d}T04:00:00Z`)).weekdayName);
	assert.deepEqual(names, ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
});

test("tool returns the date in both text and structured details", async () => {
	const tool = createCurrentTimeTool();
	const res = await tool.execute("t", {});
	const text = res.content[0].text;
	assert.match(text, /^当前北京时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（周[一二三四五六日]）/);
	assert.equal(res.details.timezone, "Asia/Shanghai");
	assert.match(res.details.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("scheduled task prefix stamps the real fire date", () => {
	const prefix = scheduledTimePrefix(new Date("2026-09-18T01:00:00Z")); // 09:00 Beijing
	assert.match(prefix, /真实执行时间：2026-09-18（周五）09:00:00/);
	assert.ok(prefix.includes("不要自行猜测日期"));
});
