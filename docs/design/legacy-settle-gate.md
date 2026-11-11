# Legacy settle-gate — 单内核方向下的收尾验证回填

状态：已实现（feat/legacy-settle-gate），待发版
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
2. **marker 是唯一门控，与另两个内核一致。** `[[TASK_DONE]]` 只由自主/work 提示链路
   （`scheduler/work.ts`、`scheduler/autonomous.ts`）教给模型，普通 IM 系统提示不含该
   marker，因此普通对话天然 no-op。**不**用 `isWorkConversation()`（仅认 `work:` 前缀）
   门控——autonomous 链路的会话 id 不一定带此前缀，前缀门控会漏判。
3. **全程 fail-open。** 验证回合是附加质量门，绝不能吞掉原始交付。驱动抛错（流断、
   网关错误）时退回原 reply、清 streak、留 warn 日志。
4. **最小侵入。** 不扩 telemetry schema、不改消息历史结构、不动另两个内核。

## 状态机（与扩展版逐分支对齐）

```
reply 含 [[TASK_DONE]]
  └─ drive(验证提示)  →  judgeVerifyRound(verifyText, hadToolCalls, streak)
       ├─ pass（VERIFY_PASS 且有工具证据）        → 交付验证文本，清 streak
       ├─ release（streak ≥ VERIFY_GIVE_UP）      → 交付 ⚠️ 显式告警报告（绝不伪装成功）
       └─ repair                                    → streak+1，drive(返工提示)
            └─ 返工回复若自带 VERIFY marker，再内联判一次（pass/release 同上）
               否则交付返工结果，后续轮次经 marker 协议可再入闸
```

`hadToolCalls` 由 engine 用 `turnToolCalls` 计数在 drive 前后做差得到——验证回合必须
**真的用工具重新核实**，空口复述不算证据（这正是扩展版 `resetToolEvidence` 的同一约束）。

## 接入点

`src/engine/engine.ts` 的 `send()`，在 reply 最终定稿（narration guard、finalSummary、
undeliveredSteer 之后）、写消息历史 / commitWorkTurn 之前：

```
if (kernel === "legacy" && !ephemeral && !hardError && !deterministic && !narrationSuppressed)
    legacySettleGate.run({ conversationId, reply, enabled: true, drive: gateTurn })
```

`gateTurn` 复用 `finalSummary` 的事件订阅范式（subscribe `message_end` 收集可见文本），
但**保留工具集**——验证回合需要真实 read 能力，这与 finalSummary 清空工具相反。

跳过条件都是防御性的：ephemeral 旁路、硬错误、确定性重放、被 narration guard 抑制的
非员工发言，都不该再触发一轮模型调用。

## 与另两个内核的可观测性差异

- 扩展/durable 版把 streak 持久化（doc/conversation 存储），崩溃可续。
- legacy 版 streak 在 `LegacySettleGate` 实例的内存 Map 里，进程重启归零。这是安全的：
  每个 run 独立验证，重启后最多多给一次验证机会，不会误放行；也避免为单内核回填再
  引入一张存储表。
- 触发验证/返工/封顶放行时打 `[settle-gate] legacy <conv>: verifyRounds=… releasedAtCap=…`
  warn 日志，与现场排障习惯一致。

## 测试

`scripts/test-legacy-settle-gate.mjs`（7 例，纯状态机，drive 用 scripted 注入，无需 SDK）：
普通 IM 不入闸 / disabled 直通 / PASS+证据放行 / PASS 无证据判失败→返工→内联 PASS /
VERIFY_FAIL→返工仍失败→封顶 ⚠️ 放行 / drive 抛错 fail-open 保原回复 / streak 按会话隔离且 pass 后清除。

全量门禁：`typecheck`（双 tsc）+ `verify:immutable`（16 守护区）+ 141 测试套件全绿。

## 盒子 144 切换记录（2026-11-11）

- 三 profile 核查：Nova=`pi-session`，Orion/Synapse 已 `legacy`。仅 Nova 需改。
- 改库通道：应用 asar 瘦身后 better-sqlite3 原生件在 `resources/native/better_sqlite3.node`，
  须用 `ELECTRON_RUN_AS_NODE` 起应用 exe，并以 `new Database(path, { nativeBinding })`
  显式指定（脱离 asar 上下文后 `bindings` 无法自解析；系统 node ABI 不兼容）。
- kernel 仅启动时读取（electron/main.ts:614），故停应用→改 `appconfig.general.engineKernel`
  →经 `VE-AutoStart-Nova` 计划任务在用户会话拉起（SSH 子进程会被 Job Object 回收，
  必须用计划任务/wscript 脱离）。
- 生效三证据：新启动日志零 `[runtime]` bootstrap 行；`pi-runtime-lock` 时间戳停在旧实例；
  DB 读回三 profile 均 legacy。改前已备份 `pi-employee.sqlite.prekernel-<ts>`。
