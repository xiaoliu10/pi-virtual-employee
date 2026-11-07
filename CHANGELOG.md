# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本。

开源前的内部迭代细节不在此逐一罗列（完整历史见 git log）；以下从开源基线版本开始记录。

## 0.2.202

### English
- **Follow-up routing now happens BEFORE task triage**: a running worker on a conversation owns the dialogue — a bare reply (like an OTP code the worker asked for) is injected into the worker's session instead of falling to the context-less inline chat. Field 2026-11-07: the worker said "send me the code", the user's reply was triaged as a question, and the inline session answered "waiting for which SMS?" — three contexts, zero continuity.

### 中文
- **追问判定提前到任务 triage 之前**：会话上有运行中的 worker 时，对话归它——用户的裸回复（比如 worker 要的验证码）注入 worker 会话，不再落进没有上下文的 inline 聊天。现场 2026-11-07：worker 说「把验证码发给我」，用户回复被判为问句，inline 会话答「你在等哪方面的短信？」——三个上下文零连贯。

## 0.2.201

### English
- **The 🤔 thinking reaction no longer flashes away on dispatched turns**: an empty reply (Router dispatched the message to a worker, silent by design) now parks the reaction on the message; it is recalled only when real output — worker progress or the result — actually lands on the conversation. Inline replies recall it as before.

### 中文
- **派发轮的 🤔 不再一闪而过**：空回复（消息已被 Router 派发给 worker，按设计静默）现在会把表情留在消息上，直到真实的输出——worker 的进度或结果——真正推送到该会话时才撤下。inline 回复照旧在回复落地时撤。

## 0.2.200

### English
- **Router/Worker is infrastructure again**: a dedicated `worker_tasks` linear state machine (queued → running → done | cancelled) replaces dispatch into `work_items`. A worker is one persistent durable conversation whose completion is a code event (the turn settling), not a parsed marker; `[[NEXT_CHECK]]` written there is inert text. Follow-ups continue the same session as conversation, not as state. The transitional oneShot prompt branches and the chat NEXT_CHECK gate are deleted.
- **One browser per profile, many tab owners**: the box playwright shim v5.1 attaches to a live Chromium (own tab, own pages) or launches as host with `--remote-debugging-port=0`; two-strike stale-endpoint sweep. Real-Chromium e2e verified on the box. Immutable discipline: no profile clones, no `connect_over_cdp`, taskkill on a browser is an incident.
- **Progress notes explain themselves**: timer install, first degraded push and every successful push are now logged (`progress pushed #N to <target>`); `taskProgressMin` vs `longTaskProgressMin` confusion documented.

### 中文
- **Router/Worker 回归基础设施**：新增独立 `worker_tasks` 线性状态机（queued → running → done | cancelled），派发不再写入 `work_items`。一个 worker 是一个持久 durable 会话，完成由代码事件（回合结算）判定而非解析标记；在其中写 `[[NEXT_CHECK]]` 只是惰性文本。追问是同一会话的对话延续，不是状态。过渡期的 oneShot prompt 分支与 chat NEXT_CHECK 闸门已删除。
- **一个浏览器多标签页**：盒子 playwright shim v5.1 附着到存活的 Chromium（自己的标签页、自己的页），无端点则作为宿主启动并带 `--remote-debugging-port=0`；残留端点两击清扫。已在盒子做真 Chromium 端到端验证。不可变纪律：不克隆 profile、不自己 `connect_over_cdp`、对浏览器 taskkill 属于事故。
- **进度汇报自证**：定时器安装、首次降级推送、每次成功推送都会留日志（`progress pushed #N to <target>`）；`taskProgressMin` 与 `longTaskProgressMin` 的语义区分已写清。

## v0.2.191 — Upgrade fix, dispatch on by default, concurrent workers

### English

**Upgrading to 0.2.190 broke every existing install's task queue (P0)**: `priority` was added to `CREATE TABLE` but not to the migration block. Because the table is created with `IF NOT EXISTS`, an existing database was never rebuilt — so every profile upgrading to 0.2.190 had no such column, and the first write threw `no such column: priority`. It went unnoticed because every test builds its fixture from `CREATE TABLE` (which always carries the newest columns); only an in-place upgrade exercises the `ALTER` path, and nothing tested it. Fixed, and the migration is now a testable function driven against a frozen pre-0.2.190 table with an assertion that no declared column is lost.

**Chat dispatch is now on by default**: the gray release validated the chain, so dispatch no longer needs a switch. Legacy configs that never stored the key inherit the new default; an explicit `false` still opts out. Only a message whose plan has ≥2 numbered steps, a long-running verb, and an admin sender is handed to the background — questions, single-step commands and non-admin senders stay inline.

**Workers run concurrently (5 per profile)**: this had to land BEFORE dispatch could default on. The window runner was strictly single-window, so routing chat tasks to it would have serialised the entire profile — strictly worse than the per-conversation queue it replaced (two chats could previously run in parallel). Windows are now claimed into a bounded pool of 5, each independently tracked. Three defects in the first implementation were caught by tests: a re-entrancy race that admitted 5 windows despite a cap of 2 (a window that settled instantly deleted itself mid-loop, so the size never grew), a non-idempotent wake timer that stacked two timers for the same instant, and a shutdown path that awaited in-flight sends and deadlocked on any session that ignores abort.

**A non-admin's task is no longer acknowledged and then dropped (P1)**: the dispatch path returned a courtesy warning ("this will continue in the session"), and the caller treats any non-empty result as "dispatched" — so a viewer's task was acknowledged in text and never executed. It now falls through to inline execution. The bug predates this release but was masked by the default-off switch.

### 中文

**升级到 0.2.190 打坏了所有既有安装的任务队列（P0）**：`priority` 加进了 `CREATE TABLE` 却漏了迁移块。建表用的是 `IF NOT EXISTS`，既有数据库根本不会重建——于是每个升级到 0.2.190 的 profile 都没有这一列，第一次写入就抛 `no such column: priority`。测试没抓到是因为所有 fixture 都用 `CREATE TABLE` 建表（永远带最新列），只有「原地升级」才走 `ALTER` 路径，而这条路径没有任何测试。已修复，并把迁移抽成可测函数，用冻结的 0.2.190 之前的表结构驱动，断言升级后不丢任何声明的列。

**聊天任务转后台改为默认开启**：灰度验证了整条链路，不再需要手动开开关。从未保存过该项的旧配置继承新默认；显式设为 `false` 仍然关闭。只有「规划 ≥2 编号步骤 + 含耗时动词 + 管理员发起」的消息才转后台——问答、单步命令、非管理员一律留在前台。

**Worker 支持并发（每 profile 5 个）**：这件事必须在默认开启之前落地。窗口执行器原本是严格单窗口，把聊天任务导过去会让整个 profile 串行——比它替代的「按会话排队」更糟（原来两个会话可以并行）。现在窗口进入上限为 5 的池子，各自独立跟踪。第一版实现里的三个缺陷都被测试抓到：重入竞态（上限设 2 却起了 5 个——瞬间完成的窗口在循环中途把自己删掉，计数永远长不起来）、非幂等的唤醒定时器（同一到期时间叠了两个）、关停路径等待 in-flight send 导致遇到不响应 abort 的会话时死锁。

**非管理员的任务不再「回执后消失」（P1）**：派发路径返回一句客气的警告（「该任务将继续在会话内执行」），而调用方把任何非空返回都当作「已派发」——于是普通成员的任务被文字确认后再也不执行。现在正确落回前台执行。该缺陷在本次之前就存在，只是被「默认关闭」的开关挡住了。

## v0.2.190 — Router/Worker dispatch, script authoring without escaping, heartbeat fix

### English

**Long tasks no longer occupy the chat (Router/Worker P1, gray release)**: the single biggest field complaint — a 09:42 monitor job holding a conversation for 85 minutes while a 10:21 message queued for 30 — is an architecture problem, not a model one. A message the planner judges task-shaped (≥2 numbered steps AND a long-running verb: deploy/scrape/batch/export/reconcile/build…) is now acknowledged and handed to a background work item; the chat stays responsive and progress/results push back to the same conversation. Triage is deliberately conservative: simple questions, single-step commands, question-shaped text, and EVERY failure mode (no plan, LLM down, non-admin sender, dispatch error) stay inline — a triage failure can never swallow a message. `general.chatDispatch` is OFF by default; with it off the behaviour is unchanged. Dispatched tasks also jump the queue (`work_items.priority` = 0 vs 100 for mined work) so "已转后台" cannot mean "queued behind a mining window".

**Authoring a script no longer means fighting three layers of escaping**: VE had no write tool at all, so creating a script meant inline `echo >` / `Set-Content` / `python -c` — JSON argument, shell quoting and the target language's syntax stacked on top of each other, failing repeatedly in exactly the way the user never asked about. New `write_text_file` takes the file body as an ordinary argument (UTF-8, no BOM), verifies by reading back, writes atomically (temp file + rename) so a failed write cannot destroy a working script, and is confined by the same whitelist as list/delete plus a deny-list for the app's own databases and config. The workspace lives in its own root, outside every profile.

**Progress notes actually fire again (P0)**: the IM heartbeat read `agent.state.isStreaming`, which the durable kernel never sets — so every tick returned silently and a 20-minute turn produced zero progress notes despite `longTaskProgressMin=10`. The fix had been written on 2026-11-03 but never merged to main. It now asks the kernel instead.

**Plans are gated and readable**: a plan is pushed to chat only when the work is estimated at ≥30 minutes (a task that finishes in a minute does not need a plan pushed at it), and what IS pushed is a short human outline — goal, flow, ETA — instead of a mechanical numbered checklist. The full steps still go to the executing turn as context.

**Recovery: parked messages are re-driven**: a submission left in `placed` (queued behind a run the restart killed) used to sit until recovery timed out, reporting "执行已暂停" for a message that never ran. Recovery now re-drives it with a durable `continue`.

**MCP: the guard test could not fail**: the test pinning "MCP tools are visible to the durable kernel" read `harness.registry`, which does not exist — so its assertions never executed and the fix shipped behind a permanently green check. Repaired, plus a real stdio end-to-end chain (startup connect, late connect, RBAC execution).

**Update watchdog: profile identity survives a mangled launch**: a main process without `--profile` was recorded as the default profile, so the watchdog relaunched it bare — an instance with no identity, and every later snapshot inherited it. The identity is now recovered from a child's `--user-data-dir` (requiring ≥2 agreeing children, so an orphan cannot confer the wrong profile).

### 中文

**长任务不再占死聊天（Router/Worker P1，灰度）**：最大的现场抱怨——09:42 的监控任务占住会话 85 分钟、10:21 的消息排队 30 分钟——是架构问题不是模型问题。规划判定为任务型（≥2 编号步骤 **且** 含耗时动词：部署/抓取/批量/导出/对账/构建…）的消息现在先进回执、再交给后台工作项执行；前台继续可聊，进度与结果回投同一会话。分诊刻意保守：简单问答、单步命令、提问形状、以及**任何失败**（无规划、模型不可用、非管理员、派发异常）一律留在前台——分诊失败绝不吞消息。`general.chatDispatch` 默认关闭，关时行为不变。转派的任务还会插队（`work_items.priority` = 0，挖掘任务 100），「已转后台」不会变成「排在挖掘窗口后面」。

**写脚本不再和三层转义搏斗**：VE 此前根本没有写文件工具，创建脚本只能用内联 `echo >` / `Set-Content` / `python -c`——JSON 参数、shell 引号、目标语言语法三层叠加，反复以与用户任务无关的方式失败。新增 `write_text_file`：文件内容作为普通参数（UTF-8 无 BOM）、写完读回校验、原子写（临时文件 + rename，失败不毁掉可用的旧脚本），并受与 list/delete 相同的白名单约束，另加应用自身数据库与配置的黑名单。工作区位于 profile 之外的独立根目录。

**进度汇报恢复推送（P0）**：IM 心跳读 `agent.state.isStreaming`，而 durable 内核从不设置该标志——每个 tick 静默早退，20 分钟的回合零进度（`longTaskProgressMin=10` 明明生效）。该修复 2026-11-03 就写好了但从未合入 main。现在改为问内核。

**规划加了时长门控、可读性提升**：只有预计 ≥30 分钟的任务才把规划推到聊天（一分钟就完的任务不需要被推一份规划），且推的是简短人话大纲——目标、流程、预计耗时——而不是机械编号清单。完整步骤仍作为上下文交给执行回合。

**恢复：已排队（placed）的消息会被重新驱动**：排在「被重启杀掉的那次运行」之后的 submission 原来只能干等到超时，并对一条从未执行的消息报「执行已暂停」。现在用 durable `continue` 重新驱动。

**MCP：那条守护测试根本不可能失败**：用来钉住「MCP 工具对 durable 内核可见」的测试读 `harness.registry`——该句柄不存在，断言从未执行，修复在永远绿的勾选下发布。已修复，并补了真实 stdio 端到端链路（启动期连接、迟到连接、RBAC 实际执行）。

**更新 watchdog：参数被剥离时身份不丢**：无 `--profile` 的主进程被记为 default profile，watchdog 于是裸启动它——一个没有身份的实例，且后续每次快照都继承这个空条目。现在从子进程的 `--user-data-dir` 反推身份（要求 ≥2 个一致子进程，防止孤儿子进程撞 PID 导致的错配）。

## v0.2.189 — task planning budget fix, progress push readability, turn-settle process inventory

### English

**Task planning actually delivers (field regression fix)**: the plan-ahead side pass still carried the hard-coded 512-token reserve that the 2026-11-02 ruling abolished for progress briefs — qwen's default-thinking alone blew the cap and EVERY plan was silently skipped (`generation hit the token cap`). The budget now lives in one place, `sidePassMaxTokens()` (max-output resolution, ceil(maxOut/0.8)), shared by the progress brief and the planner; the planner's side-call timeout aligns at 180s. Regression guards: the wiring test asserts each side pass delegates to the helper (a same-line literal or a decoy call turns it red — mutation-proved), and the helper's values are pinned by dedicated tests. An independent code review round (APPROVE, no P0/P1) inventoried all `generateSummary` call sites and numerically probed the clamp across 11 values.

**Progress pushes stop reading like delivery bugs**: scheduled-progress pushes hard-cut the last progress text with `slice(-500)` — mid-sentence, under a full title. The cut now lands on paragraph boundaries (`tailExcerpt`), honestly marked 「……（以下为上次进展的节选）」. The three autonomous-task push templates (progress / done / needs-human) gained basic structure: section separators and labeled metadata (下次跟进 / 跟进原因 / 恢复方式).

**Turn-settle background-process inventory (async by design)**: a monitor script kept running after its task result was already pushed and nothing told the user — silent strays read as delivery bugs. 5s after a turn settles (fire-and-forget; the settle path never waits on process bookkeeping), any still-running background process for that conversation is reported with sessionId/pid/command plus poll/kill guidance. Silent when nothing is running.

### 中文

**任务规划真正送达（字段回归修复）**：规划旁路仍带着 2026-11-02 裁定为进度旁路废除的硬编码 512 token 预留——qwen 默认思考单独就能吃满预算，**每条任务规划都被静默跳过**（`generation hit the token cap`）。预算收敛到一处 `sidePassMaxTokens()`（按模型 max-output 解析，ceil(maxOut/0.8)），进度旁路与规划共用；规划旁路超时对齐 180 秒。回归守卫：wiring 测试断言每个旁路必须委托 helper（同行字面量或 decoy 调用都会转红——变异实测），helper 数值由专项测试钉死。独立 code review 一轮（APPROVE，无 P0/P1）盘点全部 `generateSummary` 调用点并对钳制做 11 值数值探针。

**进度推送不再像投递 bug**：定时任务阶段进展用 `slice(-500)` 硬切上次进展——句子中间开口、顶着完整标题。现在切点落在段落边界（`tailExcerpt`），并如实标注「……（以下为上次进展的节选）」。三条自主任务推送模板（进展/完成/需人工）补基本结构：分节分隔线与字段化元信息（下次跟进 / 跟进原因 / 恢复方式）。

**回合收尾后台进程盘点（异步，用户裁定）**：数币监控的结果已推送，监控脚本仍在后台运行，没有任何消息告知用户——静默的游离进程被当成投递 bug。回合收尾 5 秒后（fire-and-forget；结算路径永不等待进程簿记），如该会话仍有运行中的后台进程，推送一条盘点（sessionId/pid/命令 + poll/kill 指引）；无运行进程则静默。

## v0.2.184 — work gates accept owner, progress notes finally push, per-model thinking levels

### English

**Owner-created autonomous work no longer bounces back to "awaiting human" (P0)**: the WorkService window gate — a separate inline check in `electron/main.ts`, not the `work.ts` gate fixed in v0.2.182 — still compared `resolveRole === "admin"` literally, so an owner-created work item passed creation, then EVERY execution window judged "admin identity missing" and wrote itself back to `waiting_human`. The field loop was: admin resumes → "re-queued" → next window bounced again. Both gates now share one authority, `isDeclaredAdmin()` (explicit declaration + rank ≥ admin), preserving the rule that a permissive `defaultRole` cannot resurrect a removed confirmer — while credential egress keeps the live `isAdmin()` (honours `defaultRole`) after a review catch.

**Autonomous-task progress notes actually push again**: every side-pass summary died with `Summarization failed: generation hit the token cap` — the 512-token reserve (409 after pi-ai's 0.8 factor) is SHARED by thinking and the answer, and default-thinking qwen consumed the whole budget on a 120-char report. The output reserve is now 4096 (still clamped by the model's max tokens), and thinking level is configurable per model.

**Per-model thinking levels (设置 → 模型 → 思考档位)**: each model can declare a pi thinking level (`off/minimal/low/medium/high/xhigh/max`). Capability semantics differ by supplier kind — relay (hand-entered baseUrl) suppliers take the declaration as the capability truth (the borrowed base model describes a different upstream); account-login suppliers keep the registry model's capability and the declaration only sets the requested level. `off` strips to "no level" (the literal form forces thinking ON on Anthropic-API models and can produce `max_tokens: null`); pi-ai's `clampThinkingLevel` degrades unsupported levels automatically; undeclared models behave exactly as before. Verified by payload-level probes (real `streamSimple` + `onPayload`) across four independent review rounds.

### 中文

**owner 创建的自主任务不再反复打回「待人工恢复」（P0）**：WorkService 的窗口开工门禁是 `electron/main.ts` 里另一段内联判断（不是 v0.2.182 修过的 `work.ts` 那处），仍按 `resolveRole === "admin"` 字面比较——owner 创建的任务创建成功，但**每个执行窗口**都被判「管理员身份缺失」写回 `waiting_human`。现场循环：管理员恢复 → 「已重新入队」→ 下个窗口又被打回。两处门禁现收敛到同一权威 `isDeclaredAdmin()`（显式声明 + rank ≥ admin），保留「permissive defaultRole 不能复活已移除确认人」的防护；凭据外发经 review 提醒仍用实时的 `isAdmin()`（尊重 `defaultRole`）。

**自主任务进度汇报恢复推送**：旁路总结全部死于 `generation hit the token cap`——512 token 预留（pi-ai 折算 409）由思考与正文**共享**，默认开思考的 qwen 在一段 120 字汇报上就能吃满预算。输出预留提到 4096（仍受模型 max tokens 钳制），且思考档位可按模型配置。

**每模型思考档位（设置 → 模型 → 思考档位）**：每个模型可声明 pi 思考档位（`off/minimal/low/medium/high/xhigh/max`）。能力语义按供应商类型分叉——中继型（手填 baseUrl）以声明为能力真源（借来的基底模型描述的是另一个上游）；账号登录型保持 registry 模型能力、声明只设请求档位。`off` 剥离为「无档位」（字面 off 在 anthropic API 模型上会强制开启思考、甚至产生 `max_tokens: null`）；不支持的档位由 pi-ai `clampThinkingLevel` 自动降级；未声明的模型行为与之前完全一致。经四轮独立 review 的 payload 级探针（真实 `streamSimple` + `onPayload`）验证。

## v0.2.183 — MCP settings UI, durable streaming for widgets, and a P0 widget CSS fix

### English

**Widget CSS fix (P0, all embedders)**: the loader's shared stylesheet ended `@keyframes ve-blink` one brace short. A CSS parser drops the ENTIRE stylesheet on an unclosed block, so `.launcher { position:absolute }` never applied and the floating button rendered off-viewport — embedders lost their entry point entirely (present since v0.2.179). Fixed, plus a real regression gate: the loader's evaluated stylesheet is parsed with a CSS parser and the launcher's `position:absolute` is asserted; reintroducing the bug turns the test red with "Unclosed block".

**Durable kernel now streams widget process events**: the durable kernel (the default) drives the harness pipeline and never calls `agent.prompt`, so `agent.subscribe` observed nothing and the widget fell back to a single JSON response — every embedder showed "spinner → whole answer at once". The runtime now attaches `watchEvents()` per turn, translates harness events into the same event vocabulary the legacy kernel emits, and delivers them through `SendCtx.onProcessEvent`; the widget feeds its SSE from that sink, so streaming works on BOTH kernels with zero consumer changes (event names, order, and the per-increment credential gate are unchanged). Hardened during review: a credential split across deltas can no longer leak its prefix (risky tail bytes are held back and released at turn end), tool failures report `isError` correctly, and the event watcher cannot leak past the turn.

**MCP settings UI**: the console gains an "MCP servers" section (enable toggle, server list with stdio/HTTP transport, per-server enable, args/env/headers editors, delete/add, and a per-server "test connection" that lists the tools it finds). Connection lifecycle is fixed alongside: dropped/replaced/disabled servers now close their stdio children (previously one leaked process per refresh), a failed tool discovery closes its transport, disposal coordinates with in-flight refreshes, and app quit waits (bounded) for teardown. Saving MCP config takes effect immediately (reconnect without restart), `${ENV}` references stay literal in storage and resolve only at connect time, and saving refuses rows that would be silently dropped.

### 中文

**小组件 CSS 修复（P0，影响所有接入方）**：loader 共享样式表的 `@keyframes ve-blink` 少一个闭合花括号。CSS 解析器遇到未闭合块会丢弃**整份样式表**，`.launcher { position:absolute }` 随之失效，浮钮渲染到视口外——接入方完全看不到入口（该缺陷自 v0.2.179 起）。已修复，并补上真正的防回归门禁：对 loader 实际求值的样式表用 CSS 解析器校验、断言 `.launcher` 的 `position:absolute`；把 bug 改回去测试立即以「Unclosed block」转红。

**durable 内核支持小组件过程事件**：durable（默认内核）驱动 harness 流水线、从不调用 `agent.prompt`，`agent.subscribe` 观测不到事件，widget 因此回落为一次性 JSON——所有接入方都是「转圈 → 整段出现」。现在 runtime 每回合挂 `watchEvents()`，把 harness 事件翻译成与 legacy 内核相同的词汇表，经 `SendCtx.onProcessEvent` 交付；widget 从这个 sink 喂 SSE——**两个内核都有流式，消费方零改动**（事件名、顺序、逐增量凭据门禁全部不变）。review 中加固：跨增量拼凑的凭据不再泄露前缀（风险尾部扣住、回合结束放行）、工具失败正确上报 `isError`、事件监听不会泄漏到回合之外。

**MCP 设置页**：控制台新增「MCP 服务器」分区（启用开关、服务器列表、stdio/HTTP 传输、单条启用、参数/环境变量/请求头编辑、删除/添加、逐台「测试连接」并列出发现的工具）。连接生命周期同步修复：被替换/禁用/移除的服务器现在会关闭其 stdio 子进程（此前每次刷新泄漏一个进程）、发现失败也会关闭传输、dispose 与在途刷新协调、应用退出等待（有上限的）清理。保存 MCP 配置立即生效（免重启重连）、`${ENV}` 引用在存储中保持字面量、连接时才解析、保存会拒绝会被静默丢弃的无效行。

## v0.2.182 — owner is a strict superset of admin / owner 是 admin 的严格超集

### English

Field bug: the deployment owner was asked to type the confirmation keyword before `run_command` would fire. The confirmation exemption compared `role !== "admin"` literally, so granting owner silently REMOVED admin powers. Fixed six gates to rank comparison (`ROLE_RANK`), per the design rule that every admin-gated action must accept owner: shell confirmation + allowlist, one-shot authorization, profile memory, scheduler resume, and the scheduler scope description. Low-privilege boundaries (operator/viewer refusals and downgrades) are preserved and pinned by tests.

### 中文

现场 bug：部署 owner 发起 `run_command` 被要求输入「确认」。确认豁免写的是 `role !== "admin"` 字面量比较，owner（rank 3）被当成非 admin。按设计规则「owner 是 admin 的严格超集，任何 admin-gated 动作必须接受 owner」修复六处门禁（统一改 rank 比较）：shell 确认 + 白名单、一次性授权、profile 记忆、定时任务续跑、任务身份描述文案。低权限边界（operator/viewer 的拒绝与降级）保持不变并有测试钉住。

## v0.2.181 — Copy embed snippet from the settings page / 设置页一键复制接入代码

### English

The settings page's "running" status line now has a **copy embed snippet** button: it builds the complete `<script src="http://<host>:<port>/widget.js" data-token=... >` tag from the listener's ACTUAL state — the real bound port (after automatic reassignment), the machine's LAN IPv4 when exposing to the network, and the saved token with HTML attribute escaping. Paste it into the business system and go.

### 中文

设置页「服务运行中」状态行新增**复制接入代码**按钮：按监听器的**实际状态**生成完整 `<script>` 标签——实际绑定端口（自动改派后也是准的）、暴露到网络时自动取本机局域网 IPv4、已保存的令牌（做 HTML 属性转义）。粘贴进业务系统即可接入。

## v0.2.180 — Configurable launcher icon / 浮钮图标可配置

### English

The widget's entry point is no longer locked to a text bubble: a business system can choose a built-in robot or spark mark, or its own image, and set the size.

- `launcherIcon`: `text` (default) | `robot` | `spark` | `url`
- `launcherIconUrl`: used when the icon is `url`
- `launcherSize`: 52 by default, clamped to 44–72

Built-in marks are inline SVG, so embedding the widget never requires a CSP allowance for an image host. Custom images must be `http(s)` (other schemes fall back to the text mark), are loaded with `no-referrer`, and degrade to the legacy "AI" bubble if they fail to load.

The default stays `text`, so existing embeds look exactly as before.

### 中文

小组件的入口不再固定为文字气泡：业务系统可以选择内置的机器人或星火图标，也可以用自己的图片，并调整尺寸。

- `launcherIcon`：`text`（默认）| `robot` | `spark` | `url`
- `launcherIconUrl`：图标为 `url` 时使用
- `launcherSize`：默认 52，限制在 44–72

内置图标是内联 SVG，嵌入方无需为图片域名配置 CSP 白名单。自定义图片仅接受 `http(s)`（其它协议回退为文字图标），以 `no-referrer` 加载，加载失败时回退为原有「AI」文字气泡，不会留下空白圆。

默认值保持 `text`，现有接入方的界面完全不变。

## v0.2.179 — Live process display in the embedded assistant / 嵌入助理的过程实时展示

### English

The widget now behaves like a real conversation: thinking, tool calls and streaming text appear as they happen instead of leaving the user staring at a silent bubble during a multi-minute turn.

- **Server-Sent Events**: `POST /api/widget/chat` with `Accept: text/event-stream` streams `meta → thinking_delta → tool_start → tool_end (with duration) → delta → done`.
- **Streaming stays behind the credential gate**: the widget serves a business system's users, so every increment is passed through the same outbound credential gate as an IM push. Text is accumulated and only gated increments are sent; the moment a credential completes across deltas, the client gets a `replace` and the bubble resets — no delta can ever carry a secret.
- **Client rendering** (bubble and full page share one set of rules): streaming text with a cursor, a collapsed "thinking process" panel, and tool-call rows with a spinner that resolve to ✓/✗ plus elapsed time.
- **Honest fallback**: the durable kernel (the default since v0.2.167) does not drive agent subscriptions, so it serves plain JSON instead of an empty stream; a "thinking…" placeholder keeps that path readable.

### 中文

小组件现在就是真正的实时对话：思考、工具调用、流式文本随发生随显示，不再让用户在一次几分钟的回合里对着无反应的气泡干等。

- **SSE 流式**：`POST /api/widget/chat` 带 `Accept: text/event-stream` 时按 `meta → thinking_delta → tool_start → tool_end（含耗时）→ delta → done` 推送。
- **流式同样走凭据门禁**：小组件面向业务系统用户，每个增量都过与 IM 群推送相同的出站门禁。服务端累积全文、只发送门禁后的安全增量；凭据跨增量拼齐的那一刻客户端收到 `replace` 重置气泡——任何一条增量都不可能带走凭据。
- **客户端渲染**（浮窗与整页同一套规则）：流式文本带光标、「思考过程」折叠面板、工具调用行（转圈 → ✓/✗ + 耗时）。
- **诚实回退**：durable 内核（v0.2.167 起默认）不驱动 agent 订阅，因此回退为普通 JSON 而不是空流；「正在思考…」占位保证该路径依然可读。

## v0.2.178 — Widget ticket auth & business-side role passthrough / 小组件票据鉴权与业务方权限透传

### English

The embedded assistant now honours the BUSINESS system's own account model: a user who is an admin over there can act as an admin here, and the port is closed to anyone without credentials.

- **Session tickets replace trust-the-browser role claims.** The business system's backend calls `POST /api/widget/session` (Bearer widget token + `X-VE-Secret` header) with `{user, role}` and receives a short-lived ticket (TTL 5 min). The browser only ever holds the ticket — the secret never reaches a page.
- **Tickets are bound to their declared consumer**: the exchange declares the `origin` (and optionally `clientIp`) of the browser that will use the ticket. A ticket replayed from another machine or origin is refused with a specific reason.
- **Roles ascend to admin, never owner**: a ticketed admin passes the same gates as a local admin (shell, settings, task management, confirmations); `owner` remains deployment-owner-only. A widget actor with no verified role is a viewer — `security.defaultRole` does not apply.
- **Reverse-proxy aware**: configure trusted proxy addresses; only their `X-Forwarded-For` is honoured, and only when the chain's last hop names the trusted proxy itself (fail-closed against forged chains).
- **CORS preflight allows `X-VE-Ticket`**, so the cross-origin embed works in real browsers.

### 中文

小组件现在尊重业务系统自己的账号体系：在那边是管理员的用户，在这里也能以管理员身份行事；而没有凭据的任何人都进不了这个端口。

- **会话票据取代「浏览器说了算」的角色声明**。业务系统后端调用 `POST /api/widget/session`（携带 Bearer 访问令牌 + `X-VE-Secret` 头）提交 `{user, role}`，换取一张短期票据（5 分钟有效）。浏览器只持有票据——接入密钥永远不会出现在页面里。
- **票据绑定「声明的使用方」**：换票时声明使用方浏览器的 `origin`（可选 `clientIp`）；票据被转到别的机器或别的来源会以明确原因拒绝。
- **角色上限 admin，永远到不了 owner**：持票据的 admin 与本地管理员走完全相同的门禁（命令、设置、任务管理、确认授权）；`owner` 仍是部署者专属。无票据的 widget 会话是 viewer——不受「默认角色」影响。
- **支持反向代理**：配置信任的代理地址后才会采用 `X-Forwarded-For`，且要求链的最后一跳就是该可信代理（对伪造链 fail-closed）。
- **CORS 预检放行 `X-VE-Ticket`**，跨域嵌入在真实浏览器中可用。

## v0.2.177 — Widget port allocation across profiles / 多 profile 小组件端口自动分配

### English

Running several profiles on one machine (`--profile Nova`, `--profile Orion`, …) used to break the widget: every profile defaulted to port 17880, so the second listener died on `EADDRINUSE` while the settings page still showed "enabled".

- **Automatic port allocation**: at startup the widget probes the configured port, and if it is busy walks forward from 17880 to the first free one, then **persists it into that profile's config** — the address stays stable across restarts, which matters because business systems embed a literal URL.
- **Manual "自动分配" button** in Settings → 助理小组件 to re-pick deterministically without a restart.
- **Failures are visible now**: the settings page shows "服务运行中 :17881" or the actual reason ("端口 17880 已被占用（可能是同机另一个 profile 的实例）") instead of one line in `main.log`.
- **Cross-mode conflict detection**: probing only the widget's own bind host is wrong — measured on macOS, a `0.0.0.0` holder does NOT block a later `127.0.0.1` bind (SO_REUSEADDR), so a loopback profile could claim a port a lan profile already owned. Ports are now treated as taken when **any** interface holds them.

### 中文

同机跑多个 profile（`--profile Nova`、`--profile Orion` 等）时小组件会坏：每个 profile 都默认 17880，第二个监听直接 `EADDRINUSE` 死掉，而设置页还显示「已启用」。

- **自动分配端口**：启动时探测配置端口，被占用就从 17880 往后找第一个空闲端口，并**写回该 profile 的配置**——重启后地址不变，因为业务系统嵌入的是写死的 URL。
- 设置页新增**「自动分配」按钮**，不用重启就能确定性地重选。
- **失败可见**：设置页直接显示「服务运行中 :17881」或真实原因（「端口 17880 已被占用（可能是同机另一个 profile 的实例）」），不再只是 `main.log` 里一行 WARN。
- **跨暴露模式冲突检测**：只探自己的绑定地址是错的——macOS 实测，`0.0.0.0` 已占用并不阻止之后 `127.0.0.1` 绑定（SO_REUSEADDR），loopback profile 会抢走 lan profile 已占的端口。现在只要求**任一接口**占用即判定为不可用。

## v0.2.176 — Embeddable assistant widget for business systems / 可嵌入业务系统的 AI 助理小组件

### English

A business system can now embed the virtual employee as an AI assistant panel — a floating bubble (Shadow DOM, no style leakage) or a full-page chat — served over a small HTTP surface on the VE host.

- **New widget server** (`GET /widget.js`, `GET /widget`, `GET /api/widget/config`, `POST /api/widget/chat`). Style follows the Alibaba Cloud console assistant: bubble → panel with title, greeting, suggestion chips, message list, Shift+Enter input, AI disclaimer.
- **Bearer token = access token**, not an admin credential. End users are addressed as `widget-user-<key>` and are **clamped to the viewer role** — `security.defaultRole` cannot lift them.
- **Widget conversations are a remote, untrusted channel** (`widget:` origin). They are not the local console: no profile-scope memory writes, no actorless admin path.
- **Same outbound credential gate as IM group pushes**: replies carrying credentials are withheld.
- **Abuse limits**: 256KB body cap, 4000-char message cap, 30 req/min per token+client, one in-flight turn per conversation.
- Configurable from Settings → 助理小组件 (port 17880, loopback/LAN exposure, token, title, suggestions, disclaimer, allowed origins).

### 中文

业务系统现在可以把虚拟员工嵌成 AI 助理面板——右下角浮窗（Shadow DOM，样式不互相污染）或整页对话，由 VE 主机上一个小型 HTTP 服务提供。

- **新增小组件服务**（`GET /widget.js`、`GET /widget`、`GET /api/widget/config`、`POST /api/widget/chat`）。样式对齐阿里云控制台 AI 助理：气泡 → 面板（标题、欢迎语、建议 chips、消息列表、Shift+Enter 输入、AI 声明）。
- **Bearer 令牌是访问令牌**，不是管理员凭据。终端用户身份为 `widget-user-<key>`，角色**强制封顶 viewer**——`security.defaultRole` 无法提权。
- **widget 会话是远端不可信通道**（`widget:` 来源），不等同本机控制台：不能写 profile 作用域记忆，也没有无 actor 的 admin 兜底路径。
- **与 IM 群推送同一道出站凭据门禁**：带凭据的回复会被拦下。
- **滥用防护**：body 上限 256KB、消息上限 4000 字、每 token+客户端 30 次/分钟、同一会话同时仅一个在途回合。
- 设置页「助理小组件」可配：端口 17880、暴露范围（本机/局域网）、令牌、标题、建议问题、免责声明、允许的来源域名。

## [0.2.91] — 2026-09-21

### 开源基线

首个开源发布版本。桌面形态的虚拟员工（Virtual Employee）应用：以 pi agent SDK 为对话内核、Electron 承载，接入钉钉/飞书等 IM 渠道，让一个真正动手干活的 AI 员工为团队服务。

### 核心能力

- **对话引擎**：多轮对话、自动上下文压缩（/compact 与阈值触发双通路）、长任务进度心跳、停滞看门狗（in-flight 模型调用视为存活）
- **IM 集成**：钉钉单聊/群聊（AI 卡片流式回复、表情回应、文件收发、@提及解析）、飞书、企微适配器
- **工具体系**：知识库（含向量检索与记忆层）、联网调研、浏览器自动化、本地文件、文档库、报告发布、受控命令执行、Computer Use 桌面操控
- **定时任务**：cron 调度、无人值守执行、结果自动推送回创建会话、跟随创建人权限
- **权限模型**：平台验证身份的三级角色（viewer/operator/admin）+ 会话能力门槛 + 危险操作「确认」门
- **自我运维**：应用自动更新（独立 watchdog 安装器 + 熔断）、运行遥测、失败聚类、改进提案回路、提示词自评测（prompt_lab）
- **不可变内核**：安全红线、数据真实性红线、权限判定、更新熔断等关键区域哈希钉死，变更必须显式确认

### 暂未开源的历史能力

内置提示词中沉淀的特定部署环境运维经验（登录态实测、堡垒机 canvas 操作等）已从开源版本中移除，核心红线（不泄露凭据、不编造数据）完整保留。
