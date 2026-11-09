# Router/Worker 单内核核心设计：pi-agent-core + RouterSession/WorkSession + 上下文层

> 状态：设计稿 v1（2026-11-09），待评审。
> 决策背景（用户 2026-11-09 裁定）：
> 1. **崩溃恢复不是第一要义**——步级持久执行（pi-durable 的 checkpoint 语义）先放一放，恢复降级为「任务级标记 + 恢复简报」。
> 2. **VE 自建上下文管理之后，pi-session 与 durable 的存在理由消失**——回退 pi-agent-core 单内核。
> 3. 现在要做的是完整的 bot 能力：**router/worker 任务处理、上下文管理、记忆管理**，这三件事按本设计开发好，之后再解决别的问题。
>
> 前置阅读与关系：
> - [`router-worker.md`](router-worker.md)：两级架构思想基准（Router 只交互派发 / Worker 隔离执行 / 会话是实现细节）。本文件是它的落地版。
> - [`context-management.md`](context-management.md)：Inline & Spill + Chain of Recall 注入方法论。本文件的上下文层（§6）以它为注入纪律。
> - [`crash-recovery.md`](crash-recovery.md)：当年选 pi-durable 的论证。本文件 §9 正面降级其目标。
> - [`superagent-response-latency.md`](superagent-response-latency.md)：Router 热点化的前车之鉴。
> - dsh-superagent-prototype（deepseek-ai，2026-11-09 调研）：任务持久化参照——Trigger 幂等 / Eval 批合并去重 / 不自动复活 / 恢复简报自愈。

## 0. 结论先行

**一个内核（pi-agent-core `Agent`），两类会话（RouterSession / WorkSession），一个上下文层（CCL）。**

- 引擎不再拥有上下文：内核只负责「执行一个回合」，上下文的拥有、装配、压缩、记忆注入全部上收到 VE 自己的层。
- 任务处理沿用 WorkItem/WorkService 既有骨架，补齐 dsh 已验证的四条语义：Trigger 幂等、评估层去重、失败不自动复活、资源预算。
- kernel 矩阵（legacy / pi-session / durable）整体拆除。当年引入三内核要解决的问题（崩溃恢复、扩展宿主、流式），或降级、或已有 VE 层等价物、或随拆除消失。

## 1. 决策理由

### 1.1 kernel 矩阵是事故的主要来源

2026-10 → 11 的现场事故里，凡带「×内核」字样的都是组合爆炸的产物：

| 事故家族 | 根因形态 |
|---|---|
| 进度汇报四处静默门（v0.2.173/175/176） | durable 从不设置 `agent.state.isStreaming`，legacy 才有——同一语义两处实现漏改 |
| widget 流式（v0.2.179 + 凭据 holdback） | durable 不走 `agent.subscribe`，被迫另做一条事件翻译管道 |
| MCP 热更（v0.2.183/184） | durable 的 registration 冻结在 open 时刻，与 legacy 生命周期不同 |
| flood-loop 永动机（v0.2.198，2026-11-06） | durable cycle-loop 掐 turn × WorkService 顺延复活——两个「恢复语义」叠加成永动机 |
| 恢复风暴（现场 2026-11） | durable 每条 IM 消息=一个 submission，恢复时逐个 redrive：用户重发 3 次「查天气」→ 3 个任务全部恢复执行 |

**单内核不是简化，是消灭一整类 bug。**

### 1.2 durable 的上下文模型本身就是「丢历史」的主因

每回合 `createConversation` + 从 UI 薄历史（纯文本 user/assistant 行）导入（`runtime.ts:394` `init` → `history.listMessages`）→ **回合间的全部工具调用、工具结果、执行过程不跨回合存在**，project 只回写最终回复文本。v0.2.167 durable 化之前，进程内 transcript 是全量的——这就是「现在经常在一个对话中丢对话历史」的回归点。压缩（pi-durable harness 侧）只作用于单回合会话内，且用 pi-ai 的字符÷3.5 估算器，**无 CJK 感知**，中文长对话压缩严重迟到（0.2.67 在 legacy 层修过的坑在新内核重新出现）。

### 1.3 「引擎持有上下文」违背两级架构基准

两级架构基准（router-worker.md）明确：**会话是系统的实现细节，不是用户的心智负担**。把上下文语义埋进三个内核，导致换内核=换记忆行为（`degradeToLegacyKernel` 静默降级时用户对话「突然失忆」），这从根上就是错的。上下文必须上收为 VE 的一等层，内核降级为可替换执行器。

## 2. 目标（可验收）

1. **单内核**：全部会话执行在 pi-agent-core `Agent` 上；`general.engineKernel` 配置退役；`degradeToLegacyKernel`、pi runtime 引导器（`ensurePiRuntime` 三源装机链）删除。
2. **RouterSession**：每个 trigger（IM 会话 / GitHub hook / 控制台 / 定时触发）一个会话身份；简单请求 router 直接回答（可用轻模型）；任务型默认派发 worker；一次推理期间到达的消息**排队合并**进下一轮判断。
3. **WorkSession**：每个 WorkItem 一个 `work:<id>` 会话；上下文隔离；只向来源 trigger 汇报（进度泵 + 结果回投，既有件）。
4. **重复请求合并**：同一 trigger 内用户连发 N 条相同/相似请求 → 合并为一次判断，至多一个 open WorkItem（验收：3 次重发「查天气」只产生 1 个工单、1 次执行）。
5. **失败不自动复活**：worker 失败/暂停停住等人，只有用户消息或显式重试指令才重入；**重启的 working 任务一律「标记结束 + 恢复简报」重新入队，绝不静默续跑**（验收：kill -9 后重启，不存在任何未被用户感知的自动执行）。
6. **上下文管理**：CCL 落地，worker 跨窗口的工具摘要可见（验收：worker 第二个窗口能引用第一个窗口查过的数据要点，不再「拿自己任务的产物答别的任务」之外还要「忘了自己查过什么」）。
7. **记忆管理**：人/群/任务三级记忆在 router 与 worker 两侧一致注入；任务完成后结果摘要可被后续会话检索（Chain of Recall 第一跳，见 context-management.md §3）。
8. **资源预算**：worker slots 上限（现有 5）、回合时长预算（现有 maxMinutes）、全局 Pause 开关。

## 3. 非目标（本期明确放一放）

- **步级崩溃恢复**：不做工具副作用幂等重放、不做中断回合无缝续跑。durable 的 checkpoint 语义整体放弃；残余风险=进程崩溃时正在执行的回合丢失，重启后该任务以恢复简报重入队（当前步重跑）。缓解：升级重启仍走「engine idle 才重启」更新门（既有），纯崩溃是小概率事件。
- **pi 插件宿主**：pi-session 的扩展运行时能力放弃。VE 的技能/MCP 连接器均为自有实现，不受影响。
- **水平分片**：单 RouterSession 跟不上再议（两级架构基准的未来选项）。

## 4. 架构总览

```
Trigger 来源（Source）
  IM 钉钉/飞书  ·  GitHub hook  ·  控制台/widget  ·  定时与自主
        │  入口层：幂等键（平台消息 id）+ 读位点 + 归一化为 Trigger 事件
        ▼
RouterSession（每 trigger 一个，主会话不做长活）
  ├─ 批处理：推理期间到达的事件排队，下一轮合并判断
  ├─ 确定性 triage（looksLikeTask + plan 旁路 + 长耗时动词表）——主路径，不花 LLM
  ├─ 灰色地带 → Router LLM 判断（对照在办/已办工单列表去重）
  ├─ 简单请求 → 直接回答（ContextBundle + 轻模型可选）
  └─ 任务型 → 开 WorkItem（唯一交接凭证）→ WorkService 派发
                ▼
        WorkSession（work:<id>，全套工具 + 强模型）
          · CCL：ContextBundle 装配 + TurnRecord 步级摘要
          · 进度 → 进度泵（taskProgressMin 节奏，既有）
          · 结果 → delivery ledger 回投来源 trigger（既有）
                ▼
CCL（Conversation Context Layer，src/context/，新）
  · ContextStore：append-only 事件账本（TurnRecord）
  · ContextBundle：下一回合模型该看什么（装配/压缩/记忆注入）
  · Inline & Spill 预算纪律（context-management.md）
```

## 5. 概念与规则

### 5.1 与 dsh-superagent 的概念对照

| dsh 概念 | VE 对应物 | 差异说明 |
|---|---|---|
| Source | trigger 入口层（im/adapters + 未来 hook） | VE 已有 IM adapters；读位点为新增 |
| Trigger | 归一化的入站事件（现有 InboundMessage 扩展） | 补幂等键与不可变存储 |
| Thread | trigger 身份（= 现有 conversationId） | 一致 |
| Eval | triage（确定性）+ Router LLM 判断（灰色带） | VE 已有 triage/planner；补批合并与去重输入 |
| Ticket | **WorkItem**（db/work-item-store，已有） | 状态机形状一致：queued/working/waiting_human/done/error |
| Mandate | RBAC + 会话门槛 + 单次授权（已有） | VE 的授权体系更细，直接复用 |
| Executor / Executor Session | **WorkSession**（`work:<id>` 会话） | 由 engine 直驱 pi-agent-core Agent |
| Channel | 投递通道 + delivery ledger（已有） | 一致 |
| Panel | 控制台 + widget（已有） | 补「需要人处理」优先视图（后置） |

### 5.2 关键规则（从 dsh 吸收，逐条落到 VE 件上）

1. **Trigger 幂等**：入站消息以平台消息 id 为幂等键落账；同一 trigger 的重复消息**合并进同一判断批次**，不各自成任务。
2. **去重在评估层**：triage/Router 判断的输入必须包含该 trigger 的在办与最近完成工单（标题 + 一行结论 + 状态）；同义请求指向 open 工单时**合并/续问**，不开新单。
3. **状态机解耦**：WorkItem 状态不跟随 WorkSession 进程——WorkSession 崩了，WorkItem 的状态、授权、待办输入完好，新 WorkSession 接上（WorkItemStore 已是这个形状）。
4. **失败不自动复活**：`error` / `waiting_human` 停住等人；临时性错误（408/429/5xx/超时）才有界重试（3 次退避）；**任何「顺延复活」「自动重启窗口」语义删除**（flood-loop 的根因语义）。
5. **恢复=标记结束+简报**：重启后 working 任务标记 `interrupted`（error 的子态），带恢复简报重新入队；简报=TurnRecord 摘要 + 「先核对现场再重复任何外部动作，最老任务优先」。恢复简报是**给人看、也给模型看**的，不是静默续跑。
6. **资源预算**：worker slots=5（既有）+ 回合 maxMinutes（既有）+ Pause 开关（新增，§8.5）。后台脚本随回合收尾清理（0.2.213 已落）。
7. **Router 不亲自执行**：RouterSession 不配长活工具（对齐两级架构基准）；直接回答仅限无需工具链的问答/查询。

### 5.3 群聊 / 单聊分叉（同一骨架的两种 profile）

**总原则**：不是两套机制——triage → 直接回答/派发 → WorkItem → CCL 主干完全共用，分叉只在门槛与注入点上；做成两套代码 = 重蹈 kernel 矩阵覆辙。

**平台事实（钉钉，2026-11-09 确认）**：群聊机器人**只能收到 @ 它的消息**（Stream 模式投递策略，非代码选择；adapter 无群消息过滤，`normalizeInboundText` 仅剥离 @ 前缀）；单聊收到全部消息。此差异由 Source 的 event 定义吸收（dsh："Source defines what counts as an event"），Router 不感知；未来飞书（可配置收全量）经同一抽象接入，Source 声明 `receivesAllMessages` 能力位。

| 维度 | 单聊 | 群聊 |
|---|---|---|
| 进入门槛 | 全部消息到达，全进 | 平台 @-only，**到达即相关**，Router 无过滤逻辑 |
| 判定批 | 单 actor，批=1 | **按 actor 分组合并**：同人重发/补充合并为一个请求；跨人不合并请求、同批多 Decision |
| 长任务阻塞 | — | **不阻塞他人消息**：判断走批快路径，执行在 worker（废除会话级串行对群聊的阻塞——router-worker.md 的原始痛点在此消除） |
| 直接回答 | 主模型、详尽 | @ 才答、短答优先；轻模型做成 per-conversation 配置（重要群可配主模型，待拍板） |
| 追问/中途指令 | 直接说 | 必须再 @；指向判断（工单号/关键词/回复进度消息）+ RBAC：owner/admin 才能改/停，他人只读进度（角色下限待拍板，推荐 viewer） |
| done 复活 | 创建人续单 | 创建人续单按当前角色复验 Mandate（降权立即生效既有语义）；他人仅只读查询 |
| 记忆 | person+conversation 全量注入 | conversation 共享 + person 仅该 actor 回合注入，带披露护栏（§7 打通契约） |
| 播报 | 诚实详尽 | speaks-only-when：失败/需人才开口；进度按泵节奏；短答 |

**半盲边界（设计提醒）**：群聊里机器人看不到成员之间的对话——「按刚才说的改」类指代必须靠用户 @ 时把结论带上，或靠工单标题/结论 inline 与任务边界简报补偿（context-management.md 断链清单）。补充通道：回执/进度模板显式引导「补充信息请继续 @我」；AI 卡片输入组件、钉钉群历史拉取合规性为后置调研项（未查证，不承诺）。

## 6. 上下文层（CCL）

### 6.1 定位与两个原语

新目录 `src/context/`。上下文的**拥有者**，三类会话（router / work / 直接回答）共用；注入纪律遵循 context-management.md（Inline & Spill + Chain of Recall）。

```ts
/** 一回合的归一化记录（append-only，sqlite 账本） */
interface TurnRecord {
  conversationId: string;      // trigger 身份 或 work:<id>
  seq: number;                 // 账本内序号
  kind: "request" | "reply" | "tool-digest" | "steer" | "delivery" | "system";
  text: string;                // 用户原文（去脚手架）/ 最终回复 / 工具摘要 / 投递事件
  toolDigest?: { name: string; argsBrief: string; resultBrief: string; artifacts?: string[] };
  refs?: string[];             // 关联对象 id（work:<id>、kb 条目、person）——Chain of Recall 的边
  ts: number;
}

/** 下一回合模型该看什么（装配产物，进内核前最后形态） */
interface ContextBundle {
  systemPrompt: string;
  messages: AgentMessage[];    // 摘要链 + 最近逐字窗口 + 工具摘要行
  memoryPrefix?: string;       // 人/群记忆前缀（已按相关性裁剪）
  budget: { estimatedTokens: number; window: number };
}
```

### 6.2 装配规则（三类会话一张表）

| Bundle | 摘要链 | 逐字窗口 | 特有 Inline |
|---|---|---|---|
| RouterSession | trigger 内历史压缩摘要（curated 模板，CJK 感知估算） | 最近对话窗 + 在办工单标题行 | 人/群记忆前缀、活跃成员摘要（context-management.md 断链清单） |
| WorkSession | 本任务 TurnRecord 工具摘要链 | 本窗口内全量 | 任务边界简报（收编 `withWorkerTaskBrief`）+ 来源会话相关任务摘要 + 任务记忆 |
| 直接回答 | 同 RouterSession | 最近对话窗 | 同 RouterSession |

### 6.3 压缩与估算（收编既有件，一处实现）

- 估算器：`estimateTokensSafe`（CJK 1 字 1 token，与 pi 估算取大）从 `engine/context.ts` 移入 CCL，成为**唯一**估算口径——不再有「legacy 修了 durable 没修」的分裂。
- 压缩：`maybeCompact` 的 curated 摘要模板 + 摘要链（chained summary）收编为 CCL 的 `compactIfNeeded`；阈值按 `usableContextWindow`（窗口−输出预留）计量。内核不再自带压缩（pi 的 auto-compaction 关闭）。
- `rehydrateMessages` 的 40 行硬截断废除：重建一律走 ContextStore 账本按 token 预算装配。

### 6.4 与内核的窄接口

```ts
// 内核适配只剩两个动作：
const bundle = ccl.buildContext(conversationId);   // 回合开始
agent.prompt(...)；回合结束 → ccl.commitTurn(conversationId, turnRecord);
```

pi-agent-core `Agent` 每回合由 bundle 种入 `initialState.messages`；进程内 transcript 不再跨回合积累（它只是本回合的执行现场），跨回合记忆完全由账本+装配决定——**丢历史问题在这一步结构性消失**，且未来任何执行器替换都不再改变对话行为。

### 6.5 上下文分区与隔离（铁律）

**上下文按 trigger 硬分区，对象按权限软共享，跨会话只走显式引用。**

- 单聊 `dt:<staffId>` 与群聊 `dt:group:<cid>` 是不同 trigger 身份 → 不同 RouterSession → 不同账本分区 → 各自装配的 ContextBundle。「一个 Router」指逻辑层一套规则，**不是**所有对话共享一个大 transcript——隔离由结构保证（账本分区 + 装配按分区读），不靠模型自觉。dsh 对照：其 Main Session 物理上全局一个，但 Eval 是无状态裁决（只喂当前 Thread 快照 + 本批 Trigger + 工单列表）——隔离靠输入结构化；VE 的形态 A（每 trigger 一个会话）比它更硬一层。
- **对话流**（聊天历史、压缩摘要、回合工具轨迹）：严格 per-trigger，跨会话零共享。
- **工作对象**（工单、任务结果、记忆、知识）：按权限全局可查，跨会话仅经**显式引用**（工单号/任务名解析）进入当前回合，绝不沉淀进其他会话的账本。dsh 规则采纳：*Correlation adds context; never routes*。
- Router 判断的输入只带本 trigger 的在办工单（含创建人）；「我的工单」跨 trigger 只读查询是显式动作（WorkItemStore 全局表，既有）。
- 典型场景校验：用户在单聊说「把群里那个对账任务停了」——单聊 RouterSession 看不到群的**对话**（正常），但可通过跨会话工单查询定位并操作**工单**（权限校验后执行）。

## 7. 记忆管理

1. **三级贯通，注入点统一在 CCL**：
   - **profile 级**：系统提示（既有 `listMemoryIndex`）。
   - **person/conversation 级**：回合前缀按相关性召回（既有 `listScopedMemoryIndex`）——**router 与 worker 都注入**（现状：durable 主回合不注入，是回归；本设计修复）。
   - **task 级（新）**：WorkItem 完成/暂停时，`{taskId, 标题, 一行结论}` 写入来源 trigger 的可检索层——「上次那个对账」从此有第一跳抓手（context-management.md 已立项的断链 2/3）。
2. **写入触发**：worker 收尾 learn 回路（既有）+ router 在直接回答中判定的 remember 请求（既有 remember 工具），全部经 CCL 的记忆服务，规则不分叉。
3. **预算纪律**：每级注入块常量化预算（MEMORY_RECALL_LIMIT 模式），超限按局部性裁剪（当前消息相关性 > 时间相邻 > 空间相邻）。
4. **人级记忆跨单聊/群聊打通（2026-11-09 裁定：打通，落地为契约）**：person 记忆 owner 键 = `person:<渠道族>:<staffId>`（memory-scope.ts），不含会话维度——单聊写、群聊召回（反向同理）**现有实现即如此**；本设计把它从「顺带正确」升级为有测试钉住的契约：
   - 契约测试：单聊写 → 群召回；群写 → 单聊召回；他人记忆零泄漏；群回复披露护栏断言。
   - 边界明示：owner 键含渠道族——钉钉与 widget 记忆不互通（身份族不同）；双 profile 同 staffId 现状互通，与「双 agent 独立」裁定的冲突见 §12 开放问题。

## 8. 任务处理细则

### 8.1 分诊决策表（确定性优先）

| 输入特征 | 动作 |
|---|---|
| 命中在办工单（同义/追问） | 合并进该工单：追问内容作为 Input 递给 worker（steer/等待语义既有） |
| `looksLikeTask=false` 或问句 | router 直接回答 |
| 任务型 + plan ≥2 步 + 长耗时动词 | 开 WorkItem 派发（回执：规划卡片 + 「已转后台」，既有） |
| 灰色带（LLM 判断） | 批合并后对照工单列表判断；fail-open 维持前台 |
| 用户「前台执行」 | 取消 convertible 工单，前台重跑原指令（既有逃生门） |

### 8.2 重试与复活边界

- 临时性错误：3 次退避重试（发送层既有 retry ladder）。
- 结构性失败：`error` 态停住；**删除 WorkService 的自动顺延复活语义**；`waiting_human` 只被人消息解除（0.2.45 的重提醒陈旧性防御保留）。
- 重启：working → `interrupted` → 恢复简报 → 重新入队（`recoverWorking` 既有，改简报内容）；`done`/`error`/`waiting_human` 不动。

### 8.3 进度与投递

- 进度：全局进度泵（既有，v0.2.197 修复版）+ TurnRecord 步摘要作为「最近进展」素材。
- 投递：delivery ledger（既有）继续兜底幂等与 uncertain 语义；结果全文回投来源 trigger 不变。

### 8.4 新增 Source：GitHub hook（后置 Phase 4）

入站 webhook → 幂等键（delivery id）→ 归一化 Trigger → 对应 RouterSession。dsh cookbook 008 的「adding a Source」模式，本期只留接口位。

### 8.5 Pause 开关（新增）

`manage_pause`（admin）：停派发、停分诊判定、停进度推送；Source 照记账、在跑回合不打断。恢复后按批处理消化积压。flood 迹象的兜底闸（替代「暂停 scheduled item」这种手工止血）。

## 9. 恢复语义（对 crash-recovery.md 的正面降级）

crash-recovery.md 选 pi-durable 的论据是「工具调用不落库，崩溃后不知道做到哪步」。本设计以三件事替代步级 checkpoint：

1. **升级不再打断回合**：engine idle 才重启的更新门（既有）已把升级窗口与执行窗口错开。
2. **任务级状态机恢复**（既有 `recoverWorking` + redrive 语义保留但**去掉自动顺延**）。
3. **TurnRecord 恢复简报**：重启后 worker 第一窗口注入「已恢复；此前进度：[步摘要]；先核对现场（文件/浏览器/远端）再重复任何外部动作」。dsh 同款哲学：**状态可审计 + Agent 面向现场自愈**，而非事务级续跑。

残余风险（明示接受）：纯崩溃瞬间正在执行的单步丢失，重跑当前步。相比 durable 方案的代价（恢复风暴、丢历史、维护面），这是正确的交换——用户 2026-11-09 裁定确认。

## 10. 现状复用与拆除清单

| 处置 | 对象 | 说明 |
|---|---|---|
| **复用不动** | WorkItemStore / WorkService（去自动顺延）、triage/planner、进度泵、delivery ledger、进度/停滞 watchdog（单路径化）、RBAC/授权、KB 与记忆存储、更新门、后台脚本收尾（0.2.213） | 全部既有已验证件 |
| **收编进 CCL** | `engine/context.ts`（估算/压缩/锚点）、`withTurnMemoryPrefix`、`withWorkerTaskBrief`、`rehydrateMessages`、`progressContextSlice` | 一处实现，三类会话共用 |
| **删除** | kernel 矩阵与 `opts.kernel` 全部分支、`DurableRuntime` + `durable/*`（harness-host/ve-tools/runtime…）、`degradeToLegacyKernel`、`ensurePiRuntime` 引导器与 pi-runtime-lock、`engineKernel` 配置项及 0.2.167 迁移逻辑、durable sqlite（存档不删） | 拆除即收益 |
| **新增** | `src/context/`（ContextStore/ContextBundle/TurnRecord）、trigger 入口层幂等键与读位点、Pause 开关、task 级记忆写入 | 唯一的净新增面 |

## 11. 阶段计划（每阶段独立 PR、独立可回退）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1 上下文层** | `src/context/`：TurnRecord 账本 + ContextBundle 装配 + 估算/压缩收编；先只接 WorkSession（`work:<id>` 直驱 pi-agent-core Agent，替换 durable work 路径） | worker 第二窗口能引用第一窗口的工具结果要点；单一估算口径测试钉死 |
| **P2 RouterSession** | IM 会话层收编：trigger 身份化 + 批合并 + 分诊决策表 + 直接回答/派发；Trigger 幂等与读位点；删除自动顺延复活 | 3 次重发合并为 1 工单；重启后无任何未感知自动执行 |
| **P3 单内核切换** | 全部会话（console/widget/sched）切 CCL+pi-agent-core；恢复简报；Pause 开关；`engineKernel` 退役与存量迁移（carry-forward 模式） | 全量门禁绿（`npm run test:all` / `typecheck` / `verify:immutable`）；盒子发布窗口灰度 |
| **P4 后置** | task 级记忆检索闭环、GitHub hook Source、panel「需要人处理」视图、durable sqlite 归档清理 | — |

## 12. 风险与开放问题

1. **RouterSession 热点化**：批合并 + 轻模型 + 「不亲自执行」纪律必须同时落地，否则重蹈 superagent-response-latency.md。开放问题：Router 直接回答是否也走工具（倾向：只读查询白名单）。
2. **worker「看现场」自愈弱于 coding agent**：dsh 的 Executor 是 coding agent（目录+git 即现场）；VE worker 有浏览器/远端会话类任务，恢复简报质量依赖 TurnRecord 摘要——P1 的工具摘要格式要按「足以重判现场」设计，这是恢复简报的命门。
3. **记忆注入 token 预算**：三级记忆 + 成员摘要 + 工单标题行同回合注入，总预算上限与裁剪优先级要在 P2 定参（context-management.md 的 Spill 纪律）。
4. **迁移期行为切换**：P3 上线即切，不做双跑（双跑=第二套语义，正是本设计要消灭的）；盒子切换走发布窗口 + 当次确认（惯例）。
5. **durable sqlite 存档**：历史审计数据保留但不再读取；P4 决定保留期。
6. ~~群聊多发送者 × RouterSession 身份~~ **已收敛**（2026-11-09）：actor 是 Trigger 的 metadata（dsh 语义采纳），分叉规则见 §5.3，分区铁律见 §6.5，记忆打通契约见 §7。
7. **群聊轻模型与只读权限细则（待拍板）**：直接回答降轻模型建议做成 per-conversation 配置（重要群配主模型）；群内非创建人只读进度的角色下限推荐 viewer 即可。
8. **双 profile 记忆互通边界（待拍板）**：personOwner 无 robotCode 维度，同 staffId 两个 profile 间记忆互通——与「双 agent 独立」裁定的关系需 P2 前定（加维度 = 隔离，维持现状 = 打通）。
