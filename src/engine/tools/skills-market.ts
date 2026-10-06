import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ConfigStore } from "../../db/config-store.js";
import { parseSkillFile } from "../skills/skill-parser.js";
import type { SkillWriter } from "../skills/skill-writer.js";
import { requireConfirmedAdmin, type AdminToolDeps } from "./admin.js";

/** Default market index: the project's own curated list (editable in-repo). */
export const DEFAULT_MARKET_URL =
	"https://gitee.com/xiaoliu10/pi-virtual-employee/raw/main/skills-market/index.json";

export interface SkillsMarketDeps extends AdminToolDeps {
	skillWriter: SkillWriter;
	userSkillsDir: string;
	listSkills: () => Promise<{ skills: { name: string }[]; info: { name: string; enabled: boolean }[] }>;
	onSkillsChanged: () => Promise<void>;
}

interface MarketEntry {
	name: string;
	description?: string;
	url?: string;
}

const FETCH_LIMIT = 512 * 1024;
/** Same shape as the loader/writer name rule: no separators, no traversal. */
const SKILL_NAME = /^[\p{Script=Han}a-z0-9]+(-[\p{Script=Han}a-z0-9]+)*$/u;

const MAX_REDIRECTS = 3;

function isPrivateHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
	// Hostname form of an IPv4/IPv6 literal: reject loopback/private/link-local.
	if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
	const m = host.match(/^172\.(\d+)\./);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	if (host === "::1" || host === "[::1]" || host.startsWith("fd") || host.startsWith("fe80")) return true;
	return false;
}

/**
 * Fetch with hard transport guarantees: every hop must be https, no redirects
 * into private/loopback hosts (SSRF), no silent https→http downgrade, and the
 * body is streamed with a hard byte cap (a hostile server must not be able to
 * buffer unbounded memory into the employee process).
 */
async function fetchText(url: string): Promise<string> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!/^https:\/\//.test(current)) throw new Error("仅允许 https 来源（检测到降级或非 https 跳转）");
		const host = new URL(current).hostname;
		if (isPrivateHost(host)) throw new Error(`拒绝访问内网地址（${host}）`);
		const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
			current = new URL(location, current).toString();
			continue;
		}
		if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
		if (res.body) {
			const declared = Number(res.headers.get("content-length") ?? "");
			if (Number.isFinite(declared) && declared > FETCH_LIMIT) {
				throw new Error(`内容超过 ${FETCH_LIMIT / 1024}KB 上限，拒绝安装`);
			}
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let received = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > FETCH_LIMIT) {
					await reader.cancel().catch(() => {});
					throw new Error(`内容超过 ${FETCH_LIMIT / 1024}KB 上限，拒绝安装`);
				}
				chunks.push(value);
			}
			const merged = new Uint8Array(received);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder().decode(merged);
		}
		return res.text();
	}
	throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳，拒绝安装`);
}

function marketIndexUrl(config: ConfigStore): string {
	return config.all().skills.marketUrl?.trim() || DEFAULT_MARKET_URL;
}

async function fetchIndex(config: ConfigStore): Promise<MarketEntry[]> {
	const raw = await fetchText(marketIndexUrl(config));
	const parsed = JSON.parse(raw) as { skills?: unknown };
	if (!Array.isArray(parsed.skills)) throw new Error("市场索引格式非法（缺少 skills 数组）");
	return parsed.skills.filter(
		(e): e is MarketEntry =>
			!!e && typeof e === "object" && typeof (e as MarketEntry).name === "string" && typeof (e as MarketEntry).url === "string",
	);
}

/** Refuse anything that escapes the user skills dir (defense in depth under the name regex). */
function assertInsideUserDir(filePath: string, userSkillsDir: string): boolean {
	const resolved = resolve(filePath);
	return resolved.startsWith(resolve(userSkillsDir) + sep);
}

/**
 * All user-side skill files whose PARSED name matches, mirroring the loader's
 * acceptance (dir/SKILL.md plus top-level *.md in any case). The builtin dir is
 * never scanned — builtins are not removable.
 */
async function findUserSkillPathsByName(userSkillsDir: string, wanted: string): Promise<string[]> {
	const out: string[] = [];
	let entries;
	try {
		entries = await readdir(userSkillsDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const candidates: string[] = [];
		if (entry.isDirectory()) candidates.push(join(userSkillsDir, entry.name, "SKILL.md"));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) candidates.push(join(userSkillsDir, entry.name));
		for (const candidate of candidates) {
			try {
				const raw = await readFile(candidate, "utf8");
				const { skill } = parseSkillFile(candidate, raw);
				if (skill?.name === wanted) out.push(candidate);
			} catch {
				/* unreadable/foreign file — the loader skips it too */
			}
		}
	}
	return out;
}

/**
 * Build the manage_skills tool: an admin-gated bridge to the skill market.
 *
 * install/remove run through requireConfirmedAdmin, so the「确认」demand is
 * waived under security.adminFullAccess — same mirror as every other admin
 * gate. Installing third-party prompt content is a supply-chain action: the
 * description tells the model to surface source trust, and the writer enforces
 * built-in protection + path containment + round-trip validation.
 */
export function createManageSkillsTool(deps: SkillsMarketDeps): AgentTool {
	const fullAccess = () => deps.config.all().security.adminFullAccess === true;
	return {
		name: "manage_skills",
		label: "技能市场",
		description:
			"从技能市场发现、安装、移除员工技能（仅管理员）。action=market 列出市场上可安装的技能；" +
			"action=install 按 name（从市场）或 url（任意 SKILL.md 的 https 直链）安装，安装后自动重新加载立即生效；" +
			"action=remove 按名字移除一个本机技能（内置技能不可移除）；action=list 查看当前已加载技能。" +
			"安装的是外部内容，应在安装前向对方说明来源；覆盖已有技能需对方明确同意后传 overwrite=true。" +
			"市场索引可用 manage_settings 设置 skills.marketUrl 换源。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("market"), Type.Literal("install"), Type.Literal("remove"), Type.Literal("list")], {
				description: "market=看市场上有什么；install=安装；remove=移除；list=看本机已加载",
			}),
			name: Type.Optional(Type.String({ description: "install（从市场）/remove 必填：技能名" })),
			url: Type.Optional(Type.String({ description: "install 可选：SKILL.md 的 https 直链（优先于 name）" })),
			overwrite: Type.Optional(
				Type.Boolean({ description: "install 可选：目标同名技能已存在时，对方明确同意覆盖后传 true 再次安装" }),
			),
		}),
		async execute(_toolCallId, params) {
			const { action, name, url, overwrite } = params as {
				action: string;
				name?: string;
				url?: string;
				overwrite?: boolean;
			};

			if (action === "list") {
				const { info } = await deps.listSkills();
				return {
					content: [{
						type: "text",
						text: info.length === 0
							? "当前没有已加载的技能。可用 action=market 看看市场上有什么。"
							: `当前已加载 ${info.length} 个技能：${info.map((i) => `${i.name}${i.enabled ? "" : "（已禁用）"}`).join("、")}。`,
					}],
					details: { action, count: info.length },
				};
			}

			if (action === "market") {
				const gate = requireConfirmedAdmin(deps, { needConfirmation: false, groupHint: "技能市场查询仅限管理员单聊。" });
				if ("content" in gate) return gate;
				try {
					const entries = await fetchIndex(deps.config);
					if (entries.length === 0) {
						return { content: [{ type: "text", text: "技能市场当前为空。也可以用 action=install 传 url 直接安装任意 SKILL.md 直链。" }], details: { action, count: 0 } };
					}
					const lines = entries.map((e) => `- ${e.name}${e.description ? `：${e.description}` : ""}\n  来源：${e.url}`);
					return { content: [{ type: "text", text: `技能市场共 ${entries.length} 个技能：\n${lines.join("\n")}\n安装前请核对来源可信；用 action=install 安装。` }], details: { action, count: entries.length } };
				} catch (err) {
					return { content: [{ type: "text", text: `技能市场暂不可用：${err instanceof Error ? err.message : String(err)}` }], details: { action, failed: true } };
				}
			}

			// install / remove: confirmed admin (confirmation waived under full access)
			const gate = requireConfirmedAdmin(deps, {
				needConfirmation: true,
				confirmationHint: "安装/移除技能会改变员工的行为规则，请在当前消息中包含「确认」。",
			});
			if ("content" in gate) return gate;

			if (action === "install") {
				let sourceUrl = (url ?? "").trim();
				let label = sourceUrl;
				if (!sourceUrl) {
					const wanted = (name ?? "").trim();
					if (!wanted) return { content: [{ type: "text", text: "install 需要提供 name（从市场安装）或 url（SKILL.md 直链）。" }], details: { action } };
					try {
						const entries = await fetchIndex(deps.config);
						const hit = entries.find((e) => e.name === wanted);
						if (!hit?.url) {
							return { content: [{ type: "text", text: `市场里没有叫「${wanted}」的技能。可用 action=market 查看现有列表，或直接传 url 安装。` }], details: { action, name: wanted } };
						}
						sourceUrl = hit.url;
						label = wanted;
					} catch (err) {
						return { content: [{ type: "text", text: `技能市场暂不可用（${err instanceof Error ? err.message : String(err)}）；也可以直接传 url 安装 SKILL.md 直链。` }], details: { action, failed: true } };
					}
				}
				if (!/^https:\/\//.test(sourceUrl)) {
					return { content: [{ type: "text", text: "仅支持 https 直链（防降级与内网地址伪造）。" }], details: { action } };
				}
				try {
					const raw = await fetchText(sourceUrl);
					const { skill, warning } = parseSkillFile(`market/${label || "unnamed"}/SKILL.md`, raw);
					if (!skill) {
						return { content: [{ type: "text", text: `安装失败：该文件不是有效的技能（${warning ?? "解析失败"}）。技能需含 YAML frontmatter（name/description）与正文步骤。` }], details: { action, failed: true } };
					}
					const result = await deps.skillWriter.upsert({
						name: skill.name,
						description: skill.description,
						content: skill.content,
						mode: overwrite ? "replace" : "create",
					});
					if (result.outcome === "needs-confirm") {
						const overwriteHint = fullAccess()
							? `若对方明确同意覆盖，携带 overwrite=true 重新安装即可。`
							: `若对方明确同意覆盖，请回复「确认覆盖」后携带 overwrite=true 重新安装。`;
						return {
							content: [{ type: "text", text: `技能「${skill.name}」已存在（来源：${sourceUrl}）。${overwriteHint}` }],
							details: { action, needsConfirm: true },
						};
					}
					if (result.outcome === "rejected") {
						return { content: [{ type: "text", text: `安装失败：${result.message}` }], details: { action, failed: true } };
					}
					await deps.onSkillsChanged();
					return {
						content: [{ type: "text", text: `✅ 技能「${skill.name}」已${result.outcome === "updated" ? "更新" : "安装"}（来源：${sourceUrl}）并重新加载，从下一条消息起生效。${skill.description}` }],
						details: { action, name: skill.name, outcome: result.outcome, sourceUrl },
					};
				} catch (err) {
					return { content: [{ type: "text", text: `安装失败：${err instanceof Error ? err.message : String(err)}` }], details: { action, failed: true } };
				}
			}

			if (action === "remove") {
				const wanted = (name ?? "").trim();
				if (!wanted || !SKILL_NAME.test(wanted)) {
					return { content: [{ type: "text", text: "remove 需要提供合法的技能名（中文/小写字母/数字/连字符）。" }], details: { action } };
				}
				// Locate by PARSED FRONTMATTER NAME (the loader's semantics), not by
				// file name: `Foo.MD` with frontmatter name excel-pivot loads as
				// excel-pivot, so a filename probe would miss it.
				const targets = await findUserSkillPathsByName(deps.userSkillsDir, wanted);
				if (targets.length === 0) {
					return { content: [{ type: "text", text: `本机没有名为「${wanted}」的用户技能。内置技能不可移除；用 action=list 查看已加载列表。` }], details: { action, name: wanted } };
				}
				if (targets.some((t) => !assertInsideUserDir(t, deps.userSkillsDir))) {
					return { content: [{ type: "text", text: "目标路径越界，移除被拒绝。" }], details: { action } };
				}
				try {
					for (const target of targets) {
						await rm(target);
						// Only directory-form skills have a removable parent — never
						// touch the user dir itself for top-level <file>.md skills.
						if (target.endsWith(sep + "SKILL.md") && dirname(target) !== resolve(deps.userSkillsDir)) {
							await rm(dirname(target), { recursive: true, force: true }).catch(() => {});
						}
					}
					await deps.onSkillsChanged();
					return {
						content: [{ type: "text", text: `✅ 技能「${wanted}」已移除并重新加载。` }],
						details: { action, name: wanted },
					};
				} catch (err) {
					return { content: [{ type: "text", text: `移除失败：${err instanceof Error ? err.message : String(err)}` }], details: { action, failed: true } };
				}
			}

			return { content: [{ type: "text", text: "action 必须是 market/install/remove/list。" }], details: { action } };
		},
	};
}

/** Exposed for tests: the effective market index URL for a config. */
export function effectiveMarketUrl(config: ConfigStore): string {
	return marketIndexUrl(config);
}
