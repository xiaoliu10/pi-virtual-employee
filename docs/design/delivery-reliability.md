# VE 交付架构：从「拼字符串推消息」到「有契约的交付管道」

> 真实意图：用户体感「VE 完成任务很差」。深挖后的判断是——**任务执行能力不是主要瓶颈，交付环节没有架构**。今天推两遍、明天链接失效，都只是「缺少交付层」这个根因的症状。需要的是把交付变成一条有契约、可观测、可修复的管道。
> 日期：2026-10-27　状态：草案（待评审）
> 对标：NousResearch/hermes-agent（25.7 万星，Python/MIT），源码实证

---

## 1. 现状剖面：交付是「散落在各处的副作用」

### 1.1 我们今天的交付长什么样

```
10 处独立调用点 → 各自拼字符串 → pushToConversation(cid, text) → 分片 → adapter.push()

electron/main.ts:642   心跳进度
electron/main.ts:717   连麦提示
electron/main.ts:782   工具回执
electron/main.ts:836   自主任务（含 ✅/⏸️/🔁 多种形态）
electron/main.ts:865   自主链
electron/main.ts:906   work 服务注入的 push
electron/main.ts:1022  定时任务（⏰ 完成 + 报告链接）
electron/main.ts:1074  work 服务注入的 push
electron/main.ts:1847  管理员通知
```

**问题不在改得不好，而在没有层**。每个调用点自己决定：发不发、发什么措辞、多长、要不要带链接、失败了怎么办。所以：

- 措辞风格不统一（`✅ 自主任务完成` vs `⏰ 定时任务完成` vs `⏳ 任务仍在进行中`，三种模板）
- 重复防护只在个别点有（`work-service.ts:555` 有 push 前二次读行，定时任务没有）
- 失败处理各写各的（有的 `void` 掉、有的 await、有的记 `pushError`）
- **没有任何地方记录「这条已经发过了」**

### 1.2 四个结构性缺口（逐条对应体感）

| 缺口 | 代码证据 | 后果 |
|---|---|---|
| **无投递账本** | 全库无 push/delivery/sent 表 | 同一次运行推两遍，系统不知道 |
| **无 occurrence 身份** | `listDue` 判据仅 `next_run_at <= now`；`markRun` 才推进 | 推送后、markRun 前崩溃 → 重启重跑再推 |
| **分片非原子** | `splitForPush` 返回数组，`pushToConversation` 逐片发，中途失败返回 `{ok:false}` | 上层当「整体失败」重试 → **上半段 + 完整重来** |
| **推送结果无分类** | `push?: (...) => Promise<{ok, error?}>` | 无法区分「该重试」与「永久失败」，一律重试或一律放弃 |

### 1.3 渠道层抽象的真实水位

`IMAdapter` 已经做得不错（`metadata` 能力声明、`status()` 健康度、`egressAudience` 出站门禁）。**缺的是「交付语义」这一层**——渠道知道怎么发，但没人管「该不该发、发几次、发一半怎么办」。

---

## 2. Hermes 的架构：三层职责分明

```
┌─ 渠道层 ─────────────────────────────────────┐
│ gateway/delivery.py      DeliveryRouter       │  目标路由 + 截断策略
│ platforms/base.py        BasePlatformAdapter  │  SendResult + error_kind
│                          splits_long_messages │  渠道自己声明能不能分片
└───────────────────────────────────────────────┘
              ▲ 只负责「怎么发」
┌─ 交付层（我们缺的）──────────────────────────┐
│ gateway/delivery_ledger.py   outbox 账本      │  pending/attempting/delivered
│ cron/occurrences.py          occurrence 身份  │  (job_id, scheduled_instant)
│ cron/delivery_queue.py       跨进程队列       │  claim 后死亡→unknown，不重试
└───────────────────────────────────────────────┘
              ▲ 只负责「该不该发、发过没有」
┌─ 内容层 ─────────────────────────────────────┐
│ delivery.py:_cap_oversized_output             │  超长先落盘，再决定截断/全量
│ delivery.py:_is_silence_narration              │  纯静默叙述过滤
│ platforms/base.py:extract_media                │  MEDIA: 标签收口去重
└───────────────────────────────────────────────┘
```

**三个设计决策特别值得抄：**

**① 幂等键 = 身份，不是内容**

```python
# gateway/delivery_ledger.py
def compute_obligation_id(session_key, message_ref, content):
    return hashlib.sha256(f"{session_key}|{message_ref}|{content}").hexdigest()[:24]
```
```python
# cron/scheduler_delivery.py（注释原文）
# never deduping recurring runs by their (potentially identical) output
# or previous last_run timestamp
```

> **这条直接纠偏我们的思路**：如果体感是「每天报告内容雷同」，那不是幂等问题——每天各推一次是**正确行为**，该改的是内容形态（推变更摘要）。如果把两种现象混成一个「去重」需求，会做出错误的系统（把合法的每日推送压掉）。

**② 两种相反的崩溃策略，显式选择**

| 层 | 策略 | 原文 |
|---|---|---|
| 回复层 | **带标记重发**（宁可重复） | `attempting = crashed mid-await, platform MAY have it, redeliver WITH a visible recovered marker` |
| cron 队列 | **永不重试**（宁可丢） | `If that gateway dies after claiming, the outcome is marked unknown and never retried: losing a delivery is safer than duplicating` |

**关键的诚实性设计**：重复发生时，用户**看得见原因**——
`♻️ Recovered reply — the gateway restarted during delivery, so this may be a duplicate:`
而不是让用户困惑「为什么又发一遍」。

**③ 部分送达禁止重发全文**

```python
class PartialDeliveryError(RuntimeError):
    """A split send failed after earlier chunks were delivered.
    Callers must not fall back to re-sending the whole payload:
    the recipient already has the head."""
```

**这一条直接命中「上半段 + 完整重来」**，而且是我们体感最刺眼的重复形态。

### 2.1 关于报告链接：Hermes 没做，但它的立场是对的

**结论：Hermes 根本没有链接功能，它不发链接。**

```
# 全文搜 presigned 只有两处，都不是面向用户的结果链接
tools/connectors/gateway/files.py       # 模型传本地路径，存储 URL 永不进模型/日志
hermes_cli/diagnostics_upload.py        # 内网诊断包，非用户产物
```

它超长内容的处理是**落本地文件 + footer 写路径**：

```python
footer = f"\n\n... [truncated, full output saved to {saved_path}]"
```

**但它反向给了一条明确的设计立场**：把易腐的签名 URL 写死在消息里是**反模式**。Hermes 消息里持久引用的是不可腐的东西（本地路径）。

对应到我们的 OSS 架构，等价物是：

> **消息里和账本里存 object key（永不过期），签名按需现签。**

这不是「修链接」，而是「让消息里的引用永不可腐」。

---

## 3. 目标架构：四层交付管道

```
┌─ L4 内容层 Content ────────────────────────────────────┐
│  一次交付 = 一个有类型的 DeliveryContent                │
│  · 结构化字段（标题/摘要/正文/附件key/后续动作）        │
│  · 长度策略：超限先落盘 → 再决定分片 or 摘要+key        │
│  · 单一出口渲染：所有 ⏰✅⏸️🔁 模板收口到一处            │
└────────────────────────────────────────────────────────┘
                          ▼
┌─ L3 交付层 Delivery（新建，核心）──────────────────────┐
│  · occurrence 身份：(kind, refId, occurrenceInstant)    │
│  · 投递账本：pending → attempting → delivered/failed    │
│  · 幂等：同一 occurrence 已 delivered → 跳过            │
│  · 崩溃恢复：attempting → 带标记重发（用户可见原因）     │
└────────────────────────────────────────────────────────┘
                          ▼
┌─ L2 分片层 Chunking ───────────────────────────────────┐
│  · 分片计划先落库（planId + 片序号）                     │
│  · 逐片 ACK，记录「已发到第 N 片」                       │
│  · 失败 → PartialFailure{deliveredParts}  ← 禁止重发全文 │
│  · 续发从第 N+1 片开始                                  │
└────────────────────────────────────────────────────────┘
                          ▼
┌─ L1 渠道层 Adapter（已具备）────────────────────────────┐
│  IMAdapter：metadata/status/egressAudience + error_kind │
│  · 补：SendResult{ok, errorKind, retryable, retryAfter} │
│  · 补：dead-target 短路（群解散/bot被拉黑）              │
└────────────────────────────────────────────────────────┘
```

### 3.1 关键契约变更

**L1 渠道层：推送结果从 `{ok, error?}` 升级为分类结果**

```ts
// src/im/types.ts
export type DeliveryErrorKind =
  | "too_long" | "bad_format" | "forbidden"
  | "not_found" | "rate_limited" | "transient" | "unknown";

export interface DeliveryResult {
  ok: boolean;
  /** 平台级错误分类：调用方按类型分支，不再匹配字符串 */
  errorKind?: DeliveryErrorKind;
  /** 服务端要求的等待时间（钉钉流控） */
  retryAfterMs?: number;
  /** 成功时平台返回的消息 id */
  messageId?: string;
}
```

**L2 分片层：部分送达是一等公民**

```ts
export interface PartialDelivery {
  ok: false;
  /** 已成功送达的片数（>0 时上层禁止重发全文） */
  deliveredParts: number;
  totalParts: number;
  error: string;
  errorKind?: DeliveryErrorKind;
}
```

**L3 交付层：账本 schema**

```sql
CREATE TABLE IF NOT EXISTS delivery_obligations (
  occurrence_key TEXT PRIMARY KEY,   -- sha256(kind|refId|occurrenceInstant)[:24]
  kind           TEXT NOT NULL,      -- 'scheduled' | 'work' | 'report' | 'notice'
  ref_id         TEXT NOT NULL,      -- task.id / work item id
  occurrence_at  INTEGER NOT NULL,   -- 本次触发时刻（身份，不是内容）
  conversation   TEXT NOT NULL,
  content        TEXT NOT NULL,      -- 落库原文（审计 + 重发用）
  state          TEXT NOT NULL,      -- pending|attempting|delivered|partial|failed|abandoned
  delivered_parts INTEGER NOT NULL DEFAULT 0,
  total_parts    INTEGER NOT NULL DEFAULT 1,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  owner_pid      INTEGER,
  owner_started_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_state ON delivery_obligations(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_delivery_ref ON delivery_obligations(kind, ref_id, occurrence_at);
```

**L4 内容层：交付内容结构化**

```ts
export interface DeliveryContent {
  kind: "scheduled-done" | "scheduled-error" | "work-done" | "work-progress"
      | "work-needs-human" | "heartbeat" | "notice";
  title: string;
  body: string;
  /** 附件的不可腐引用（OSS object key），不是签名 URL */
  artifacts?: Array<{ key: string; label: string }>;
  /** 多长都要送完，还是允许摘要+key */
  lengthPolicy: "full" | "summarize-with-link";
}
```

**渲染收口**：`renderDelivery(content, channel)` **唯一出口**，所有 `⏰✅⏸️🔁` 模板都从这里出。渠道差异（钉钉卡片 vs 纯 markdown）在这一层适配。

### 3.2 数据流（改动后）

```
任务/自主任务完成
   │
   ├─ L4 构造 DeliveryContent（结构化，非拼串）
   │
   ├─ L3 计算 occurrence_key = hash(kind|refId|occurrenceAt)
   │      ├─ 账本已 delivered → 跳过（幂等，消除重复）
   │      ├─ 无记录 → recordObligation(pending)
   │      └─ attempting（上次崩溃）→ 内容前加 ♻️ 可能重复标记
   │
   ├─ L2 分片计划：splitForPush → parts，落 total_parts
   │      逐片：markAttempting → adapter.push → 成功则 delivered_parts++
   │      第 N 片失败 → state='partial'，返回 PartialDelivery{deliveredParts:N}
   │      ⚠️ 上层看到 partial 只能续发，禁止重发全文
   │
   ├─ L1 adapter.push 返回 DeliveryResult{ok, errorKind, retryAfterMs}
   │      transient/rate_limited → 可重试（带 retryAfter）
   │      forbidden/not_found → 死目标，进 dead-target 注册表，不再重试
   │
   └─ L3 终态：delivered（全部成功）/ partial / failed / abandoned(attempts≥3)
```

---

## 4. 分阶段实施（每步独立可验证）

| 阶段 | 内容 | 验收（必须可复现） | 影响面 |
|---|---|---|---|
| **S1** | **投递账本 + occurrence 身份**（L3 核心） | 推送后立刻杀进程 → 重启**不得二次推送**；已 delivered 再触发直接跳过 | 新表 + `main.ts` 推送段 + `scheduler-service` 查账 |
| **S2** | **部分送达语义**（L2） | 模拟第 2 片失败 → 断言**不重发全文**，续发从第 3 片开始；用户只看到一条完整消息 | `chunks.ts` + `pushToConversation` + 返回值契约 |
| **S3** | **推送结果分类 + 死目标**（L1） | 群解散后不再重试（日志可见 dead-target 命中）；流控按 retryAfter 等待 | `im/types.ts` + 钉钉 adapter |
| **S4** | **内容层收口**（L4） | 10 处推送点全部改走 `renderDelivery`；措辞统一；链接改为 object key | `main.ts` 全部推送点 + 新 renderer |

**S1 是第一优先**——它是唯一能直接消灭「同一次运行推两遍」的机制，且改动局部（不动渲染、不动渠道）。

### 4.1 测试策略

- **S1**：账本状态机单测（6 态转移）+ 崩溃注入（推送后 kill -9，重启断言不重推）
- **S2**：分片失败注入（第 2 片 mock 失败）→ 断言 `PartialDelivery.deliveredParts === 1`，且**上层无重发整包路径**
- **S3**：error_kind 映射表单测 + dead-target 短路
- **S4**：渲染快照测试（同 content + 不同渠道 → 稳定输出）

---

## 5. 明确不做的（避免过度设计）

| 不做 | 理由 |
|---|---|
| 按内容哈希跨时间去重 | Hermes 明确拒绝；每日雷同内容是**合法**的，该改内容形态而非压掉推送 |
| 分布式锁 / 多实例协调 | VE 是单机单进程（多 profile 是独立进程，各管各的库，天然隔离） |
| exactly-once | 跨进程 + 跨平台 ACK 做不到；诚实 at-least-once（带标记）是正确的工程选择 |
| 富消息统一模板层 | 钉钉卡片/纯 markdown 差异大，强行统一会两头不讨好；先收口渲染函数，不急着建抽象 |
| 报告链接签名刷新服务 | 先看 S1-S4 落地后还剩多少痛点；把 URL 换 object key 大概率就够了 |

---

## 6. 盲区与待拍板

**盲区（证据不足，不假装解决）**
- 「每天推雷同内容」如果确实存在，是 **L4 内容层**问题（应推变更摘要），本设计只预留了接口，没有设计算法
- 钉钉流控的具体退避参数未实测
- 盒子公网可达性未验证（决定 artifact 是「object key + 应用内重签」还是「只能长 TTL」）

**待拍板**
1. **S1 的 occurrence 粒度**：定时任务用 `(task.id, scheduled_instant)` 没问题；**自主任务**用 `(item.id, windowStartedAt)` 还是 `(item.id, nextCheckAt)`？后者在顺延时可能重复
2. **partial 之后的策略**：续发剩余（体验最好但逻辑复杂）vs 只发一条「上一条不完整，完整内容见 X」（简单但多一条消息）
3. **是否接受「♻️ 可能重复」这条可见标记**——它会让用户看到系统的不确定性，但比静默重复诚实

**证据来源标注**
- 我方代码：全部读过原文，行号已标
- Hermes：`gh api` 直读 main 分支源码，引文为原文；`website/docs/developer-guide/cron-internals.md` 为一手官方文档
- 「体感最刺眼的是上半段+完整重来」——**这是推断**，需盒子日志验证
