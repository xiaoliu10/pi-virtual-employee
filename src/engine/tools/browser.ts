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
				const coordNote = `\n（截图与视口 ${shot.viewport.width}x${shot.viewport.height} 1:1 对应——Canvas/远程桌面类页面上，可用 browser_click_at 按画面中的像素坐标点击）`;
				return {
					content: [
						{ type: "text", text: `当前页面截图（${url}）：${note}${coordNote}` },
						{ type: "image", data: shot.base64, mimeType: shot.mimeType },
					],
					details: { ok: true, url, mimeType: shot.mimeType, savedPath, viewport: shot.viewport },
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
			"向当前页面发送键盘按键或组合键。用于：输入后按 Enter 提交日期/搜索框，Tab 切换到下一个输入框，Escape 关闭弹层/下拉面板，方向键翻日历；" +
			"远程桌面/终端场景还常用：PageUp/PageDown/Home/End（滚动与跳转）、Delete、F5（刷新远程画面）、ArrowUp/ArrowDown（终端历史命令）、" +
			"以及组合键——用 + 连接修饰键，如 Control+c（中断终端当前命令）、Control+v（粘贴）、Alt+Tab（切换远程窗口）、Control+Shift+Escape。" +
			"按键只送到当前焦点：先确认 browser_click_at 返回的 focus 已在远程会话内，否则组合键会打在页面本身上。",
		parameters: Type.Object({
			key: Type.String({ description: "键名或组合键，如 Enter、Tab、Escape、ArrowUp、PageDown、F5、Delete、Control+c、Alt+Tab、Control+Shift+Escape" }),
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

	const clickAt: AgentTool = {
		name: "browser_click_at",
		label: "浏览器：坐标点击",
		description:
			"按屏幕坐标点击（原始鼠标输入），用于 Canvas 画布类页面——堡垒机/H5 远程桌面把远程屏幕画在 canvas 里，Navicat 等远程程序的按钮不是 DOM 元素，browser_click 点不到。" +
			"用法：先 browser_screenshot 看清画面（截图与视口 1:1，1280x800），把目标按钮的像素坐标传进来。" +
			"返回里的 focus 告诉你键盘现在会打到谁：拿到焦点的是远程会话的隐藏 textarea/div 才算点中；是 body 说明没点中，键盘输入到不了远程，应重新截图定位再点。" +
			"tabSwitched=true 表示这次点击打开了新标签页/窗口（堡垒机常把 SSH 终端开在新窗口），已自动跟随，后续工具作用于新页。" +
			"需要双击传 double=true，右键传 button=right。普通网页仍优先用 browser_click（按元素点更稳）。",
		parameters: Type.Object({
			x: Type.Number({ description: "像素 X 坐标（以 browser_screenshot 画面为准）" }),
			y: Type.Number({ description: "像素 Y 坐标" }),
			double: Type.Optional(Type.Boolean({ description: "true=双击" })),
			button: Type.Optional(Type.String({ description: "left（默认）| right" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { x: number; y: number; double?: boolean; button?: string };
				const r = await browser.mouseClick(resolveOwnerId(), p.x, p.y, {
					double: p.double,
					button: p.button === "right" ? "right" : "left",
				});
				const focus = r.focus ? `${r.focus.tag}${r.focus.id ? `#${r.focus.id}` : ""}${r.focus.cls ? `.${r.focus.cls.split(/\s+/)[0]}` : ""}` : "未知";
				const hint = !r.focus || r.focus.tag === "body"
					? "焦点仍在 body：键盘输入到不了远程会话，请重新截图确认坐标是否落在远程画面内。"
					: "焦点已进入目标，可用 browser_type_text（英文/短文本）或 browser_paste_text（中文/长文本）输入，再 browser_press_key 提交。";
				return textResult(
					`已在坐标 (${r.x}, ${r.y}) 点击。当前焦点：${focus}。${r.tabSwitched ? "（本次点击打开了新标签页，已自动跟随到新页）" : ""}${hint}`,
					{ x: r.x, y: r.y, double: !!p.double, button: p.button === "right" ? "right" : "left", tabSwitched: r.tabSwitched, url: r.url, focus: r.focus },
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const scroll: AgentTool = {
		name: "browser_scroll",
		label: "浏览器：滚动",
		description:
			"在画布/页面上滚动（原始滚轮输入）。Canvas 远程会话里滚动条属于远程程序（如 Navicat 的结果网格、SSH 终端回滚缓冲），DOM 滚动无效，必须发真实滚轮事件。" +
			"deltaY 正数向下、负数向上；deltaX 处理横向滚动。默认在视口中心滚动，可用 x/y 指定在某个区域滚（如把指针放到结果网格内再滚）。" +
			"远程客户端灵敏度不一，一次不够就把 times 调大（最多 20）。滚动后建议再 screenshot 确认到达位置。",
		parameters: Type.Object({
			deltaY: Type.Optional(Type.Number({ description: "垂直滚动量，正数向下、负数向上（如 300 / -300）" })),
			deltaX: Type.Optional(Type.Number({ description: "水平滚动量，正数向右、负数向左" })),
			x: Type.Optional(Type.Number({ description: "可选：滚轮所在像素 X（默认视口中心）" })),
			y: Type.Optional(Type.Number({ description: "可选：滚轮所在像素 Y（默认视口中心）" })),
			times: Type.Optional(Type.Number({ description: "重复次数，默认 1，最多 20（远程客户端灵敏度低时用）" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { deltaY?: number; deltaX?: number; x?: number; y?: number; times?: number };
				const r = await browser.mouseWheel(resolveOwnerId(), p);
				return textResult(`已在 (${r.x}, ${r.y}) 滚动 deltaX=${r.deltaX} deltaY=${r.deltaY} ×${r.times}。建议 screenshot 确认位置。`, { ...r });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const drag: AgentTool = {
		name: "browser_drag",
		label: "浏览器：拖拽",
		description:
			"按住鼠标从一点拖到另一点（原始鼠标输入），用于 Canvas 远程会话：拖动滚动条、移动/缩放远程窗口、拖动表格列宽、在远程程序里框选文本——这些都不是 DOM 元素，没有选择器可用。" +
			"坐标以 browser_screenshot 画面为准（1:1）。拖拽前不要先 browser_click_at（那会先松一次鼠标）；本工具自己完成按下-移动-抬起。",
		parameters: Type.Object({
			fromX: Type.Number({ description: "起点像素 X" }),
			fromY: Type.Number({ description: "起点像素 Y" }),
			toX: Type.Number({ description: "终点像素 X" }),
			toY: Type.Number({ description: "终点像素 Y" }),
			button: Type.Optional(Type.String({ description: "left（默认）| right" })),
			steps: Type.Optional(Type.Number({ description: "移动步数，默认 12，范围 2-40（远程客户端需要足够中间事件才认拖拽时调大）" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { fromX: number; fromY: number; toX: number; toY: number; button?: string; steps?: number };
				const r = await browser.mouseDrag(
					resolveOwnerId(),
					{ x: p.fromX, y: p.fromY },
					{ x: p.toX, y: p.toY },
					{ button: p.button === "right" ? "right" : "left", steps: p.steps },
				);
				return textResult(`已从 (${r.from.x}, ${r.from.y}) 拖到 (${r.to.x}, ${r.to.y})。建议 screenshot 确认结果。`, { ...r });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const pasteText: AgentTool = {
		name: "browser_paste_text",
		label: "浏览器：剪贴板粘贴",
		description:
			"把文本写入剪贴板再按 Ctrl+V 粘贴（Windows/Linux 为 Ctrl+V，macOS 为 Cmd+V）——远程桌面/终端输入中文的唯一可靠通路：" +
			"RDP/SSH 客户端把按键翻译成远程扫描码，中文没有对应扫描码，用 browser_type_text 逐键输入会丢字；粘贴走客户端自己的剪贴板通道，中文和长文本都能完整送进去。" +
			"用法：先 browser_click_at 点中远程会话里的输入位置（focus 不在远程会话时粘贴同样到不了），再调用本工具，最后 browser_press_key 提交。" +
			"英文短文本仍可直接用 browser_type_text；中文、长 SQL、含特殊符号的字符串一律走本工具。",
		parameters: Type.Object({
			text: Type.String({ description: "要粘贴的文本（中文/长文本均可，先写入剪贴板再发送粘贴键）" }),
		}),
		async execute(_id, params) {
			try {
				const r = await browser.pasteText(resolveOwnerId(), (params as { text: string }).text);
				const focus = r.focus ? `${r.focus.tag}${r.focus.id ? `#${r.focus.id}` : ""}` : "未知";
				return textResult(
					`已通过 ${r.chord} 粘贴 ${r.length} 个字符（剪贴板来源：${r.clipboard === "both" ? "系统+页面" : r.clipboard === "os" ? "系统" : "页面"}）。当前焦点：${focus}。` +
						"若远处没有任何字符出现，说明焦点不在远程会话内——重新 browser_screenshot 定位输入位置后再点一次。",
					{ ok: true, length: r.length, chord: r.chord, clipboard: r.clipboard, focus: r.focus },
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	const typeText: AgentTool = {
		name: "browser_type_text",
		label: "浏览器：逐键输入文本",
		description:
			"把文本逐键敲进当前焦点（原始键盘输入）。主要用于 Canvas/远程桌面场景：先用 browser_click_at 点中远程会话里的输入框，再用本工具输入文本——远程程序不是 DOM，browser_type 填不进去。" +
			"适合英文、数字、短命令；中文或长文本请改用 browser_paste_text（逐键发送没有中文扫描码，会丢字）。" +
			"可直接传 x/y：本工具会先在该坐标点一下再输入，省去「焦点没落在输入位置」的来回。" +
			"普通网页输入框仍优先 browser_type（有回读校验）。输入后通常接 browser_press_key Enter 提交。",
		parameters: Type.Object({
			text: Type.String({ description: "要键入的文本（逐键发送，约每键 30ms）" }),
			x: Type.Optional(Type.Number({ description: "可选：先在该像素 X 点一下再输入（截图为 1:1 视口）" })),
			y: Type.Optional(Type.Number({ description: "可选：先在该像素 Y 点一下再输入" })),
		}),
		async execute(_id, params) {
			try {
				const p = params as { text: string; x?: number; y?: number };
				const r = await browser.keyboardType(resolveOwnerId(), p.text, { x: p.x, y: p.y });
				const focus = r.focus ? `${r.focus.tag}${r.focus.id ? `#${r.focus.id}` : ""}` : "未知";
				const warn = !r.focus || r.focus.tag === "body"
					? "注意：当前焦点是 body，字符不会进入远程会话——请先 browser_screenshot 定位输入位置并用 browser_click_at 点中。"
					: "";
				return textResult(`已逐键输入 ${r.length} 个字符。当前焦点：${focus}。${warn}`, { ok: true, length: r.length, focus: r.focus });
			} catch (err) {
				return errorResult(err);
			}
		},
	};

	return [navigate, read, screenshot, click, clickAt, scroll, drag, type, typeText, pasteText, pressKey, evaluate, tabs];
}
