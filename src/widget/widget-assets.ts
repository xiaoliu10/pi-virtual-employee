/**
 * Widget assets (v0.2.176): the embeddable loader and the full chat page.
 *
 * Both are self-contained (no framework, no external assets) and rendered from
 * template functions so per-deployment strings (title/subtitle/suggestions)
 * are injected server-side from the live config. The loader mounts a Shadow
 * DOM so the host page's CSS can never break the panel (and vice versa).
 *
 * Visual reference: Aliyun console's AI 助理 — a round launcher bottom-right,
 * expanding into a light panel with a header (title + close), a greeting
 * headline, suggestion chips, a message list, an auto-growing input with
 * Shift+Enter for newline, and a small AI disclaimer footer.
 */

const SHARED_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
button { font-family: inherit; cursor: pointer; }
input, textarea { font-family: inherit; }
/* ── 过程展示（v0.2.179）：工具调用行 / 思考折叠 / 流式光标 ── */
.step { display:flex; align-items:center; gap:6px; margin:4px 0; font-size:12px; color:#86909c; }
.step .st-ico { font-size:12px; }
.step .st-spin { display:inline-block; width:14px; text-align:center; color:#4f6ef7; }
.step .st-spin::after { content:"⋯"; }
.step.ok .st-spin { color:#00b42a; }
.step.ok .st-spin::after { content:"✓"; }
.step.bad { color:#f53f3f; }
.step.bad .st-spin { color:#f53f3f; }
.step.bad .st-spin::after { content:"✗"; }
.think { margin:4px 0; border:1px solid #eef0f4; border-radius:8px; overflow:hidden; }
.think-h { padding:6px 10px; font-size:12px; color:#86909c; cursor:pointer; user-select:none; background:#f7f8fa; }
.think-b { padding:8px 10px; font-size:12px; color:#4e5969; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow-y:auto; background:#fafbfc; }
.think-b.hidden { display:none; }
.msg.streaming::after { content:"▍"; color:#4f6ef7; animation:ve-blink 1s step-start infinite; }
@keyframes ve-blink { 50% { opacity:0; }
`;

/**
 * The embeddable loader. Usage on the business system's page:
 *
 *   <script src="http://ve-host:17880/widget.js"
 *           data-token="..." data-user="endUserKey" data-title="业务助理"></script>
 *
 * `data-*` beats server config when present, so one deployment can serve many
 * business systems with different titles without extra endpoints. The API base
 * derives from the script's own URL — no configuration beyond the script tag.
 */
export function renderWidgetLoader(): string {
	return `(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var base = script.src.replace(/\\/widget\\.js.*$/, "");
  var token = script.getAttribute("data-token") || "";
  var user = script.getAttribute("data-user") || "";
  var titleOverride = script.getAttribute("data-title") || "";
  // SESSION TICKET (v0.2.178). The browser must never hold the widget secret —
  // with it, anyone could mint themselves an admin ticket. So the business
  // system's BACKEND calls POST /api/widget/session {user, role} once and puts
  // the resulting short-lived ticket here. The ticket is bound to that caller's
  // address + Origin, so copying it to another machine does not work.
  var ticket = script.getAttribute("data-ticket") || "";

  var state = { open: false, busy: false, cfg: null, messages: [] };

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;right:0;bottom:0;z-index:2147483000;width:0;height:0;";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  document.body.appendChild(host);

  var css = ${JSON.stringify(SHARED_CSS)} + \`
  .launcher { position:absolute; right:24px; bottom:24px; width:56px; height:56px; border-radius:50%;
    border:none; background:linear-gradient(135deg,#4f6ef7,#7a5cf0); color:#fff; font-size:13px; font-weight:600;
    box-shadow:0 6px 20px rgba(79,110,247,.4); display:flex; align-items:center; justify-content:center; }
  .launcher:hover { transform:scale(1.05); }
  .panel { position:absolute; right:24px; bottom:92px; width:380px; max-width:calc(100vw - 32px);
    height:560px; max-height:calc(100vh - 130px); background:#fff; border-radius:14px;
    box-shadow:0 12px 48px rgba(0,0,0,.18); display:flex; flex-direction:column; overflow:hidden;
    font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif; }
  .head { padding:14px 16px; display:flex; align-items:center; justify-content:space-between;
    border-bottom:1px solid #eef0f4; }
  .head .t { font-size:15px; font-weight:600; color:#1f2329; }
  .head button { background:none; border:none; font-size:16px; color:#86909c; padding:4px; }
  .body { flex:1; overflow-y:auto; padding:16px; background:#f7f8fa; }
  .hero { font-size:20px; font-weight:700; color:#1f2329; line-height:1.4; margin:6px 0 14px; }
  .hero em { font-style:normal; color:#4f6ef7; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
  .chip { padding:8px 12px; background:#fff; border:1px solid #e5e6eb; border-radius:10px;
    font-size:13px; color:#4e5969; text-align:left; }
  .chip:hover { border-color:#4f6ef7; color:#4f6ef7; }
  .msg { max-width:86%; padding:10px 12px; border-radius:12px; font-size:14px; line-height:1.6;
    color:#1f2329; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; }
  .msg.ai { background:#fff; border:1px solid #e5e6eb; border-top-left-radius:4px; }
  .msg.me { background:#4f6ef7; color:#fff; margin-left:auto; border-top-right-radius:4px; }
  .msg.err { background:#fff7e8; border:1px solid #ffd591; color:#ad6800; }
  .foot { border-top:1px solid #eef0f4; padding:10px 12px 6px; background:#fff; }
  .box { width:100%; height:64px; resize:none; border:1px solid #e5e6eb; border-radius:10px;
    padding:8px 10px; font-size:14px; color:#1f2329; outline:none; }
  .box:focus { border-color:#4f6ef7; }
  .sendrow { display:flex; justify-content:flex-end; padding-top:6px; }
  .send { background:#4f6ef7; border:none; color:#fff; border-radius:8px; padding:6px 16px; font-size:13px; }
  .send:disabled { background:#c9cdd4; }
  .dis { text-align:center; font-size:11px; color:#c9cdd4; padding:4px 0 6px; }
  .hidden { display:none !important; }
  \`;
  var style = document.createElement("style");
  style.textContent = css;
  root.appendChild(style);

  var panel = document.createElement("div");
  panel.className = "panel hidden";
  panel.innerHTML =
    '<div class="head"><span class="t"></span><button title="收起">─</button></div>' +
    '<div class="body"><div class="hero"></div><div class="chips"></div><div class="msgs"></div></div>' +
    '<div class="foot"><textarea class="box" placeholder="请将您遇到的问题告诉我，使用 Shift + Enter 换行"></textarea>' +
    '<div class="sendrow"><button class="send">发送</button></div><div class="dis"></div></div>';
  root.appendChild(panel);

  var launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.textContent = "AI";
  launcher.title = "AI 助理";
  root.appendChild(launcher);

  function q(sel) { return panel.querySelector(sel); }
  function body() { return q(".body"); }
  function msgs() { return q(".msgs"); }
  function scrollEnd() { body().scrollTop = body().scrollHeight; }

  function addMsg(cls, text) {
    var el = document.createElement("div");
    el.className = "msg " + cls;
    el.textContent = text;
    msgs().appendChild(el);
    scrollEnd();
    return el;
  }

  function renderCfg(cfg) {
    state.cfg = cfg;
    q(".head .t").textContent = titleOverride || cfg.title || "AI 助理";
    q(".hero").innerHTML = "";
    var hero = q(".hero");
    hero.appendChild(document.createTextNode("你好，我是 "));
    var em = document.createElement("em");
    em.textContent = titleOverride || cfg.title || "AI 助理";
    hero.appendChild(em);
    var chips = q(".chips");
    chips.innerHTML = "";
    (cfg.suggestions || []).forEach(function (s) {
      if (!s) return;
      var b = document.createElement("button");
      b.className = "chip"; b.textContent = s;
      b.addEventListener("click", function () { send(s); });
      chips.appendChild(b);
    });
    q(".dis").textContent = cfg.disclaimer || "内容由 AI 生成，仅供参考。";
  }

  function api(path, options) {
    options = options || {};
    var headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
    if (path === "/api/widget/chat" && ticket) headers["X-VE-Ticket"] = ticket;
    options.headers = headers;
    return fetch(base + path, options).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    });
  }

  // ── 过程展示（v0.2.179）：流式文本 / 思考 / 工具调用，参考桌面控制台 ──
  // 一个回合可能跑几分钟且中间有多次工具调用；只等最终回复的交互在业务
  // 页面里等于「点了没反应」。渲染规则：
  //   thinking_delta → 折叠的「思考过程」面板（灰色小字，默认收起）
  //   delta          → 流式追加到当前 AI 气泡
  //   tool_start/end → 「调用工具 …」过程行，进行中转圈，结束标 ✓/✗
  //   replace        → 服务端凭据门禁整条替换时，重置当前气泡
  function streamChat(messageText, handlers) {
    fetch(base + "/api/widget/chat", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-VE-Ticket": ticket
      },
      body: JSON.stringify({ message: messageText })
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          handlers.onerror((d && d.error) || ("请求失败（" + res.status + "）"));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { handlers.onend(); return; }
          buf += dec.decode(chunk, { stream: true });
          var frames = buf.split("\n\n");
          buf = frames.pop();
          frames.forEach(function (frame) {
            var line = frame.split("\n").find(function (l) { return l.indexOf("data:") === 0; });
            if (!line) return;
            try { handlers.onevent(JSON.parse(line.slice(5))); } catch (e) { /* 忽略坏帧 */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { handlers.onerror("网络错误：" + e); });
  }

  function addStep(msgs, label) {
    var step = document.createElement("div");
    step.className = "step";
    step.innerHTML = '<span class="st-ico">⚙</span><span class="st-txt"></span><span class="st-spin"></span>';
    step.querySelector(".st-txt").textContent = label;
    msgs.appendChild(step);
    scrollEnd();
    return step;
  }
  function finishStep(step, label, ok, ms) {
    if (!step) return;
    step.querySelector(".st-txt").textContent = label + (ms != null ? "（" + Math.round(ms / 100) / 10 + "s）" : "");
    step.querySelector(".st-spin").textContent = ok ? "✓" : "✗";
    step.classList.add(ok ? "ok" : "bad");
  }
  function addThinking(msgs) {
    var wrap = document.createElement("div");
    wrap.className = "think";
    var head = document.createElement("div");
    head.className = "think-h";
    head.textContent = "💭 思考过程";
    var bodyEl = document.createElement("div");
    bodyEl.className = "think-b hidden";
    head.addEventListener("click", function () { bodyEl.classList.toggle("hidden"); });
    wrap.appendChild(head); wrap.appendChild(bodyEl);
    msgs.appendChild(wrap);
    scrollEnd();
    return bodyEl;
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || state.busy) return;
    if (!ticket) {
      // Explicit guidance beats a bare 401: the integration step is on the
      // business system's backend, not in this page.
      addMsg("err", "未配置会话票据（data-ticket）。请业务系统后端先调用 POST /api/widget/session 换取票据，再写入本页面。");
      return;
    }
    state.busy = true;
    q(".send").disabled = true;
    addMsg("me", text);
    var box = addMsg("ai", "");
    box.classList.add("streaming");
    var m = msgs();
    var aiText = "";          // 当前气泡累计文本
    var thinkEl = null;       // 思考面板
    var tools = {};           // toolCallId → step 元素
    var lastTool = null;
    var ended = false;

    function finish() {
      if (ended) return;
      ended = true;
      box.classList.remove("streaming");
      if (!aiText && !box.textContent) box.textContent = "（空回复）";
      state.busy = false;
      q(".send").disabled = false;
      q(".box").focus();
      scrollEnd();
    }

    streamChat(text, {
      onerror: function (msg) { box.remove(); addMsg("err", msg); finish(); },
      onend: function () { finish(); },
      onevent: function (ev) {
        switch (ev.type) {
          case "delta":
            aiText += ev.text;
            box.textContent = aiText;
            scrollEnd();
            break;
          case "replace":
            aiText = ev.text;
            box.textContent = aiText || "（内容已按安全策略隐藏）";
            scrollEnd();
            break;
          case "tool_start":
            lastTool = addStep(m, "调用工具 " + ev.toolName + " …");
            if (ev.toolCallId) tools[ev.toolCallId] = lastTool;
            scrollEnd();
            break;
          case "tool_end": {
            var step = (ev.toolCallId && tools[ev.toolCallId]) || lastTool;
            finishStep(step, "工具 " + ev.toolName, !ev.isError, ev.durationMs);
            break;
          }
          case "thinking_delta":
            if (!thinkEl) thinkEl = addThinking(m);
            thinkEl.textContent += ev.text;
            scrollEnd();
            break;
          case "error":
            box.remove();
            addMsg("err", ev.message || "处理失败");
            finish();
            break;
          case "done":
            finish();
            break;
        }
      }
    });
  }

  function open() {
    state.open = true;
    panel.classList.remove("hidden");
    if (!state.cfg) {
      api("/api/widget/config").then(function (r) {
        renderCfg(r.ok ? r.data : { title: titleOverride || "AI 助理", suggestions: [], disclaimer: "" });
      }).catch(function () { renderCfg({ title: titleOverride || "AI 助理", suggestions: [], disclaimer: "" }); });
    }
    q(".box").focus();
  }
  function close() { state.open = false; panel.classList.add("hidden"); }
  launcher.addEventListener("click", function () { state.open ? close() : open(); });
  panel.querySelector(".head button").addEventListener("click", close);
  q(".send").addEventListener("click", function () { send(q(".box").value); q(".box").value = ""; });
  q(".box").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(q(".box").value); q(".box").value = ""; }
  });
})();`;
}

/** Full-page variant: same conversation API, standalone layout for iframe/link embedding. */
export function renderWidgetPage(): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AI 助理</title>
<style>
${SHARED_CSS}
body { font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif; background:#f7f8fa;
  display:flex; justify-content:center; }
.wrap { width:100%; max-width:720px; display:flex; flex-direction:column; height:100vh; background:#fff; }
.head { padding:16px 20px; border-bottom:1px solid #eef0f4; font-size:16px; font-weight:600; color:#1f2329; }
.body { flex:1; overflow-y:auto; padding:20px; }
.hero { font-size:24px; font-weight:700; color:#1f2329; margin-bottom:16px; }
.hero em { font-style:normal; color:#4f6ef7; }
.chips { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:20px; }
.chip { padding:10px 14px; background:#fff; border:1px solid #e5e6eb; border-radius:10px;
  font-size:14px; color:#4e5969; cursor:pointer; text-align:left; }
.chip:hover { border-color:#4f6ef7; color:#4f6ef7; }
.msg { max-width:80%; padding:12px 14px; border-radius:12px; font-size:14px; line-height:1.6;
  color:#1f2329; margin-bottom:12px; white-space:pre-wrap; word-break:break-word; }
.msg.ai { background:#f7f8fa; border:1px solid #e5e6eb; }
.msg.me { background:#4f6ef7; color:#fff; margin-left:auto; }
.msg.err { background:#fff7e8; border:1px solid #ffd591; color:#ad6800; }
.foot { border-top:1px solid #eef0f4; padding:14px 20px 8px; }
.box { width:100%; height:72px; resize:none; border:1px solid #e5e6eb; border-radius:10px;
  padding:10px 12px; font-size:14px; outline:none; }
.box:focus { border-color:#4f6ef7; }
.sendrow { display:flex; justify-content:flex-end; padding-top:8px; }
.send { background:#4f6ef7; border:none; color:#fff; border-radius:8px; padding:8px 20px; font-size:14px; }
.send:disabled { background:#c9cdd4; }
.dis { text-align:center; font-size:12px; color:#c9cdd4; padding:6px 0; }
.hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head" id="t">AI 助理</div>
  <div class="body" id="body">
    <div class="hero" id="hero"></div>
    <div class="chips" id="chips"></div>
    <div id="msgs"></div>
  </div>
  <div class="foot">
    <textarea class="box" id="box" placeholder="请将您遇到的问题告诉我，使用 Shift + Enter 换行"></textarea>
    <div class="sendrow"><button class="send" id="send">发送</button></div>
    <div class="dis" id="dis">内容由 AI 生成，仅供参考，请自行判断后使用。</div>
  </div>
</div>
<script>
(function () {
  "use strict";
  // Token via FRAGMENT preferred (#token=): fragments are not sent to the
  // server and stay out of access logs (review P2-5). Query still works for
  // convenience, but the settings page documents the fragment form.
  var hash = new URLSearchParams(location.hash.slice(1));
  var qs = new URLSearchParams(location.search);
  var token = hash.get("token") || qs.get("token") || "";
  var user = hash.get("user") || qs.get("user") || "";
  // Ticket comes from the business backend, same as the loader path.
  var ticket = hash.get("ticket") || qs.get("ticket") || "";
  var busy = false;
  function el(id) { return document.getElementById(id); }
  function scrollEnd() { var b = el("body"); b.scrollTop = b.scrollHeight; }
  function add(cls, text) {
    var d = document.createElement("div");
    d.className = "msg " + cls; d.textContent = text;
    el("msgs").appendChild(d); el("body").scrollTop = el("body").scrollHeight;
    return d;
  }
  function api(path, options) {
    options = options || {};
    var headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
    if (path.indexOf("/api/widget/chat") === 0 && ticket) headers["X-VE-Ticket"] = ticket;
    options.headers = headers;
    return fetch(path, options).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    });
  }
  api("/api/widget/config").then(function (r) {
    var cfg = r.data || {};
    if (cfg.title) el("t").textContent = cfg.title;
    el("hero").innerHTML = "";
    el("hero").appendChild(document.createTextNode("你好，我是 "));
    var em = document.createElement("em"); em.textContent = cfg.title || "AI 助理"; el("hero").appendChild(em);
    (cfg.suggestions || []).forEach(function (s) {
      if (!s) return;
      var b = document.createElement("button"); b.className = "chip"; b.textContent = s;
      b.addEventListener("click", function () { send(s); });
      el("chips").appendChild(b);
    });
    if (cfg.disclaimer) el("dis").textContent = cfg.disclaimer;
  }).catch(function () {});
  // ── 过程展示（v0.2.179）：与浮窗同一套渲染规则 ──
  function streamChat(messageText, handlers) {
    fetch("/api/widget/chat", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-VE-Ticket": ticket
      },
      body: JSON.stringify({ message: messageText })
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          handlers.onerror((d && d.error) || ("请求失败（" + res.status + "）"));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { handlers.onend(); return; }
          buf += dec.decode(chunk, { stream: true });
          var frames = buf.split("\n\n");
          buf = frames.pop();
          frames.forEach(function (frame) {
            var line = frame.split("\n").find(function (l) { return l.indexOf("data:") === 0; });
            if (!line) return;
            try { handlers.onevent(JSON.parse(line.slice(5))); } catch (e) { /* 忽略坏帧 */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { handlers.onerror("网络错误：" + e); });
  }
  function addStep(list, label) {
    var step = document.createElement("div");
    step.className = "step";
    step.innerHTML = '<span class="st-ico">⚙</span><span class="st-txt"></span><span class="st-spin"></span>';
    step.querySelector(".st-txt").textContent = label;
    list.appendChild(step);
    scrollEnd();
    return step;
  }
  function finishStep(step, label, ok, ms) {
    if (!step) return;
    step.querySelector(".st-txt").textContent = label + (ms != null ? "（" + Math.round(ms / 100) / 10 + "s）" : "");
    step.querySelector(".st-spin").textContent = ok ? "✓" : "✗";
    step.classList.add(ok ? "ok" : "bad");
  }
  function addThinking(list) {
    var wrap = document.createElement("div");
    wrap.className = "think";
    var head = document.createElement("div");
    head.className = "think-h";
    head.textContent = "💭 思考过程";
    var bodyEl = document.createElement("div");
    bodyEl.className = "think-b hidden";
    head.addEventListener("click", function () { bodyEl.classList.toggle("hidden"); });
    wrap.appendChild(head); wrap.appendChild(bodyEl);
    list.appendChild(wrap);
    scrollEnd();
    return bodyEl;
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    if (!ticket) {
      addMsg("err", "未配置会话票据（#ticket=）。请业务系统后端先调用 POST /api/widget/session 换取票据。");
      return;
    }
    busy = true; el("send").disabled = true;
    add("me", text);
    var list = el("msgs");
    var box = add("ai", "");
    box.classList.add("streaming");
    var aiText = "";
    var thinkEl = null;
    var tools = {};
    var lastTool = null;
    var ended = false;
    function finish() {
      if (ended) return;
      ended = true;
      box.classList.remove("streaming");
      if (!aiText && !box.textContent) box.textContent = "（空回复）";
      busy = false; el("send").disabled = false; el("box").focus();
      scrollEnd();
    }
    streamChat(text, {
      onerror: function (msg) { box.remove(); add("err", msg); finish(); },
      onend: function () { finish(); },
      onevent: function (ev) {
        switch (ev.type) {
          case "delta":
            aiText += ev.text;
            box.textContent = aiText;
            scrollEnd();
            break;
          case "replace":
            aiText = ev.text;
            box.textContent = aiText || "（内容已按安全策略隐藏）";
            scrollEnd();
            break;
          case "tool_start":
            lastTool = addStep(list, "调用工具 " + ev.toolName + " …");
            if (ev.toolCallId) tools[ev.toolCallId] = lastTool;
            scrollEnd();
            break;
          case "tool_end": {
            var step = (ev.toolCallId && tools[ev.toolCallId]) || lastTool;
            finishStep(step, "工具 " + ev.toolName, !ev.isError, ev.durationMs);
            break;
          }
          case "thinking_delta":
            if (!thinkEl) thinkEl = addThinking(list);
            thinkEl.textContent += ev.text;
            scrollEnd();
            break;
          case "error":
            box.remove(); add("err", ev.message || "处理失败"); finish();
            break;
          case "done":
            finish();
            break;
        }
      }
    });
  }
  el("send").addEventListener("click", function () { send(el("box").value); el("box").value = ""; });
  el("box").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(el("box").value); el("box").value = ""; }
  });
})();
</script>
</body>
</html>`;
}
