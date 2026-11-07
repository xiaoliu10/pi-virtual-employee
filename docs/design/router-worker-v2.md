# Router / Worker 第二期：结构分家（基础架构裁定版）

> 裁定（2026-11-07，用户多次重申后升级为架构决策）：**Router/Worker 是基础
> 架构，是结构型语义，不是任务体系的一种任务类型。** 它与自主任务体系
> （work_items/scheduled/resident）完全无关——不得复用其表、状态机、协议、
> prompt。第一期的 D2 决策（「Worker 容器：复用 work item，不造新引擎」）
> 就此推翻。
>
> 现场教训（95b04015，2026-11-06）：群聊派发的一次性统计任务在 work_items
> 里自我排程 [[NEXT_CHECK]]: 2026-11-07 00:50，完成推送套用自主任务模板
> （「后台任务阶段进展/下次跟进/跟进原因」）——一条对话消息「变成」了自主
> 任务。根因不是模型越权，是结构让越权成为可能：同表、同状态机、同 prompt、
> 同协议。

## 一、为什么必须分家（三个结构性理由）

1. **生命周期形状不同**。worker 是线性的（queued → running → done）；自主
   任务是循环的（scheduled → working → scheduled → …，resident 永续）。
   work_items 为循环形状准备的列（next_check_at/cadence_ms/fixed_streak/
   timeout_streak/kicked_off/last_remind_at/remind_count/chain_state）对
   worker 全部是死字段。
2. **靠禁止规则维持边界本质脆弱**。三层闸（禁 create_scheduled_task、禁
   mine/confirm、禁 NEXT_CHECK）每条都要 prompt 教导 + 引擎拦截 + 测试守护，
   漏一层就是事故。独立体系下这些规则**天然不存在**——worker 的代码里没有
   那些路径，无从越权。
3. **补偿性复杂度已是税**。`origin === "chat"` 条件化渗透 prompt/协议/推送/
   状态机四处，每处都是会漏的 if-else。分家后整体消失。

## 二、分层与唯一接口

```
IM 消息
  → Router（manager/triage 接收层）
      ├─ 命令 / steering → 即时路径
      ├─ 闲聊/单步问答   → 直接回合回答
      ├─ 任务型          → WorkerService.spawn(spec)      【基础架构调用】
      └─ 用户要求建自主任务（「以后每天…」）
                          → 自主任务创建 API（管理员确认流程）【唯一合法接口】

WorkerService（对话执行基础架构）
  一个 worker = 一个持久 durable 会话（worker:<id>）
  生命周期由代码状态机驱动 = durable turn 生命周期：
      queued ──claim──▶ running ──send settle──▶ deliver ──▶ done
                        │                          ▲
                        └── fault/timeout ─────────┘（error 简报）
  结果 = durable 会话最终 assistant 文本（代码提取，非解析模型标记）
  交付 = 推回来源会话（occurrenceId 幂等）
  用户追问 = 新消息 → 同一会话新 turn（上下文连续）→ 新一轮交付
  无标记协议（[[TASK_DONE]]/[[NEED_HUMAN]]/[[NEXT_CHECK]] 对 worker 无意义）
  无排程 / 无挖掘 / 无常驻 / 无 waiting_human——代码路径不存在

WorkService / work_items（自主任务体系，回归本名，不动）
  只服务 mining 提案 / 常驻巡检 / 手动创建的自主任务
  [[NEXT_CHECK]] / 观察点 / 跟进节奏是它的专属协议
  与 Router 零耦合
```

**两体系的唯一合法接口**：用户在对话中要求建自主任务时，Router 调用自主任务
创建 API（走管理员确认流程）。Router 可以「创建」，但**永远不能「转换」**。

## 三、结构区分的代码落点（不是 prompt 约束）

| 区分点 | work_items（自主） | worker_tasks（worker） | 实现层 |
|---|---|---|---|
| 表 | work_items（循环列） | worker_tasks（线性列） | sqlite |
| 状态机 | 7 态循环 | 3 态线性（queued/running/done） | 代码转换 |
| 结束判定 | 模型标记 [[TASK_DONE]] | durable turn settle 事件 | 代码事件 |
| 排程能力 | [[NEXT_CHECK]] 协议 | 不存在该代码路径 | 结构 |
| 会话前缀 | work:<itemId> | worker:<taskId> | durable |
| prompt | 窗口协议（跟进/节奏） | 无协议（instruction 即用户轮） | 结构 |
| 进度 | work:progress notifier | side-pass 简报（复用引擎旁路） | 共享内核 |

模型在 worker 会话里输出 [[NEXT_CHECK]] 只会被当作普通文本推给用户——
**不是被拦截，是不存在解析它的代码**。这就是「代码级区分」的试金石。

## 四、实现清单

- [x] `src/router/worker-tasks.ts`：worker_tasks 表 + 线性状态机 store
- [x] `src/router/worker-service.ts`：WorkerService（claim/exec/deliver/inject）
- [x] Router 接线：triage 任务型消息 → spawn（拆除建 work_items 路径）
- [x] 追问路由：来源会话活跃 worker → 同会话新 turn
- [x] 测试：线性终态 / 结果交付 / error 终态 / 追问续聊 / 标记免疫
- [x] 控制台任务列表**永不显示 worker 记录**（裁定 2026-11-07）：任务列表
      数据源是 work_items（`tasks:workList`），worker_tasks 独立表 → 结构性
      隔离，无需过滤代码。worker 的可见性 = 日志与 DB 查询（基础设施遥测），
      不属于任务 UI；将来若有运维需要，做独立区块并明确标注「基础设施执行
      记录」，与任务列表物理分开。
      裁定原文（2026-11-07）：**「任务列表只有定时/自主任务」**——控制台
      现状即符合（任务页 = 定时任务 tab + 自主任务 tab，数据源
      scheduled_tasks / work_items），worker_tasks 不在任何 UI 数据源中。

## 五、存量与过渡

- 盒子 chat origin 存量已清零（2026-11-06），无迁移负担。
- Router 切换后 work_items 不再产生 chat origin——该 origin 值成为历史概念。
- work_items 现存 chat 分支代码（oneShot 条件）在下一次触碰该文件时移除。
