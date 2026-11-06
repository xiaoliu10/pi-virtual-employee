# VE playwright shim v5: ONE browser per user-data-dir, many tab owners.
#
# The user's ruling (2026-11-06, after v4's clone-on-use produced a false
# "master busy" outage): the Hermes model is THE ONLY path — every
# launch_persistent_context() on a directory already served by a live Chromium
# ATTACHES to that browser and opens its own tab; isolation between tasks is
# per-owner pages, never per-profile copies. v4's clones are gone, and with
# them the bug where a leftover clone's chrome matched the master's directory
# name and made every later task fail with PROFILE_MASTER_BUSY.
#
# How v5 decides (generic — no per-profile tag lists):
#   1. <dir>/DevToolsActivePort exists and a CDP connect succeeds  -> ATTACH.
#      The caller gets a TabContext wrapper: new_page() opens a fresh tab in
#      the SHARED browser; close() closes only the pages this caller created,
#      then disconnects. The browser keeps running for the next task.
#   2. No endpoint (nothing running, or a stale file) -> LAUNCH as the host:
#      original launch_persistent_context plus --remote-debugging-port=0, so
#      Chromium writes DevToolsActivePort itself (no port races). The host is
#      the owner-exit shutdown: its close() closes the browser. Login state
#      lives on disk (persistent context), so the next host relaunches with
#      everything intact.
#   3. Singleton conflict during launch (another host is mid-launch) ->
#      PROFILE_BUSY fast-fail. Never retry in a loop, never taskkill.
#
# This replaces v4 clone-on-use entirely (manifest, saveback, quarantine).
# Rollback: remove ve_pw_profile_lock.pth + this file (v4 is in git history),
# or set VE_PW_NO_ATTACH=1 to bypass the shim per process.
import atexit, fnmatch, os, time

_LOG = os.path.join(os.path.expanduser("~"), "pw_profile_lock.log")
# Windows lock files Chromium refuses to inherit a profile with (union of
# browser-use / Skyvern lists plus the process_singleton_win.cc `lockfile`).
_STALE_ROOT_FILES = ("lockfile", "SingletonLock", "SingletonCookie",
                     "SingletonSocket", "*.lock", "*-journal", "LOCK", "LOCKFILE")

def _ve_note(msg):
    try:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass

def _ve_http_base(user_data_dir):
    """http://127.0.0.1:<port> from Chromium's own DevToolsActivePort file,
    or None when absent/stale/garbage. Line 1 is the port, line 2 the
    browser websocket path (unused here). The file is written after the
    endpoint listens, so a missing file simply means "not ready yet"."""
    try:
        path = os.path.join(str(user_data_dir), "DevToolsActivePort")
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            first = (f.read().splitlines() or [""])[0].strip()
        port = int(first)
        if not (0 < port < 65536):
            return None
        return "http://127.0.0.1:%d" % port
    except Exception:
        return None

def _ve_try_attach(btype, user_data_dir, timeout_s=4.0):
    """Connect over CDP to the browser serving `user_data_dir`.
    Returns (browser, default_context) or (None, reason). A connect that
    fails / dies immediately means the endpoint file is stale — caller
    should treat the dir as free (Chromium removes the file on a clean
    exit; a crashed host leaves it until the next launch overwrites it)."""
    base = _ve_http_base(user_data_dir)
    if not base:
        return None, "no endpoint file"
    try:
        browser = btype.connect_over_cdp(base, timeout=timeout_s * 1000)
    except Exception as e:
        return None, "connect failed: %s" % str(e)[:120]
    try:
        # connect_over_cdp exposes the persistent context as contexts[0]
        # (Playwright models the browser's default context that way).
        ctx = browser.contexts[0] if browser.contexts else None
        if ctx is None:
            browser.close()
            return None, "browser has no default context"
        return browser, ctx
    except Exception as e:
        try:
            browser.close()
        except Exception:
            pass
        return None, "context probe failed: %s" % str(e)[:120]

class TabContext:
    """launch_persistent_context-compatible wrapper for ATTACH mode.

    The caller wrote its script against a persistent context: new_page(),
    pages, and close(). On the shared browser those become: a fresh tab in
    the common default context, the caller's own tabs, and "close MY tabs
    then disconnect — the browser itself stays for the next task". Anything
    else is transparently forwarded, so scripts written for v3/v4 keep
    working unchanged."""

    def __init__(self, browser, shared_ctx, label):
        self._browser = browser
        self._shared = shared_ctx
        self._mine = []
        self._label = label

    def new_page(self, *a, **kw):
        page = self._shared.new_page(*a, **kw)
        self._mine.append(page)
        return page

    @property
    def pages(self):
        # Only this caller's tabs. Handing back other tasks' tabs is exactly
        # the cross-client tab fight Playwright #42961 refuses to support.
        return [p for p in self._mine if not p.is_closed()]

    def close(self, *a, **kw):
        for p in self._mine:
            try:
                if not p.is_closed():
                    p.close(*a, **kw)
            except Exception:
                pass
        self._mine = []
        try:
            # disconnect, not close: browser.close() would kill every other
            # task's tabs (the v0.2.186 field incident in one line).
            self._browser.disconnect()
        except Exception:
            pass
        _ve_note("attach owner exited (%s): tabs=%d closed" % (self._label, len(self._mine)))

    def __getattr__(self, name):
        return getattr(self._shared, name)

def _ve_clean_stale_locks(user_data_dir):
    """A crashed host leaves lock files Chromium created with
    CREATE_ALWAYS|DELETE_ON_CLOSE — process-dead ones never block a relaunch,
    but they confuse copy-based tooling and are pure residue. Sweep only the
    known root files; never touch profile data."""
    for pat in _STALE_ROOT_FILES:
        import glob
        for fp in glob.glob(os.path.join(str(user_data_dir), pat)):
            try:
                os.remove(fp)
                _ve_note("removed stale lock file %s" % fp)
            except OSError:
                pass

def _install():
    try:
        from playwright.sync_api import BrowserType
    except Exception:
        return
    if getattr(BrowserType, "_ve_lock_patched_v5", False):
        return
    original = BrowserType.launch_persistent_context

    def wrapped(self, user_data_dir, *a, **kw):
        if os.environ.get("VE_PW_NO_ATTACH"):
            return original(self, user_data_dir, *a, **kw)
        udd = str(user_data_dir)
        browser, ctx = _ve_try_attach(self, udd)
        if browser is not None:
            _ve_note("attach: %s -> shared browser (%d existing tab(s))"
                     % (udd, len(ctx.pages)))
            return TabContext(browser, ctx, os.path.basename(udd) or udd)
        _ve_note("launch as host for %s (attach said: %s)" % (udd, ctx))
        # Host launch: let Chromium pick its own CDP port so later tasks can
        # attach (port=0 writes DevToolsActivePort; no bind-then-close races).
        args = list(kw.get("args") or [])
        if not any(str(x).startswith("--remote-debugging-port=") for x in args):
            args.append("--remote-debugging-port=0")
        kw["args"] = args
        _ve_clean_stale_locks(udd)
        t0 = time.time()
        try:
            host_ctx = original(self, user_data_dir, *a, **kw)
        except Exception as e:
            fast = (time.time() - t0) < 20
            msg = str(e).lower()
            if fast and (("closed" in msg) or ("singleton" in msg)):
                raise RuntimeError(
                    "PROFILE_BUSY: user_data_dir %s is being launched by another "
                    "host right now. Do NOT retry in a loop and do NOT taskkill; "
                    "try again shortly or report." % udd)
            raise
        atexit.register(_ve_host_exit, host_ctx, udd)
        _ve_note("host launched %s in %.1fs (endpoint: %s)"
                 % (udd, time.time() - t0, _ve_http_base(udd)))
        return host_ctx

    wrapped.__name__ = "launch_persistent_context"
    BrowserType.launch_persistent_context = wrapped
    BrowserType._ve_lock_patched_v5 = True
    _ve_note("patch v5 installed (attach-or-host, one browser per profile)")

def _ve_host_exit(host_ctx, udd):
    """Owner-exit shutdown: the host's close() closes the browser. Persistent
    login state is already on disk, so the next host relaunches with it.
    A task still attached at that instant gets closed pages and reports —
    accepted race, bounded by the short attach window."""
    try:
        host_ctx.close()
        _ve_note("host exited; browser closed (%s)" % udd)
    except Exception as e:
        _ve_note("host exit close failed (%s): %r" % (udd, e))

_install()
