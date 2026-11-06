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
 * The ruling (2026-11-06): the Hermes model is THE ONLY path — ONE browser per
 * profile, each task owning its own tab. This module provides the TS side's
 * ownership registry; the box-side python scripts get the same semantics from
 * resources/browser-bridge/ve_pw_profile_lock.py (attach-or-host shim v5).
 */
import type { Page } from "playwright-core";

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
