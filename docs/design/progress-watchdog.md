# 动态看门狗：检测「活跃但无进展」的失控循环 调研与设计

> 真实意图：异常脚本 / 残留进程在死循环里反复调用模型，烧 token、占进程槽，而现有静默看门狗抓不到（每轮都有新 LLM 响应和工具调用，看起来是「活着」）。
> 2026-11-03 · 状态：切片零+切片一/二已实现（feat/progress-watchdog），L1 注入纠偏与残留进程回收为后续切片
>
> **核心约束（用户明确）：不要硬上限。** 30 次可能是卡死，100 次也可能是正常任务。用固定 N 次掐断会降低任务成功率。要的是能**区分「健康推进」与「病态空转」的动态判据**。

---

## 1. 现状与接入点

### 1.1 数据流（改动前）

```
IM/调度/widget 消息
   └─ engine.send()                          [engine.ts:2087 统一入口]
       ├─ durable（默认）→ durableRuntime.send() → Harness（工具轮次无应用层上限）
       └─ legacy → Agent + finishTurn 钩子（maxToolSteps=20 在这里）
每个模型请求 → makeStreamFn() / openDurableRuntime.stream()   [两个独立入口]
每个工具结束 → onToolEvent → recordToolTelemetry({name,ok,error}) [无参数/结果]
静默看门狗 → im/watchdog.ts（判"距上次活动时长"，active 永不触发）
```

### 1.2 已有的四道防线（事实，`路径:行`）

| 防线 | 位置 | 判据 | 为什么抓不到本场景 |
|---|---|---|---|
| 静默看门狗 | `src/im/watchdog.ts:48` | 距上次活动时长；`llmInFlight>0` 直接返回 0（`:50`） | **死循环每轮都活动**，`activityAgeMs` 恒为 0 |
| 工具步上限 | `engine.ts:1945`、`config-store.ts:566` | legacy 内核 `maxToolSteps=20` | **durable 内核完全绕过**（`:2088` 直接进 durableRuntime）；上游 Harness 无等价物（已核 `pi-durable` types/generation.js，只在模型返回 `stopReason:"stop"` 时结束） |
| 调度熔断 | `work-service.ts:105,433` | `MAX_CONSECUTIVE_TIMEOUTS=2`，只数连续**硬超时** | 死循环每次都成功返回，不超时；任意一次非超时关闭即清零（`:567`） |
| 进程数上限 | `shell.ts:120,440` | `MAX_RUNNING_COMMANDS=16` | 只防「并发 16 个」，不防「1 个脚本反复起」；后台命令在回合中止后**存活**（`shell.ts:452`） |

其它相关上限（事实）：autonomous 预算 `maxTurns:0=不限`、`maxMinutes:120`（`autonomous.ts:50`）；transient 重试 `TRANSIENT_RETRIES=10`（`engine.ts:185`，只管错误重试不管成功重复）；前台命令 300s、后台 0=不限（`config-store.ts:574`）。

### 1.3 关键缺口（推断，依据如下）

1. **durable 内核无工具轮次上限**——已核实：`grep maxToolSteps src/engine/durable/*` 为空；上游 Harness 只认模型的 `stopReason`。这是「一轮永不结束」的直接通道。
2. **无累计模型请求 / token 预算闸**——`llmInFlight` 是瞬时仪表不是累计计数（子代理取证）；telemetry 有事后统计无事中拦截。
3. **无「重复」检测**——`recordToolTelemetry` 的事件只有 `{name, durationMs, ok, error}`（`engine.ts:2315`），**拿不到工具参数与结果**，所以现状连「同一动作重复 N 次」都无法判断。
4. **后台进程脱离回合生命周期**——回合中止不杀后台命令（`shell.ts:452`），应用退出才靠 `will-quit → disposeShellCommands`（`main.ts:2282`）批量清。中途崩溃 / 逃逸的子进程无回收（kill 是 best-effort，`command-session.ts:75`）。

### 1.4 要动的文件 + 契约层

- **新增** `src/engine/progress-watchdog.ts`（纯判定逻辑，可单测，无 Electron 依赖）
- `src/engine/engine.ts`：回合开始注册、每次工具事件喂信号、回合结束注销；暴露「进展指纹」
- `src/engine/durable/runtime.ts`：durable 工具执行结束处同样喂信号（补齐第 1.3-1 通道）
- 工具事件契约（`engine.ts:2315` 的 `event` 类型）扩一个**可选**字段：工具参数/结果的轻量指纹（不是原文，避免泄漏与膨胀）
- 配置 `config-store.ts`：新增 `general.progressWatchdog` 段（阈值可配，见 §4.6）
- 不动 immutable 16 区（纯新增运行时模块，不改 RBAC / 存储格式）

---

## 2. 外部调研

> 工具降级声明：子代理无 `gh api` / 浏览器，结论来自本地克隆源码，OpenAI/LangGraph/AutoGen/CrewAI 的默认值为**记忆未核实**（标 ⚠️），下方已剔除不可直接采信的部分。

### 2.1 同类实现（已核实源码）

- **同门 pi-desktop** `src/main/agent/runtime.ts:18`：`const MAX_STEPS = 30;` —— **但全仓库无第二处引用，是死代码**（我亲自 grep 确认，实际循环 `:132 do...while(prompt)` 不检查它）。这条反面证据比正面案例更有价值：**连本家都「想加上限却没接上」**，印证硬上限既容易忘接、也不符合实际（所以才被闲置）。
- **pi-subagents** `runs/shared/nested-events.ts:29`：`MAX_STEPS=12 / MAX_CHILDREN=16 / MAX_DEPTH=3`，同时还限制扇出与深度——但这是**有界子任务**场景（一次性委派），不是长跑主回合，不直接适用。
- **qwen-code** `utils/runBudget.ts:225`：`RunBudgetEnforcer({maxWallTimeSeconds, maxToolCalls})`，两者默认 `-1=关闭`，按**累计工具调用 + 墙钟**双轴，用 AbortController 中止。
- **pi 自身引擎** `packages/agent/.../env/nodejs.ts:192`：`taskkill /F /T /PID` + `kill(-pid)` 兜底，与我们 `shell.ts:306` 同一模式（Windows 用 `/T` 杀树、POSIX 用进程组）。
- **本应用 updater** `updater.ts:975`：杀残留时用 WMI → schtasks → detached 三级，并在 3s 后做 **PID 存活探测**（防 PID 复用误杀）。这是「清理残留进程」的现成范本。

### 2.2 上游生态位（pi-durable）

- `LiveState.run` / `pi.live.tools`（`pi-durable/.../live.d.ts`）已暴露每轮工具槽（callId/name/status/entry）。我们在 PR #149 的 `watchProcess` 已经在读它——**进展看门狗可以复用同一条 watch 通道拿工具轮次，不必改存储**。
- `restart_limit`（HarnessSettings，默认 5）只管「连续崩溃/驱逐」，不管成功重复——不能借用。

### 2.3 反面证据（保留）

- **6 个本地框架无一默认开启跨轮「重复检测」**——只有连续计数、墙钟、预算。说明「检测同一工作在重复」是新工程，业界普遍回避（误判风险高）。
- Claude Code 的 `maxTurns`、OpenCode 的 `steps ?? Infinity` **默认都不设限**——证明「默认硬掐」在真实 coding agent 上不可接受，与你的约束一致。

### 2.4 适配判断（外部做法 → 我们的接入点）

| 外部做法 | 本项目接入点 | 取舍 |
|---|---|---|
| qwen-code 双轴预算（工具调用数+墙钟） | `progress-watchdog.ts` 内部状态 | **只取「信号」不取「硬掐」**：作为判定输入，触发的是「升级处置」而非直接 abort |
| pi-desktop MAX_STEPS 死常量 | — | **明确不抄**（用户否定硬上限，且它本身就是坏先例） |
| `pi.live.tools` 工具槽 | `runtime.ts` watch 通道 | 复用，拿 durable 每轮工具名/callId，零存储改动 |
| updater 的 PID 存活探测 | 残留进程回收（§4.5） | 复用来防 PID 复用误杀 |
| 「无框架做重复检测」 | — | 提示我们：判据必须保守、可被「新进展」随时解除，宁可漏报不可误杀 |

---

## 3. 动态判据：怎么区分「推进」和「空转」

这是整个设计的核心。**不数次数，数「停滞」。**

### 3.1 进展指纹（progress fingerprint）

每发生一次工具调用，算一个指纹：

```
fingerprint = hash( toolName ＋ 规范化参数 ＋ 结果的稳定摘要 )
```

- 参数规范化：去掉时间戳/随机 ID/自增字段（否则每次都「不同」），按键排序
- 结果摘要：取 `ok` 标志 + 输出前 N 字节哈希 + 受影响资源标识（文件路径/URL/PID），**不取全文**

判据不是「调用是否重复」，而是**「在一个滑动预算窗口内，是否出现过任何一次新指纹」**：

- 出现新指纹 = 在推进未知状态 → 健康，看门狗时钟重置
- 窗口内全是旧指纹（同一动作、同样参数、同样结果反复出现）= 停滞 → 进入升级序列

> 为什么这能区分 30 次卡死和 100 次正常：正常任务即使调用 100 次，每次在读写不同文件/翻不同页/处理不同数据项，指纹持续更新，看门狗永远不触发；死循环（每轮重新登录同一个页、反复跑同一条失败命令、对同一条记录反复打标）指纹恒定，窗口耗尽即触发。**次数本身从不进入判据。**

### 3.2 多信号融合（避免单点误判）

单一指纹会误判「轮询等待」（合法地反复查同一状态）。融合三类信号，任一「有进展」即续命：

| 信号 | 说明 | 合法重复的豁免 |
|---|---|---|
| **新进展指纹** | §3.1 | — |
| **状态变化** | 工作项状态推进、有新文件落盘、浏览器 URL/DOM 变化、后台进程输出增长 | 轮询类：输出字节在增长 / 被轮询对象状态确实翻转 → 算进展 |
| **模型产出增量** | assistant 文本长度 / 新的 toolUse 名称序列变化 | 防止「模型在思考长答案」被误杀（静默看门狗也认 in-flight） |

只有当**三类信号在窗口内全部停滞**才判定失控。

### 3.3 与现有静默看门狗的关系（不是另起炉灶）

```
静默看门狗（已有）：活动?        否 → abort（死 socket / 挂起）
进展看门狗（新增）：有进展?      否 → 升级序列（活着但空转）
```

两者共用同一套 per-conversation 注册/注销与 `touchActivity`，新增的是 `touchProgress(fingerprint)`。

---

## 4. 方案对比与推荐

### 4.1 方案 A：硬上限（轮次/请求数掐断）—— ❌ 不采用

用户已否定。证据支持：默认硬掐在 Claude Code/OpenCode 都不开；pi-desktop 的常量是死代码；会降低合法长任务成功率。仅作为**最后兜底的超高安全阀**保留（见 §4.6，默认关闭）。

### 4.2 方案 B：纯墙钟预算 —— ❌ 不够

autonomous 已有 `maxMinutes=120`，但墙钟分不清「干了 2 小时真活」和「空转 2 小时」。只能当辅助轴。

### 4.3 方案 C：进展停滞动态看门狗 —— ✅ 推荐

§3 的判据。触发后**不是立刻杀**，而是渐进升级（给系统和人多次纠错机会）。

**升级序列（每一级都可被「检测到新进展」自动撤销）：**

1. **观察（L0）**：停滞窗口耗尽 → 记一条诊断日志 + telemetry 计数 `runaway_suspected`
2. **注入纠偏（L1）**：向回合注入一条系统提示，明确告诉模型「你已连续 N 次产生相同结果且无新进展，这通常是循环；请换方法或结束并汇报卡在哪」，**不中止**——多数 LLM 循环会被这句话打破
3. **软停 + 上报（L2）**：再次停滞一个窗口 → 优雅结束当前回合，产出「检测到无进展循环已自动停止」的诚实回复（复用现有的 `EMPTY_ANSWER_REPLY` / 暂停态诚实告知机制，不假装成功），并通知管理员
4. **硬中止（L3）**：仅当进程/资源仍被占用且无响应 → abort 回合 + 回收该回合启动的后台进程树

> 关键：从 L1 起，任何一级只要检测到新进展指纹，立刻回退到 L0。轮询等待只要被观察对象在变化就永远停在 L0。

### 4.4 为什么不用更简单的替代

- **「只检测完全相同的连续工具调用」**（不做指纹融合）：会被「参数里带时间戳」「轮流调两个工具」的循环绕过，也会误杀轮询。必须指纹 + 多信号。
- **「只在事后用 telemetry 报警」**：拦不住正在烧的 token，只能复盘。用户要的是运行中止血。
- **「直接复用熔断 streak」**：熔断只数超时，语义不同（§1.2）。

### 4.5 残留进程：独立的第二把刀

「残留进程死循环调模型」与「回合内 LLM 循环」是两个问题。前者进程在、但可能已没有活跃回合。需要：

- 给每个 `run_command` 后台会话打上**启动它的回合/任务标识**（部分已有 `conversationId`/`ownerId`/`channel`，`shell.ts` SessionEntry）
- 回合 L3 中止或任务被熔断暂停时，回收**该身份启动的**后台进程树（复用 `killProcessTree`，PID 先做存活探测，借 updater 的防复用做法）
- 应用启动时做一次孤儿扫描：列出仍在运行的 shell 会话，其所属回合/任务都已不存在的，提示管理员或按策略回收

### 4.6 配置（默认值保守，全部可配 / 可关）

```
general.progressWatchdog:
  enabled: true
  stallWindowMs: 300_000     # 连续无进展多久才升级（5 分钟，远大于单轮正常耗时）
  fingerprintHistory: 32     # 滑动窗口记多少个指纹
  injectNudge: true          # L1 注入纠偏
  autoSoftStop: true         # L2 软停
  hardAbort: false           # L3 默认关；先只观测+软停，现场验证误判率后再开
  hardSafetyCap: 0           # 超高轮次兜底（0=关，用户否定硬上限，留口子但不启用）
```

---

## 5. 详细设计（推荐方案 C）

### 5.1 数据流（改动后）

```
工具执行结束（legacy onToolEvent / durable watch 工具槽 / 后台命令事件）
   └─ recordToolTelemetry(...)
        ├─ touchActivity(cid)            （已有：喂静默看门狗）
        └─ touchProgress(cid, fp)        （新增：喂进展看门狗）
progress-watchdog（每 cid 一个，随回合生灭）
   窗口内有新 fp / 状态变化 / 产出增量 ?
        是 → level=0，清停滞时钟
        否 → 到点升级 L0→L1(注入)→L2(软停+通知)→L3(abort+回收进程树)
   任一级检测到新 fp → 立即回 L0
```

### 5.2 文件级改动清单

| 文件 | 职责（一句话） |
|---|---|
| `src/engine/progress-watchdog.ts`（新） | 纯逻辑：指纹规范化/哈希、滑动窗口、停滞判定、升级状态机；零 IO 可单测 |
| `src/engine/engine.ts` | 持有 `Map<cid, ProgressWatchdog>`；`touchProgress`；L1 注入、L2 软停、L3 调 abort；回合结束清理 |
| `src/engine/durable/runtime.ts` | 从 `pi.live.tools` watch 取每轮工具名/参数指纹喂入（补齐 durable 通道） |
| 工具事件契约 | `recordToolTelemetry` 的 event 增加可选 `paramsDigest?` / `resultDigest?` / `resource?` |
| `src/db/config-store.ts` | `progressWatchdog` 默认配置段 |
| `src/engine/tools/shell.ts` | 后台会话与回合身份关联 + 提供「按身份回收进程树」 |
| 设置 UI（后续切片） | 阈值可配、展示当前被软停的回合 |

### 5.3 契约变更与兼容

- 工具事件只**加可选字段**，旧调用方不传则该工具不参与指纹（退化为只看其它信号），完全向后兼容
- 不改存储格式 / immutable 区；watchdog 状态是进程内 Map，随回合生灭，崩溃即清（与 settle-gate 的「fail-open，宁可多验证」一致）
- L2 软停复用现有诚实回复通道，不新增对用户的状态语义

### 5.4 分阶段实施（第一步 = 可验证最小切片）

1. **切片一（纯观测，零中止）**：`progress-watchdog.ts` + 接两类工具事件 + telemetry 记 `runaway_suspected`。**先只在日志/遥测里报，不停任何东西**，现场收集真实数据校准窗口与指纹规范化（哪些时间戳字段该剔除）。这一步就能回答「判据到底准不准」。
2. **切片二（L1 注入纠偏）**：停滞时注入提示，观察循环是否被打破，仍不中止。
3. **切片三（L2 软停 + 管理员通知）**。
4. **切片四（残留进程回收 + 启动孤儿扫描）**。
5. L3 硬中止 / `hardSafetyCap` 等现场确认误判率可接受后，默认仍关闭、手动开。

> 先观测后干预，是因为 §2.3 的反面证据：业界都不做重复检测，说明误判风险真实存在。我们必须先用自己的现场数据证明判据可靠，再逐步放开处置权。

### 5.5 测试策略

`progress-watchdog.ts` 是纯函数式状态机，直接构造指纹序列单测，不依赖 Electron：

- 100 个**不同**指纹 → 永不升级（用户的核心约束，必须有此测试）
- 连续相同指纹 + 无状态变化 → 按窗口升级 L0→L1→L2
- 升级到 L1 后出现一个新指纹 → **立即回 L0**
- 合法轮询（输出字节增长）→ 停在 L0
- 带时间戳的相同动作 → 规范化后判为重复
- 轮流调两个工具的双工具循环 → 仍判停滞
- 变异测试：去掉指纹规范化 / 去掉回退逻辑，断言转红

集成层：durable 下用 faux provider 造一个「永远返回 toolUse 同一工具」的回合，断言切片一会计数、切片二会注入。

### 5.6 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误判正常长任务（最大风险） | 三信号融合；新进展即解除；切片一先只观测；L3 默认关；阈值可配可整体关 |
| 指纹碰撞 / 参数含敏感信息 | 只存哈希与资源标识，不存原文；hash 用于判重不用于还原 |
| L1 注入被模型当成新指令反而多跑 | 注入文案明确要求「换方法或结束」；切片二单独观测效果 |
| 回收进程误杀（PID 复用） | 复用 updater 的存活探测；按「本回合启动」的身份收，不按裸 PID |
| durable 通道拿不到工具参数 | 退路：只用 `pi.live.tools` 的 name/callId + 结果 entry 做粗指纹，精度降低但仍能抓「同工具空转」 |

回滚：`progressWatchdog.enabled=false` 一键完全退回现状（纯新增模块，无存储迁移）。

---

## 6. 盲区与待拍板

**盲区（证据不足，如实标注）：**
- 指纹该规范化剔除哪些字段，取决于真实工具的参数形状——切片一的现场数据才能定稿，现在列不全。
- durable 的 `pi.live.tools` 是否稳定携带工具**参数**未最终核实；只确认了 name/status/entry（PR #149）。拿不到参数则指纹降级为「工具名+结果」，误判率需重估。
- OpenAI Agents SDK / LangGraph / CrewAI 的默认上限是子代理记忆、未核实，未用于任何结论。

**需要你拍板：**
1. **升级序列认不认可**（观测 → 注入纠偏 → 软停 → 硬中止）？尤其是 L1「注入提示让模型自己跳出循环」这个动作你接受吗？
2. **第一切片只观测不停手**，先在盒子上跑一段收集数据再开干预——接受这个节奏，还是希望直接做到软停？
3. **残留进程回收**要不要纳入本次范围，还是作为独立 PR？（它和 LLM 循环是两个独立问题）
4. 默认 `stallWindowMs=5 分钟` 是否合适？现场那些死循环大概多久能看出来？

---

## 附录：2026-11-03 线上事故实证（本文档判据的现场证据）

**现象**：Nova「一直在执行但不回消息、不汇报进度」，两个会话队列全堵。

**取证**（durable 库 + main.log）：
- 两个 `pi.generation` task 卡在 `phase:"request", attempt:1`（`tasks` 表 id 195025/195029），即请求已发出、模型流再无返回
- `llmInFlight=1` → 静默看门狗被 `computeStallIdleMs` 直接豁免（`im/watchdog.ts:50` 返回 0）
- `requestTimeoutMin: 30`（盒子实测配置）→ 挂死请求最长可合法占住串行队列 30 分钟
- IM 回合按会话严格串行 → 后续所有消息全部排队等一个挂死的请求

**处置**：重启 Nova，durable 自动恢复重放 placed 提交，日志确认 09:52/09:53 两条 AI 卡片成功送达（恢复前该通道完全静默）。

**由本次事故新增的修复项（切片零，先于 §5.4 切片一）**：

> **挂死请求豁免上限**：`llmInFlight>0` 不应无条件豁免静默看门狗。请求开始时间引擎已有（`lastLlmCallAt`），超过 `min(requestTimeoutMin, 10min)` 仍未产生任何首字节/流事件的 in-flight 请求，按「静默」参与判定，触发升级序列（先注入提示/软停，不直接杀）。另一个等价做法是在 `makeStreamFn`/durable stream 闭包加**首字节 deadline**（如 120s 无首字节即 abort+重试）。二者取其一即可，首选后者（语义清晰：连首字节都没有的请求几乎必死）。


---

## 实现状态（2026-11-03，feat/progress-watchdog）

**已实现**：切片零（挂死请求首字节熔断）+ 切片一（L1 观测）+ 切片二（L2 软停，abort reason "runaway"）。

- `src/engine/progress-watchdog.ts`：指纹 + 状态机（纯逻辑，17 条测试）
- `definition.ts withTelemetry`：双内核全工具最外层算指纹（含 MCP——经 guardTool 包装后仍过这里；含 throw 路径）
- `engine.ts`：recordToolTelemetry 喂看门狗；send() 顶部 beginTurn；L2 走 abortSession 同一通道
- `im/watchdog.ts`：零首字节请求超过 hungRequestCapMs（默认 10 分钟）立即判挂死；有首字节仍无条件豁免（v3 不回归）
- `general.progressWatchdog`：enabled / stallWindowMs / windowSize / softStopAfterWindows / hungRequestCapMs，旧配置缺块时全部走默认值

**首字节检测实现**：makeStreamFn 对返回的 EventStream 做 asyncIterator 包装（透传一切，只记录消费方的第一次 next()）；已核实两个消费方（pi-durable generation.js:550、pi-agent-core agent-loop.js:280）都走 for await → 双内核生效；非可迭代响应（测试替身）原样透传。

**已核实的边界（如实记录）**：
- 同一回合内 >32 个不同指纹轮换会漏报（每步都便宜，不构成烧钱事故）
- 跨回合的重复（如定时任务每轮问同一问题）不在本切片——beginTurn 每条新消息重置窗口；那属于 streak 类检测（熔断器已有超时 streak）
- L1 目前只记日志+观测，注入纠偏（切片原 L1 文案）延后；L2 直接软停
- 残留进程回收（§4.5）未实现，另开切片

**变异验证**：时间戳不归一化 / 新指纹不重置 / 轮换误判 / 挂死回退豁免 / 首字节豁免删除 —— 5 个变异逐个转红。
