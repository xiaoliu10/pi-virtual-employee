# 收尾验证门禁（settle verification gate）

2026-10-16 · `feat/settle-verify-gate` · 借监 pi 编码场景的 verify-gate 模式，移植到 VE 的无人值守收尾。

## 背景与动机

现场实证（2026-10-16）：自主任务在模型退化（`stopReason=length` 空转后碎片）场景下，模型声明「已完成」即可直接 settle 推群——**没有任何机制要求它证明确实做完了**。同日更常见的形态：任务自我确认（没有用工具重新核实就回答"完成了"）。#83 退化门禁只拦「乱码」，不拦「没做完就宣告完成」。

## 设计

### 状态机（两处收尾共用一套协议）

```
执行轮产出 [[TASK_DONE]]
  └─ 系统拦截 → 追加一轮收尾验证（verify round，不计入正常轮次预算）
       ├─ [[VERIFY_PASS]] 且本轮 toolCalls > 0 → settle（done）+ 正常推送
       ├─ [[VERIFY_FAIL]]: 未达成项 → 把失败原因写进下一轮消息（修复轮）
       │     └─ 修复轮 → [[TASK_DONE]] → 再验证
       │           ├─ PASS → settle
       │           └─ 连续第 2 轮 FAIL（VERIFY_GIVE_UP=2）→ 强制 settle + 推送显式放行报告
       ├─ 验证轮 [[NEED_HUMAN]] → 走既有 waiting_human
       ├─ 验证轮 toolCalls === 0 → 视为无效验证（自我确认循环），按 FAIL 计
       └─ 验证轮自身无回复/退化 → 引擎层 #83 门禁接住（deterministic / degenerate）
```

- 验证轮是**普通执行轮**（同一会话、同一会话上下文），只是用户消息换成验证 prompt；模型对 `[[VERIFY_PASS]]/[[VERIFY_FAIL]]` 的协议教学已写入两处窗口前缀（work 窗口前缀 + 自主链轮前缀）。
- **熔断计数只存系统侧**（work_items `verify_streak` 列 / chain_state JSON `verifyStreak`），不写进 prompt——模型不知道放行规则，不存在"熬过 N 轮就行"的逃逸目标。
- 连续 2 轮 FAIL 放行时，推送带显式报告：`⚠️ 收尾验证连续 2 轮未通过，已按防死循环策略放行：<最后失败原因>`，绝不以干净的 ✅ 掩盖未验证的完成。

### 证据式验证 prompt（`buildSettleVerifyPrompt`）

验证轮要求：① 逐条列出目标对照当前真实状态；② 每条给出**刚发生的**读取/查询证据（页面、数据、文件、命令输出原样摘录），**凭记忆复述不算证据**；③ 没核实过的条目现在就查。最后一行单独 `[[VERIFY_PASS]]` 或 `[[VERIFY_FAIL]]: 哪条未达成`。

配合 `SendResult.toolCalls`（engine 每轮记录工具调用数）：验证轮 `toolCalls === 0` 即使写了 PASS 也判 FAIL——防"我说我核过了"的自我确认循环。

### 共享核心（`src/scheduler/settle-gate.ts`，2026-10-16 独立审查后抽取）

判定状态机与用户文案只有一份：`judgeVerifyRound`（证据检查 + 熔断判定 + streak 计算）、`settleReleaseReport`（放行报告模板）、`settleRepairInstruction`（修复轮指令模板）。work-service 与链路 runner 是两个薄壳，只负责各自的 send 与持久化——独立审查曾发现两份手写实现分叉（链路漏了「第 2 轮 FAIL 立即放行」），抽核心根治这一类 bug。判定逻辑与 pi-quality-gates 的 `src/core` 同模式，未来可在协议层合流。

### 韧性（与普通轮同一套）

- 验证轮 send 挂了（error / deterministic 无回复）走**与普通轮相同的静默退避重试**（`nextStallStep`，2 次静默重试后才升级）；分级耗尽才进入既有的诚实暂停（work-service）/链路暂停（chain）。完成前的最后一刻不该新增单发即挂的失败点。
- 验证轮被 RBAC 拒绝的工具调用**不算证据**（`toolCalls` 只计非 refused 调用）。

### 解析规则（`parseVerifyReply`）

- 标记必须顶格一行（与既有 marker 协议一致，容错 markdown 强调前缀）。
- 标记按**最后出现者生效**（last-mark-wins）：PASS 在后 = 通过（先认失败、修复后复核通过）；FAIL 在 PASS 之后或无 PASS = 未达成（宣称通过却自认有未达成项 = 未达成）。
- 无任何标记 = `none` → 按 FAIL 计（note：验证轮没有给出明确结论）。

## 覆盖范围

| 场景 | 实现 |
| --- | --- |
| 自主任务（work item）窗口循环 | `src/scheduler/work-service.ts` done 分支：验证轮 → 修复轮（`repairNote` 进下轮消息）→ 熔断放行 |
| 自主链（autonomous chain，定时任务） | `electron/main.ts` 链路 runner done 分支：同一协议，链状态 JSON 持久化 verifyStreak/verifyNote |
| 开关 | `scheduler.verifyGate`（config，默认 **true**），`manage_settings` 可关；WorkService `opts.verifyGate` 注入 |
| 持久化 | work_items 新列 `verify_streak`/`verify_note`（迁移安全：DEFAULT 0 / NULL，旧库自动 ALTER）；链状态复用 `chain_state` JSON |

## 明确不做

- **不作用于普通 IM 对话轮**：门禁只上无人值守收尾（用户在场的对话不需要，也付不起多一轮延迟）。
- **不做独立验证者模型**：验证与执行同模型（同会话上下文），所以必须证据式 + toolCalls 检查——换"另一个脑子"是后续独立课题。
- 验证轮**不计入** `maxTurns` 正常轮次预算（两处实现一致：验证发送不消耗轮次）；修复轮计入 1 轮；`maxMinutes` 照旧兜底（时间到了照样熔断）。
- 模型永远不知道 `VERIFY_GIVE_UP` 的值。

## 测试

- `scripts/test-autonomous.mjs`：`parseVerifyReply`（PASS/FAIL/none、last-mark-wins、note 提取）、`buildSettleVerifyPrompt`、链状态 verifyStreak 往返。
- `scripts/test-work-service.mjs`（9 个门禁用例）：门禁开→验证轮触发、FAIL→修复轮（消息带失败原因）→PASS settle、连续 2 FAIL→放行+显式报告+计量清零、PASS 无 toolCalls→判 FAIL、门禁关→零验证轮、`setVerifyState` 持久化、验证轮瞬时失败被静默重试吸收、验证轮持久失败→诚实暂停（文案说明已重试）、crash-resume 计量≥上限→立即放行（带旧 note、清零、零验证轮）。
- `scripts/test-work-e2e.mjs`：全生命周期含验证轮（done 推送无协议标记、审批号答案不进验证轮）。
- 全量：47 套件 + typecheck + build + 13 immutable。
