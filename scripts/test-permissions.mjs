/**
 * RBAC permission model + access-tool tests. Run with `npm run test:permissions`.
 *
 * Pure logic against an in-memory SQLite config store (same esbuild-bundle
 * pattern as test-shell-timeout.mjs): no app data, no network, no child
 * processes. Covers role resolution precedence, conversation floors (tighten
 * only, never loosen, fail closed on typos), the local-vs-IM trust boundary,
 * the last-admin guards, and normalization of hand-edited config files.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = await mkdtemp(join(root, "node_modules/.permissions-test-"));
after(() => rm(workDir, { recursive: true, force: true }));
const bundle = join(workDir, "permissions.mjs");
await build({
	stdin: {
		contents: `
			export { ConfigStore } from "./src/db/config-store.ts";
			export { HistoryStore } from "./src/db/history-store.ts";
			export { checkPermission, resolveRole, hasAnyAdmin, isAdmin, describeAccess, CAPABILITY_LABEL } from "./src/security/permissions.ts";
			export { createManageAccessTool, createCheckMyAccessTool } from "./src/engine/tools/access.ts";
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
const {
	ConfigStore,
	HistoryStore,
	checkPermission,
	resolveRole,
	hasAnyAdmin,
	isAdmin,
	describeAccess,
	createManageAccessTool,
	createCheckMyAccessTool,
} = await import(pathToFileURL(bundle).href);

/** Fresh in-memory config store with the tables ConfigStore touches. */
function store(t, seed = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const config = new ConfigStore(db);
	t.after(() => db.close());
	if (Object.keys(seed).length) config.replaceAll(seed);
	return { db, config };
}

const actor = (senderId, chatType = "single", text = "") => ({ senderId, chatType, channel: "dingtalk", text });

/** Roster store on an in-memory DB carrying the real schema's columns. */
function roster(t) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE conversation_members (
			conversation_id TEXT NOT NULL,
			staff_id        TEXT NOT NULL,
			name            TEXT,
			first_seen_at   INTEGER NOT NULL,
			last_seen_at    INTEGER NOT NULL,
			message_count   INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (conversation_id, staff_id)
		);
	`);
	t.after(() => db.close());
	return new HistoryStore(db);
}

/** The exact member shape engine.ts hands to the access tool. */
const asDep = (members) =>
	members.map((m) => ({ staffId: m.staff_id, name: m.name, lastSeenAt: m.last_seen_at, messageCount: m.message_count }));

/** Tie-break the roster's recency ordering when a test asserts on it. */
const tick = () => new Promise((r) => setTimeout(r, 3));

test("role precedence: people[] > adminStaffIds > defaultRole", (t) => {
	const { config } = store(t, {
		security: {
			adminStaffIds: ["boss"],
			defaultRole: "viewer",
			people: [
				{ staffId: "alice", role: "operator", name: "Alice" },
				{ staffId: "boss", role: "viewer" }, // explicit entry outranks the whitelist
			],
		},
	});
	assert.equal(resolveRole(config, "alice"), "operator");
	assert.equal(resolveRole(config, "boss"), "viewer");
	assert.equal(resolveRole(config, "stranger"), "viewer");
	assert.equal(resolveRole(config, undefined), "viewer");
	assert.equal(isAdmin(config, "boss"), false);
	assert.equal(hasAnyAdmin(config), true, "whitelist still counts as an admin configured");
});

test("unknown senders fall back to defaultRole; default admin grants everything", (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"], defaultRole: "admin" } });
	assert.equal(checkPermission(config, actor("whoever"), "dt:group:g1", "computer").ok, true);
	config.update({ security: { defaultRole: "viewer" } });
	assert.equal(checkPermission(config, actor("whoever"), "dt:group:g1", "computer").ok, false);
});

test("local console conversations keep full access; IM/runtime conversations do not", (t) => {
	const { config } = store(t, { security: { adminStaffIds: [], defaultRole: "viewer" } });
	// Desktop console + localhost HTTP use bare uuids: the settings UI's trust.
	assert.equal(checkPermission(config, undefined, "9f0c4a1e-console", "shell").ok, true);
	// An IM conversation whose turn arrived without verified metadata must NOT
	// inherit admin: it resolves to the default role — for every channel prefix,
	// not just DingTalk (a bare `dt:`-only check would fail open on feishu/wecom).
	assert.equal(checkPermission(config, undefined, "dt:group:g1", "browser").ok, false);
	assert.equal(checkPermission(config, undefined, "feishu:oc_abc123", "browser").ok, false);
	assert.equal(checkPermission(config, undefined, "wecom:group-1", "browser").ok, false);
	assert.equal(checkPermission(config, undefined, "echo:conv-1", "browser").ok, false);
	assert.equal(checkPermission(config, undefined, "sched:t1:1700000000000", "browser").ok, false);
});

test("conversation floors tighten per chat and never loosen past the capability default", (t) => {
	const { config } = store(t, {
		security: {
			adminStaffIds: ["boss"],
			defaultRole: "viewer",
			people: [{ staffId: "op", role: "operator" }],
			conversations: [{ id: "dt:group:prod", name: "生产群", floors: { browser: "admin", filesystem: "operator" } }],
		},
	});
	// Group floor raises browser (default operator) to admin.
	assert.equal(checkPermission(config, actor("op"), "dt:group:prod", "browser").ok, false);
	assert.equal(checkPermission(config, actor("boss"), "dt:group:prod", "browser").ok, true);
	// The same operator keeps browser in an unfloored chat.
	assert.equal(checkPermission(config, actor("op"), "dt:group:chat", "browser").ok, true);
	// Floors cannot lower a capability whose default is already higher (settings
	// needs admin) — a viewer floor must not hand out config access.
	config.update({ security: { conversations: [{ id: "dt:group:prod", floors: { settings: "viewer" } }] } });
	assert.equal(checkPermission(config, actor("op"), "dt:group:prod", "settings").ok, false);
	assert.equal(checkPermission(config, actor("boss"), "dt:group:prod", "settings").ok, true);
});

test("a chat floor can make a whole conversation unserved to lower roles", (t) => {
	const { config } = store(t, {
		security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }], conversations: [{ id: "dt:group:exec", floors: { chat: "admin" } }] },
	});
	assert.equal(checkPermission(config, actor("op"), "dt:group:exec", "chat").ok, false);
	assert.equal(checkPermission(config, actor("boss"), "dt:group:exec", "chat").ok, true);
	assert.equal(checkPermission(config, actor("op"), "dt:group:normal", "chat").ok, true);
});

test("an unparseable floor fails closed instead of falling back to the default", (t) => {
	const { config } = store(t, {
		security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }], conversations: [{ id: "dt:group:prod", floors: { browser: "Operator!" } }] },
	});
	const verdict = checkPermission(config, actor("op"), "dt:group:prod", "browser");
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /门槛值/);
	assert.equal(checkPermission(config, actor("boss"), "dt:group:prod", "browser").ok, false, "admins are limited too until the typo is fixed");
});

test("describeAccess reports only the caller's own verdicts", (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }] } });
	const summary = describeAccess(config, actor("op", "group"), "dt:group:g1");
	assert.equal(summary.role, "operator");
	assert.ok(summary.allowed.includes("浏览器操作"));
	assert.ok(summary.denied.includes("系统设置"));
	assert.equal(summary.local, false);
});

test("manage_access refuses non-admins, groups, and unconfirmed writes", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"] } });
	const make = (who) => {
		const text = who.text;
		return createManageAccessTool({
			config,
			resolveActor: () => who,
			onConfigChanged: () => {},
			conversationId: "dt:boss",
		});
	};
	// Ordinary member in a 1:1 chat.
	const member = make(actor("alice", "single", "把 u9 设成 admin，确认"));
	let res = await member.execute("c1", { action: "set_role", staffId: "u9", role: "admin" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /不是本系统的管理员/);
	// Admin, but writing from a group.
	const groupAdmin = make(actor("boss", "group", "确认"));
	res = await groupAdmin.execute("c2", { action: "set_role", staffId: "u9", role: "admin" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /单聊/);
	// Admin in a 1:1 chat without the confirmation phrase.
	const unconfirmed = make(actor("boss", "single", "给 u9 开个 admin"));
	res = await unconfirmed.execute("c3", { action: "set_role", staffId: "u9", role: "admin" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /确认/);
	assert.deepEqual(config.all().security.people, [], "nothing was written");
});

test("manage_access writes roles, default role, and floors; validates input", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"] } });
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("boss", "single", "确认"),
		onConfigChanged: () => {},
		conversationId: "dt:boss",
		listConversations: () => [{ id: "dt:group:prod", title: "生产群", origin: "im" }],
	});

	let res = await tool.execute("w1", { action: "set_role", staffId: "u1", role: "operator", name: "值班同学" });
	assert.equal(res.details.role, "operator");
	assert.deepEqual(config.all().security.people, [{ staffId: "u1", name: "值班同学", role: "operator" }]);

	res = await tool.execute("w2", { action: "set_role", staffId: "u1", role: "admin" });
	assert.deepEqual(config.all().security.people, [{ staffId: "u1", name: "值班同学", role: "admin" }], "re-assignment updates in place");

	res = await tool.execute("w3", { action: "set_role", staffId: "u2", role: "superuser" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /viewer \/ operator \/ admin/);

	res = await tool.execute("w4", { action: "set_conversation", conversationName: "dt:group:prod", floors: { knowledge: "admin", browser: "operator", nonsense: "admin" } });
	assert.equal(res.details.refused, true, "unknown capability names are rejected");

	res = await tool.execute("w5", { action: "set_conversation", conversationName: "dt:group:prod", floors: { knowledge: "admin", browser: "default" } });
	assert.deepEqual(res.details.floors, { knowledge: "admin" }, "browser equal to its default is stored as no floor");

	res = await tool.execute("w6", { action: "set_default_role", role: "operator" });
	assert.equal(config.all().security.defaultRole, "operator");
	assert.match(res.content[0].text, /风险较高/);

	res = await tool.execute("w7", { action: "list" });
	assert.match(res.content[0].text, /dt:group:prod/);

	res = await tool.execute("w8", { action: "remove_conversation", conversationName: "dt:group:prod" });
	assert.deepEqual(config.all().security.conversations, []);
});

test("the last admin cannot be demoted or removed through manage_access", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: [], people: [{ staffId: "solo", role: "admin" }] } });
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("solo", "single", "确认"),
		onConfigChanged: () => {},
		conversationId: "dt:solo",
	});
	let res = await tool.execute("l1", { action: "set_role", staffId: "solo", role: "viewer" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /最后一位管理员/);
	res = await tool.execute("l2", { action: "remove_person", staffId: "solo" });
	assert.equal(res.details.refused, true);
	assert.equal(resolveRole(config, "solo"), "admin");
	// Promote someone else first — then the demotion is allowed.
	await tool.execute("l3", { action: "set_role", staffId: "other", role: "admin" });
	res = await tool.execute("l4", { action: "set_role", staffId: "solo", role: "viewer" });
	assert.equal(res.details.refused, undefined);
	assert.equal(resolveRole(config, "solo"), "viewer");
	assert.equal(isAdmin(config, "other"), true);
});

test("check_my_access answers any sender with their own effective permissions", async (t) => {
	const { config } = store(t, {
		security: { adminStaffIds: ["boss"], people: [{ staffId: "op", role: "operator" }], conversations: [{ id: "dt:group:prod", floors: { filesystem: "admin" } }] },
	});
	const viewer = createCheckMyAccessTool({
		config,
		resolveActor: () => actor("nobody", "group"),
		onConfigChanged: () => {},
		conversationId: "dt:group:prod",
	});
	const res = await viewer.execute("q1", {});
	assert.match(res.content[0].text, /viewer/);
	assert.ok(res.details.denied.length > 0);
	const one = await viewer.execute("q2", { capability: "filesystem" });
	assert.equal(one.details.refused, true);
	assert.match(one.content[0].text, /文件系统/);
	const bad = await viewer.execute("q3", { capability: "root" });
	assert.match(bad.content[0].text, /未知能力名/);
});

test("normalization keeps the policy through a save/load round trip and drops junk", (t) => {
	const { db, config } = store(t);
	config.update({
		security: {
			adminStaffIds: ["  boss  ", "boss", ""],
			defaultRole: "nonsense",
			people: [
				{ staffId: "u1", role: "operator" },
				{ staffId: "u1", name: "重新指派", role: "admin" },
				{ staffId: "u2", role: "root" },
				{ staffId: "   ", role: "admin" },
			],
			conversations: [
				{ id: "dt:group:prod", name: "生产群", floors: { browser: "admin", knowledge: "sudo" } },
				{ id: "", floors: { browser: "admin" } },
			],
		},
	});
	// Reopen from the same DB — the normalization path runs on every load.
	const reloadedStore = new ConfigStore(db);
	const reloaded = reloadedStore.all().security;
	assert.deepEqual(reloaded.adminStaffIds, ["boss"]);
	assert.equal(reloaded.defaultRole, "viewer", "an invalid default role falls back to viewer");
	assert.deepEqual(reloaded.people, [
		{ staffId: "u1", name: "重新指派", role: "admin" },
	], "dedupe by id, last entry wins, invalid roles and blank ids dropped");
	assert.deepEqual(reloaded.conversations, [
		{ id: "dt:group:prod", name: "生产群", floors: { browser: "admin", knowledge: "sudo" } },
	], "invalid floor values are KEPT so the permission check can fail closed on them");
	assert.equal(checkPermission(reloadedStore, actor("boss"), "dt:group:prod", "knowledge").ok, false,
		"a typo'd floor value (sudo) denies everyone until an admin fixes it");
});

test("the roster accumulates inbound senders: idempotent, name-backfilling, per-conversation", (t) => {
	const store = roster(t);
	store.recordMember("dt:group:g1", "alice", "成员A");
	store.recordMember("dt:group:g1", "bob");
	store.recordMember("dt:other", "alice");

	let rows = store.listMembers("dt:group:g1");
	assert.equal(rows.length, 2);
	assert.equal(rows.find((r) => r.staff_id === "alice").message_count, 1);

	// A repeat from the same sender must bump the counter, not add a row…
	store.recordMember("dt:group:g1", "alice");
	rows = store.listMembers("dt:group:g1");
	assert.equal(rows.length, 2, "the same sender never appears twice");
	assert.equal(rows.find((r) => r.staff_id === "alice").message_count, 2);
	assert.equal(rows.find((r) => r.staff_id === "alice").name, "成员A");
	assert.ok(rows.find((r) => r.staff_id === "alice").last_seen_at >= rows.find((r) => r.staff_id === "bob").last_seen_at);

	// …a late name fills in, but a nameless repeat must NOT erase a known name.
	store.recordMember("dt:group:g1", "bob", "成员B");
	store.recordMember("dt:group:g1", "bob");
	assert.equal(store.listMembers("dt:group:g1").find((r) => r.staff_id === "bob").name, "成员B");

	// The roster is keyed by conversation: another chat's members are not leaked.
	assert.deepEqual(store.listMembers("dt:other").map((r) => r.staff_id), ["alice"]);
	assert.deepEqual(store.listMembers("dt:unknown"), []);
});

test("the roster table in sqlite.ts matches the upsert's conflict target", async () => {
	// The store and the schema drift silently if this ever changes: an upsert
	// against a missing/renamed PRIMARY KEY throws at the worst moment (first IM
	// message after an upgrade), and the error is swallowed by the best-effort
	// wrapper, so the roster would just stay empty.
	const source = await readFile(join(root, "src/db/sqlite.ts"), "utf8");
	const block = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS conversation_members"));
	const ddl = block.slice(0, block.indexOf(");") + 2);
	for (const column of ["conversation_id", "staff_id", "name", "first_seen_at", "last_seen_at", "message_count"]) {
		assert.ok(ddl.includes(column), `schema is missing column ${column}`);
	}
	assert.match(ddl, /PRIMARY KEY\s*\(\s*conversation_id\s*,\s*staff_id\s*\)/, "the upsert's ON CONFLICT target must exist");
});

test("list_members resolves a group by NAME and never guesses members", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"] } });
	const store2 = roster(t);
	store2.recordMember("dt:group:prod", "alice", "成员A");
	await tick();
	store2.recordMember("dt:group:prod", "bob", "成员B");
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("boss", "single", "看看成员"),
		onConfigChanged: () => {},
		conversationId: "dt:boss",
		listConversations: () => [
			{ id: "dt:group:prod", title: "生产群", origin: "im" },
			{ id: "dt:group:quiet", title: "安静群", origin: "im" },
			{ id: "9f0c-console", title: "本地会话", origin: "console" },
		],
		listMembers: (cid) => asDep(store2.listMembers(cid)),
	});

	// No target at all: in a 1:1 chat there is no "current group", so the tool must
	// ask — and it must ask for a NAME, never for an id nobody can look up.
	let res = await tool.execute("m1", { action: "list_members" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /缺少目标会话/);
	assert.match(res.content[0].text, /群名/);
	assert.doesNotMatch(res.content[0].text, /请提供.{0,6}(会话)?ID/, "never asks the human for an id");

	res = await tool.execute("m2", { action: "list_members", conversationName: "生产群" });
	assert.equal(res.details.memberCount, 2);
	assert.equal(res.details.conversationId, "dt:group:prod", "the group name resolved to the platform id");
	assert.match(res.content[0].text, /只含给机器人发过消息的人/, "the roster's incompleteness is stated, not hidden");
	assert.match(res.content[0].text, /成员A/);
	assert.deepEqual(res.details.members.map((m) => m.staffId), ["bob", "alice"], "most recently active first");

	// An id also works (the model may echo one from `list`).
	res = await tool.execute("m2b", { action: "list_members", conversationId: "dt:group:prod" });
	assert.equal(res.details.memberCount, 2);

	res = await tool.execute("m3", { action: "list_members", conversationName: "安静群" });
	assert.equal(res.details.memberCount, 0);
	assert.match(res.content[0].text, /不要凭群名推测成员/);
	assert.match(res.content[0].text, /在这个群里 @ 我 随便说一句话/, "it hands over a usable next step");
	assert.doesNotMatch(res.content[0].text, /staffId/, "and never sends the admin looking for an id");

	res = await tool.execute("m3b", { action: "list_members", conversationName: "示例群" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /没有叫「示例群」的会话/);
	assert.match(res.content[0].text, /生产群/, "it lists the groups it does know so the admin can correct the name");

	// Non-admins cannot enumerate who is in which chat.
	const member = createManageAccessTool({
		config, resolveActor: () => actor("alice", "single", "名单"), onConfigChanged: () => {},
		conversationId: "dt:alice", listMembers: (cid) => asDep(store2.listMembers(cid)),
	});
	res = await member.execute("m4", { action: "list_members", conversationName: "生产群" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /不是本系统的管理员/);
});

test("a person is resolved by NAME from the bot's own roster, or refused with candidates", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"], defaultRole: "viewer" } });
	const store2 = roster(t);
	store2.recordMember("dt:group:prod", "s_alice", "成员A");
	store2.recordMember("dt:group:prod", "s_zhang1", "张工");
	store2.recordMember("dt:group:ops", "s_zhang2", "张工");
	store2.recordMember("dt:group:prod", "s_wang", "王小明");
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("boss", "single", "确认"),
		onConfigChanged: () => {},
		conversationId: "dt:boss",
		listConversations: () => [
			{ id: "dt:group:prod", title: "生产群", origin: "im" },
			{ id: "dt:group:ops", title: "运维群", origin: "im" },
		],
		listMembers: (cid) => asDep(store2.listMembers(cid)),
	});

	// The point of the whole change: an admin who only knows a display name can act.
	let res = await tool.execute("p1", { action: "set_role", person: "成员A", role: "operator" });
	assert.equal(res.details.staffId, "s_alice");
	assert.equal(res.details.matchedBy, "name");
	assert.match(res.content[0].text, /成员A/);
	assert.match(res.content[0].text, /s_alice/, "the reply shows which id it resolved to");
	assert.deepEqual(config.all().security.people, [{ staffId: "s_alice", name: "成员A", role: "operator" }]);

	// Two people share a name → refuse and show both, never pick one.
	res = await tool.execute("p2", { action: "set_role", person: "张工", role: "operator" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /叫「张工」的有 2 个人/);
	assert.match(res.content[0].text, /s_zhang1/);
	assert.match(res.content[0].text, /s_zhang2/);
	assert.match(res.content[0].text, /生产群|运维群/, "candidates say where each person was seen");
	assert.equal(resolveRole(config, "s_zhang1"), "viewer", "nothing was written");

	// A partial name offers near matches instead of guessing.
	res = await tool.execute("p3", { action: "set_role", person: "王", role: "operator" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /名字接近的有/);
	assert.match(res.content[0].text, /王小明/);

	// Someone who never messaged the bot cannot be resolved — say what to do.
	res = await tool.execute("p4", { action: "set_role", person: "李四", role: "operator" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /只登记\*\*给机器人发过消息的人\*\*/);
	assert.match(res.content[0].text, /list_people/);

	// The id path still works, and carries the roster name along.
	res = await tool.execute("p5", { action: "set_role", person: "s_wang", role: "admin" });
	assert.equal(res.details.matchedBy, "roster-id");
	assert.deepEqual(config.all().security.people.find((p) => p.staffId === "s_wang"), { staffId: "s_wang", name: "王小明", role: "admin" });

	// A name dropped into the id parameter must NOT be written as a staffId.
	res = await tool.execute("p6", { action: "set_role", staffId: "成员A", role: "operator" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /看起来是姓名/);
	assert.match(res.content[0].text, /person=<姓名>/);
	assert.equal(config.all().security.people.some((p) => p.staffId === "成员A"), false, "no dead staffId entry was created");

	// list_people is the directory the admin works from.
	res = await tool.execute("p7", { action: "list_people" });
	assert.equal(res.details.peopleCount, 4);
	assert.match(res.content[0].text, /成员A/);
	assert.match(res.content[0].text, /运维群/, "it says where each person was seen");
});

test("a group-wide grant resolves the group by name and refuses to guess it", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"], defaultRole: "viewer" } });
	const store2 = roster(t);
	store2.recordMember("dt:group:prod", "s_a", "成员A");
	store2.recordMember("dt:group:prod", "s_b", "成员B");
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("boss", "single", "确认"),
		onConfigChanged: () => {},
		conversationId: "dt:boss",
		listConversations: () => [
			{ id: "dt:group:prod", title: "内部群", origin: "im" },
			{ id: "dt:group:other", title: "外部群", origin: "im" },
		],
		listMembers: (cid) => asDep(store2.listMembers(cid)),
	});

	let res = await tool.execute("g1", { action: "set_conversation_roles", conversationName: "内部群", role: "operator" });
	assert.equal(res.details.changed, 2);
	assert.equal(res.details.conversationId, "dt:group:prod");
	assert.match(res.content[0].text, /内部群/);

	res = await tool.execute("g2", { action: "set_conversation_roles", conversationName: "内部", role: "viewer" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /没有正好叫「内部」的会话/);
	assert.match(res.content[0].text, /内部群/);

	// Group-wide admin is the one case that must carry the scope warning.
	res = await tool.execute("g3", { action: "set_conversation_roles", conversationName: "内部群", role: "admin" });
	assert.match(res.content[0].text, /⚠️/);
	assert.equal(isAdmin(config, "s_a"), true);

	// Floors take a group name too.
	res = await tool.execute("g4", { action: "set_conversation", conversationName: "内部群", floors: { knowledge: "admin" } });
	assert.deepEqual(res.details.floors, { knowledge: "admin" });
	res = await tool.execute("g5", { action: "remove_conversation", conversationName: "内部群" });
	assert.deepEqual(config.all().security.conversations, []);
});

test("a permission request in a group is refused with instructions that need no id", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: ["boss"] } });
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("boss", "group", "给群里所有人设 operator"),
		onConfigChanged: () => {},
		conversationId: "dt:group:prod",
	});
	const res = await tool.execute("h1", { action: "set_conversation_roles", conversationName: "生产群", role: "operator" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /单聊/);
	assert.match(res.content[0].text, /不用提供任何 ID/, "the way forward must not require an id");
	assert.match(res.content[0].text, /有哪些群|这个群都有谁/, "it offers wording the admin can actually say");
});

test("the platform's group name is stored as the conversation title without touching recency", (t) => {
	// A group name arrives with EVERY inbound message, so this write must not
	// bump updated_at — otherwise the sidebar would reshuffle on each message.
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE conversations (
			id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
			model_supplier_id TEXT, model_model_id TEXT, origin TEXT NOT NULL DEFAULT 'console'
		);
	`);
	t.after(() => db.close());
	const store2 = new HistoryStore(db);
	store2.ensureConversation("dt:group:prod", "帮我看看这个", "im");
	const before = store2.getConversation("dt:group:prod");

	store2.setConversationName("dt:group:prod", "示例群");
	const after = store2.getConversation("dt:group:prod");
	assert.equal(after.title, "示例群");
	assert.equal(after.updated_at, before.updated_at, "recency is untouched");
	assert.equal(after.origin, "im", "origin is preserved — the trust boundary keys off it");
});

test("set_conversation_roles grants the whole observed roster, but spares the last admin", async (t) => {
	const { config } = store(t, { security: { adminStaffIds: [], defaultRole: "viewer", people: [{ staffId: "solo", role: "admin", name: "我" }] } });
	const store2 = roster(t);
	store2.recordMember("dt:group:prod", "solo", "我");
	await tick();
	store2.recordMember("dt:group:prod", "alice", "成员A");
	const tool = createManageAccessTool({
		config,
		resolveActor: () => actor("solo", "single", "确认"),
		onConfigChanged: () => {},
		conversationId: "dt:solo",
		listConversations: () => [
			{ id: "dt:group:prod", title: "内部群", origin: "im" },
			{ id: "dt:group:quiet", title: "安静群", origin: "im" },
		],
		listMembers: (cid) => asDep(store2.listMembers(cid)),
	});

	// No target conversation ⇒ refuse (this is what "给群内所有人加管理员" hits).
	let res = await tool.execute("b1", { action: "set_conversation_roles", role: "admin" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /缺少目标会话/);

	// A known-but-empty conversation ⇒ refuse rather than silently granting nobody.
	res = await tool.execute("b2", { action: "set_conversation_roles", conversationName: "安静群", role: "admin" });
	assert.equal(res.details.refused, true);
	assert.match(res.content[0].text, /没有已记录成员/);
	assert.match(res.content[0].text, /@ 我 随便说一句话/, "the remedy is the group @, stated as an action");
	assert.match(res.content[0].text, /不要去向对方索要 staffId/, "and the id route is refused explicitly");

	// Bulk DEMOTION must skip the only admin and still apply to everyone else.
	res = await tool.execute("b3", { action: "set_conversation_roles", conversationName: "内部群", role: "operator" });
	assert.equal(res.details.changed, 1);
	assert.match(res.content[0].text, /成员A/);
	assert.ok(res.details.skipped.some((s) => s.includes("最后一位管理员")));
	assert.equal(resolveRole(config, "solo"), "admin", "the deployment keeps an admin");
	assert.equal(resolveRole(config, "alice"), "operator");

	// Promoting the roster to admin is applied per member, with the scope warning.
	res = await tool.execute("b4", { action: "set_conversation_roles", conversationName: "内部群", role: "admin" });
	assert.equal(res.details.changed, 1, "solo already is admin — no redundant write");
	assert.deepEqual(res.details.skipped, ["我（已是 admin）"]);
	assert.match(res.content[0].text, /⚠️/, "it warns that these are system-wide admins, not group-local");
	assert.match(res.content[0].text, /默认角色/);
	assert.equal(isAdmin(config, "alice"), true);

	// A bulk demotion can never empty the admin seat, even when every member of
	// the roster is currently admin: whoever gets processed last is skipped.
	res = await tool.execute("b5", { action: "set_conversation_roles", conversationName: "内部群", role: "viewer" });
	assert.equal(res.details.changed, 1);
	assert.equal(res.details.skipped.length, 1);
	assert.match(res.details.skipped[0], /最后一位管理员/);
	assert.equal(
		[isAdmin(config, "alice"), isAdmin(config, "solo")].filter(Boolean).length,
		1,
		"exactly one admin survives — the seat is never emptied by a bulk write",
	);

	// A refused call must not write anything.
	const beforeRefused = config.all().security.people;
	res = await tool.execute("b6", { action: "set_conversation_roles", conversationName: "内部群", role: "root" });
	assert.equal(res.details.refused, true);
	assert.deepEqual(config.all().security.people, beforeRefused);
});
