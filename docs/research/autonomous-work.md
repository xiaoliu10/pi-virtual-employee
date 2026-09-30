# 自主工作功能 · 实现方式调研

> 2026-09-30 · 已定稿：一期按**方案 A（链式增强 MVP）**落地。
> 已拍板：① 方案 A；② operator 可创建（执行身份＝创建人当前角色，沿用现有定时任务权限模型）；③ 预算超限先请示再续（推送进度 + 「继续」命令重置预算续跑）。
> 二期再评估方案 B（工作项模型+SDK 钩子）；方案 C（全自主巡检）留作远期。

---

## 一、现有基础设施盘点（可直接复用）

| 设施 | 现状 | 对自主工作的价值 |
|---|---|---|
| 调度器（scheduler-service） | cron → 全新 `sched:` 会话 → `engine.send` 一次 → 推送结果；重入守卫、1h 超时 | 自主执行的骨架：隔离会话、超时、防重入模式照搬 |
| 无人值守提示语境 | `sched:` 前缀注入 `isScheduledRun` 提示（先检测登录态、不问 OTP） | 自主会话沿用同一套无人值守行为约束 |
| 心跳进度播报 | IM 回合内每 N 分钟经 `engine.progressBrief` 侧路推送 | 自主工作的「还在干、干到哪」直接复用 |
| 看门狗 / 压缩 / 有界旁路调用 | 回合失速看门狗（IM 会话）、上下文预算门、compaction | 长任务的保命三件套已就绪 |
| 汇报中心 | startRun/completeRun/publish → Gitee 链接 | 自主工作的交付物天然是一份可分享报告 |
| 升级/请示通道 | `escalate_to_human`（工具结果 `terminate: true` 终止回合）、一次性授权确认 | 「卡住了就问人」的现成机制 |
| RBAC | admin/operator/viewer + 工具级 capability | 自主权限授予沿用创建者角色模型 |
| 定时任务工具组 | LLM 可自建/改/停 cron 任务 | 自主工作项的创建入口可以同构 |

**关键缺口**：① 没有多轮自我延续（一轮 send 结束，循环就停）；② 没有工作项持久化（目标/计划/步骤/预算/状态）；③ 没有预算与止损；④ 非 IM 会话无看门狗（调度器注释明说 sched 回合在 IM 看门狗之外，靠 1h 硬超时兜底）；⑤ 没有跨会话桥（人在群里回话 → 注入工作中的会话）。

---

## 二、pi SDK 0.99.1 提供的原语（不用自己造轮子）

`@earendil-works/pi-agent-core` 的 `Agent` 已为「应用层自主循环」留好了钩子：

- **`finishTurn(turnCtx, signal)`**：每个助手回合完成后、`turn_end` 前调用。返回 `{action:"continue"}` 强制再来一个提供方请求，返回 `{action:"end"}` 硬停。**这就是应用层自主循环的总闸门**——引擎在钩子里检查「员工是否还想继续」，想继续就 continue。
- **`prepareNextTurn(ctx)`**：决定继续后、下一请求前调用。可**追加消息**（如合成「继续执行步骤 N」指令）、换模型/思考等级、替换上下文。用来把「下一步指令」注入会话。
- **`agent.steer(msg)` / `agent.followUp(msg)`**（配 `steeringMode`/`followUpMode: "all" | "one-at-a-time"`）：steer 在回合间注入（人插话改方向）；followUp 在「本该停下来的时刻」续上一个消息让循环继续。**followUp 就是自我续命的官方姿势**。
- **工具结果 `terminate: true`**：工具内部直接终结回合循环（escalate 已用）——「我干完了/我要问人」可由模型自己触发。
- `getSteeringMessages`/`getFollowUpMessages` 队列轮询钩子、`prepareRequest` 每请求改写——备用扩展点。

结论：**自主循环不需要改 SDK，在引擎的 AgentOptions 里接上 finishTurn/prepareNextTurn 即可实现**。

---

## 三、实现方案对比

### 方案 A：定时任务链式增强（最小改动）

给定时任务加「自主」开关：每轮 `engine.send` 结束后，用一次**旁路评估调用**判断目标是否达成 → 未达成则把「继续，当前进度 X」作为 followUp 注入同一会话，直到达成/超预算。

- ✅ 改动最小（调度器 runner + 一个评估器 + 预算计数），复用度最高
- ❌ 没有结构化计划（模型每轮重新想「接下来干嘛」，长目标易漂移）
- ❌ 每轮一次评估调用的开销；「完成」判定全押在评估 prompt 上
- 适合：验证需求、快速上线 MVP

### 方案 B：工作项模型 + SDK 钩子（推荐）

新增**工作项（work item）**实体与执行器，自主循环建在 SDK 钩子上：

- **数据模型**（新表 `work_items`）：goal、plan（步骤 JSON，模型可改）、status（queued/running/waiting_human/done/failed/cancelled）、budget（max_turns/max_minutes）、creator、target_conversation、result、时间戳。
- **执行器**（仿 SchedulerRunner）：`work:` 专属会话 → `engine.send(工作简报)` → `finishTurn` 钩子读回合终态判断：
  - 模型在终稿里声明「步骤完成，继续」→ `prepareNextTurn` 追加「继续执行下一步」→ continue
  - 声明「需要人」→ end + 把问题推给 target chat，工作项转 `waiting_human`
  - 声明「全部完成」→ end + 交付推送
  - 预算耗尽 → end + 如实汇报进度
- **模型自管理工具** `manage_work`：读/改自己的计划步骤、标记完成、申报完成或求助——结构化自管理代替纯靠终稿措辞。
- **进度播报**：执行器起 interval 复用 `engine.progressBrief` 推 target chat（心跳推送的自主版）。
- **看门狗**：为 `work:` 会话补 stall 看门狗（补上 sched 已知的盲区），另加总墙钟预算。
- **权限**：创建者角色随工作项冻结，工具确认门按现有策略（admin 免确认）；执行中到不了的确认 → 自动转 `waiting_human`。
- **急停**：admin 在 target chat 发「停止工作」→ 命令通道 abort 活动工作项 → cancelled。

- ✅ 结构化计划抗漂移；状态机清晰（人可查可管）；预算/止损/急停完备；报告与知识沉淀天然衔接
- ❌ 新表 + 新工具 + 执行器，工作量中等（估计 2~3 个 PR 的量）

### 方案 C：全自主巡检（环境循环）

员工常驻后台循环：每隔 N 分钟自查目标清单/知识缺口/收件箱，**自主决定**是否开工。

- ✅ 最接近「数字员工」的终极形态（README 里 vs LobsterAI 的差异化也能兑现）
- ❌ 成本不可控、无价值空转风险高、信任建立期很长
- 定位：**三期**，等 B 跑出信任后再开，且必须戴预算紧箍咒

### 对比结论

| 维度 | A 链式增强 | B 工作项+钩子 | C 全自主巡检 |
|---|---|---|---|
| 改动量 | 小 | 中 | 大 |
| 抗漂移 | 弱 | 强 | 中（靠记忆） |
| 人的控制感 | 中 | 强（状态机可视） | 弱 |
| 成本可控 | 中 | 强 | 弱 |
| 建议 | MVP 备选 | **一期做** | 三期 |

---

## 四、一期落地设计（方案 A：自主定时任务）

在现有定时任务上加「自主」模式，不引入新实体：

1. **数据模型**：`scheduled_tasks` 加列 `autonomous`（0/1）、`max_turns`（默认 20）、`max_minutes`（默认 120）、`chain_state`（JSON：`{ convId, turns, startedAt, pending }`）。沿用现有迁移模式（PRAGMA + ALTER）。
2. **完成/请示信号**：模型用文本标记自申报——终稿末行 `[[TASK_DONE]]`（完成）或 `[[NEED_HUMAN]]: 问题`（需人工）。runner 逐轮解析，推送前剥掉标记行。相比每轮旁路评估调用：零额外成本、确定性解析；漏发标记则链继续直到预算（有界）。
3. **执行循环**（runner 内）：同一 `sched:` 会话逐轮 `engine.send`：
   - done → 推送成果 + 汇报中心发布，链结束
   - need_human → 推送问题 + 「回复「继续 <任务名>」并附答案可续跑」，链转 pending=human
   - 预算耗尽（轮数/墙钟）→ 推送进度 + 「回复「继续」续跑（预算重置）」，pending=budget
   - 否则注入「继续」前缀进入下一轮（每轮推送轮次进度）
4. **续跑**：新增 `resume_scheduled_task` 工具（admin 或创建人），pending 链立即恢复：同一会话、预算重置。等待人工期间的新 cron 触发直接跳过（防止分叉）。
5. **权限**：完全沿用现有模型——执行身份＝创建人当前角色；operator 创建的任务以 operator 身份执行，高危工具按现行规则拒绝/请示。
6. **超时**：SchedulerService 的单次运行超时改为按任务计算：自主任务 = `max_minutes + 30min` 余量，普通任务维持 1h。
7. **进度播报**：每轮结束推送轮次进度（第 N/M 轮 + 尾部摘要）；回合内复用 `progressBrief` 心跳（runner 自建 interval，逻辑同 IM manager）。
8. **纯函数模块** `src/scheduler/autonomous.ts`：标记解析、预算判断、轮次前缀构建——全部可单测，runner 只做编排。

## 五、风险与开放问题（一期后复盘）

- **循环失控**：预算上限 + 逐轮判定 + 「继续」需人确认，三道保险；max_turns 默认 20。
- **费用可见性**：自主任务的 token 消耗要单列遥测，避免月底账单惊吓。
- **「完成」判定质量**：文本标记自申报有漏发/误发风险——漏发靠预算兕底，误发（提前报完成）二期可用廉价旁路校验对照。
- **与定时任务的关系**：定时任务是「到点做一件明确的事」，自主模式是「到点朝目标持续推进直到完成或请示」；二者同一实体、同一入口，只是执行循环不同。二期工作项模型（方案 B）承接更复杂的目标管理。
- **开放问题（二期复盘）**：
  1. 自主执行中的确认门拒绝（operator 角色遇 run_command）目前表现为工具报错由模型自行调整，是否要升级为主动转 waiting_human？
  2. 预算重置上限（防「继续」无限续）？
  3. 控制台可视化链状态时间线？
