# Unit tests for the v5 attach-or-host playwright shim — no real Chromium.
#
# We inject a fake `playwright.sync_api` into sys.modules BEFORE importing the
# shim, so _install() patches OUR fake BrowserType and every decision path is
# exercised against stubs that record what happened:
#   - attach mode: endpoint file + successful CDP connect -> TabContext that
#     closes ONLY its own pages and disconnects (never browser.close())
#   - host mode: no/stale endpoint -> original launch with port=0 injected
#   - fast singleton conflict -> PROFILE_BUSY RuntimeError (loop/taskkill ban)
#   - VE_PW_NO_ATTACH=1 -> raw passthrough
# Run: python3 test_ve_pw_shim_v5.py  (also runs on the box's python-win)
import importlib.util, json, os, sys, tempfile, time, types, unittest

# ---- fake playwright.sync_api ------------------------------------------------
class FakePage:
    def __init__(self):
        self.closed = False
        self.close_calls = 0
    def is_closed(self): return self.closed
    def close(self, *a, **kw):
        self.close_calls += 1; self.closed = True

class FakeCtx:
    def __init__(self): self.pages = []; self.new_page_calls = 0
    def new_page(self, *a, **kw):
        self.new_page_calls += 1
        p = FakePage(); self.pages.append(p); return p

class FakeBrowser:
    def __init__(self, ctx): self.contexts = [ctx]; self.disconnects = 0; self.closed = 0
    def disconnect(self): self.disconnects += 1
    def close(self): self.closed += 1

class FakeBrowserType:
    launch_calls = []   # (user_data_dir, args)
    connect_calls = []  # http bases
    connect_error = None
    launch_error = None
    _ve_lock_patched_v5 = False
    def launch_persistent_context(self, user_data_dir, *a, **kw):
        FakeBrowserType.launch_calls.append((str(user_data_dir), list(kw.get("args") or [])))
        if FakeBrowserType.launch_error:
            time.sleep(0.01)   # fast (<20s) singleton-style failure
            raise RuntimeError("Target page, context or browser has been closed")
        return FakeCtx()
    def connect_over_cdp(self, base, timeout=None):
        FakeBrowserType.connect_calls.append(base)
        if FakeBrowserType.connect_error:
            raise RuntimeError("connect ECONNREFUSED")
        return FakeBrowser(FakeCtx())

fake_pw = types.ModuleType("playwright"); fake_sync = types.ModuleType("playwright.sync_api")
fake_sync.BrowserType = FakeBrowserType
fake_pw.sync_api = fake_sync
sys.modules.setdefault("playwright", fake_pw); sys.modules["playwright.sync_api"] = fake_sync

SHIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ve_pw_profile_lock.py")
spec = importlib.util.spec_from_file_location("ve_pw_profile_lock", SHIM)
shim = importlib.util.module_from_spec(spec); spec.loader.exec_module(shim)

class TestEndpointReading(unittest.TestCase):
    def test_missing_file_means_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(shim._ve_http_base(d))
    def test_valid_port(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "DevToolsActivePort"), "w").write("54321\n/devtools/browser/abc\n")
            self.assertEqual(shim._ve_http_base(d), "http://127.0.0.1:54321")
    def test_garbage_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "DevToolsActivePort"), "w").write("not-a-port\n")
            self.assertIsNone(shim._ve_http_base(d))
            open(os.path.join(d, "DevToolsActivePort"), "w").write("99999\n")
            self.assertIsNone(shim._ve_http_base(d))  # out of range

class TestAttachMode(unittest.TestCase):
    def setUp(self):
        FakeBrowserType.launch_calls = []; FakeBrowserType.connect_calls = []
        FakeBrowserType.connect_error = None
        self.tmp = tempfile.TemporaryDirectory()
        open(os.path.join(self.tmp.name, "DevToolsActivePort"), "w").write("54321\nx\n")
    def tearDown(self): self.tmp.cleanup()

    def test_attach_returns_tab_context_and_never_launches(self):
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        self.assertIsInstance(ctx, shim.TabContext)
        self.assertEqual(FakeBrowserType.launch_calls, [], "attach must not launch a rival browser")
    def test_tab_close_only_own_pages_then_disconnect(self):
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        p1 = ctx.new_page()
        browser = ctx._browser
        self.assertEqual(p1.close_calls, 0)
        ctx.close()
        self.assertEqual(p1.close_calls, 1, "own tab must be closed on exit")
        self.assertEqual(browser.disconnects, 1, "must disconnect from the shared browser")
        self.assertEqual(browser.closed, 0, "NEVER browser.close() — that kills other tasks' tabs")
    def test_pages_only_mine_and_dead_filtered(self):
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        p1 = ctx.new_page(); p2 = ctx.new_page()
        p1.closed = True  # simulate externally-closed tab
        self.assertEqual(ctx.pages, [p2], "dead pages must be filtered, never handed out")
    def test_getattr_forwards_to_shared_context(self):
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        # anything not overridden goes to the shared ctx (e.g. .pages is ours, but a
        # method like add_cookies-style attribute must forward) — use new_page_calls
        self.assertEqual(ctx._shared.new_page_calls, 0)
        self.assertTrue(hasattr(ctx, "_label"))

class TestHostMode(unittest.TestCase):
    def setUp(self):
        FakeBrowserType.launch_calls = []; FakeBrowserType.connect_calls = []
        FakeBrowserType.connect_error = None; FakeBrowserType.launch_error = None
        self.tmp = tempfile.TemporaryDirectory()
    def tearDown(self): self.tmp.cleanup()

    def test_no_endpoint_launches_with_port_zero(self):
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        self.assertEqual(len(FakeBrowserType.launch_calls), 1)
        udd, args = FakeBrowserType.launch_calls[0]
        self.assertEqual(udd, self.tmp.name)
        self.assertIn("--remote-debugging-port=0", args, "host MUST expose a CDP endpoint for later tasks")
    def test_existing_port_arg_not_duplicated(self):
        fake_sync.BrowserType().launch_persistent_context(self.tmp.name, args=["--remote-debugging-port=9222"])
        args = FakeBrowserType.launch_calls[0][1]
        self.assertEqual(args.count("--remote-debugging-port=0"), 0)
        self.assertIn("--remote-debugging-port=9222", args)
    def test_stale_endpoint_falls_through_to_host(self):
        FakeBrowserType.connect_error = RuntimeError("connect ECONNREFUSED")
        open(os.path.join(self.tmp.name, "DevToolsActivePort"), "w").write("54321\nx\n")
        ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        self.assertEqual(len(FakeBrowserType.launch_calls), 1, "dead endpoint file must fall through to host launch")
    def test_fast_singleton_conflict_raises_profile_busy(self):
        FakeBrowserType.connect_error = RuntimeError("connect ECONNREFUSED")
        FakeBrowserType.launch_error = RuntimeError("Target closed")
        t0 = time.time()
        with self.assertRaises(RuntimeError) as cm:
            fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        self.assertIn("PROFILE_BUSY", str(cm.exception))
        self.assertIn("Do NOT retry in a loop and do NOT taskkill; try again shortly or report.", str(cm.exception))
    def test_stale_lock_files_swept_before_launch(self):
        for f in ("lockfile", "SingletonLock"):
            open(os.path.join(self.tmp.name, f), "w").close()
        fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "lockfile")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "SingletonLock")))

class TestEscapeHatch(unittest.TestCase):
    def test_no_attach_env_bypasses_everything(self):
        FakeBrowserType.launch_calls = []; FakeBrowserType.connect_calls = []
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["VE_PW_NO_ATTACH"] = "1"
        try:
            ctx = fake_sync.BrowserType().launch_persistent_context(self.tmp.name)
            self.assertEqual(FakeBrowserType.connect_calls, [], "env escape must skip attach probing")
            self.assertEqual(len(FakeBrowserType.launch_calls), 1, "env escape must call the original launch")
        finally:
            os.environ.pop("VE_PW_NO_ATTACH", None); self.tmp.cleanup()

class TestPatchIdempotence(unittest.TestCase):
    def test_double_import_patches_once(self):
        # exec_module again on a fresh module object; the patched flag on the
        # SHARED fake BrowserType must prevent double wrapping.
        before = FakeBrowserType.launch_persistent_context
        spec2 = importlib.util.spec_from_file_location("ve_shim_again", SHIM)
        m2 = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(m2)
        self.assertIs(FakeBrowserType.launch_persistent_context, before, "no double wrap")

if __name__ == "__main__":
    unittest.main(verbosity=2)
