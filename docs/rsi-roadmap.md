# RSI 路线：让这个员工自己迭代

本文是 2026-09-15 对「怎么让 agent 自动迭代」的研究结论与落地状态。**顺序不能颠倒**：没有度量的自动迭代只会改出更啰嗦的提示词、更松的门禁、更配合自己的测试。

## 结论：四要素里已有三个，缺的是反馈信号

| 要素 | 现状 |
| --- | --- |
| 自我修改面 | ✅ `prompt.rules` 可整体替换工作准则；`save_to_skill` 写技能且技能全文注入提示词（当场生效）；`remember` / `save_to_knowledge`；`manage_settings` 改自身配置；`manage_update` 装自己的新版本 |
| 验证设施 | ✅ 9 个套件、约 90 项断言（esbuild 打包 + `node --test`；browser/computer/shell 打真 Chromium 与真子进程） |
| 部署链路可脚本化 | ✅ `npm run package:win` → `npm run release`（上传 Gitee + HEAD 校验），机上 `manage_update` 即装 |
| **反馈信号** | ❌→✅ 0.2.63 起有：此前回合级成败只存在于日志与瞬间，模型无从知道自己哪儿反复失败 |

## 第 1 层：度量（已发布，0.2.63）

- `turn_events`：每回合一行——状态（ok / error / aborted / empty_reply / deterministic_failure）、耗时、工具调用数、重试、工具步数封顶、空回复、兜底、中断原因、回复长度，以及「用户当场纠错」这个**弱标签**（只存布尔，不存原话）。
- `tool_events`：每次工具调用一行——名称、耗时、是否失败、**是否被权限拒绝**、错误串（截断存储）。
- 写入点：`engine.ts` 的 `send` → `recordTurnTelemetry` / `recordToolTelemetry`；`definition.ts` 的 `withTelemetry` 包裹**全部**工具，且位于 RBAC guard 之外，所以权限拒绝被记为拒绝而不是静默通过。
- 工具 `my_stats`（能力 `telemetry`，operator 起）：回答「你最近表现怎么样 / 为什么老失败」。默认只看本会话；`scope=all` 看全部会话**仅管理员**。空窗口如实报「没有数据」，不显示成「一切正常」。
- 隐私：纯本地、不发外部服务、错误串截断、90 天自动清理、不存消息原文。
- 测试：`npm run test:telemetry`（7 项）。

**下一步（未做）**：把弱标签做细（同一请求重试、报告被要求重做、IM 表情反馈），因为奖励信号的质量决定后面几层能不能用。

## 第 2 层：门禁（0.2.64）

两件事，缺一不可：

1. **发布前置测试门禁**——`scripts/run-all-tests.mjs`（`npm run test:all`）串行跑全部套件，`scripts/publish.mjs` 在上传前调用；失败则打印「REFUSING TO PUBLISH」并退出，**一个字节都不上传**。此前发布只要求 typecheck + 三件产物齐全，一条测试都不跑。
2. **不可变内核的绊线**——`docs/immutable.manifest.json` 列出「不许悄悄漂移」的区域，`scripts/verify-immutable.mjs` 比对哈希：

   | 区域 | 为什么 |
   | --- | --- |
   | `prompt-red-lines` | 安全红线：凭据不得进回复 |
   | `prompt-integrity` | 数据真实性：禁止编造业务数据（用户红线） |
   | `rbac-gate` / `rbac-defaults` / `rbac-trust-boundary` | 权限判定、默认策略表、本机 vs 远端信任边界 |
   | `tool-gates` | 「必须是单聊」与「确认」口令的解析 |
   | `updater-breakers` | 自动更新熔断阈值（坏版本的最后一道网） |
   | `publish-target` | 发布上传目标，不可被静默改指 |
   | `test-prompt` / `test-permissions` / `test-immutable` | 守护上述红线的断言本身 |

   命中时发布被拒，除非人用 `IMMUTABLE_ACK="为什么改" npm run release` 显式放行——**理由会被打印**，不是静默通过。
   区域用源码里的 `// #region immutable:<id>` 标记，边界写在读代码的人眼前，而不是只存在于某份清单里。

   **诚实的边界**：这是绊线，不是密码学边界——能改被守护文件的人也能改清单与校验脚本（清单自身的哈希被钉在校验脚本里，所以改它必须同时改脚本，是最显眼的一种 diff）。真正的兜底是人看 diff；它的作用是让护栏变更**不可能不被注意**。

3. **回滚目标**——发布时额外留一个版本 tag 的 release（保留最近 3 个），`latest` 仍是最新（自动更新源）不变。此前每次发布 delete+recreate 会吃掉上一版安装包的链接：既回不去，也没有稳定链接可给别人。

回归保护：`npm run test:immutable`（4 项）盯住「清单没被偷偷删条目」「区域标记没在重构中丢掉」「清单自身的 pin 没被移动」「publish 真的接了两个门禁」。

## 第 3 层：提案回路（未做）

一个每周跑的 `sched:` 任务：读遥测 → 聚类同类失败 → 产出 `docs/proposals/<date>.md`（证据 / 假设 / 拟改什么 / 如何验证）→ 推给管理员单聊确认。**这一条是把「人肉 relay」变成产品的地方**，也是机上 agent 唯一现实的形态（见下）。

## 第 4 层：配置/提示词 A/B（未做，性价比最高）

`prompt.rules`、技能描述、检索参数是**热数据**：改完不需要重新打包发布，`markConfigChanged()` 下个会话就重建提示词。所以可以做：离线评测集（从真实 transcript 抽「给什么输入、期望什么行为」）→ 变体生成 → 打分（规则类用代码断言，开放类用 judge 模型）→ 只留优胜者 → `prompt_history` 表支持回滚。注意 `prompt.ts` 里的常驻块（安全红线、数据真实性、权限/身份规则）只能动可编辑部分。

## 第 5 层：代码层闭环（未做，必须留人门）

提案 → 分支 → 跑测试 → 第二模型评审 diff → **人一键批准** → package → release → canary 观测遥测 → 自动回滚。开之前必须有第 2 层（已具备）。模型权重层不做。

## 现实约束（别忘）

- **源码不在跳板机上**：那台机器跑的是打包后的 app，没有 repo、没有 electron-builder，而且 GitHub 不可达、只通 Gitee。所以机上 agent 的现实形态是「**提提案 + 附证据**」，实现与发布在开发侧完成，人只做一键批准——即把今天的 relay 模式工程化，而不是让机器自改自发布。
- **爆炸半径**：那个 profile 里是明文 LLM API key、钉钉 appSecret、Gitee/OSS 令牌、带登录态的浏览器 profile，机器还对交易系统有访问权。任何「自主改代码 + 自主发布」的设计都必须假设这四条会被滥用——这就是第 2 层不可跳过的原因。
