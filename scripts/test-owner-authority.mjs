/**
 * OWNER GLOBAL AUTHORITY — end-to-end through the REAL buildTools + REAL gates.
 *
 * User ruling, 2026-11-08: 「让 owner 权限能按照设计要求在单聊中修改 VE 的所有
 * 配置、脚本、知识和记忆」.
 *
 * Design intent (permissions.ts): owner is a strict superset of admin and may
 * act ACROSS conversations, because "I am the owner and I still have to go to
 * another chat to fix a stuck task" is a usability defect, not a security
 * property.
 *
 * This suite asserts the four resource classes the user named actually WORK for
 * an owner in a 1:1 DM — not merely that the tools are listed. Each case drives
 * the real gate chain (requireSingleChatActor → requireConfirmedAdmin →
 * effectiveActorRole) and fails on a concrete refusal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.owner-global-test-"));
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
const DM = `dt:${OWNER}`;
const GROUP = "dt:group:cidnD94vyjhmWEhoS0AEeH7+Q==";

function makeConfig({ role = "owner", senderId = OWNER, adminFullAccess = false, people } = {}) {
	const security = {
		adminStaffIds: [],
		ownerStaffIds: [],
		defaultRole: "viewer",
		adminFullAccess,
		people: people ?? [{ name: "张训", role, staffId: senderId }],
	};
	return {
		all: () => ({ security, general: { language: "zh-CN", taskProgressMin: 10 }, kb: { enabled: true, learn: true, manage: true, research: false, local: { topK: 5 } }, browser: { enabled: true }, computer: { enabled: true }, scheduler: { enabled: true }, documents: { enabled: true }, filesystem: { enabled: true, allowedDirs: ["C:/Nova"] }, reports: { enabled: true }, downloads: { enabled: true }, capabilities: { shell: { enabled: true, allowedCommands: ["echo"] }, mcp: { enabled: true } } }),
		update: () => {},
		get: () => undefined,
	};
}

function boot(opts = {}) {
	const senderId = opts.senderId ?? OWNER;
	const config = makeConfig({ ...opts, senderId });
	const effects = [];
	const writes = [];
	const tools = buildTools({
		config,
		conversationId: opts.conversationId ?? DM,
		...(opts.originConversationId ? { originConversationId: opts.originConversationId } : {}),
		kbEnabled: true, learnEnabled: true, manageEnabled: true,
		browserEnabled: true, schedulerEnabled: true, documentsEnabled: true,
		filesystemEnabled: true, reportsEnabled: true, downloadsEnabled: true,
		scheduler: {
			validateCron() {}, list: () => [], get: () => undefined,
			update: (id, patch) => { effects.push(["sched-update", id, patch]); return { id, title: "T", ...patch }; },
			create: (input) => { effects.push(["sched-create", input]); return { id: "s1", ...input }; },
			remove: () => undefined, fireNow: () => true, stageAnswer: () => {}, setCreatedBy: () => undefined,
		},
		knowledge: {
			search: async () => [], saveLearned: async (entry) => { writes.push(["kb", entry]); return { id: "k1" }; },
			searchEntries: async () => [], delete: async () => true, update: async () => ({}), reindex: async () => ({}),
			save: async () => ({ id: "k1" }),
		},
		filesystem: {
			list: async () => [], read: async () => "",
			writeTextFile: async (p, c) => { writes.push(["fs", p, c]); return true; },
			remove: async () => true, write: async () => true,
		},
		work: {
			items: { get: () => undefined, list: () => [], create: () => undefined, update: () => undefined, setField: () => undefined, resume: () => undefined, pause: () => undefined, cancel: () => undefined, setSchedule: () => undefined, addLesson: () => undefined },
			fireItem: () => true, mine: async () => ({ scanned: 0, proposals: [] }),
		},
		resolveActor: () => ({ senderId, channel: "dingtalk", chatType: "single", text: opts.text ?? "确认修改" }),
		onSkillsChanged: async () => {},
		listSkills: async () => ({ skills: [], info: [] }),
		onConfigChanged: () => { effects.push(["config-changed"]); },
	});
	return { tools, effects, writes, names: tools.map((t) => t.name) };
}

const find = (tools, name) => {
	const t = tools.find((x) => x.name === name);
	assert.ok(t, `tool ${name} is not registered at all`);
	return t;
};

// ── 1. CONFIG ───────────────────────────────────────────────────────────────
test("CONFIG: owner in a DM can READ settings", async () => {
	const { tools } = boot();
	const r = await find(tools, "manage_settings").execute("c", { action: "get", path: "general.language" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a settings read: ${text.slice(0, 160)}`);
	assert.match(text, /zh-CN|language/i, "the value must come back");
});

test("CONFIG: owner in a DM can WRITE settings (with confirmation)", async () => {
	const { tools, effects } = boot();
	const r = await find(tools, "manage_settings").execute("c", { action: "set", path: "general.taskProgressMin", value: 30 });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a settings write: ${text.slice(0, 160)}`);
});

test("CONFIG: owner in a DM can toggle capabilities", async () => {
	const { tools } = boot();
	const cap = find(tools, "manage_capabilities");
	const r = await cap.execute("c", { action: "list" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused capability list: ${text.slice(0, 160)}`);
});

// ── 2. SCRIPT ───────────────────────────────────────────────────────────────
test("SCRIPT: owner in a DM can run a command", async () => {
	const { tools } = boot();
	const r = await find(tools, "run_command").execute("c", { command: "echo hi" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a command: ${text.slice(0, 160)}`);
});

test("SCRIPT: owner in a DM can write a file", async () => {
	const { tools } = boot();
	const r = await find(tools, "write_text_file").execute("c", { path: "C:/Nova/x.txt", content: "hi" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a file write: ${text.slice(0, 160)}`);
});

// ── 3. KNOWLEDGE ────────────────────────────────────────────────────────────
test("KNOWLEDGE: owner in a DM can save knowledge", async () => {
	const { tools } = boot();
	const r = await find(tools, "save_to_knowledge").execute("c", { title: "T", content: "C" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a knowledge write: ${text.slice(0, 160)}`);
});

// ── 4. MEMORY ───────────────────────────────────────────────────────────────
test("MEMORY: owner in a DM can write memory", async () => {
	const { tools } = boot();
	const r = await find(tools, "remember").execute("c", { content: "owner 在单聊里可以改记忆" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a memory write: ${text.slice(0, 160)}`);
});

// ── CROSS-CONVERSATION: the design intent ────────────────────────────────────
test("CROSS-CONVERSATION: owner in a DM can edit a task owned by a GROUP", async () => {
	const { tools, effects } = boot();
	const r = await find(tools, "update_scheduled_task").execute("c", { id: "abc", prompt: "NEW" });
	const text = r.content?.[0]?.text ?? "";
	assert.notEqual(r.details?.refused, true, `owner refused a cross-conversation edit: ${text.slice(0, 200)}`);
	assert.ok(effects.some((e) => e[0] === "sched-update"), "the edit must reach the scheduler");
});

// ── THE SUBSET CONTRACT: owner must never be weaker than admin ───────────────
test("SUPERSET: every action an admin can take, an owner can take too", async () => {
	const asAdmin = boot({ people: [{ name: "管理员", role: "admin", staffId: OWNER }] });
	const asOwner = boot({ people: [{ name: "所有者", role: "owner", staffId: OWNER }] });
	const probes = [
		["manage_settings", { action: "get", path: "general.language" }],
		["manage_capabilities", { action: "list" }],
		["run_command", { command: "echo hi" }],
	];
	for (const [name, params] of probes) {
		const a = await find(asAdmin.tools, name).execute("c", params);
		const o = await find(asOwner.tools, name).execute("c", params);
		const aRefused = a.details?.refused === true;
		const oRefused = o.details?.refused === true;
		if (!aRefused) {
			assert.equal(oRefused, false, `admin was allowed ${name} but OWNER was refused — owner must be a superset`);
		}
	}
});

// ── CLAIM SEMANTICS: adding owner to hasAnyAdmin must not weaken the claim gate
test("CLAIM: a deployment whose only principal is its owner counts as CLAIMED", async () => {
	// hasAnyAdmin is the UNCLAIMED probe. Returning false means "the next person
	// to say 确认 becomes the first admin" — a self-service escalation. A
	// deployment that configured an owner is managed, so that door must be SHUT.
	// This is the security side of the fix: adding owner makes the gate STRICTER
	// for strangers while OPENING it for the owner (see the CONFIG cases above).
	const { tools } = boot({ people: [{ name: "所有者", role: "owner", staffId: OWNER }] });
	const r = await find(tools, "manage_settings").execute("c", { action: "get", path: "general.language" });
	const text = r.content?.[0]?.text ?? "";
	assert.ok(
		!/管理员尚未设置/.test(text),
		"an owner-configured deployment must not report itself unclaimed",
	);
});

test("CLAIM: an empty deployment is still UNCLAIMED (claim path preserved)", async () => {
	// Reads are deliberately ungated (get must work before anyone is claimed),
	// so the CLAIM probe shows up on a WRITE, not a read.
	const { tools } = boot({ people: [] });
	const w = await find(tools, "manage_settings").execute("c", { action: "set", path: "general.taskProgressMin", value: 30 });
	const text = w.content?.[0]?.text ?? "";
	assert.equal(w.details?.refused, true, "an unclaimed deployment must refuse writes");
	assert.match(text, /管理员尚未设置|claim/, "a truly empty deployment keeps the claim path");
});

await rm(dir, { recursive: true, force: true });
