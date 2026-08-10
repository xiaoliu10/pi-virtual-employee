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
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ConfigStore } from "../db/config-store.js";

const NAV_TIMEOUT = 30_000;
const VIEWPORT = { width: 1280, height: 800 };
/** Cap how much page text we hand the model, to keep context bounded. */
const TEXT_LIMIT = 6000;
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
}

export class BrowserService {
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private page: Page | null = null;
	private launching: Promise<Page> | null = null;

	constructor(private readonly config: ConfigStore) {}

	/** Lazily launch Chromium + a context/page using the current config. */
	private ensurePage(): Promise<Page> {
		if (this.page && !this.page.isClosed()) return Promise.resolve(this.page);
		if (this.launching) return this.launching;
		this.launching = this.launch().finally(() => {
			this.launching = null;
		});
		return this.launching;
	}

	private async launch(): Promise<Page> {
		const { headless } = this.config.all().browser;
		this.browser = await chromium.launch({ headless });
		this.context = await this.browser.newContext({ viewport: VIEWPORT });
		this.page = await this.context.newPage();
		this.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
		return this.page;
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

	async navigate(url: string): Promise<{ url: string; title: string }> {
		this.assertAllowed(url);
		const page = await this.ensurePage();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
		return { url: page.url(), title: await page.title() };
	}

	async click(selector: string): Promise<{ ok: boolean; url: string }> {
		const page = await this.ensurePage();
		await page.click(selector, { timeout: NAV_TIMEOUT });
		return { ok: true, url: page.url() };
	}

	async type(selector: string, text: string): Promise<{ ok: boolean }> {
		const page = await this.ensurePage();
		await page.fill(selector, text, { timeout: NAV_TIMEOUT });
		return { ok: true };
	}

	/** Send a single keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowLeft"). */
	async pressKey(key: string): Promise<{ ok: boolean }> {
		const page = await this.ensurePage();
		await page.keyboard.press(key);
		return { ok: true };
	}

	/**
	 * Run arbitrary JS in the current page and return the result as short text.
	 * `script` is evaluated as an expression (wrap multi-statement logic in an
	 * IIFE: `(() => { …; return x; })()`). Runs only on the already-allowed page,
	 * so it inherits the `allowedDomains` trust boundary of navigate/click/type.
	 */
	async evaluate(script: string): Promise<{ value: string }> {
		const page = await this.ensurePage();
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

	/** Read the visible body text (truncated) so the model can reason about the page. */
	async getText(): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
		const page = await this.ensurePage();
		// String form avoids needing the DOM lib in this (Node) compile target.
		const raw = await page.evaluate<string>("document.body ? document.body.innerText : ''");
		const truncated = raw.length > TEXT_LIMIT;
		return { url: page.url(), title: await page.title(), text: raw.slice(0, TEXT_LIMIT), truncated };
	}

	/** Full-page-ish screenshot (current viewport) as base64 JPEG (see SCREENSHOT_QUALITY). */
	async screenshot(): Promise<BrowserScreenshot> {
		const page = await this.ensurePage();
		const buf = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY });
		return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
	}

	async currentUrl(): Promise<string> {
		const page = await this.ensurePage();
		return page.url();
	}

	async close(): Promise<void> {
		try {
			await this.browser?.close();
		} catch (err) {
			console.warn("[browser] close failed:", (err as Error).message);
		}
		this.browser = null;
		this.context = null;
		this.page = null;
	}
}
