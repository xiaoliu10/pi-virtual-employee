/**
 * END-TO-END: an owner inside a worker must be able to change their own task.
 *
 * User ruling, 2026-11-07: 「如果是系统限制那系统限制就有问题，我是最高权限我应该
 * 有全局的权限，可以修改任何配置和任务」.
 *
 * The refusal they hit was NOT a real policy: work.ts has an explicit owner
 * cross-conversation exemption. It never ran, because inside a worker
 * `buildTools` hands the IM tools the ORIGIN conversation id while the only
 * live turn actor is stamped on the worker transcript — so resolveActor(origin)
 * returned the worker-labelled actor (or nothing), and verifiedIMActor /
 * source-scoping refused before the exemption was reached.
 *
 * This suite boots the REAL buildTools and drives manage_work_items end to end:
 * real capability guard, real verifiedIMActor, real owner check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.owner-in-worker-test-"));
const bundle = join(dir, "def.mjs");
await build({
	stdin: { contents: 'export { buildTools } from "./src/engine/definition.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
});
const { buildTools } = await import(pathToFileURL(bundle).href);

const OWNER = "manager5792";
const WORKER = `worker:wmw6g4ldpi9tg`;
const GROUP = "dt:group:cidnD94vyjhmWEhoS0AEeH7+Q==";
const ITEM_ID = "3db7f642-4670-48a7-b6cd-be212c93ceec";

function makeItem(overrides = {}) {
	return {
		id: ITEM_ID,
		title: "每日对账异常动态巡检与群内汇报（7天版·明细报告）",
		goal: "每日巡检 spay 最近 7 天全部商户的日终对账异常",
		conditions: null,
		progress: "已扫 7 天",
		lessons: "[]",
		origin_conversation: GROUP,
		origin_note: "管理员要求直接创建",
		status: "waiting_human",
		question: "应用曾在执行中退出",
		next_check_at: null,
		next_check_reason: null,
		created_by: OWNER,
		answer: null,
		created_at: 1,
		updated_at: 2,
		fixed_streak: 0,
		fallback_streak: 0,
		last_remind_at: null,
		remind_count: 0,
		cadence_ms: null,
		kicked_off: 1,
		resident: 1,
		timeout_streak: 0,
		max_minutes: null,
		priority: 100,
		origin: "manual",
		...overrides,
	};
}

function boot({ itemOverrides = {}, workerActorChatType = "single" } = {}) {
	const item = makeItem(itemOverrides);
	const updates = [];
	const workItems = {
		get: (id) => (id === item.id ? item : undefined),
		list: () => [item],
		update: (id, patch) => { updates.push({ id, patch }); Object.assign(item, patch); return item; },
		setField: (id, field, content) => {
			const column = field === "set_conditions" ? "conditions" : field === "set_progress" ? "progress" : field;
			updates.push({ id, patch: { [column]: content } });
			item[column] = content;
			return item;
		},
		resume: () => undefined,
		pause: () => undefined,
		cancel: () => undefined,
		setSchedule: () => undefined,
		addLesson: () => undefined,
		create: () => undefined,
	};

	const config = {
		all: () => ({
			security: {
				adminStaffIds: [],
				ownerStaffIds: [],
				defaultRole: "viewer",
				people: [{ name: "张训", role: "owner", staffId: OWNER }],
			},
			kb: { enabled: false },
			browser: { enabled: false },
			computer: { enabled: false },
			scheduler: { enabled: false },
		}),
	};

	// The ONLY live turn actor: stamped on the worker transcript.
	const turnActor = {
		senderId: OWNER,
		channel: "dingtalk",
		chatType: workerActorChatType,
		text: "把推送规则改成只发需人工处理的完整列表",
	};
	const lookups = [];
	const resolveActor = (cid) => {
		lookups.push(cid);
		if (cid === WORKER) return turnActor;
		return undefined; // nothing is stamped on the origin chat
	};

	const tools = buildTools({
		config,
		conversationId: WORKER,
		originConversationId: GROUP,
		resolveActor,
		work: { items: workItems, fireItem: () => true, mine: async () => ({ scanned: 0, proposals: [] }) },
		kbEnabled: false,
		onSkillsChanged: async () => {},
		listSkills: async () => ({ skills: [], info: [] }),
		onConfigChanged: () => {},
	});
	const manage = tools.find((t) => t.name === "manage_work_items");
	assert.ok(manage, "manage_work_items must be present in the worker tool set");
	return { manage, item, updates, lookups, tools };
}

async function callUpdate(ctx) {
	return ctx.manage.execute("call", {
		action: "update",
		id: "3db7f642",
		goal: "每日巡检 spay 最近 7 天全部商户的日终对账异常；群内推送只发「需人工处理」完整列表（按商户/类型分组，组内完整不截断），其他部分省略，完整明细走报告链接。",
	});
}

test("OWNER inside a worker CAN update their own task (the ruling)", async () => {
	const ctx = boot();
	const result = await callUpdate(ctx);
	const text = result.content?.[0]?.text ?? "";
	assert.equal(
		result.details?.ok,
		true,
		`the owner must not be refused inside a worker; got: ${text.slice(0, 200)}`,
	);
	assert.ok(ctx.updates.length > 0, "the update must actually be persisted");
	const patched = ctx.updates.at(-1);
	assert.match(String(patched.patch.goal ?? ""), /需人工处理/, "the new goal text must land");
	// The capability guard and the IM checks resolved the ORIGIN chat, and the
	// fallback had to reach for the worker transcript to find the person.
	assert.ok(ctx.lookups.includes(GROUP), "lookups target the origin conversation");
	assert.ok(ctx.lookups.includes(WORKER), "the fallback reaches the worker transcript for the actor");
});

test("the same call is REFUSED for a non-owner in a worker (scope still holds)", async () => {
	const ctx = boot({ itemOverrides: { created_by: "someoneelse" } });
	// Same worker, but the verified person is an ordinary viewer.
	const config = {
		all: () => ({
			security: { adminStaffIds: [], defaultRole: "viewer", people: [{ name: "群成员", role: "viewer", staffId: "member1" }] },
			kb: { enabled: false }, browser: { enabled: false }, computer: { enabled: false }, scheduler: { enabled: false },
		}),
	};
	const tools = buildTools({
		config,
		conversationId: WORKER,
		originConversationId: GROUP,
		resolveActor: (cid) => (cid === WORKER ? { senderId: "member1", channel: "dingtalk", chatType: "single", text: "改一下" } : undefined),
		work: {
			items: { get: () => undefined, list: () => [], update: () => undefined, setField: () => undefined, resume: () => undefined, pause: () => undefined, cancel: () => undefined, setSchedule: () => undefined, addLesson: () => undefined, create: () => undefined },
			fireItem: () => true,
			mine: async () => ({ scanned: 0, proposals: [] }),
		},
		kbEnabled: false,
		onSkillsChanged: async () => {},
		listSkills: async () => ({ skills: [], info: [] }),
		onConfigChanged: () => {},
	});
	const manage = tools.find((t) => t.name === "manage_work_items");
	const result = await manage.execute("call", { action: "update", id: "3db7f642", goal: "x" });
	assert.equal(result.details?.ok, false, "an ordinary member must still be refused");
});

await rm(dir, { recursive: true, force: true });
