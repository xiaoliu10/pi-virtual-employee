# VE 崩溃恢复与中断重连：实现设计

> 目标（用户 2026-10-28 明确）：**进程崩溃 / 升级重启后，正在执行的任务能接续；中断后能重连。** 不是「升级前等一等」那种规避式方案。
> 路径二选一：引入 `pi-durable`（已实测可行）或 VE 自建。本文给出两方案对比、选定路线与第一步切片。
> 状态：待评审。所有关键结论均标注证据来源（代码 `路径:行` / 实测输出 / 官方文档）。

## 0. 结论先行

**选 pi-durable。** 理由不是"它更先进"，而是：

1. VE 要的能力（每步 checkpoint、重启自动接续、工具副作用不重跑、断线重连）是 durable runtime 的核心命题，自建等于重新实现一遍，且要独立维护迁移/崩溃循环/版本兼容。
2. 三个原本被判定为"阻塞"的点，**已实测全部打通**（§2）。
3. 唯一硬约束是 Electron 运行时版本（Node 20.18 → 需 ≥22.19），这是可解的升级，不是设计障碍。

自建方案保留为"若集成试验失败则回退"，不是首选。

## 1. VE 现状：崩溃后到底丢了什么

```text
IM/控制台 → Engine.send → messages 表只写 user/assistant 两条
  → 内存中多轮 模型调用 + 工具调用（不落库）
  → 最终 assistant reply → 投递
崩溃/升级 → 内存全丢 → 只剩"用户说了什么 + 最后回答了什么"
```

关键事实（代码已核）：

| 事实 | 位置 | 含义 |
|---|---|---|
| 消息只有两种角色 | `src/db/history-store.ts:27` `role: "user" \| "assistant"` | **工具调用与结果完全不落库**，崩溃后无法知道做到哪步 |
| 重建只回放消息 | `src/engine/context.ts:66` `rehydrateMessages` | 重启后模型看到的是"上次的问答"，不是"上次干到哪" |
| 会话回放上限 40 条 | `src/engine/context.ts:30` | 长任务连完整对话都可能截断 |
| 自主任务有防护 | `src/db/work-item-store.ts:123` `recoverWorking()` | 唯一有崩溃意识的地方：working → waiting_human（不盲目重试） |
| 遥测不足以恢复 | `src/db/telemetry-store.ts:240` | 只存工具名/耗时/成败，**无参数、无结果、无外部副作用标识** |
| IM 无断线重连 | `src/im/adapters/dingtalk.ts:435` `stop()` | 只能靠 keepAlive，没有应用层重连状态机 |

**结论**：VE 现在能恢复"聊天记录"，不能恢复"执行"。用户要的是后者。

## 2. pi-durable 可行性：四项实测（本次会话真跑）

全部在 `/tmp/ve-durable-recovery-probe/`，被测对象 npm `@earendil-works/pi-durable@1.4.0`（官方 monorepo `packages/durable`），宿主 Node 26，**未集成进 VE**。

### 2.1 双会话崩溃接续（核心诉求）

`probe.mjs`：两个会话各自完成一次工具 → 都进入第二次工具（长挂）→ 第二个开始时对子进程 `SIGKILL` → 新进程重开同一 SQLite → 重注册工具 → 恢复。

```text
Both conversations are mid-tool; killing process.
Recovered submission 8 done
Recovered submission 24 done
PASS: two conversations recovered after SIGKILL; 2 completed calls retained; 2 interrupted unsafe calls not rerun.
```

要点：**已完成的工具没有重跑；执行中被杀的工具（`replay: unsafe` 默认）没有自动重跑**，而是给模型一个 `interrupted` 结果，由上层决定核实还是放弃。这正是"不重复外部操作"的正确语义。

### 2.2 权限不因恢复而丢失（安全关键）

`perm3.mjs`：两个会话不同角色（admin / viewer），工具执行时读 `api.snapshot(ActorDoc, api.conversationId, context)` 判定权限。

```text
工具读到的角色序列(按调用序) = ["admin","viewer"]
重启后从存储读到的角色 = ["admin","viewer"]
```

要点：角色来自**持久化文档而非内存**，所以进程重启后权限判定不变；不存在"恢复后任务以错误身份继续"的窗口。VE 的 `turnActor` 目前是内存 Map，迁移时改为 conversation doc 即可。

### 2.3 VE 收尾门禁能用 `onYield` 承载

`gate.mjs`：模拟 VE 的 settle-gate（看到 `[[TASK_DONE]]` 就要求补一轮验证）。

```text
门禁触发轮数 = 1 (期望 1)
最终状态 = done
会话条目 = pi.assistant -> pi.user -> pi.assistant -> pi.user
```

**这推翻了我上一轮"`agent_before_settle` 无对应事件所以不能迁"的判断**——`GenerationTask.onYield` 支持返回 `{ continue: UserInput }`，语义等价。我之前的结论错在只看事件名集合，没有去读 `onYield` 的返回契约。

### 2.4 业务状态与断线重连原语

`capability.mjs`：

```text
1. 提交/等待接口            done
2. 自定义业务文档           {"items":[{"id":"w1","status":"working"}]}
3. watch 断线重连           window=3条
4. 任务图（UI 展示）        ok
5. storage 路径             openNodeSqliteStorage(file) 支持
```

`watch()` 带 `from` 游标可从断点续推（官方文档「Reconnecting after a drop: only what was missed」），这直接对应"中断重连"里 UI 那一半。

### 2.5 唯一硬约束：Electron 运行时

| 项 | 实测值 |
|---|---|
| 当前 VE | `package.json` electron `^33.2.1`，`ELECTRON_RUN_AS_NODE` 报 **Node 20.18.3**，`require('node:sqlite')` → `ERR_UNKNOWN_BUILTIN_MODULE` |
| durable 要求 | `package.json` `engines.node: ">=22.19.0"` |
| 满足的 Electron | 37 → Node 22.21.1；38 → 22.22.0；39 → 22.22.1（读各自 `DEPS` 的 `node_version`） |

这是**升级 Electron 的任务，不是架构障碍**。需要一并验证 better-sqlite3 的 ABI 重建（`postinstall` 已有 `electron-rebuild`）与现有 native 依赖。

## 3. 两方案对比

| 维度 | A. 引入 pi-durable | B. VE 自建恢复层 |
|---|---|---|
| 每步 checkpoint | 现成（工具调用前提交 intent） | 自己设计表结构与提交时机，易漏 |
| 副作用防重 | 内建 `replay: safe/unsafe` 策略 | 需自建策略 + 每个工具标注 |
| 重启接续调度 | 现成（`resume()`、任务图、崩溃循环上限） | 自建调度器，与现有 scheduler 争夺，极易重复触发 |
| 断线重连 | `watch()` + 游标 | 自建增量协议 |
| 版本迁移 | 内建 task version / migration | 自建，且随业务表变更长期维护 |
| 权限模型 | 已验证可用 doc 承载 | 可用现有 SQLite，改动小 |
| 改动面 | Electron 升级 + 工具/认证/门禁适配 | 集中在 VE 内部，但触及 engine 核心链路 |
| 风险 | API 标 Experimental；一次性大改 | 长期维护成本；边界条件多（半完成外部操作、迁移、并发恢复） |
| 回退 | 灰度开关按会话切换 runtime | 无"回退到现成实现"的选项 |

**选 A**，但**分两阶段落地**，不在一次改动里全量切换。

## 4. 实施路线

### 阶段 0：先把 Electron 升到 37+（前置，独立可验证）

- 升 electron 33 → 37.x，验证：better-sqlite3 重建、`node:sqlite` 可用、打包/自动更新、现有 58 测试套件全绿。
- 这一阶段**不引入 durable**，本身也有价值（Node 22 的安全与性能收益）。
- 验收：`ELECTRON_RUN_AS_NODE` 报 Node ≥22.19；`require('node:sqlite')` 成功。

### 阶段 1：单会话灰度集成（最小可验证切片）

只让**一个指定的 IM 会话**走 durable 路径，其余全部走现有内核。用 VE 已有的 `environmentKernel` 开关扩一档 `durable`。

改动清单：

| 文件 | 职责 |
|---|---|
| `package.json` | 加 `@earendil-works/pi-durable`（固定版本，不用 `^`） |
| 新增 `src/engine/durable/harness-host.ts` | 创建 Harness + SQLite storage（每 profile 独立文件）+ 注册工具 |
| 新增 `src/engine/durable/ve-tools.ts` | 把 VE 工具适配为 durable `defineTool`：`content` → `output`；标注 `replay: safe/unsafe` |
| 新增 `src/engine/durable/ve-settle-gate.ts` | settle-gate 的 `onYield` 版本（§2.3 已验证） |
| 新增 `src/engine/durable/ve-actor.ts` | 发起人身份 → conversation doc（§2.2 已验证） |
| `src/engine/engine.ts` | `send()` 按开关分流：durable 路径走 `root.submit()` |
| `electron/main.ts` | 启动时 `harness.resume()`；退出时 `harness.close()` |

验收（必须全过才进阶段 2）：

1. 会话执行到第 3 个工具时 `kill -9`，重启后从第 3 步继续，前 2 步不重跑。
2. 同一会话不同发送人，权限各自正确；重启后仍正确。
3. settle-gate 在崩溃重启后仍要求验证轮，不能被跳过。
4. 现有 58 测试套件全绿。

### 阶段 2：全量切换 + 中断重连

- 剩余会话迁入；`messages` 表降级为 UI 投影（由 durable entries 重建）。
- UI 接 `watch()` 游标：断线重连只补增量。
- IM 断线重连：连接状态机 + 未送达消息 outbox。
- 删除 VE 侧重复的执行状态管理，避免双写。

### 阶段 3：外部副作用收口

- 对退款/备份/发消息这类操作，标 `replay: unsafe` 并保存业务 `operationId`。
- 恢复时向业务系统查询"这笔操作发生过吗"，而不是问模型。
- 钉钉消息投递无端到端幂等，明确标注"可能重复"，不承诺 exactly-once。

## 5. 明确不做 / 边界

- **不做 exactly-once**：本地提交与远端副作用之间永远有窗口。能做到的是"不重复执行 + 让不确定状态可见可核实"。
- **不承诺恢复浏览器会话**：页面与句柄不可序列化，恢复的是"目标 URL + 已完成步骤"，页面重开后需重新校验登录态。
- **不与 pi coding-agent 的 AgentSession 并存同一会话**：一个会话只能是其中一种 runtime，避免双写。
- **多 profile**：每个 profile 独立 SQLite 文件，durable 明确"一个存储同时只能一个进程拥有，无跨进程锁"。

## 6. 盲区

- 未在 VE 内部跑过 durable：阶段 1 之前，所有结论来自独立 probe（同 NPM 包、同 API，但宿主环境不同）。
- 未验证 Electron 37 升级对现有 14 个 immutable 区、native 依赖、打包产物的影响——这是阶段 0 的主要工作量。
- 未核对 pi-durable 未发布的破坏性改动风险；固定版本 + 迁移测试是必须的。
- 用户现场那两个中断会话的日志尚未拿到，无法确认当时是崩溃、强杀还是升级终止；本设计不依赖该事实（三种情况走同一恢复路径）。
