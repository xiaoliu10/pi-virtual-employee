/**
 * Shared browser session — one Chromium per profile home, many owners.
 *
 * WHY THIS EXISTS
 * ---------------
 * Chromium permits exactly ONE process per user-data-dir. When two of our tasks
 * (a work window, a scheduled fire, an IM turn) wanted the same logged-in
 * profile, the loser died with exitCode 21 (`RESULT_CODE_PROFILE_IN_USE`), the
 * model misread that as "browser kernel broke", ran `taskkill /IM chrome.exe`,
 * and destroyed every other task's browser and login state. Field incident
 * 2026-11-05: 40+ such kills, 31 login expiries.
 *
 * Two shapes solve it:
 *   (a) give every task its own copy of the profile (N browsers, N× memory), or
 *   (b) ONE browser per profile, each task gets its own context/page (1 browser).
 *
 * This module implements (b), matching Hermes (`tools/browser_launcher.py`:
 * "One browser per launcher key … a persistent profile shared by every key") and
 * puppeteer-cluster's PAGE concurrency ("Shares everything (cookies,
 * localStorage, etc.) between jobs"). Login state is shared because the pages
 * live in one context; isolation between tasks is per-owner page ownership, not
 * per-profile.
 *
 * WHAT IT GUARANTEES
 *   - Concurrent first-use collapses to ONE launch (`launching` promise).
 *   - A crash/close is not masked: the next call relaunches and tells the caller
 *     the previous browser is gone (never hands back a dead page).
 *   - Owner→page mapping is explicit, so one task can never be handed another
 *     task's tab (the failure mode Playwright #42961 refuses to support: "two
 *     clients ended up navigating and closing each other's tabs").
 */
import type { Browser, BrowserContext, Page } from "playwright-core";

/** A live shared browser plus its CDP endpoint. */
export interface SharedBrowser {
	browser: Browser;
	context: BrowserContext;
	/** `http://127.0.0.1:<port>` — useful for a human to attach a DevTools client. */
	httpBase: string;
	/** pid of the Chromium we launched (null when attached to a running one). */
	pid: number | null;
	/** True when this process launched it; false when attached to an existing one. */
	owned: boolean;
}

export interface SharedBrowserHandle {
	/** Start (or join) the shared browser. Idempotent; concurrent calls share one launch. */
	acquire(): Promise<SharedBrowser>;
	/** The page belonging to `ownerId`, created in the shared context on first use. */
	pageFor(ownerId: string): Promise<Page>;
	/** Drop `ownerId`'s page (closes it). Other owners are untouched. */
	releaseOwner(ownerId: string): Promise<void>;
	/** Close everything this handle started. Idempotent. */
	dispose(): Promise<void>;
	/** Snapshot for diagnostics/tests. */
	state(): {
		ready: boolean;
		launching: boolean;
		owners: string[];
		pid: number | null;
		owned: boolean;
	};
}

/**
 * Ownership registry: `ownerId -> Page`.
 *
 * Deliberately NOT "the last opened page" or "pages()[0]" — a global selector is
 * exactly how two clients end up fighting over one tab. A missing owner always
 * means "open a fresh page", never "reuse somebody else's".
 */
export class PageOwnership {
	private readonly pages = new Map<string, Page>();

	get(ownerId: string): Page | undefined {
		const page = this.pages.get(ownerId);
		if (page && !page.isClosed()) return page;
		if (page) this.pages.delete(ownerId); // dead page: forget it, never hand it out
		return undefined;
	}

	set(ownerId: string, page: Page): void {
		this.pages.set(ownerId, page);
	}

	/** Forget an owner without closing (used after an explicit close). */
	forget(ownerId: string): void {
		this.pages.delete(ownerId);
	}

	/**
	 * Transfer `page` to `ownerId`, dropping whoever held it.
	 *
	 * switchPage uses this so a tab can never have two live owners: the previous
	 * owner's pointer is dropped and it gets a fresh page on its next call. Merely
	 * logging a takeover still left both owners driving one tab — the exact
	 * "I navigated your page" failure this registry exists to prevent (review
	 * P2-6). Returns the previous owner (null when none) so the caller can log.
	 */
	takeover(ownerId: string, page: Page): string | null {
		const previous = this.ownedBy(page);
		if (previous && previous !== ownerId) this.pages.delete(previous);
		this.pages.set(ownerId, page);
		return previous;
	}

	/** Forget whoever owns `page` (used when a page closes on its own). */
	forgetByPage(page: Page): void {
		for (const [owner, p] of this.pages) {
			if (p === page) this.pages.delete(owner);
		}
	}

	owners(): string[] {
		return [...this.pages.keys()];
	}

	/** True when `page` belongs to some owner — used to refuse "foreign" operations. */
	ownedBy(page: Page): string | null {
		for (const [owner, p] of this.pages) if (p === page) return owner;
		return null;
	}

	clear(): void {
		this.pages.clear();
	}
}
