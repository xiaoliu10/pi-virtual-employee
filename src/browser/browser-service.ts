/**
 * BrowserService — computer-use capability for the employee, built on Playwright.
 *
 * Runs a single Chromium instance (lazily launched on first use) that the
 * employee drives through structured tools: navigate / click / type / read /
 * screenshot. Screenshots come back as compressed base64 JPEG so a vision-capable
 * model can reason about the page without overflowing the context window.
 *
 * Safety: every navigation is checked against `browser.allowedDomains` (empty
 * list = unrestricted). The browser is headless by default and lives in the main
 * process; call `close()` on app quit.
 */
import { chromium, type BrowserContext, type Download, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigStore } from "../db/config-store.js";

const NAV_TIMEOUT = 30_000;
const DOWNLOAD_WAIT_TIMEOUT = 60_000;
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Hook the main process injects so each download is funneled into a managed
 * workspace (DownloadService). BrowserService itself stays free of any
 * filesystem coupling — it only forwards the Playwright `Download` + the page
 * it originated from.
 */
export type DownloadHandler = (download: Download, page: Page) => void | Promise<void>;

/** Minimal metadata returned after a click-triggered download resolves. */
export interface DownloadMeta {
	url: string;
	suggestedFilename: string;
}
/** Cap how much page text we hand the model, to keep context bounded. */
const TEXT_LIMIT = 6000;

/** 页面主要输入框的简要状态（不含明文），用于登录态/表单填写判断。 */
export interface InputFieldSummary {
	tag: string;
	type: string;
	name: string;
	placeholder: string;
	filled: boolean;
	valueLength: number;
}
/**
 * Screenshots go into the LLM context as base64. A full-viewport PNG is often
 * 1–2 MB (hundreds of thousands of tokens), and a long browser task takes many
 * screenshots — that overflows the context window and the model returns an empty
 * completion. JPEG at this quality keeps pages legible while staying ~10× smaller.
 */
const SCREENSHOT_QUALITY = 70;

export interface BrowserScreenshot {
	base64: string;
	mimeType: "image/jpeg";
	/** Viewport size — screenshot pixels map 1:1 to coordinate tools (mouseClick). */
	viewport: { width: number; height: number };
}

export class BrowserService {
	private context: BrowserContext | null = null;
	/** One page per owner (IM 会话 / 定时任务会话 / 控制台会话)，共享同一个 context，
	 * 互不覆盖表单与 URL；cookie/localStorage/登录态在 context 层共享。 */
	private readonly pages = new Map<string, Page>();
	/** 共享的 context 启动 promise：并发首次访问时只 launch 一次。 */
	private launching: Promise<void> | null = null;
	private downloadHandler: DownloadHandler | null = null;
	/**
	 * One in-flight handling promise per `Download` object, so a download that is
	 * both captured by a passive `page.on("download")` listener AND awaited via
	 * `clickAndDownload` is saved + recorded exactly once. Both paths share the
	 * same promise; `clickAndDownload` awaits it so the file is on disk before it
	 * returns. Entries are cleared on completion (no unbounded growth).
	 */
	private readonly inflightDownloads = new Map<Download, Promise<void>>();

	constructor(
		private readonly config: ConfigStore,
		/** Persistent store root for this profile (the app's userData). The browser
		 * profile lives under <profileDir>/browser-profile. Required for login persistence. */
		private readonly profileDir: string,
	) {}

	/** Inject the download funnel (DownloadService.handleDownload). */
	setDownloadHandler(handler: DownloadHandler): void {
		this.downloadHandler = handler;
	}

	/**
	 * Lazily launch the persistent Chromium context（只建 context，不预建页面）。
	 * 并发首次访问共享同一个 promise，避免重复 launch。
	 */
	private ensureContext(): Promise<void> {
		if (this.context) return Promise.resolve();
		if (this.launching) return this.launching;
		this.launching = this.launch().finally(() => {
			this.launching = null;
		});
		return this.launching;
	}

	/**
	 * 获取 owner 专属 Page：存在且未关闭则复用；否则在共享 context 上 newPage。
	 * 首次调用会先确保 context 已启动。新页挂导航超时；下载监听由 context 层
	 * 的 page 事件统一挂载（launch 内），无需重复。页面触发的弹窗（target=_blank、
	 * window.open，如堡垒机/后台系统在新标签页打开终端或详情）会自动接管为该
	 * owner 的当前页——后续工具直接作用在新标签页上。
	 */
	async getPage(ownerId: string): Promise<Page> {
		await this.ensureContext();
		const cached = this.pages.get(ownerId);
		if (cached && !cached.isClosed()) return cached;
		if (!this.context) throw new Error("浏览器上下文不可用");
		const page = await this.context.newPage();
		page.setDefaultNavigationTimeout(NAV_TIMEOUT);
		page.on("popup", (popup) => this.adoptPopup(ownerId, popup));
		this.pages.set(ownerId, page);
		return page;
	}

	/** 把弹窗接管为 owner 的当前页（递归：弹窗再开弹窗同样跟随）。 */
	private adoptPopup(ownerId: string, popup: Page): void {
		popup.setDefaultNavigationTimeout(NAV_TIMEOUT);
		this.pages.set(ownerId, popup);
		popup.on("popup", (child) => this.adoptPopup(ownerId, child));
		console.log(`[browser] popup adopted for owner ${ownerId}: ${popup.url() || "(about:blank)"}`);
	}

	/** 当前打开着的标签页（index 即 list/switch/close 共用的序号）。 */
	private openPages(): Page[] {
		return (this.context?.pages() ?? []).filter((p) => !p.isClosed());
	}

	/** 列出共享浏览器里的所有标签页（多 owner 共享一个 context，列表是全局的）。 */
	async listPages(ownerId: string): Promise<{ index: number; url: string; title: string; current: boolean }[]> {
		await this.ensureContext();
		const pages = this.openPages();
		const current = this.pages.get(ownerId);
		return Promise.all(
			pages.map(async (p, index) => ({
				index,
				url: p.url(),
				title: await p.title().catch(() => ""),
				current: p === current,
			})),
		);
	}

	/** 把 owner 的当前页切换到指定序号的标签页。 */
	async switchPage(ownerId: string, index: number): Promise<{ url: string; title: string }> {
		await this.ensureContext();
		const target = this.openPages()[index];
		if (!target) throw new Error(`标签页序号 ${index} 不存在（可用 browser_tabs action=list 查看列表）`);
		this.pages.set(ownerId, target);
		return { url: target.url(), title: await target.title().catch(() => "") };
	}

	/** 关闭指定序号的标签页；若它是 owner 的当前页，下次工具调用会自动开新页。 */
	async closePage(ownerId: string, index: number): Promise<{ ok: boolean }> {
		await this.ensureContext();
		const pages = this.openPages();
		const target = pages[index];
		if (!target) throw new Error(`标签页序号 ${index} 不存在（可用 browser_tabs action=list 查看列表）`);
		await target.close().catch(() => {});
		if (this.pages.get(ownerId) === target) this.pages.delete(ownerId);
		return { ok: true };
	}

	/** 关闭并移除某 owner 的 Page（会话结束可选调用；默认保留以复用登录态产物）。 */
	async releasePage(ownerId: string): Promise<void> {
		const page = this.pages.get(ownerId);
		this.pages.delete(ownerId);
		try {
			if (page && !page.isClosed()) await page.close();
		} catch (err) {
			console.warn("[browser] releasePage failed:", (err as Error).message);
		}
	}

	private async launch(): Promise<void> {
		const { headless } = this.config.all().browser;
		const profilePath = join(this.profileDir, "browser-profile");
		await mkdir(profilePath, { recursive: true });
		// Persistent context: cookies/localStorage/login state are written to disk
		// and reused next launch, so the employee stays logged in across restarts.
		// acceptDownloads lets Playwright capture file downloads instead of the
		// browser canceling them; the handler routes each into the managed dir.
		this.context = await chromium.launchPersistentContext(profilePath, {
			headless,
			viewport: VIEWPORT,
			acceptDownloads: true,
		});
		// Attach the passive download funnel to every page — owner pages created via
		// getPage() plus popups (target=_blank) and JS-opened windows, so a download
		// is never silently lost. De-duplicates against clickAndDownload via
		// runDownloadHandler.
		const attach = (page: Page): void => {
			page.on("download", (download) => {
				void this.runDownloadHandler(download, page);
			});
		};
		for (const p of this.context.pages()) attach(p);
		this.context.on("page", attach);
		// Close the blank initial page launchPersistentContext opens — otherwise an
		// empty tab lingers for the whole app lifetime. Pages opened later (via
		// getPage or popups) still get the attach listener above.
		for (const p of this.context.pages()) {
			if (p.url() === "about:blank") void p.close().catch(() => {});
		}
	}

	/**
	 * Run the handler for a `Download` exactly once: passive listeners and
	 * clickAndDownload both route here. The first caller creates (and memoizes)
	 * the handling promise; later callers for the same `Download` reuse it. Cleared
	 * on settle, so the map never accumulates completed downloads.
	 */
	private runDownloadHandler(download: Download, page: Page): Promise<void> {
		const existing = this.inflightDownloads.get(download);
		if (existing) return existing;
		const h = this.downloadHandler;
		const p = h
			? Promise.resolve(h(download, page))
					.catch(() => {})
					.finally(() => this.inflightDownloads.delete(download))
			: Promise.resolve();
		this.inflightDownloads.set(download, p);
		return p;
	}

	/** Throw if the host isn't in the allowlist (empty list = unrestricted). */
	private assertAllowed(url: string): void {
		const allowed = this.config.all().browser.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
		if (allowed.length === 0) return;
		let host: string;
		try {
			host = new URL(url).hostname.toLowerCase();
		} catch {
			throw new Error(`无效的 URL：${url}`);
		}
		const ok = allowed.some((d) => host === d || host.endsWith("." + d));
		if (!ok) {
			throw new Error(`域名 ${host} 不在允许列表内（browser.allowedDomains）。请在设置中放行后再访问。`);
		}
	}

	async navigate(ownerId: string, url: string): Promise<{ url: string; title: string }> {
		this.assertAllowed(url);
		const page = await this.getPage(ownerId);
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
		return { url: page.url(), title: await page.title() };
	}

	/**
	 * 点击后回读状态避免“假成功”：返回点击前后 URL 与是否发生 URL/hash 变化。
	 * urlChanged=false 不代表失败（弹层/原地刷新），但可提示模型再次 read 确认。
	 * tabSwitched=true 表示点击打开了新标签页且已自动跟随——后续工具作用于新页。
	 */
	async click(ownerId: string, selector: string): Promise<{ ok: boolean; url: string; beforeUrl: string; urlChanged: boolean; tabSwitched: boolean }> {
		const page = await this.getPage(ownerId);
		const beforeUrl = page.url();
		await page.click(selector, { timeout: NAV_TIMEOUT });
		// 点击可能触发跳转，稍等一拍再取最终 URL，减少竞态误判；短暂停留也给
		// target=_blank 的弹窗事件留出触发窗口（popup 事件先于页面加载完成）。
		await page.waitForLoadState("domcontentloaded").catch(() => {});
		await page.waitForTimeout(250).catch(() => {});
		// 重新取 owner 当前页：若弹窗接管已发生，page 与 now 不同。
		const now = await this.getPage(ownerId);
		const tabSwitched = now !== page;
		const url = now.url();
		return { ok: true, url, beforeUrl, urlChanged: url !== beforeUrl, tabSwitched };
	}

	/**
	 * Click an element that triggers a file download, resolving the
	 * click-vs-download race: wait for the download and click in parallel, then
	 * hand the captured `Download` to the registered funnel (DownloadService)
	 * so it is saved + recorded just like a passive download. Returns the
	 * suggested filename so the employee can immediately find the saved file.
	 */
	async clickAndDownload(ownerId: string, selector: string): Promise<DownloadMeta> {
		const page = await this.getPage(ownerId);
		const [download] = await Promise.all([
			page.waitForEvent("download", { timeout: DOWNLOAD_WAIT_TIMEOUT }),
			page.click(selector, { timeout: NAV_TIMEOUT }),
		]);
		const meta: DownloadMeta = { url: download.url(), suggestedFilename: download.suggestedFilename() };
		// Route through the same dedup path as passive listeners, and await it so
		// the file is actually on disk (and recorded) before we report success.
		await this.runDownloadHandler(download, page);
		return meta;
	}

	/**
	 * 填入后回读真实 value 长度（不回传明文，敏感字段如密码不进上下文），
	 * 让模型能区分“填成功了”与“受控组件没吃进去”。
	 */
	async type(ownerId: string, selector: string, text: string): Promise<{ ok: boolean; valueLength: number }> {
		const page = await this.getPage(ownerId);
		await page.fill(selector, text, { timeout: NAV_TIMEOUT });
		const value = await page.inputValue(selector).catch(() => "");
		return { ok: true, valueLength: value.length };
	}

	/** Send a single keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowLeft"). */
	async pressKey(ownerId: string, key: string): Promise<{ ok: boolean }> {
		const page = await this.getPage(ownerId);
		await page.keyboard.press(key);
		return { ok: true };
	}

	/**
	 * Raw coordinate click — for CANVAS apps (H5 remote-desktop clients, 堡垒机
	 * web terminals, games): the remote UI is painted pixels, not DOM elements,
	 * so selector-based click can't reach it. `page.mouse` operates at the
	 * browser input level, exactly like a real user's mouse. Pair with
	 * screenshot (viewport 1:1) for the model to pick coordinates.
	 */
	async mouseClick(
		ownerId: string,
		x: number,
		y: number,
		opts: { button?: "left" | "right"; double?: boolean } = {},
	): Promise<{ ok: boolean; x: number; y: number }> {
		const page = await this.getPage(ownerId);
		if (x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) {
			throw new Error(`坐标 (${x}, ${y}) 超出视口 ${VIEWPORT.width}x${VIEWPORT.height}——请以 browser_screenshot 的画面为准（1:1 对应）`);
		}
		await page.mouse.move(x, y);
		await page.mouse.click(x, y, { button: opts.button ?? "left", clickCount: opts.double ? 2 : 1 });
		return { ok: true, x, y };
	}

	/**
	 * Type text key-by-key into whatever has focus (raw keyboard input). After
	 * mouseClick lands focus inside a canvas remote session, this is how text
	 * reaches the remote machine — browser_type (DOM fill) can't see it.
	 */
	async keyboardType(ownerId: string, text: string): Promise<{ ok: boolean; length: number }> {
		const page = await this.getPage(ownerId);
		await page.keyboard.type(text, { delay: 30 });
		return { ok: true, length: text.length };
	}

	/**
	 * Run arbitrary JS in the current page and return the result as short text.
	 * `script` is evaluated as an expression (wrap multi-statement logic in an
	 * IIFE: `(() => { …; return x; })()`). Runs only on the already-allowed page,
	 * so it inherits the `allowedDomains` trust boundary of navigate/click/type.
	 */
	async evaluate(ownerId: string, script: string): Promise<{ value: string }> {
		const page = await this.getPage(ownerId);
		const result = await page.evaluate(script);
		let text: string | undefined;
		try {
			text = typeof result === "string" ? result : JSON.stringify(result);
		} catch {
			text = String(result);
		}
		if (text === undefined) text = "(无返回值)";
		if (text.length > 2000) text = text.slice(0, 2000) + "…";
		return { value: text };
	}

	/** 主要输入框的简要状态（不含明文），帮助模型判断登录态/表单是否已填。 */
	async readInputs(ownerId: string): Promise<InputFieldSummary[]> {
		const page = await this.getPage(ownerId);
		return page.evaluate<InputFieldSummary[]>(
			`(() => {
				const els = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea'));
				return els.slice(0, 10).map((el) => ({
					tag: el.tagName.toLowerCase(),
					type: el.getAttribute('type') || (el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text'),
					name: el.getAttribute('name') || '',
					placeholder: el.getAttribute('placeholder') || '',
					filled: String(el.value || '').length > 0,
					valueLength: String(el.value || '').length,
				}));
			})()`,
		);
	}

	/** Read the visible body text (truncated) so the model can reason about the page. */
	async getText(ownerId: string): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
		const page = await this.getPage(ownerId);
		// String form avoids needing the DOM lib in this (Node) compile target.
		const raw = await page.evaluate<string>("document.body ? document.body.innerText : ''");
		const truncated = raw.length > TEXT_LIMIT;
		return { url: page.url(), title: await page.title(), text: raw.slice(0, TEXT_LIMIT), truncated };
	}

	/** Full-page-ish screenshot (current viewport) as base64 JPEG (see SCREENSHOT_QUALITY).
	 *  Dimensions equal the viewport (1:1 with coordinate tools — mouseClick etc.). */
	async screenshot(ownerId: string): Promise<BrowserScreenshot> {
		const page = await this.getPage(ownerId);
		const buf = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY });
		return { base64: buf.toString("base64"), mimeType: "image/jpeg", viewport: { ...VIEWPORT } };
	}

	async currentUrl(ownerId: string): Promise<string> {
		const page = await this.getPage(ownerId);
		return page.url();
	}

	async close(): Promise<void> {
		try {
			// Closing the persistent context flushes cookies/storage to disk.
			await this.context?.close();
		} catch (err) {
			console.warn("[browser] close failed:", (err as Error).message);
		}
		this.context = null;
		this.pages.clear();
	}
}
