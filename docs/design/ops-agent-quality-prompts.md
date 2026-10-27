# 运维型 VE 的质量提示词：适配边界与 Hermes 源码调研

> 真实意图：VE（运维/助理型 IM 机器人）出现「没查日志就给原因」的编造诊断。用户问：quality-prompt（面向编码 agent）能否直接内置，并要求参考 Hermes 的内置提示词。
> 日期：2026-10-27　状态：调研完成（待评审）
> 外部源码：NousResearch/hermes-agent @ `89a6e05de462768016b2ae0d684338e3cce3f3ee`（gh api 直读，未降级）

## 结论先行

**整包内置 quality-prompt 不可行；按 Hermes 的分层方式筛选后可行。**

Hermes 自己就是证据：它的编码规则（`CODING_AGENT_GUIDANCE`，coding_context.py）**只在交互式表面 + 代码工作区才加载**：

```python
# coding_context.py:33
INTERACTIVE_CODING_PLATFORMS = {"cli", "tui", "acp", "desktop", ""}
# _detect_profile(): auto 模式下，messaging 平台（telegram/钉钉类）永远返回 GENERAL_PROFILE
```

IM/定时任务场景从不进编码 posture。VE 是 IM 机器人——按 Hermes 的实践，编码 prompt 不该常驻。

## 1. Hermes 提示词的真实分层（源码实证）

```
┌─ 通用层（所有模型、所有场景，每会话必带）────────────────────┐
│ DEFAULT_AGENT_IDENTITY      直接、简洁、不确定就直说              │
│ TASK_COMPLETION_GUIDANCE    交付=真实工具输出支撑的成果；         │
│                             绝不用编造输出替代真实结果             │
│ PARALLEL_TOOL_CALL_GUIDANCE 独立调用批量发                        │
├─ 模型补强层（按模型门控，auto）────────────────────────────┤
│ TOOL_USE_ENFORCEMENT        说做就必须同回合做（弱纪律模型）       │
│ EXECUTION_GUIDANCE          mandatory_tool_use（时间/算术/系统    │
│                             状态/文件内容必须用工具查）；          │
│                             external_state_verification：         │
│                             「外部写后必须读回目标，成功的工具调用 │
│                             不等于成功的任务」；                   │
│                             missing_context：缺信息先查，          │
│                             查不到就显式标注假设                   │
├─ 场景层 ───────────────────────────────────────────────────┤
│ PLATFORM_HINTS["cron"]      无人值守：不能提问，回复自动投递       │
│ cron _CRON_HINT             [SILENT]/[CRON_FAILURE] 控制 token    │
│ CODING_AGENT_GUIDANCE       仅交互表面+代码工作区（见上）          │
└────────────────────────────────────────────────────────────┘
```

三个对 VE 最有价值的细节：

**① 模型门控有实测依据，不是拍脑袋**。`TOOL_USE_ENFORCEMENT_MODELS` 注释记录：Nemotron 3.5 加不加这些块，SWE-bench 通过率差异 <1 点（p=0.14），所以**不加**——提示词是按「实测该模型有此失败模式」定向补的。

**② 验证门在 messaging 表面默认关闭**。`verification_stop.py`：

```python
# "auto" is the legacy surface-aware mode: ON for interactive coding surfaces,
# OFF for messaging surfaces where the verification narrative is chat noise.
```

编辑代码后没跑测试会注入 nudge（默认 opt-in），但 IM 聊天里不推这个 nudge——**验证叙事对聊天用户是噪音**。

**③ 验证证据是 SQLite 账本，不是模型自觉**。`verification_evidence.py` 记录每次验证命令的 exit code/输出摘要，文件编辑后证据自动标 stale；nudge 文本里直接引用账本状态（"last command X, output summary..."）。这是**机制层**，提示词只是它的出口。

## 2. quality-prompt 逐条适用性（15 条）

| 条目 | 运维 VE | 理由 |
|---|---|---|
| verified vs assumed（区分确认与假设） | ✅ 通用 | 正是这次事故的对症药 |
| 范围纪律（完成全部授权范围） | ✅ 通用 | 运维任务同样适用 |
| 推进纪律（先试再说卡住） | ✅ 通用 | 与 VE 既有「先尝试再下结论」同向 |
| 不可逆操作先确认 | ⚠️ 改造 | 必须服从 VE 无人值守权限契约，不能让定时任务反复要确认 |
| 根因修复 | ⚠️ 改造 | 证据不足时先调查，不能为了「修根因」编一个根因 |
| 验证强制（prove it works） | ⚠️ 改造 | 编码验证=跑测试；运维验证=读回目标/核对新文件/服务健康 |
| 反 reward-hacking | ➖ 场景 | 「不许改测试凑通过」仅在有测试的场景有意义 |
| 惯例遵循/注释密度/注释 WHY-only | ❌ 编码 | IM 回合无意义 |
| 反过度工程/反兼容墓碑 | ❌ 编码 | 同上 |
| OWASP/命令注入 | ❌ 编码 | VE 已有安全红线段（immutable:prompt-red-lines） |
| 探索+复用前置（先读代码） | ❌ 编码 | 编码任务时该由技能携带 |

**约 1/3 通用、1/3 需改造、1/3 纯编码**——整包常驻会浪费指令预算，还可能诱导模型在 IM 任务里跑 typecheck/build 这类无关动作。

## 3. 方案

### 方案 A：整包内置 quality-prompt（上一轮 worktree 的做法）——不推荐

把 15 条全部常驻。问题：编码条目对 IM 机器人是噪音；且那次试接还发现 VE 的 session-host 提示词接线有兼容缺口（占位 prompt 会顶掉 agent 原有提示词）。**该 worktree（`fix/builtin-quality-prompt`）未提交未发布，建议弃用或重做。**

### 方案 B（推荐）：三层落地，对齐 Hermes 架构

**通用层（常驻，进 prompt.ts 内置红线区）**——吸收 quality-prompt 通用条目 + Hermes 执行纪律的运维版：

```text
## 执行与验收纪律（内置，勿删）
- 结论必须有本轮工具证据支撑；没查到就明说「原因尚未确认」，禁止用
  「大概率是网络/应该是推送丢失」这类未验证解释当结论。
- 区分两层成功：① 执行流程走完（exit 0 / 任务 ok）② 业务目标达成
  （数据文件真的生成、内容真的正确）。①不证明②。
- 修改外部系统（写文件/调 API/发消息）后，必须读回目标验证效果；
  工具调用成功不等于任务成功。
- 关键结论注明来源与对应执行时间；后来的重跑成功不能反证先前那次成功。
- 新证据与先前结论冲突时，明确指出修正了什么、依据是什么。
- 缺信息先查（知识库/读文件/重跑采集）；查不到且必须继续时，显式标注假设。
```

**场景层（按需，走 VE 既有技能机制）**：把编码纪律（惯例/注释/测试/反 reward-hacking）做成技能，执行编码任务时 `save_to_skill`/技能市场加载，不常驻。Hermes 的 coding posture 按工作区检测加载，VE 的等价物是技能。

**机制层（已有，保持克制）**：settle-gate 只拦自主任务的完成声明——这与 Hermes「messaging 表面不推验证 nudge」的取舍一致，不动。

### 为什么不用更简单的替代
- 「只加一句禁止编造」：VE 已有数据真实性红线，这次事故证明它管不住**因果编造**——需要上面 6 条里「区分两层成功」「读回验证」「冲突修正」这些操作性规则，一句话不够。
- 「加机械门禁拦『原因是』」：关键词+工具调用计数可被无关调用绕过，误杀正常回答；Hermes 的等价机制（evidence ledger）是**记录+定向 nudge**，不是文本拦截。先提示词，观察能效比再议门禁。

## 4. 最小可验证切片

1. prompt.ts 加「执行与验收纪律」内置段（immutable 区外，跟随红线注入）+ `test:prompt` 断言（自定义 rules 也冲不掉）。
2. 用 02:00 事故做回放测试：把当时的对话喂给带新提示词的模型（eval turn），断言回复包含「未确认/需查日志」而非确定性归因。**这是行为级验证，提示词级测试只是底线。**
3. quality-prompt 插件保持独立 npm 包，不内置；编码技能后续按需建。

## 5. 盲区与待拍板

- 提示词有效性未经现场验证（第 2 步回放测试未做）；提示词纪律 ≠ 机械保证，模型仍可能违反。
- VE 盒子实际内核（legacy/pi-session）未确认——影响后续任何扩展类改动，不影响本方案（prompt.ts 两条路径都走）。
- 待拍板：① 上一轮 `fix/builtin-quality-prompt` worktree 弃用还是保留等方案 B 重做？② 「执行与验收纪律」放 immutable 区（需 ACK 才能改）还是普通内置段？
