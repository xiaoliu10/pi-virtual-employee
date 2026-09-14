/**
 * Browser (computer-use) tools. Registered only when browser.enabled is on.
 *
 * A small, composable set the employee uses to drive a real browser:
 * navigate → read/screenshot → click/type → read again. `browser_screenshot`
 * returns an image so a vision-capable model can see the page; `browser_read`
 * returns the text for non-vision models or quick reasoning.
 *
 * All tools funnel errors into a text result so the agent can recover (retry a
 * selector, report the failure) instead of the run aborting.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserService } from "../../browser/browser-service.js";

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(err: unknown): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: `浏览器操作失败：${(err as Error).message}` }],
		details: { ok: false, error: (err as Error).message },
	};
}

export function createBrowserTools(
	browser: BrowserService,
	isVisionModel: () => boolean = () => true,
	/** Optional resolver for a managed dir where screenshots are also saved to disk,
	 *  so the employee can later send_image them. Absent → screenshots stay in-context only. */
	screenshotDir?: () => Promise<string | undefined>,
	/** 当前会话归属（ownerId，通常即 conversationId）。每个 owner 独享一个浏览器 Page，
	 * 不同会话（IM/定时任务/控制台）互不覆盖表单与 URL。 */
	resolveOwnerId: () => string = () => "default",
): AgentTool[] {
	const navigate: AgentTool = {
		name: "browser_navigate",
		label: "浏览器：打开网页",
		description:
			"用内置浏览器打开一个网址（受允许域名限制）。返回最终 URL 与页面标题。这是浏览器自动化的第一步。",
		parameters: Type.Object({
			url: Type.String({ description: "完整 URL，例如 https://example.com/order" }),
		}),
		async execute(_id, params) {
			try {
				const r = await browser.navigate(resolveOwnerId(), (params as { url: string }).url);
				return textResult(`已打开「${r.title || r.url}」（${r.url}）。可用 browser_read 读取内容或 browser_screenshot 截图查看。`, { ok: true, ...r });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const read: AgentTool = {
		name: "browser_read",
		label: "浏览器：读取页面文本",
		description: "读取当前页面的可见文本（截断到若干千字），用于理解页面内容、提取信息或决定下一步操作。",
		parameters: Type.Object({}),
		async execute() {
			try {
				const ownerId = resolveOwnerId();
				const r = await browser.getText(ownerId);
				const note = r.truncated ? "\n（内容较长，已截断）" : "";
				// 附带主要输入框简要状态（name/placeholder/是否非空/长度，不含明文），
				// 帮助模型判断是否在登录页、账号密码是否已填。
				const inputs = await browser.readInputs(ownerId).catch(() => []);
				const inputNote =
					inputs.length > 0
						? "\n\n输入框状态（不含明文）：" +
							inputs.map((f) => `${f.tag}[${f.type}]${f.name ? ` name=${f.name}` : ""}${f.placeholder ? ` placeholder="${f.placeholder}"` : ""} ${f.filled ? `已填(${f.valueLength}字)` : "空"}`).join("；")
						: "";
				return textResult(`页面：${r.title}（${r.url}）\n\n${r.text}${note}${inputNote}`, {
					ok: true,
					url: r.url,
					truncated: r.truncated,
					inputs,
				});
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const screenshot: AgentTool = {
		name: "browser_screenshot",
		label: "浏览器：截图",
		description: "对当前页面截图并以图片返回，便于直接“看到”页面布局与内容。若当前模型不支持图像输入，会自动降级为返回页面文本，不会报错。",
		parameters: Type.Object({}),
		async execute() {
			try {
				const ownerId = resolveOwnerId();
				const url = await browser.currentUrl(ownerId);
				if (!isVisionModel()) {
					// Non-vision model: an image block would make the request fail —
					// degrade to page text so the agent can still reason about the page.
					const r = await browser.getText(ownerId);
					const note = r.truncated ? "\n（内容较长，已截断）" : "";
					return textResult(
						`当前模型不支持图像输入，已改为返回页面文本（${r.title} · ${url}）：\n\n${r.text}${note}`,
						{ ok: true, url, degraded: true, truncated: r.truncated },
					);
				}
				const shot = await browser.screenshot(ownerId);
				// Best-effort: also save the JPEG to a managed dir so the employee can
				// hand the file to send_image later. Failure never breaks the screenshot.
				let savedPath: string | undefined;
				try {
					const dir = await screenshotDir?.();
					if (dir) {
						await mkdir(dir, { recursive: true });
						savedPath = join(dir, `screenshot-${Date.now()}.jpg`);
						await writeFile(savedPath, Buffer.from(shot.base64, "base64"));
					}
				} catch {
					savedPath = undefined;
				}
				const note = savedPath ? `\n（已保存到 ${savedPath}，可用 send_image 发给对方）` : "";
				return {
					content: [
						{ type: "text", text: `当前页面截图（${url}）：${note}` },
						{ type: "image", data: shot.base64, mimeType: shot.mimeType },
					],
					details: { ok: true, url, mimeType: shot.mimeType, savedPath },
				};
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const click: AgentTool = {
		name: "browser_click",
		label: "浏览器：点击",
		description:
			"点击当前页面上的元素。selector 用 CSS 选择器，如 'button.submit'、'#login'、'a:has-text(\"登录\")'。点击后页面可能跳转，可再 browser_read 确认。若结果 tabSwitched=true（如 target=_blank、堡垒机在新标签页打开终端），已自动跟随到新标签页，后续工具直接作用于新页；需要回旧页用 browser_tabs action=switch。复杂组件示例：AntD 日期/时间选择器，先 browser_click 输入框展开面板（面板渲染在 body 下），每个日期格带 title 属性，可直接点 '.ant-picker-dropdown .ant-picker-cell[title=\"2026-07-30\"]' 选中某天；范围选择则依次点起止两天。",
		parameters: Type.Object({
			selector: Type.String({ description: "目标元素的 CSS 选择器" }),
		}),
		async execute(_id, params) {
			try {
				const r = await browser.click(resolveOwnerId(), (params as { selector: string }).selector);
				const changeNote = r.tabSwitched
					? "点击打开了新标签页，已自动切换过去。"
					: r.urlChanged
						? "页面已变化。"
						: "页面 URL 未变化（可能是弹层/原地刷新，可再 browser_read 确认）。";
				return textResult(`已点击。${changeNote}当前页面：${r.url}`, {
					ok: r.ok,
					url: r.url,
					beforeUrl: r.beforeUrl,
					urlChanged: r.urlChanged,
					tabSwitched: r.tabSwitched,
				});
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const tabs: AgentTool = {
		name: "browser_tabs",
		label: "浏览器：管理标签页",
		description:
			"列出/切换/关闭浏览器的标签页。action=list 查看所有标签页（含序号、URL、标题、哪个是当前页）；" +
			"action=switch + index 切换当前页到指定序号（如从新标签页切回堡垒机主页）；action=close + index 关闭某个标签页。" +
			"点击打开的新标签页会自动跟随，一般无需手动切换。",
		parameters: Type.Object({
			action: Type.String({ description: "list | switch | close" }),
			index: Type.Optional(Type.Number({ description: "标签页序号（switch/close 时必填，来自 list）" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { action: string; index?: number };
				const ownerId = resolveOwnerId();
				if (p.action === "list") {
					const tabs2 = await browser.listPages(ownerId);
					if (tabs2.length === 0) return textResult("当前没有打开的标签页。", { ok: true, tabs: [] });
					const lines = tabs2.map(
						(t) => `${t.index}${t.current ? " ◀ 当前" : ""}. ${t.title || "(无标题)"} — ${t.url}`,
					);
					return textResult(`共 ${tabs2.length} 个标签页：\n${lines.join("\n")}`, { ok: true, tabs: tabs2 });
				}
				if (p.action === "switch") {
					if (p.index === undefined) return textResult("switch 需要提供 index（先用 action=list 查看）。", { ok: false });
					const r = await browser.switchPage(ownerId, p.index);
					return textResult(`已切换到标签页 ${p.index}：「${r.title || r.url}」（${r.url}）。可用 browser_read 确认内容。`, { ok: true, ...r });
				}
				if (p.action === "close") {
					if (p.index === undefined) return textResult("close 需要提供 index（先用 action=list 查看）。", { ok: false });
					await browser.closePage(ownerId, p.index);
					return textResult(`已关闭标签页 ${p.index}。`, { ok: true });
				}
				return textResult(`未知 action：${p.action}（可用 list / switch / close）。`, { ok: false });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const type: AgentTool = {
		name: "browser_type",
		label: "浏览器：输入",
		description:
			"向当前页面的输入框填入文本（会先清空该框）。selector 用 CSS 选择器，如 'input[name=\"q\"]'、'#search'。对日期/下拉等复杂组件，优先用 browser_click 点选面板里的选项；若用本工具输入，之后通常要 browser_press_key Enter 提交。",
		parameters: Type.Object({
			selector: Type.String({ description: "输入框的 CSS 选择器" }),
			text: Type.String({ description: "要输入的文本" }),
		}),
		async execute(_id, params) {
			try {
				const p = params as { selector: string; text: string };
				const r = await browser.type(resolveOwnerId(), p.selector, p.text);
				// 只回读长度不回传明文：密码等敏感字段不进上下文，同时能发现“没填进去”。
				return textResult(`已向 ${p.selector} 输入文本（已确认填入 ${r.valueLength} 个字符）。`, {
					ok: r.ok,
					selector: p.selector,
					valueLength: r.valueLength,
				});
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const pressKey: AgentTool = {
		name: "browser_press_key",
		label: "浏览器：按键",
		description:
			"向当前页面发送一个键盘按键。用于：输入后按 Enter 提交日期/搜索框，Tab 切换到下一个输入框，Escape 关闭弹层/下拉面板，方向键翻日历。key 用标准键名，如 Enter、Tab、Escape、ArrowLeft、ArrowRight、Backspace。",
		parameters: Type.Object({
			key: Type.String({ description: "键名，如 Enter、Tab、Escape、ArrowLeft、ArrowRight、Backspace" }),
		}),
		async execute(_id, params) {
			try {
				const key = (params as { key: string }).key;
				await browser.pressKey(resolveOwnerId(), key);
				return textResult(`已按下 ${key}。`, { ok: true, key });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const evaluate: AgentTool = {
		name: "browser_evaluate",
		label: "浏览器：执行 JS",
		description:
			"在当前页面执行一段 JavaScript 并返回结果（结果需为可序列化值：字符串/数字/布尔/普通对象）。script 是一个 JS 表达式，多条语句请用立即执行函数包起来，如 (() => { …; return 结果; })()。作为复杂组件的兜底手段：例如 React/Vue 受控输入框无法用 browser_type 填入时，可用原生 setter 赋值再 dispatch input/change 事件。仅在 browser_click / browser_type / browser_press_key 都无效时使用；只在已放行域名内执行。",
		parameters: Type.Object({
			script: Type.String({
				description:
					"要执行的 JS 表达式，例如 (() => { const el = document.querySelector('input.date'); if (!el) return '未找到'; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, '2026-07-30'); el.dispatchEvent(new Event('input', { bubbles: true })); return '已填入'; })()",
			}),
		}),
		async execute(_id, params) {
			try {
				const r = await browser.evaluate(resolveOwnerId(), (params as { script: string }).script);
				return textResult(`JS 执行结果：${r.value}`, { ok: true });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	return [navigate, read, screenshot, click, type, pressKey, evaluate, tabs];
}
