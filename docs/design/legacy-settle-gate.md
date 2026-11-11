# Legacy settle-gate — 单内核方向下的收尾验证回填

状态：已实现（feat/legacy-settle-gate，PR #202），review 修复已完成，待发版
关联：`docs/design/router-worker-core.md` §0（单内核裁定）、`docs/design/ve-pi-session-migration.md`、
`src/engine/extensions/ve-settle-gate.ts`（pi-session 内核）、`src/engine/durable/ve-settle-gate.ts`（durable 内核）

## 背景

2026-11-09 单内核裁定（router-worker-core.md §0）：拆除 legacy / pi-session / durable
内核矩阵，回归单一 agent-core（legacy）内核。2026-11-11 用户进一步决定：盒子 144 上
所有 profile 先切回 legacy，再把 legacy 原本缺失的能力逐项补齐。

能力盘点发现一个真实缺口：**收尾验证（settle-gate）只存在于另外两个内核，legacy 没有。**

| 内核 | 宿主机制 | settle-gate 形态 |
| --- | --- | --- |
| pi-session | AgentSession 扩展运行时 | `createVeSettleGateExtension`（agent_before_settle 钩子） |
| durable | harness 扩展数组 | `createDurableSettleGate()`（harness-host 装载） |
| legacy | 裸 agent-core Agent，无扩展运行时 | **本设计：engine 层普通编排** |

## 设计原则

1. **同一套决策核心，不重写判断逻辑。** 验证标记（`[[TASK_DONE]]` / `[[VERIFY_PASS]]`
   / `[[VERIFY_FAIL]]`）、`parseVerifyReply`、`judgeVerifyRound`、返工/放行提示文案、
   防死循环上限 `VERIFY_GIVE_UP=2`，全部直接 import 自 `durable/ve-settle-gate.ts`
   （该文件本就标注 "shared semantics with extensions/ve-settle-gate.ts"）。
2. **marker 是唯一内容门控，与另两个内核一致。** `[[TASK_DONE]]` 只由自主/work 提示链路
   （`scheduler/work.ts`、`scheduler/autonomous.ts`）教给模型，普通 IM 系统提示不含该
   marker，因此普通对话天然 no-op。**不**用 `isWorkConversation()`（仅认 `work:` 前缀）
   门控——autonomous 链路的会话 id 不一定带此前缀，前缀门控会漏判。
3. **交付的 reply 必须保留 `[[TASK_DONE]]` 标记行（legacy 特有的硬约束）。**
   durable 管线不做 marker 解析（worker-service.ts:11「settle IS completion」），
   但 legacy 的 work-service / autonomous **按 marker 行判定完成**
   （`parseWindowReply` / `parseChainReply`）。若 PASS 时把 reply 换成验证文本
   （只含 `[[VERIFY_PASS]]`），调度器判 `continue` → 窗口重发「继续。」→ 模型再声明
   DONE → gate 再触发（PASS 已清 streak，封顶永不生效）→ 空转到预算耗尽。
   因此 **PASS = pass through 原 done 声明**（与扩展版「PASS: pass through (the task
   settles)」语义一致）；验证文本只是 gate 的证据，不是交付物。
   封顶放行同理：`releaseReply` = 原声明（marker 保留 → 窗口终结）+ `⚠️` 报告；
   marker 行会被 `stripMarkerLines` 剥掉，管理员只看到正文与告警。
4. **streak 局部于一条 done-claim 链，不跨调用持久化。** durable 版曾把 streak 按
   conversation 存，被 review 实测为缺陷（任务 A 失败 1 轮后，同会话的独立任务 B
   失败 1 轮就被当成「连续 2 轮」放行），后改为按 generation-task id。legacy 的整条
   验证链在一次 `run()` 内闭环（无 settle 边界可跨），故 streak 用局部变量即可；
   `work:<id>` 会话跨窗口/跨任务复用，持久化必然串味。
5. **全程 fail-open。** 验证回合是附加质量门，绝不能吞掉原始交付。驱动抛错（流断、
   网关错误）时退回原 reply、留 warn 日志。
6. **最小侵入。** 不扩 telemetry schema、不改消息历史结构、不动另两个内核。

## 状态机（一次 run() 内闭环，硬上限 2 验证 + 1 返工）

```
reply 含 [[TASK_DONE]]
  └─ loop:
       drive(验证提示) → judgeVerifyRound(verifyText, hadToolCalls, streak)
         ├─ pass（VERIFY_PASS 且有工具证据） → 交付【原 reply】（marker 保留）
         ├─ release（streak+1 ≥ VERIFY_GIVE_UP）→ 交付【原 reply + ⚠️ 报告】（marker 保留）
         └─ repair → streak+1 → drive(返工提示) → 回到 loop 重新验证
```

`hadToolCalls` 由 engine 用 `turnToolCalls` 计数在 drive 前后做差得到——验证回合必须
**真的用工具重新核实**，空口复述不算证据（与扩展版 `resetToolEvidence` 同一约束）。
`judgeVerifyRound` 内部即含封顶判定（`prevStreak+1 ≥ giveUp → release`），因此循环
必然在第 2 轮验证时终结，无无界风险。

## 回合级跳过条件（`legacyGateEligible`，单一可测处）

gate 绝不重驱动一个已带系统裁决的回合：

| 条件 | 原因 |
| --- | --- |
| `kernel !== "legacy"` | 另两个内核在各自 shell 内 gate |
| `ephemeral` | 旁路回合不交付 |
| `hardError` / `deterministic` | 错误/确定性重放回合 |
| `capHit` / `contextBudgetHit` | 安全上限已触发；`finalSummary` 正是为此**结构性清空工具**，gate 保留工具的验证回合绝不能在封顶后再开一轮工具循环 |
| `aborted`（turnAborts） | `agent.prompt` 每次新建 AbortController，gate 会**复活** `/stop` 掉的回合并在 abort 后烧预算 |
| `narrationSuppressed` / `narrationNoted` | 叙述守卫已裁决（非员工发言 / 已附通知），替换 reply 会丢通知且信号自相矛盾 |
| `undeliveredSteer` | reply 尾部带「中途指令未送达」⚠️ 通知，替换即静默丢弃 |

## 接入点

`src/engine/engine.ts` 的 `send()`，在 reply 最终定稿（narration guard、finalSummary、
undeliveredSteer 之后）、写消息历史 / commitWorkTurn / recordTurnTelemetry 之前。
`gateTurn` 复用 `finalSummary` 的事件订阅范式（subscribe `message_end` 收集可见文本），
但**保留工具集**；多条 assistant 文本按 `\n` 拼接而非直接相加——`parseVerifyReply`
要求 marker 位于**行首**，直接拼接会把前置片段与 marker 粘成一行而误判 `none`。

## 与另两个内核的可观测性差异

- 扩展/durable 版把 streak 持久化（doc/conversation 存储），崩溃可续；legacy 版
  streak 是 `run()` 局部变量。这是安全的：每条链在一次调用内闭环并必然终结于
  pass/release，不存在跨调用续算的需求。
- 触发验证/返工/封顶放行时打 `[settle-gate] legacy <conv>: verifyRounds=… releasedAtCap=…`
  warn 日志。`releasedAtCap` 是区分「验证通过完成」与「防死循环放行」的唯一现场信号
  （未扩 telemetry schema，为最小侵入的自觉取舍）。
- 封顶放行以 DONE 终结窗口而非 NEED_HUMAN：常驻/自主任务若每次不可验证都转等人，
  会卡住后续窗口节奏；`⚠️` 报告本身即交付结果，诚实性由文案承载。

## 测试

`scripts/test-legacy-settle-gate.mjs`（10 例，纯状态机 + 真实调度器解析器集成钉）：

- 普通 IM 不入闸 / disabled 直通
- PASS+证据 → 交付**原 reply**（marker 完整）
- PASS 无证据 → 返工 → 重验通过（3 次 drive，硬上限钉死）
- FAIL → 返工 → FAIL → 封顶放行（原 marker 保留 + ⚠️ 报告）
- drive 抛错 → fail-open 保原回复
- **P1-1 钉**：同会话两条独立链，后一条不因前一条的 streak 被提前放行
- **P0-1 钉**：PASS 与 release 两种 gated reply 喂给真实 `parseWindowReply` /
  `parseChainReply` 均判 `done`（窗口终结、不空转），推送文本无裸 marker 泄漏；
  极简验证文本（只有 `[[VERIFY_PASS]]`）绝不替换实质结果（P2-2）
- **P3-3 钉**：marker 未在行首（`…数据一致[[VERIFY_PASS]]`）判 `none` → 走返工
- **跳过条件钉**：`legacyGateEligible` 11 个分支逐一反证（P1-2 / P2-1 / P3-1 / P3-2）

变异验证：把 PASS 改回「返回验证文本」后 5 例变红（含 P0-1 集成钉），还原后 10/10 绿。
全量门禁：`typecheck`（双 tsc）+ `verify:immutable`（16 守护区）+ 141 测试套件全绿
（shell-timeout 套件在满负载下已知偶发抖动，单独复跑 18/18 绿）。

## Review 处置（3ff3d67d，Copilot quota 阻断后的独立 clean-context 审查）

| 编号 | 结论 | 处置 |
| --- | --- | --- |
| P0-1 PASS 剥离 DONE marker → 调度器判 continue 空转 | 成立（probe 实测 done→continue） | 已修：PASS/release 均保留原 reply（marker 完整）；新增调度器解析器集成钉 |
| P1-1 streak 按会话持久化 → 后续独立任务被提前放行 | 成立（probe 实测 1 轮即 release） | 已修：去掉 Map，streak 局部于一次 run()；新增跨链独立性测试 |
| P1-2 gate 忽略 turnAborts → /stop 后被复活 | 成立（agent.js 每次 prompt 新建 AbortController） | 已修：`legacyGateEligible` 纳入 aborted |
| P2-1 gate 忽略 capHit/contextBudgetHit → 封顶后再开工具循环 | 成立 | 已修：两条件纳入跳过集合 |
| P2-2 PASS 可能用极薄验证文本替换实质结果 | 成立（低概率） | 已修：PASS 一律交付原 reply；新增 terse-marker 测试 |
| P2-3 测试缺集成层覆盖 | 成立 | 已补：调度器解析器集成钉、跨链 streak 钉、行首 marker 反例、跳过条件 11 分支 |
| P3-1 narrationNoted 通知被替换丢弃 | 成立（边缘） | 已修：narrationNoted 纳入跳过集合 |
| P3-2 undeliveredSteer 通知被替换丢弃 | 成立 | 已修：undeliveredSteer 纳入跳过集合 |
| P3-3 gateTurn 直接拼接致 marker 不在行首 → 误判 none | 成立（低概率） | 已修：按 `\n` 拼接；新增行首反例测试 |
| P3-4 enabled 硬编码无配置开关 / 验证工具计入 ledger 与 telemetry / streak 内存态 | 接受为设计 | 与另两内核同等暴露面；ledger/telemetry 语义在设计文档「可观测性差异」中显式记录；不扩 schema 为最小侵入取舍 |

## 盒子 144 切换记录（2026-11-11）

- 三 profile 核查：Nova=`pi-session`，Orion/Synapse 已 `legacy`。仅 Nova 需改。
- 改库通道：应用 asar 瘦身后 better-sqlite3 原生件在 `resources/native/better_sqlite3.node`，
  须用 `ELECTRON_RUN_AS_NODE` 起应用 exe，并以 `new Database(path, { nativeBinding })`
  显式指定（脱离 asar 上下文后 `bindings` 无法自解析；系统 node ABI 不兼容）。
- kernel 仅启动时读取（electron/main.ts:614），故停应用→改 `appconfig.general.engineKernel`
  →经 `VE-AutoStart-Nova` 计划任务在用户会话拉起（SSH 子进程会被 Job Object 回收，
  必须用计划任务/wscript 脱离）。
- 生效三证据：新启动日志零 `[runtime]` bootstrap 行；`pi-runtime-lock` 时间戳停在旧实例；
  DB 读回 engineKernel=legacy。改前已备份 `pi-employee.sqlite.prekernel-<ts>`。
