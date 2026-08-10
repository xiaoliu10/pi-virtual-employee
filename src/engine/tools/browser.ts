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

export function createBrowserTools(browser: BrowserService, isVisionModel: () => boolean = () => true): AgentTool[] {
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
				const r = await browser.navigate((params as { url: string }).url);
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
				const r = await browser.getText();
				const note = r.truncated ? "\n（内容较长，已截断）" : "";
				return textResult(`页面：${r.title}（${r.url}）\n\n${r.text}${note}`, { ok: true, url: r.url, truncated: r.truncated });
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
				const url = await browser.currentUrl();
				if (!isVisionModel()) {
					// Non-vision model: an image block would make the request fail —
					// degrade to page text so the agent can still reason about the page.
					const r = await browser.getText();
					const note = r.truncated ? "\n（内容较长，已截断）" : "";
					return textResult(
						`当前模型不支持图像输入，已改为返回页面文本（${r.title} · ${url}）：\n\n${r.text}${note}`,
						{ ok: true, url, degraded: true, truncated: r.truncated },
					);
				}
				const shot = await browser.screenshot();
				return {
					content: [
						{ type: "text", text: `当前页面截图（${url}）：` },
						{ type: "image", data: shot.base64, mimeType: shot.mimeType },
					],
					details: { ok: true, url, mimeType: shot.mimeType },
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
			"点击当前页面上的元素。selector 用 CSS 选择器，如 'button.submit'、'#login'、'a:has-text(\"登录\")'。点击后页面可能跳转，可再 browser_read 确认。复杂组件示例：AntD 日期/时间选择器，先 browser_click 输入框展开面板（面板渲染在 body 下），每个日期格带 title 属性，可直接点 '.ant-picker-dropdown .ant-picker-cell[title=\"2026-07-30\"]' 选中某天；范围选择则依次点起止两天。",
		parameters: Type.Object({
			selector: Type.String({ description: "目标元素的 CSS 选择器" }),
		}),
		async execute(_id, params) {
			try {
				const r = await browser.click((params as { selector: string }).selector);
				return textResult(`已点击。当前页面：${r.url}`, { ok: r.ok, url: r.url });
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
				await browser.type(p.selector, p.text);
				return textResult(`已向 ${p.selector} 输入文本。`, { ok: true, selector: p.selector });
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
				await browser.pressKey(key);
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
				const r = await browser.evaluate((params as { script: string }).script);
				return textResult(`JS 执行结果：${r.value}`, { ok: true });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	return [navigate, read, screenshot, click, type, pressKey, evaluate];
}
