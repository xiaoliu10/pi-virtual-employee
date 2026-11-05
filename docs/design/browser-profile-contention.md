# 浏览器 Profile 争抢（多 bot 并发）调研与设计

> 真实意图：VE 的多个并发执行（工作项窗口 / 定时触发 / DM 回合）都要带登录态的 Chromium（playwright persistent context，如 `spay_profile`）。并发时 Chromium 单例互斥 → 第二个拿到 exitCode=21/TargetClosedError → 模型误诊为「内核故障」→ `taskkill /IM chrome.exe` 全杀 → 登录态丢失 → 连锁失败。2026-11-05 现场已在 144 盒子上做了三层热补（杀进程拦截 / PROFILE_BUSY 快速失败 / 触发口关闭），本调研要回答：**成熟 bot 框架/RPA 平台怎么解决多任务并发下的浏览器 profile 问题**，并给出产品级设计。
> 日期：2026-11-05 · 状态：草案
> 好答案标准：每个外部方案落到 VE 的具体文件/函数；给出 144 上 exitCode=21 的确切解释；≥2 个候选方向含取舍。

## 1. 现状与接入点

### 1.1 数据流（改动前，争抢发生处）

```
durable conv (work/sched/dm)
  → model → run_command/run_script 工具
    → cmd.exe → python 脚本（盒子上，模型现场写的）
      → playwright sync_api → launch_persistent_context(spay_profile)
        → Chromium 进程（user-data-dir=spay_profile，单例互斥在这里爆发）
```

关键事实：**业务脚本完全绕过 VE 进程**，直接在盒子 shell 里拉起 python+playwright。VE 内核无法在工具层拦截浏览器启动（只能事后从报错/审计得知）。

### 1.2 项目内已有的同类实现（最有价值的参考）

| 资产 | 位置 | 状态 | 说明 |
|---|---|---|---|
| **profile 复制隔离** | `src/browser/profile-isolation.ts` | **已建未接线（无调用方）** | FIELD 2026-11-04：母本只读 + 每次启动复制干净副本（剔除 `Singleton*` 锁文件与 Cache 类目录）+ context 关闭即删副本 + 崩溃残留清扫。注释原文即本问题的现场记录（"two work windows against the same persistent Chromium profile … exitCode=21 — the known persistent lock issue"） |
| 应用单实例锁 | `electron/profile-lock-core.ts` | 已接线（VE 自身） | `.profile.lock` + WMI 存活探测 + 陈旧锁回收；解决的是 VE 自身 profile，不是业务脚本浏览器 |
| VE 托管浏览器 | `src/browser/browser-service.ts` | 已接线（browser 工具） | 持久 context，`:640` 关闭时 flush cookies——但**未用** profile-isolation 复制，同 profile 并发同样会撞 |
| 144 盒子热补（临时） | `python-win/Lib/site-packages/ve_pw_profile_lock.py` + `.pth` | 已生效 | launch_persistent_context 包装：endpoint 存活→CDP attach（attach-only，v3.1）；否则裸启动 + 单例冲突快速失败 `PROFILE_BUSY`（明确报错，禁止循环重试/杀进程） |
| 144 盒子热补（临时） | `Nova/shim/taskkill.cmd` + `start_nova.bat` + HKCU Run | 已生效 | 按镜像名杀浏览器（`/IM chrome.exe` 等）直接拒绝并留审计；按 PID 放行 |

### 1.3 要动的文件（产品级修复的接触面）

- `src/scheduler/work-service.ts` — 工作窗口认领/执行（`:158` waiting_human 语义、`:172` claim 条件）
- `src/engine/tools/run-script.ts` / `shell.ts` — 盒子脚本执行入口（能拿到 cwd/命令，可在工具层做 profile 声明）
- `src/browser/profile-isolation.ts` — 复制隔离（已实现，待接线）
- `src/engine/prompt.ts` / skills（`windows-script-automation` 等） — 给模型的浏览器使用约定

### 1.4 已知约束与坑（本项目实测，全部有现场证据）

1. **Chromium 每 user-data-dir 只允许一个进程**：第二实例秒退 `exitCode=21`（`profile-isolation.ts:9` 注释称 "the known persistent lock issue"；2026-11-05 盒子矩阵实验复现：TEMP profile + 调试端口启动 OK，SPAY+PORT 撞锁失败）。**exitCode=21 ≠ 调试端口被禁**——矩阵实验 TEMP+PORT 成功启动证明 `--remote-debugging-port` 本身可用，此前 daemon 全失败是残留 chrome 持锁（推断，依据：失败时间线与孤儿 chrome 存活时间重合；已在清场后由 TEMP+PORT 反证）。
2. **Windows 锁文件名为 `lockfile`（profile 根），且是 OS 强制文件锁**：`CreateFile(CREATE_ALWAYS|FILE_FLAG_DELETE_ON_CLOSE)` + `ERROR_SHARING_VIOLATION` 裁决，5s×100ms 轮询（process_singleton_win.cc L48,246,231）。**崩溃残留的 lockfile 不阻塞后续启动**（CREATE_ALWAYS 覆盖式拿锁）——所以「删 lockfile」既不必要也不充分，进程已死时它自动失效。副本剔除清单仍应含它 + `Singleton*`。
3. **headless 实例之间的单例互斥不生效**（盒子实测：两个 headless 同 profile 并存 60s+）；headed 之间互斥可靠。任何并发方案不能依赖 headless 单例兜底。
4. **模型不可信任会遵守约定**：prompt 级规则（"不要 taskkill /IM"）今天被无视 40+ 次；约束必须机械（shim/库补丁/调度层），prompt 只做引导。
5. **单实例锁导致"重启验证"假阳性**：对 VE 执行 schtasks 启动时，旧实例还在则新启动静默退出，看起来"重启成功"实际没换进程（2026-11-05 17:34 事故）。

## 2. 外部调研

（进行中：browser pool 与 CDP 多路复用 / RPA 平台实践 / Chromium 内核语义与坑）

### 2.1 agent 框架同类实现（browser-use / Skyvern / OpenAdapt / LaVague，源码级，gh api 直读，2026-11-05）

**四个项目实际是「三个可组合的层次 + 一个反面教材」：**

| 维度 | browser-use (120k★) | Skyvern (23k★) | OpenAdapt (1.8k★) | LaVague (6.4k★, 停更) |
|---|---|---|---|---|
| profile 策略 | 复制到 /tmp 副本（**无回收，泄漏**） | 对象存储权威副本 → 每运行临时副本 → 显式丢弃 | **无 profile**（ephemeral context） | 原样透传（反面教材） |
| 并发互斥 | 每实例唯一目录 | **DB 条件 UPDATE CAS（跨进程）** | 上下文天然隔离 | 无 |
| 锁文件处理 | `Singleton*`+`*.lock`+`*-journal`+`LOCK/LOCKFILE` 黑名单 + Windows `winerror==32` 特判（`profile.py:36,102`） | 同类白名单（`local.py:47`）+ **非白名单复制失败必抛** | N/A | 无 |
| 损坏降级 | 报错让用户关 Chrome | **识别损坏→丢副本→换新→重试→显式标记**（`browser_factory.py:1123,1275`） | N/A | 无 |

**逐条证据（原文摘录保存在调研材料，此处只列决策相关）：**

1. browser-use 用**裸 subprocess + 动态调试端口 + CDP attach**，不用 `launch_persistent_context`（`local_browser_watchdog.py:146`；`:118` 断言 user-data-dir 必须非默认路径才能 CDP attach）。**证明 CDP 路线是主流做法**——我们昨晚的 owner-daemon 方向正确，但 `_find_free_port` 的 bind→close→再 bind 是 TOCTOU 竞态，不能抄实现。
2. 【反面·必记】browser-use **#5422**：临时副本泄漏 **7741 目录 / 14GB**——根因是清理器的前缀过滤（`'browseruse-tmp-'`）与创建前缀（`'browser-use-user-data-dir-'`）不一致，**该 bug 在当前 main 仍成立**。教训：副本必须有 owner + 回收器，且两个前缀必须同源常量。
3. 【反面·必记】browser-use **#4548**：固定共享 `user_data_dir` 作多实例默认值 → 15+ 会话 36 进程抢锁，**只有第一个能用**；修复 PR #4555 至今未合并（`merged: false` 实查）。
4. Skyvern 并发互斥是 **DB 条件 UPDATE + RETURNING 的 CAS 占用**（`repositories/browser_sessions.py:1608`）：`runnable_id IS NULL 或已是自己` 才允许占用，零行变更即 `AlreadyOccupied`。**跨进程有效**——正是我们「单飞队列」需要的原语（SQLite 可直接实现），且与 2026-09-22 调度器 ticking 进程内锁事故（内存锁跨进程无效）形成对照。
5. Skyvern 有**profile 损坏识别与降级**：`corruption_indicators = ["target closed", "browser has been closed", "failed to launch", "unable to open database", ...]` → 丢弃副本、换新目录重试一次、`mark_seed_load_failed()` 显式标记（不静默）。任何持久 profile 方案必须有这个分支。
6. **OpenAdapt 全程不用持久 profile**（grep `user_data_dir` 0 命中），共享一个 browser + 每会话 `new_context`；issue 区 **0 个 profile bug**。「零缺陷是因为没做这件事」。browser-use 源码注释（`profile.py:790`）同样推荐：多浏览器并行时 `user_data_dir=None` + 只用 `storage_state`，或每浏览器独立 user_data_dir。
7. browser-use 并发多 agent 同浏览器是官方标注 **experimental**（焦点全局唯一 + asyncio.Lock 管焦点竞争，`session_manager.py:55`）——不适合 VE 场景，不抄。

**对本项目的适配判断（汇总）：**
- 首选问句：**VE 的盒子脚本是否真的需要 persistent profile？** 政务网站登录态含 SMS 验证，频繁重登录代价高 → 完全无 profile 不现实；但 `storage_state`（cookies+localStorage）注入是中间态，值得验证政务站会话是否只依赖 cookies（待办，见 §5 盲区）。
- 必须持久 profile 时，抄 **Skyvern 三段式**（权威副本→每任务临时副本→finally 丢弃），**不抄 browser-use 两段式**（泄漏实证）。
- 跨进程互斥抄 **DB 条件 UPDATE CAS**；锁文件剔除清单必须含 Windows 的 **`lockfile`**（我们实测）+ `Singleton*/LOCK` 两家的并集。
- 三处明确不抄：`_find_free_port` TOCTOU、`_subprocess` 在 await 后赋值（取消留孤儿）、固定共享 user_data_dir 多实例默认值。

### 2.3 企业 RPA 平台实践（UiPath / Robot Framework+Pabot / Automation Anywhere / Power Automate / Selenium Grid，官方文档直取 + 源码，2026-11-05）

**核心发现：五大平台无一支持「多个并发任务共享同一个已登录浏览器会话」，且多条为显式否定：**

| 平台 | 并发单位 | 共享已登录会话？ | 关键原文 |
|---|---|---|---|
| UiPath | (账号, Windows 会话) | ❌ | "One account can run one foreground process at a time." / "There can only be one active console session at a time."（社区实证报错栈：`PreventConcurrentForegroundJobs`，5 账号 5 runtime 仍失败） |
| RF Browser | 进程/测试 | ❌（维护者关门） | 提案"login once then run numerous tests in parallel in that same context"→维护者："because what you want, is not possible I am closing this issue."（issue #1722） |
| Automation Anywhere | 设备 | ❌ | "The system supports running only one automation for each device at a given time … the second automation is queued according to its type"（不抢占） |
| Power Automate | 机器会话（串行复用） | ❌ | "creates a new session for each unattended run … signs it off"；session reuse = 跑完锁屏、按机器串行复用 |
| Selenium Grid | slot/session | ❌（架构无此概念） | "New Session Queue → Distributor → Node slots"；每 session 独立临时 profile |

**工业界标准解法 = 三件套（照抄结构）：**
1. **队列 + 槽位闸门**：AA「第二个自动化按类型排队」、PAD「放进 run queue（上限 12h）」、Grid「New Session Queue → Distributor 分配 slot」。
2. **命名锁/资源租借**：pabot 官方 API `Acquire Lock` / `Acquire Value Set`（"No other process can reserve the same set of values while the set is reserved"）——稀缺资源显式互斥，等待而非失败。
3. **凭据与会话分离**：凭据资产每次注入（UiPath Credential Assets = 用户名密码，非活会话）；已登录会话禁止跨任务共享，只允许串行复用（PAD session reuse：跑完不销毁、锁屏保状态、下一个任务复用——**这是「登录态宝贵」场景的唯一官方先例**）。

**Playwright 官方立场**（playwright.dev/docs/auth）：「共享登录态」= **storageState 文件复用（一次登录 → N 次注入）**，明确限定「测试间不互相修改服务端状态」才适用；browser contexts "completely isolated, even when running in a single browser"。源码佐证：`browserType.ts:171` 每次 mkdtemp 全新临时 profile、`chromium.ts:368` 禁止 launch 传 `--user-data-dir` 参数——持久目录并发本就不是 Playwright 设计内场景。

**对本项目的适配判断：**
- 把「共享 user-data-dir 的 headed Chromium」建模为 **AA 语义的 device：一时刻一任务，其余进 durable 队列（排队而非失败，带超时上限）**——与已有 durable 台账天然吻合。
- 登录态走 **PAD session-reuse 语义**：保留单一 persistent profile 保活，任务结束只释放锁、不销毁浏览器。
- 唯一值得开的并行例外：**只读任务走 storageState 注入独立 context**；改服务端状态的操作（提交/申报/重新对账）必须串行。
- 不抄：UiPath 多账号多会话堆并发、Grid 每 session 新 profile（必然重登）。
- 必须补的错误语义：占用时显式排队 + 可诊断原因 + 排队超时上限。

**补：官方大厂 agent 产品的公开形态（Wayback/官方文档原文）：**
- OpenAI Operator FAQ："Can Operator handle multiple tasks at once?" → "Yes … for security reasons, Operator places **dynamic limits on the number of simultaneous tasks and open conversations**"——并行任务各自独立虚拟浏览器 + 动态并发上限，无共享登录会话产品面。
- Claude computer-use 官方文档：reference implementation **runs in a Docker container**；风险缓解第一条 "Using a dedicated virtual machine or container"；并明确建议 "Avoiding giving the model access to sensitive data, such as account login information"；batch action 顺序执行不并发。
→ 两家头部产品同样收敛：**每任务独立环境 + 并发上限**，不共享 live 登录会话。对 VE：单机版不必上容器，但「动态并发上限 + 结构化拒绝」应进调度器语义。

### 2.2 Browser pool / CDP 多路复用 / Chromium 上游语义（源码级，2026-11-05）

**exitCode=21 的确切语义（Chromium 源码 enums.xml + chrome_result_codes.h + chrome_main_delegate.cc）：**
- `21 = chrome::RESULT_CODE_PROFILE_IN_USE`（PROFILE_IN_USE 与 LOCK_ERROR 两个分支都映射到它）；`24 = NORMAL_EXIT_PROCESS_NOTIFIED`（正常把命令行转交已有实例后的退出码）。
- **修正我们此前的解读**：daemon 启动拿 21 = 没拿到 profile 所有权（当时确有 chrome 持锁），而非调试端口问题；但也不能由 21 断言「另一实例活着」——权限问题、锁文件创建失败同样走 21。处置：遇 21 先查既有 Chromium PID/命令行/profile 路径与锁创建错误，不得删锁兜底或盲目再次 launch。
- Windows 单例完整链（process_singleton_win.cc + chrome_process_finder.cc）：命名 mutex `Local\ChromeProcessSingletonStartup!` → 用 user-data-dir 作标题找已有实例消息窗口 → mutex 内复查 → **排他创建 profile 下 `lockfile`** → 才创建消息窗口；第二实例经 `WM_COPYDATA` 发 `START` 协议转交命令行。锁 = mutex + 文件锁 + 消息窗口三者协作，不是单 mutex 判终身。

**CDP 共享（owner daemon）方向的官方态度：**
- pipe 与 port **可同时启动**（remote_debugging_server.cc 两个独立 if 分支）——不存在「互斥拒启」的源码路径。但 pipe 的 `OnDisconnect` 绑定 `CloseBrowserSoon`：**owner 的 pipe 断开会关闭整个浏览器 → owner 生命周期必须等于浏览器生命周期**。
- Playwright 维护者在 #11442 亲自给出 `launchPersistentContext + --remote-debugging-port + connectOverCDP` 模式（提问者回复 "that totally works"）——方向有官方背书，但 CDP attach 官方标注 "significantly lower fidelity"。
- 【反面】Playwright #42961：两个 CDP 客户端「互相导航并关掉对方的 tab」，维护者："we are not sure this scenario is worth supporting" → **共享 CDP 必须自建 page 所有权注册表**（Skyvern `VirtualTargetRegistry` 是参考实现），禁止"当前 tab/第 0 个 page"式全局选择；headed 焦点/剪贴板/全局输入需单独串行化。
- Chrome 136 默认目录限制（官方公告）：只有**默认** user-data-dir 被拒；显式非默认目录即合规（且该检查仅 Google Chrome branding 执行，Chromium 不执行）→ `spay_profile` 非默认，**不受此限制**，无需放弃 owner/CDP 架构。
- 企业策略 `RemoteDebuggingAllowed=Disabled`：只不建调试服务（stderr 输出 "DevTools remote debugging is disallowed by the system admin."），**Chrome 照常启动**——与 21 无关，preflight 需区分「Chrome 活着但 CDP 不可用」和「进程退出」。

**Browserless（browserless/browserless）——集中管理的可抄机制：**
- limiter：有界并发 + 有界等待队列 + 超时 + 过载拒绝（含 "concurrent sessions and … queued requests" 错误语义）。
- Persisting State 官方限制：**"Only one client can connect to a session at a time"**，第二连接 429，"There is no built-in queuing for concurrent session access"——**连商业产品都不做同一活会话多客户端并发**。
- Authenticated Profiles：**"Each session gets its own working copy" / "Workers don't fight over a single shared browser"**——快照副本才是现成产品的标准并行架构。
- 反面 #4913：同 userDataDir 重连却创建新 session——目录持久化、活会话复用、启动参数正确性必须分别验证。

**puppeteer-cluster 三档并发实现（README 原文）：** PAGE「Shares everything (cookies, localStorage…)」/ CONTEXT「No shared data」/ BROWSER 每 worker 一浏览器——有界 worker 队列 + 每任务只回收自己的资源。#207：chrome 进入「cannot be restarted」状态——修复失败必须有明确终态。

**Playwright 官方文档（class-browsertype.md）原文：** "browsers do not allow launching multiple instances with the same User Data Directory." → **同 profile 多 launch 在上游层面就是被禁止的**，任何方案都是在其上叠加资源协调层（引用 #19742 维护者同义回复）。

## 3. 方案对比与推荐

**先立一个被全部证据收敛的事实**：Chromium/Playwright 上游明确禁止同 user-data-dir 多实例（21=PROFILE_IN_USE；Playwright 文档原文禁止）；五大 RPA 平台无一支持并发共享已登录会话；商业云产品 Browserless 的持久会话也限制单客户端。**「共享活会话并发」不是任何成熟方案的选择，「队列串行 + 会话/凭据分离」才是**。

| 方案 | 内容 | 改动面 | 风险 | 并行度 |
|---|---|---|---|---|
| **A. profile 单飞队列**（推荐主路径） | 把共享 profile 建模为 AA 语义的 device：同一 profile 一时刻一任务；第二任务进 durable 队列（显式排队 + 可诊断原因 + 超时上限），互斥原语用 SQLite 条件 UPDATE CAS（Skyvern occupy 同款） | `work-service.ts`（认领闸门）、`scheduler-service.ts`（触发闸门）、`run-script.ts`/`shell.ts`（工具层 profile 归属声明）、prompt | 低——语义与五大平台一致，复用 durable 台账 | 无并行（但写操作本来必须串行） |
| **B. CDP owner 守护 + attach** | 单 owner 持浏览器，任务经 CDP attach 各得 context/page；需要 page 所有权注册表 + owner 生命周期=浏览器生命周期 + 有界队列 | 新增 owner 服务 + `.pth` shim 已在盒子（attach-only 版） | 高——#42961 互踩 tab、fidelity 降低、焦点竞争、owner 崩溃域大 | 真并行（读操作） |
| **C. 复制隔离**（接线已有模块） | 每任务冷复制母本副本（`profile-isolation.ts` 已实现未接线）：**复制前断言源进程已退出**（lockfile 残留不作数）、剔除清单补 `lockfile`、成套复制含 journal/wal、owner/回收器（防 browser-use #5422 泄漏）、非白名单失败必抛、损坏降级重试（Skyvern 式显式标记） | `browser-service.ts` 接线 + 盒子 launcher（python 侧显式布尔开关，**不做路径启发式**——browser-use #4548 教训：启发式让 36 进程静默共享一把锁） | 中——复制耗时/磁盘（缓存排除后 50–150MB，秒级）；登录态是快照时点，写操作仍会服务端互踩 | 真并行（读操作） |
| **D. storageState 注入** | 登录态导出为 state 文件，任务开独立 context 注入；persistent 只用于保活登录 | 新增 state 导出/注入工具 + 验证政务站会话只依赖 cookies/localStorage | 中——上游明确限定「不改服务端状态」才安全 | 只读任务可并行 |

**推荐：分层组合 A → C → (D/B 为可选增强)。**
- 为什么主推 A 而不是 B/C：五大平台一致语义 + 与 durable 台账天然吻合 + 改动最小且第一步即可独立验证；对账类写操作在服务端有状态（重复点击=重复对账），**本来就必须串行**——并行收益只存在于只读查询，属于 D/C 的增量。
- 为什么不只用 C（复制隔离）：写操作的服务端互踩与副本时点问题不因此消失（两份副本同一个政务会话并发点「重新对账」依然双跑）；复制是给「读并行」用的，不是写安全的替代。
- 为什么不做 B 作为主路径：#42961 维护者态度 + fidelity 降级 + page 所有权/焦点/生命周期的复杂度，与我们的收益（读并行）不匹配；盒子上 `.pth` attach 版已存在，作为实验分支保留。

## 4. 详细设计（推荐方案 A + C 接线）

### 4.1 数据流（改动后）

```
durable conv
  → admission（work-service/scheduler 合流点，新增 ProfileGate）
      ├─ SQLite 条件 UPDATE：profileClaims(name) 空闲→占用（CAS，Skyvern 式）
      ├─ 占用中 → status='queued' + next_check_at=now+回退 + reason='profile busy: <owner conv>'
      └─ 到手 → 创建窗口 conv → 模型 run_script
            → run-script 工具层：声明式校验（脚本触碰的 profile 目录必须与 claim 一致）
            → python playwright 裸启动（单例互斥自然满足，不再有竞争者）
      → 窗口结束/失败 → finally 释放 claim（异常也必须释放，幂等）
```

### 4.2 文件级改动清单
1. `src/scheduler/profile-gate.ts`（新）：`claim(profile, convId)` / `release(profile, convId)`——SQLite `UPDATE profile_claims SET owner=? WHERE name=? AND owner IS NULL` + 变更行数判定；排队任务 `status='queued'` 复用现有台账；排队上限（参考 PAD 12h，默认 2h）与超时显式报错。
2. `src/scheduler/work-service.ts`：窗口创建前过 ProfileGate；`:172` claim 条件后追加 profile 闸门；释放挂 finally。
3. `src/scheduler/scheduler-service.ts`：fireItem 触发前过 ProfileGate（同 claim），占用则把 firing 改为「入队等待」而不是并发起跑（堵 2026-11-05 15:52/16:06 双跑）。
4. `src/engine/tools/run-script.ts` / `shell.ts`：脚本命令文本含 profile 目录字样时校验 claim 归属（软校验：不一致→拒绝并指引导）；输出 PROFILE_BUSY 语义与 `.pth` 报错同文案。
5. `src/browser/browser-service.ts`：接线 `profile-isolation.ts`（C）：托管浏览器默认复制隔离启动；剔除清单补 Windows `lockfile`；非白名单复制失败必抛；窗口关闭/启动清扫已有钩子。
6. `src/engine/prompt.ts` + `resources/skills/windows-script-automation/SKILL.md`：浏览器使用三条铁律（同 profile 必须串行、PROFILE_BUSY 是正常排队信号、禁止 taskkill /IM）——引导层，不承担安全性。
7. 盒子 `.pth` shim（已部署）在发版后保留为纵深防御；`ve_pw_profile_lock.py` 报错文案与 ProfileGate 对齐。

### 4.3 契约变更与兼容
- `work_items` 增加 `profile_claim` 审计字段（可选）；`durable` submissions 不变；对外工具契约不变（ProfileGate 对模型透明）。
- 兼容：无 claim 的旧任务按「匿名 profile=cwd 推断」走同一闸门；闸门关闭开关（config）保留逃生口。

### 4.4 分阶段实施
- **切片 1（最小可验证）**：ProfileGate 核心模块 + work-service 接入 + 变异测试（并发两个 claim 只成一个 → RED）。验收：双窗口同 profile 第二个排队入台账。
- **切片 2**：scheduler fireItem 闸门 + `run-script` 软校验 + 报错文案对齐。
- **切片 3**：browser-service 接线 profile-isolation（Windows `lockfile` 剔除 + 回收器 owner 化）。
- **切片 4（可选）**：只读任务 storageState 通道（先验证政务站会话依赖，见 §5）。

### 4.5 测试策略
- 单元：ProfileGate CAS 竞争（两协程同 claim 一成一败）、异常路径释放、排队超时。
- 集成（脚本）：`scripts/test-profile-gate.mjs`——两个 durable conv 同时要同一 profile，第二个必须 queued 且在第一个释放后接续；崩溃（kill 中间态）后 claim 泄漏检测与回收。
- 变异：去掉 WHERE owner IS NULL → 必 RED；去掉 finally 释放 → 泄漏检测必须 RED。

### 4.6 风险与回滚
- 风险：claim 泄漏（进程崩溃）→ 启动时按 conv 存活性回收（profile-lock-core 的存活探测思路复用）；闸门误判 → config 开关 + 审计日志。
- 回滚：闸门开关一键关闭，行为退回现状（`.pth` 快速失败仍兜底）。

## 5. 盲区与待拍板
1. **storageState 对政务站是否充分未验证**（sessionStorage/SW 中转票据大概率丢失，§2.4 已列丢失面）——切片 4 前置实验：导出 state（含 `indexedDB:true`）→ 新 context 注入 → 只读页面验证登录态。**需要你拍板是否投入。**
2. Skyvern persistent_browser_sessions 的 service 层未读完（tarball 超时），「租约续期/僵尸回收」结论仅基于 broker 源码与迁移文件推断。
3. 「固化 N 份冷 profile」预分配路线（§2.4 架构启示）的运维形态需要拍板：政务站会话有效期未知，冷副本的登录态寿命需要实测。
4. 144 上 `.pth`/shim 是临时热补，**发版安装后应评估移除**（保留会与产品行为叠加）。
5. 方案 A 的排队语义需要用户拍板：排队上限时长（建议默认 2h）与排队时是否推送「已排队」通知。
6. headless-shell 的静默坏档风险（§2.4 风险反转）：盒子脚本全部 headed，风险低；但若将来引入 headless 提速，必须先确认上游行为。
### 2.4 Chromium 锁与复制语义（chromium 镜像源码 + 官方文档 + 本机实验，2026-11-05）

**单例机制细节（补 §2.2）：**
- `Local\ChromeProcessSingletonStartup!` mutex 的 `Local\` 前缀 = **每登录会话一个命名空间**：跨 Windows 会话（如 schtasks Session 0 vs 用户 Session 1）不经 mutex 串行化，靠 lockfile 裁决；而会合窗口按「user-data-dir 完整路径字符串」精确匹配标题——**跨会话时 FindWindow 找不到对方** → 21。**这解释了我们 daemon（Session 0）对 Session 1 持有者拿 21 的全部现象**。
- 【新发现的雷】第二实例对「判定 hung 且**无可见窗口**」的持有者会**不经确认直接 TerminateProcess**（`TerminateProcessWithHistograms(process, RESULT_CODE_HUNG)`，直方图 `NO_VISIBLE_WINDOW_FOUND=2`）——headed 实例叠在 headless 持有者上会静默杀掉对方。
- 崩溃残留 lockfile：`CREATE_ALWAYS+DELETE_ON_CLOSE` 覆盖式拿锁，「Lock file exists but is writable」——残留不阻塞。

**headless「不互斥」的完整解释与风险反转：**
- Playwright headless 用的是 `chromium-headless-shell` 二进制（`chromium.ts:420`），该壳**完全没有 ProcessSingleton**；显式传 `--user-data-dir` 的新 headless 其实有单例（crbug 40280278 修复 CL 099ad6ea5085）。
- 【风险反转】**headless 并存是假安全**：Windows 上 Cookies 库有第二层独占文件锁（`exclusive_cookie_database_locking_=true`，Windows-only），打开失败**静默降级**（DLOG 一条，浏览器照常跑）→ 后开者 **cookie 空载/不落盘**；leveldb OS 锁直接让后开者的 Local Storage/IndexedDB 挂掉。「看起来能跑」实则坏档。

**复制保登录态（方案 C 的科学依据，全部一手）：**
- 登录态 = `Local State`（`os_crypt.encrypted_key`，DPAPI 包裹 AES-256-GCM 主密钥）+ `Default/`（Cookies / Local Storage / IndexedDB / Session Storage / Preferences / SW Database+ScriptCache）。
- DPAPI 官方语义：绑「用户主密钥+机器」，无 `CRYPTPROTECT_LOCAL_MACHINE` → **同机同用户复制后 cookie 仍可解密**（跨机/跨用户不可）。
- App-Bound v20 已双重排除：Playwright 恒传非默认 `--user-data-dir` + 非 system install（app_bound_encryption_win.cc 的 SupportLevel 判定 + Chrome136 官博「非标准目录使用不同加密密钥」）。运维红线：**固定同一 exe + 同一目录**，否则加密体系换轨。
- 正确姿势 = **冷复制 + 成套复制**：browser.close() 级完全退出（进程消失为准，非删 lockfile）→ 复制 `Local State` + 整个 `Default/`（含 `-journal/-wal` 兄弟文件）→ 副本删 `lockfile/Singleton*`。只拷 Cookies 不拷 Local State = cookie 值全解不开；崩溃后热复制 = journal 不配套（`database disk image is malformed`）+ leveldb CURRENT/MANIFEST 撕裂（playwright #35466 实证库损）。
- **storage_state 的丢失面**（playwright.dev 原文）：含 cookies/localStorage/IndexedDB(需显式 `indexedDB:true`)/OPFS/虚拟 WebAuthn；**不含 sessionStorage、Service Worker 注册与 CacheStorage、HSTS、Secure Preferences 站点状态、扩展状态**——政务站常用 sessionStorage 放中转票据、SW 续会话，这类只有整目录复制能保。
- 加速：实测 600MB 目录排除缓存类（SW CacheStorage 387MB 是大头）后典型落 **50–150MB**，robocopy /MT 秒级；**NTFS 硬链接禁用**（实验证明：经副本就地写会同步污染源文件——SQLite EXCLUSIVE 就地页写/leveldb log 追加都破坏共享）。

**架构启示（比每任务现场复制更优）：**「登录一次后**固化 N 份冷 profile**，每任务永久独占一份（任务期零复制、零冲突）」；或单 keeper + CDP。现场复制仅留作扩容路径且必须冷复制断言。

### 4.7 实施状态（2026-11-05，144 盒子热补 v4，发版后由产品实现替换）

- `python-win/Lib/site-packages/ve_pw_profile_lock.py`（.pth 自动加载）已升级 v4：**clone-on-use + 登录态回流 + 副本回收**，但由 flag 文件 `Nova\clone_enabled.flag` 门控——**flag 不存在时行为与 v3.1 完全一致**（裸启动 + PROFILE_BUSY 快速失败），部署即安全，不打扰运行中任务。
- 本地 9 项单测全绿：剔除清单（`lockfile`/`Singleton*`/缓存目录）、克隆包含认证文件、未变更关闭不回流、变更后回流、master 占用时隔离区（quarantine）、死 pid+旧 mtime 清扫、死 pid+新 mtime 保留。
- 关键实现语义：启动时 master 被占（登录/验证码进行中）→ `PROFILE_MASTER_BUSY` 立即报错（唯一的串行点）；进程退出时若副本认证文件有变化且 master 空闲 → 回流 `Local State`/Cookies/Local Storage/IndexedDB/Session Storage；master 忙则副本移入 `saveback_pending_*` 隔离区留痕；副本清扫带 mtime 保护（死 pid 谎报防误删）。
- 启用流程：对账任务收尾 → 创建 flag → 跑政务站双副本共存实验 → 通过即长期开启。
- 已知限制（记入 §5）：进程被硬杀时 atexit 不执行 → 副本留在磁盘（清扫兜底）且回流丢失；save-back 多副本并发时最后写者胜。

### 4.8 实测结果（2026-11-05 20:4x，144 盒子，全部通过）

**实验一 · 双副本共存（政务站同账号并发容忍度）：PASS**
两个 profile 冷副本同时 headed 打开 spay 日终对账结果页、各自翻页 2 次、共存 57 秒：
- A：`ATTACH 3.8s` → `LOGIN_START=OK` → `rows=10` → `mid_0/mid_1 login=OK` → `LOGIN_END=OK`
- B：`ATTACH 3.3s` → `LOGIN_START=OK` → `rows=10` → `mid_0/mid_1 login=OK` → `LOGIN_END=OK`
→ **政务站容忍同账号两处并发**，副本并行路线的最后一个未知数消除。

**实验二 · clone-on-use 并发（3 进程同抢 spay_profile）：PASS**
三个进程同时 `launch_persistent_context(spay_profile)`：
- 全部 `LAUNCH_OK`（无一个 PROFILE_BUSY、无等待）、全部 `LOGIN=OK`、全部 `CLOSED_OK`
- 每个进程各拿独立副本，克隆耗时 **0.6s**（剔缓存后 30MB 级）
- 关闭后**副本目录残留 0**（自动清扫）
- 三个进程的认证文件变更**全部自动回流**母本（`Local State`/`Default\Network\Cookies`/`Cookies-journal`/`Session Storage`/`Preferences`）

**实测修正的一个关键事实**：现代 Chromium 的 cookie 库在 **`Default/Network/Cookies`**，不是 `Default/Cookies`（盒子母本实测 20480 字节，旧路径不存在）。回流清单已同时覆盖新旧两个位置——这是第一版补丁的 bug，若未修正，登录态回流会静默失效。

**当前 144 状态**：clone-on-use flag 已开启并长期生效；Nova / Orion / Synapse 三实例均以 Session 1 运行；Nova 的调度与工作项已清空（过期对账任务作废）。


### 2.5 Hermes（NousResearch/hermes-agent, 260k★）的现成解法 —— 与我们同源但更成熟

源码直读（`gh api`，2026-11-05）：`tools/browser_session_real_profile.py`、`tools/browser_launcher.py`（1146 行）、`hermes_cli/browser_connect.py`、`agent/browser_provider.py`、`agent/browser_page_registry.py`、`apps/desktop/src/app/settings/browser-real-profile-panel.tsx`。

**它的产品化形态**：配置项 `browser.use_real_profile`（GUI 有开关 + 首次使用弹同意对话框）——**用户同意后，把默认浏览器的 profile（cookies/logins）快照成 Hermes 自有副本**，关掉开关就删除全部快照。文档字符串原文：

> "snapshot the user's default Chromium profile into a Hermes-owned copy and launch the user's REAL browser binary on it … **One shared browser per profile home serves every session of that profile (concurrent tasks must not launch rival Chromiums on one copy dir)**; it is terminated at exit or when THAT profile turns consent off."

**四层机制（逐层照抄价值排序）：**

1. **【最重要·补我们的短板】单浏览器 + CDP 多会话，而不是每任务一个浏览器。**
   `browser_launcher.py` 文档字符串："One browser per launcher key (the session layer's cache key, or `profile:<dir>` for a persistent profile shared by every key)."
   并发任务共享同一个浏览器进程，各自开自己的 page/context；`_attach_running()` 直接 leasing 已有实例（"attaching to the Chromium already running on %s"）。
   → 我们今天的 clone-on-use 是「N 个浏览器」，hermes 是「1 个浏览器 + N 个会话」，**内存开销差 N 倍**。这是我们应该演进的方向。

2. **【直接解决我们踩过的坑】端口竞态的正解：`--remote-debugging-port=0` + 读 `DevToolsActivePort` 文件。**
   原文："Chromium picks its own DevTools port (`--remote-debugging-port=0`) and writes it to `<user-data-dir>/DevToolsActivePort`; the CDP URL comes from that file, **so there is no port race**."
   → 我们昨晚 daemon 用固定 9333 + browser-use 的 `_find_free_port` bind→close 竞态，hermes 这条路彻底消灭竞态。**这个必须抄。**

3. **【解决跨会话/跨进程】profile home 级锁 + 单例持有者探活 + foreign/stale lock 区分。**
   `_home_lock()`：每 profile home 一个 `threading.Lock`，带 30s 超时（"Keep lock contention well inside the agent's 420-second outer tool deadline"）；超时给出可执行文案「另一个调用正在准备，稍后重试或重启」。
   `_singleton_owner()`：POSIX 读 `SingletonLock` symlink；**Windows 没有 symlink，靠「argv 里写着该目录的进程」找持有者**（`_singleton_pid` 注释原文）。
   `_foreign_holder()`：区分「别的 host/container 写的锁」与「本机崩溃残留的陈旧锁」——陈旧锁可接管（"Chromium itself takes it over"），foreign 锁不碰。
   → 这正是我们 #42961 / Session0-vs-Session1 那类问题的成熟处理。

4. **【我们还没有的】同意语义 + 撤销即删凭据 + 失败优雅降级。**
   - 快照要用户显式同意（`browser.use_real_profile`），关掉开关 → `_consent_revoked()`：停浏览器 + **删除快照存储**（"so revoking consent actually removes the credential copies"）。
   - 快照失败时降级到「无登录态的新浏览器」并**明确告知模型**：`real_profile_fallback_note()` = "Using a fresh browser without the user's logins for this session instead; tell the user if the task needs their accounts." —— 绝不静默。
   - profile 被占用时给出**需用户批准**的处置：`_snapshot_error()` 提示运行 `hermes browser close-profile`，并强调 "only after the user approves — it quits their browser and loses unsaved tabs"。
   - 用**用户真实的浏览器二进制**（而非打包 Chromium）+ 不用 `--password-store=basic`/`--use-mock-keychain`，"keeps the OS keychain path intact, so macOS cookies decrypt and the copy stays signed in"（Windows 对应 DPAPI，我们 §2.4 已独立得出同一结论）。

5. **云浏览器 provider 抽象**（`agent/browser_provider.py`）：`create_session(task_id)` / `close_session` / `emergency_cleanup`，注册 browserbase / browser-use 等；`agent/browser_page_registry.py` 用 `backend_for_task(task_id)` 把「任务 → 它的 live page」映射起来。→ 与我们是否需要上云无关，但 `task_id → page` 的归属映射正好补上 CDP 共享最容易踩的「互相操作对方 tab」（§2.2 #42961）。

**对我们的适配判断（三条具体动作）：**
- **A（立即）**：把 daemon 的固定端口改成 `--remote-debugging-port=0` + 读 `DevToolsActivePort`，消灭端口竞态。
- **B（下一步演进）**：从「每任务一个副本浏览器」升级为「一个副本浏览器 + 每任务独立 context/page」，内存从 N×500MB 降到 1×500MB，并引入 `task_id → page` 归属注册表。
- **C（产品化）**：把 clone/共享的开关做成用户可见的同意项，撤销即删副本；失败时降级并明确告知（我们已有的 PROFILE_BUSY 文案方向正确，可对齐 hermes 的措辞）。

## 6. 源码落地（本次 PR，对齐 Hermes）

**接线状态（如实）**：B（页归属）已在 `BrowserService` 生产路径生效；A（CDP 端点）与 C+（认证快照）是**已测脚手架**——生产代码尚无调用方，`BrowserService.launch()` 仍走 `launchPersistentContext`，快照也没有创建方。进程内接线（launch 切 CDP 端点、快照接入 useRealProfile）是下一个 PR 的事，本 PR 不把它们说成已生效。跨进程共享（盒子上的业务 python 不经 VE 进程）仍由 `.pth` 热补承担。源码模块如下：

| 能力 | 模块 | 关键点 |
|---|---|---|
| **A. 无端口竞态的 CDP 端点** | `src/browser/devtools-endpoint.ts` | `--remote-debugging-port=0` + 读 `<udd>/DevToolsActivePort`（Chromium 自己写）。文件被截断重写，**部分读取一律视为"未就绪"**；超时返回 null 让调用方杀掉子进程（否则留孤儿占 profile——browser-use 的原 bug）。flags 刻意不含 `--password-store=basic`/`--use-mock-keychain`、不关 hang monitor |
| **B. 单浏览器 + 每任务独立页** | `src/browser/shared-session.ts` + `BrowserService` | `PageOwnership` 显式 owner→page 映射。**绝不返回"当前页/第 0 页"**（Playwright #42961 拒绝支持的功能）；死页立即遗忘不发放；未注册的 owner 一律新开页，不复用他人 tab |
| **C. 同意即快照、撤销即删** | `src/browser/real-profile-consent.ts` + `config.browser.useRealProfile` | 显式布尔，**绝不按路径启发式**（browser-use #4548 的 36 进程抢锁根因）。撤销 / 启动 / 退出三处删除副本；清扫前缀与创建前缀同源（#5422 的 14GB 泄漏根因）。失败必须可见 |
| **C+. Windows 真实锁场景** | `src/browser/auth-snapshot.ts` | Cookie 库用 **SQLite 在线备份**（`VACUUM INTO`）而非文件复制（浏览器运行中必踩 WinError 32）；`VACUUM INTO` 不可中断、**无硬超时**（契约如实标注，不做虚假预算宣称）；锁住 → skipped、**权限错误（EPERM/EACCES）归 failed 不算「忙」**；**空表不算登录**（读 `COUNT(*)`，不用文件大小）；复用时如实报新鲜度 |

**为什么不是「每任务一个副本浏览器」**：Hermes 的形态是「一个浏览器 + N 个会话」，内存 1×500MB 而不是 N×500MB。VE 的 `BrowserService` 本来就是单 context + 每 owner 一页，本次把归属从隐式 Map 升级为显式注册表，正是这条路线。

**尚未做（下一 PR）**：跨进程共享（业务脚本在盒子 shell 里跑的 python 不经过 VE 进程）仍需 `.pth` 层方案；本次先把 VE 自托管的浏览器路径做对，并把 Hermes 的两条 Windows 硬坑（SQLite 锁、空库误判）提前吃掉。

**门禁**：typecheck 通过、immutable 16 区未变、**119 套件全绿**、新增 3 个测试套件共 8 处变异全部被杀。独立审查（真实 Chromium 复现）确认的 2 个 P1 已修：弹窗归属改事件时反查、并发建页去重；`switchPage` 改为**转移所有权**（前 owner 立即失页，绝无两 owner 共用一 tab）（M1 部分端点文件 / M2 port 0 / M3 发放死页 / M4 撤销不删副本 / M5 清扫忽略年龄 / M6 退化为文件复制 / M7 cookie 失败降级为跳过 / M8 空表当有效）。

