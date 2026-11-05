/**
 * Work-item provenance: injected rows must not impersonate chat-dispatched ones.
 *
 * The incident this pins (2026-11-05): a reconciliation task was written straight
 * into `work_items` with the operator's identity and the note
 * "从聊天转派（Router）". Because origin was sniffed from that sentence, the row
 *   - showed up in the operator's task list as if they had asked for it,
 *   - pushed progress under the 自主任务 label,
 *   - and re-armed its own follow-up window ("下次跟进"), all without consent.
 *
 * Provenance is now structured, and operator-injected rows may not self-schedule.
 */
import assert from "node:assert/strict";
import {
	allowsSelfScheduling,
	inferOriginIsNotEvidence,
	needsApproval,
	originLabel,
	resolveOrigin,
} from "../src/scheduler/work-origin.ts";

// --- structured origin wins over the note ---------------------------------
// The exact attack: a row that claims chat dispatch in text but is actually injected.
assert.equal(
	resolveOrigin({ origin: "injected", originNote: "从聊天转派（Router）" }),
	"injected",
	"the structured column must win; a note is a claim, not evidence",
);
assert.equal(resolveOrigin({ origin: "chat", originNote: null }), "chat");

// --- legacy rows (no column) fall back to text ----------------------------
assert.equal(resolveOrigin({ origin: null, originNote: "从聊天转派（Router）" }), "chat");
assert.equal(resolveOrigin({ origin: null, originNote: "自主挖掘·提案" }), "mining");
assert.equal(resolveOrigin({ origin: null, originNote: "系统注入" }), "injected");
assert.equal(resolveOrigin({ origin: null, originNote: "something old" }), "legacy");
assert.equal(resolveOrigin({ origin: null, originNote: null }), "legacy");

// --- self-scheduling gate (the actual fix) --------------------------------
assert.equal(allowsSelfScheduling({ origin: "injected" }), false,
	"an injected row must NOT arm follow-up windows");
assert.equal(allowsSelfScheduling({ origin: "chat" }), true, "chat-dispatched tasks do follow up");
assert.equal(allowsSelfScheduling({ origin: "scheduled" }), true, "schedule owns the cadence");
assert.equal(allowsSelfScheduling({ origin: "manual" }), false, "a one-shot manual task runs once");
// Approval gates CREATION (needsApproval at propose time), not the follow-up of an
// item already on the board — a running mined task keeps its cadence either way.
assert.equal(allowsSelfScheduling({ origin: "mining", approved: true }), true,
	"a mined task follows up");
assert.equal(allowsSelfScheduling({ origin: "mining", approved: false }), true,
	"an existing mined item is not stopped by a missing approval flag");

// A legacy note that says "injected" must lose self-scheduling — this is the
// path an editing-averse writer would take, so it has to be closed too.
assert.equal(allowsSelfScheduling({ origin: null, originNote: "管理员直接注入" }), false,
	"legacy rows whose note says injected must not self-schedule");

// --- approval gate --------------------------------------------------------
assert.equal(needsApproval({ origin: "mining", approved: false }), true);
assert.equal(needsApproval({ origin: "mining", approved: true }), false);
assert.equal(needsApproval({ origin: "chat" }), false, "chat-dispatched needs no proposal approval");

// --- labels tell the truth ------------------------------------------------
// work-service.pushHeaderLabel() delegates to originLabel(resolveOrigin(...)), so
// pinning the pair here pins what every push header says. (work-service itself is
// not imported: it uses TypeScript parameter properties, which Node's strip-only
// loader rejects — its wiring is covered by test-work-service.mjs.)
const labelFor = (note, origin) => originLabel(resolveOrigin({ originNote: note, origin }));
assert.equal(labelFor("从聊天转派（Router）", "chat"), "后台任务");
assert.equal(labelFor("从聊天转派（Router）", "injected"), "系统注入任务",
	"an injected row must not push as 自主任务/后台任务 even if its note claims chat");
assert.equal(labelFor(null, "injected"), "系统注入任务");
assert.equal(labelFor(null, "mining"), "自主任务");
assert.equal(labelFor(null, "scheduled"), "定时任务");
assert.equal(labelFor(null, "manual"), "手动任务");
// Legacy rows keep the historical wording.
assert.equal(labelFor("从聊天转派（Router）", null), "后台任务");

// every origin has a label (no empty header can be produced)
for (const o of ["chat", "manual", "mining", "scheduled", "injected", "legacy"]) {
	assert.ok(originLabel(o).length > 0, `origin ${o} must have a label`);
}

// documented invariant: text is never treated as proof of provenance
assert.equal(inferOriginIsNotEvidence(), true);

console.log("test-work-origin: OK");
