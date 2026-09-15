/**
 * Improvement proposals — the loop's output.
 *
 * A review that only prints numbers changes nothing, and one that files a fresh
 * note every week buries the reader. So a proposal here is a FILE with identity:
 * keyed by a slug derived from the problem statement, carrying status (open /
 * resolved), a detection count, and an evidence block that is assembled from the
 * real telemetry snapshot rather than from the model's prose. Re-detecting the
 * same problem appends to the existing proposal ("第 3 次检测到") instead of
 * creating a duplicate, and `resolve` closes it so the loop stops re-reporting.
 *
 * Storage is plain markdown under `<userData>/proposals/` — the operator can read,
 * diff, hand it to a developer, or delete it; nothing here publishes anything.
 * (Sharing it externally is a separate, deliberate act via save_report.)
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ProposalStatus = "open" | "resolved";

export interface ProposalInput {
	/** One-line problem statement — also the identity of the proposal. */
	problem: string;
	/** Why this matters / what it costs. */
	impact: string;
	/** What to change. */
	proposal: string;
	/** How we would know it worked (measurable where possible). */
	verification: string;
	/** Telemetry-derived evidence (clusters/trend lines), assembled by the caller. */
	evidence: string;
	/** Where the evidence came from, e.g. "my_stats focus=failures hours=168 scope=all". */
	source: string;
}

export interface ProposalRecord {
	id: string;
	problem: string;
	status: ProposalStatus;
	detections: number;
	firstSeenAt: number;
	lastSeenAt: number;
	path: string;
}

/** Stable, human-readable id from the problem statement. */
export function slugify(problem: string): string {
	const ascii = problem
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return ascii.slice(0, 48) || "proposal";
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const stamp = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

export class ProposalStore {
	constructor(private readonly dir: string) {}

	private async ensureDir(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	/** Newest first. Malformed files are skipped rather than breaking the review. */
	async list(): Promise<ProposalRecord[]> {
		await this.ensureDir();
		const names = (await readdir(this.dir)).filter((n) => n.endsWith(".md"));
		const out: ProposalRecord[] = [];
		for (const name of names) {
			const text = await readFile(join(this.dir, name), "utf8").catch(() => "");
			const meta = parseMeta(text);
			if (!meta) continue;
			out.push({ ...meta, path: join(this.dir, name) });
		}
		return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}

	async find(problem: string): Promise<ProposalRecord | undefined> {
		const id = slugify(problem);
		return (await this.list()).find((p) => p.id === id);
	}

	/**
	 * File a proposal, or append a new detection to the existing one. Returns the
	 * record plus whether this call created it (so the caller can say which).
	 */
	async file(input: ProposalInput, now = Date.now()): Promise<{ record: ProposalRecord; created: boolean }> {
		await this.ensureDir();
		const id = slugify(input.problem);
		const path = join(this.dir, `${id}.md`);
		const existingText = await readFile(path, "utf8").catch(() => "");
		const existing = existingText ? parseMeta(existingText) : undefined;

		if (existing && existing.status === "resolved") {
			// Reopening a solved problem is a signal in itself: the fix did not hold.
			throw Object.assign(new Error(`「${input.problem}」此前已标记解决，现在又出现了——请先确认修复是否失效，再决定是否重新开启`), {
				reopening: true,
				record: { ...existing, path },
			});
		}

		if (existing) {
			const detections = existing.detections + 1;
			const appended =
				`\n---\n\n### 第 ${detections} 次检测到（${stamp(now)}）\n\n` +
				`证据来源：${input.source}\n\n${input.evidence}\n\n` +
				`影响：${input.impact}\n\n拟改动：${input.proposal}\n\n验证方式：${input.verification}\n`;
			const meta = existingText.replace(/^(detections|last_seen_at|status):.*$/gm, (line) =>
				line.startsWith("detections:") ? `detections: ${detections}` : line.startsWith("last_seen_at:") ? `last_seen_at: ${now}` : line,
			);
			await writeFile(path, meta.trimEnd() + appended);
			return { record: { ...existing, detections, lastSeenAt: now, path }, created: false };
		}

		const body =
			`# 改进提案：${input.problem}\n\n` +
			`---\n` +
			`id: ${id}\n` +
			`status: open\n` +
			`detections: 1\n` +
			`first_seen_at: ${now}\n` +
			`last_seen_at: ${now}\n` +
			`source: ${input.source}\n` +
			`---\n\n` +
			`## 问题（${day(now)} 首次记录）\n\n${input.problem}\n\n` +
			`## 证据（来自运行统计，非估计）\n\n来源：${input.source}\n\n${input.evidence}\n\n` +
			`## 影响\n\n${input.impact}\n\n` +
			`## 拟改动\n\n${input.proposal}\n\n` +
			`## 如何验证有效\n\n${input.verification}\n\n` +
			`## 处置\n\n` +
			`- 采纳并改动后，用 \`propose_improvement action=resolve id=${id}\` 关闭，之后同类问题不再重复上报。\n` +
			`- 不打算处理也请 resolve（并在理由里写明），否则每周复盘都会再提一次。\n`;
		await writeFile(path, body);
		return { record: { id, problem: input.problem, status: "open", detections: 1, firstSeenAt: now, lastSeenAt: now, path }, created: true };
	}

	/** Close a proposal so the loop stops re-reporting it. */
	async resolve(idOrProblem: string, reason: string, now = Date.now()): Promise<ProposalRecord | undefined> {
		const all = await this.list();
		const target = all.find((p) => p.id === idOrProblem || p.id === slugify(idOrProblem) || p.problem === idOrProblem);
		if (!target) return undefined;
		const text = await readFile(target.path, "utf8").catch(() => "");
		const updated = text
			.replace(/^status:.*$/m, "status: resolved")
			.replace(/^last_seen_at:.*$/m, `last_seen_at: ${now}`)
			.trimEnd() + `\n\n---\n\n### 已关闭（${stamp(now)}）\n\n${reason}\n`;
		await writeFile(target.path, updated);
		return { ...target, status: "resolved", lastSeenAt: now };
	}
}

/** Parse the frontmatter-ish header block we wrote. Returns undefined if absent. */
function parseMeta(text: string): Omit<ProposalRecord, "path"> | undefined {
	const id = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim();
	const problem = /^# 改进提案：(.+)$/m.exec(text)?.[1]?.trim();
	if (!id || !problem) return undefined;
	const status = (/^status:\s*(open|resolved)$/m.exec(text)?.[1] ?? "open") as ProposalStatus;
	return {
		id,
		problem,
		status,
		detections: Number(/^detections:\s*(\d+)$/m.exec(text)?.[1] ?? 1),
		firstSeenAt: Number(/^first_seen_at:\s*(\d+)$/m.exec(text)?.[1] ?? 0),
		lastSeenAt: Number(/^last_seen_at:\s*(\d+)$/m.exec(text)?.[1] ?? 0),
	};
}
