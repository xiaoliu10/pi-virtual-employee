/**
 * LAST-ADMIN GUARD matrix (v0.2.206) — the wouldKeepAnAdmin contract.
 *
 * Reviewer Finding 2 (2026-11-08): the guard counted role === "admin" only.
 * Adding owner fixed that, but the deeper trap is resolveRole's PRECEDENCE:
 * people[] > ownerStaffIds > adminStaffIds. A `people[]` entry SHADOWS a
 * whitelist grant, so "the target is still an owner via ownerStaffIds" is a
 * LIE whenever the demotion writes a people[] entry for the target — the
 * deployment ends up CLAIMED (hasAnyAdmin counts ownerStaffIds) with NO
 * effective administrator (recoverable only via the desktop UI).
 *
 * The guard therefore excludes the TARGET from the whitelist checks, and the
 * matrix below pins every shape:
 *   M1 the only admin lives in people[]        → demotion refused
 *   M2 the only rank is adminStaffIds[self]    → demotion refused
 *   M3 adminStaffIds[self] + ownerStaffIds[other] → allowed (other still manages)
 *   M4 the only rank is ownerStaffIds[self]    → refused (the SHADOWING case)
 *   M5 people[]{owner,self} + ownerStaffIds[self] → refused (people[] shadows)
 *   M6 two admins in people[]                  → allowed
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(root, "node_modules/.keep-admin-test-"));
const bundle = join(dir, "def.mjs");
await build({
	stdin: { contents: 'export { buildTools } from "./src/engine/definition.ts";', resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
});
const { buildTools } = await import(pathToFileURL(bundle).href);
const A = "admin1";
const DM = `dt:${A}`;

async function setRole(secInit) {
	const sec = JSON.parse(JSON.stringify(secInit));
	const config = {
		all: () => ({ security: sec, general: {}, kb: { enabled: false }, browser: { enabled: false }, computer: { enabled: false }, scheduler: { enabled: false }, capabilities: { shell: { enabled: true, allowedCommands: ["echo"] }, mcp: { enabled: true } } }),
		update: (p) => {
			if (p.security?.people !== undefined) sec.people = p.security.people;
			if (p.security?.adminStaffIds !== undefined) sec.adminStaffIds = p.security.adminStaffIds;
			if (p.security?.ownerStaffIds !== undefined) sec.ownerStaffIds = p.security.ownerStaffIds;
			return { security: sec };
		},
	};
	const tools = buildTools({
		config, conversationId: DM, kbEnabled: false, schedulerEnabled: false,
		documentsEnabled: false, filesystemEnabled: false, reportsEnabled: false, downloadsEnabled: false,
		listConversations: () => [{ id: DM, title: "单聊", origin: "im" }],
		listMembers: () => [{ staffId: A, name: "A", lastSeenAt: 1, messageCount: 1 }],
		resolveActor: () => ({ senderId: A, channel: "dingtalk", chatType: "single", text: "确认" }),
		onSkillsChanged: async () => {}, listSkills: async () => ({ skills: [], info: [] }), onConfigChanged: () => {},
	});
	const access = tools.find((t) => t.name === "manage_access");
	const r = await access.execute("c", { action: "set_role", person: A, role: "viewer" });
	return r.details?.refused ? "refused" : "allowed";
}

test("M1: the only admin lives in people[] — demotion refused", async () => {
	const got = await setRole({ adminStaffIds: [], ownerStaffIds: [], defaultRole: "viewer", people: [{ staffId: A, role: "admin" }] });
	assert.equal(got, "refused");
});

test("M2: the only rank is the whitelist — demotion refused", async () => {
	const got = await setRole({ adminStaffIds: [A], ownerStaffIds: [], defaultRole: "viewer", people: [] });
	assert.equal(got, "refused");
});

test("M3: whitelist[self] + ownerStaffIds[other] — allowed, the other owner manages", async () => {
	const got = await setRole({ adminStaffIds: [A], ownerStaffIds: ["o2"], defaultRole: "viewer", people: [] });
	assert.equal(got, "allowed");
});

test("M4 (the reviewer's deadlock): only ownerStaffIds[self] — refused", async () => {
	// The demotion writes people[]{viewer,self}, which SHADOWS ownerStaffIds:
	// resolveRole returns viewer while hasAnyAdmin still counts ownerStaffIds →
	// CLAIMED but unmanaged. The guard must refuse.
	const got = await setRole({ adminStaffIds: [], ownerStaffIds: [A], defaultRole: "viewer", people: [] });
	assert.equal(got, "refused");
});

test("M5: people[]{owner,self} + ownerStaffIds[self] — refused (people[] shadows)", async () => {
	// Same shadowing via an EXISTING people entry: after the demotion the entry
	// says viewer and shadows the whitelist grant. The whitelist "fallback" is
	// an illusion; refusal is correct.
	const got = await setRole({ adminStaffIds: [], ownerStaffIds: [A], defaultRole: "viewer", people: [{ staffId: A, role: "owner" }] });
	assert.equal(got, "refused");
});

test("M6: two admins in people[] — allowed", async () => {
	const got = await setRole({ adminStaffIds: [], ownerStaffIds: [], defaultRole: "viewer", people: [{ staffId: A, role: "admin" }, { staffId: "a2", role: "admin" }] });
	assert.equal(got, "allowed");
});

await rm(dir, { recursive: true, force: true });
