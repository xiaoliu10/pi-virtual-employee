# VE Scoped Memory 设计

> 状态：`feat/scoped-memory` 分支，已通过独立审查修复 + 14 用例回归，待提 PR。
> 调研前置：`docs/design/memory-system-comparison.md`（pi-scoped-memory v1 / ZCode v2 / pi-memory issue #50·#48 对比）。

## 1. 背景与问题

旧记忆层是 `kb_entries` 表里带 `tags="memory"` 的条目，读取方式是：

```sql
SELECT * FROM kb_entries
WHERE archived = 0 AND tags LIKE '%,memory,%'
ORDER BY updated_at DESC LIMIT 30
```

每条拼成 `标题 — 正文前 100 字`，塞进 system prompt。现场和独立审查（2026-10-15）暴露的缺陷：

1. **不分人 / 不分群 / 不分系统** —— A 的偏好、群约定、全局规则混在同一池，全都注入每个会话。
2. **纠错是追加不是覆盖** —— `saveMemory` 走 `saveLearned`，同标题变成 `旧内容\n\n---\n新内容`。
3. **摘要位置永远是旧事实** —— 摘要截正文前 100 字，纠正内容追加在后面，注入行仍显示旧事实。
4. **`memory` 标签可被普通工具铸造** —— `save_to_knowledge{tags:"memory"}` 即可造出全局注入记忆，绕过 remember 的管理员门禁。
5. **consolidation 跨人合并** —— 后台 LLM 的合并 prompt 含全部人记忆内容，`merge` op 可能合并不同 owner 的事实。
6. **`saveLearned` 标题碰撞跨人写入** —— A 的记忆「称呼」会被 B 的对话内容追加进去。
7. **未知 scope fail-open** —— `isMemoryVisible` 对 ∉ {profile,person,conversation} 的 scope 返回 true。
8. **无验证身份 fail-open 升 profile** —— 控制台创建的定时任务（`created_by=NULL`）在远程会话调 remember，被悄悄升级成全局共享记忆。

## 2. 目标

- 记忆按 **profile / person / conversation** 三层隔离。
- **owner 只能服务端推导**，从平台验证的 `senderId` / `conversationId` 生成，模型给意图不给 owner。
- **纠错覆盖替代追加** —— 同 `(scope,owner,title)` 原地覆盖 + 重建 chunks，旧事实从正文与检索同时消失。
- **写入 / 注入 / 检索 / 整理四条链路全部按边界收口**。
- **独立 summary** —— 注入行不再依赖正文顺序。
- **向后兼容** —— 旧库、旧记忆不破坏既有可见性。

## 3. 非目标（下一期）

- **系统 / 项目维度**（spay vs 芸智服串线）—— System Registry + `system_key` + 登录态 preflight。
- **运行时自述**（Orion 跑 `ls /var/log`）—— 每轮注入「我是谁、宿主 OS、日志/任务/推送失败记录在哪查」+ 自查工具。
- **记忆语义召回** —— 目前仍是「最近 30 条固定注入」，量大后需按当前问题召回。
- **任务 → 消息绑定** —— 群内「继续」歧义消解。

## 4. 作用域模型与 owner 键

| scope | 语义 | owner 键 | 谁能写 |
|---|---|---|---|
| `profile`（DB 中 `NULL`） | 本 VE 配置全局共享 | `NULL` | admin / 本地控制台 |
| `person` | 某平台身份的个人记忆（跨其单聊与群） | `person:<channelFamily>:<senderId>` | 任意已验证身份者（写自己的） |
| `conversation` | 某 IM 会话（群）的记忆 | `conversation:<conversationId>` | operator+，且仅群内 |

数据仍是 `kb_entries`，新增三列（`src/db/sqlite.ts`）：

```text
memory_scope    TEXT   -- NULL/'profile' 共享；'person'/'conversation' 有主
memory_owner    TEXT   -- 服务端推导归属键；profile/普通知识为 NULL
memory_summary  TEXT   -- 独立索引摘要（每轮自动携带的钩子）
```

## 5. 信任边界

`src/knowledge/memory-scope.ts` 是唯一信任边界，纯函数、同步、**绝不读消息文本**：

```text
deriveMemoryContext(actor, conversationId) -> { personOwner?, conversationOwner? }
```

- person owner = `person:<channelFamily(memoryChannel ?? actor.channel, fallback)>:<senderId>`；
- 渠道折叠：来源会话前缀（`dt:`→dingtalk、`feishu/wecom/echo:`→同名）优先推导，老库 `NULL` 回退 dingtalk；
- conversation owner 仅当 `memoryConversationId` 是真实 IM 前缀（`^(dt|feishu|wecom|echo):`）时成立 —— 合成 `sched:`/`work:` id 不是会话作用域；
- 无 actor（控制台 / 匿名）→ `{}`，只能见 profile；
- 未知 scope → `isMemoryVisible` 返回 **false**（fail-closed）。

## 6. 写入路径（remember 工具重写）

`src/engine/tools/save-knowledge.ts` 的 `createRememberTool`，授权矩阵（角色来自平台验证身份 + 配置）：

| 请求 scope | viewer | operator | admin | 本地控制台 |
|---|---|---|---|---|
| person（默认） | ✅ 自己 | ✅ 自己 | ✅ 自己 | → profile |
| conversation（仅群） | 降级 person + 明示 | ✅ | ✅ | — |
| profile | 降级 person + 明示 | 降级 person + 明示 | ✅ | ✅ |
| 无验证身份（远程） | **fail-closed 直接拒绝** | | | |

- 降级时**真的按 person 存下来**，并在回复明示「已按你本人记忆保存」——不再嘴上说降级、实际什么都没存。
- 无身份且 scope 需 owner 时，`{ ok:false, reason:"no-verified-actor" }`，**绝不悄悄升成 profile**（P1-1 修复）。
- 纠错覆盖：`saveMemoryFact` 同 `(scope,owner,title)` → `UPDATE` 正文/summary + `version+1` + `replaceEntryChunks`（FTS 触发器同步、向量重置 pending）。不同人同标题是独立条目。

## 7. 注入路径（两个注入点，按缓存特性分开）

- **profile 记忆** → system prompt（每会话稳定，保 KV 缓存），文案「本配置共享」。
- **person / conversation 记忆** → **每轮消息前缀注入**（`engine.ts` `withTurnMemoryPrefix`）。理由：一个群会话服务多个发送者，谁的发言只能带谁的记忆，不能写进被缓存的 systemPrompt。前缀每轮现取（同轮写入/纠正立即可见）、**只发给模型不落进持久化历史**（history 存原始消息，重水化不堆积前缀）、重试 / 溢出恢复复用同一条带前缀消息不会丢。
- 注入行 = `标题 — 独立 summary`，不再截正文前 100 字（P2 摘要旧事实根因）。
- 前缀带非披露约束：「个人记忆仅用于理解本人偏好，不得在群回复中向其他人披露个人事实」。

## 8. 检索路径

`SearchRequest.memoryCtx` 透传到 `LocalRetrievalProvider`（`src/knowledge/retrieval/local-retrieval.ts`）。BM25 与向量命中统一过闸：每条 manual 命中查 `fetchMemoryMeta`，`isMemoryVisible(scope, owner, ctx)` 为 false 即过滤 —— 别人的 person / conversation 记忆不会在 `search_knowledge_base` 里返回给当前会话。未知 scope fail-closed。

## 9. 整理路径（consolidation 彻底改造）

`KnowledgeService.runConsolidation`：

1. **先分区再调 LLM** —— 候选按 `(是否记忆, scope, owner)` 分桶，**每桶单独发一次整理请求**，A 和 B 的记忆绝不进同一个 prompt（避免输出正文携带他人事实）。
2. merge op 只允许桶内 id，越界（含跨桶）整条丢弃；`mergeEntries` 在 store 层再硬校验跨 scope/owner，直接抛错；派生条目继承 scope/owner/memory 标签。
3. **`memory` 标签保留化** —— `saveLearned` / `saveResearched` / `reviseEntry` / `retagEntry` 全部 `stripMemoryTag`；`reviseEntry` 拒绝碰记忆条目；`retagEntry` 对记忆条目保留 memory 标签（P1-2 修复）。
4. **后台 LLM 不自动归档记忆** —— 记忆是「显式纠正覆盖」语义的持久事实，archive 阶段跳过 memory 条目。
5. `saveLearned` 标题匹配排除 memory 行和 scoped 行 —— 不会把 B 的对话内容追加进 A 的私有记忆（P2-1 修复）。

## 10. 调度器 / 自主任务身份贯通

无人值守回合不是「无身份」，而是**回挂创建者**：

- `scheduled_tasks` / `work_items` 各加 `created_channel` 列（创建时从平台验证 actor 记录）；
- 调度器合成 actor 带 `memoryConversationId`（来源群）+ `memoryChannel`（原始渠道），`channelFamily` 优先从来源会话前缀推导；
- 张训实时说「记住…」与他的定时任务无人值守写入落在同一 person owner，互相可见。

## 11. 迁移与兼容

- 三列可空，旧行 `NULL` = profile 语义 —— 旧记忆此前本来就注入所有会话，NULL 保持原可见性，不做冒险的自动归属。
- 老记忆一次性回填 `memory_summary`（正文前 80 字单行化），保住原注入体验。
- 索引 `idx_kb_entries_memory(scope, owner)` 增量创建（`IF NOT EXISTS`）。
- `scheduled_tasks` / `work_items` 加列向后兼容，`confirm` 用 `COALESCE` 不覆盖已有值。

## 12. 测试

`scripts/test-scoped-memory.mjs`，**14 用例**，真实 SQLite + esbuild 打包生产 TS：

1. 同 (scope,owner,title) 纠错覆盖，旧正文与 chunks 消失。
2. 同标题不同 owner 是独立条目。
3. 索引按 conversation→person→profile 排序、owner 过滤。
4. 派生 merge 继承 scope/owner/memory 标签。
5. 身份推导：scheduler 折叠 dingtalk、来源群给 conversation、无 actor → profile only。
6. `ownerForScope` / `isMemoryVisible` 边界（含未知 scope fail-closed）。
7. 本地检索过滤他人 person/conversation 记忆。
8. remember 工具服务端推导并强制 scope（viewer→person、conversation 需 operator+ 群内、profile 需 admin）。
9. 本地控制台写共享 profile 记忆。
10. **P1-1** 无验证身份远程 remember fail-closed，绝不升 profile。
11. **P1-2** memory 标签保留，普通工具不能铸造/剥离。
12. **P2-1** saveLearned 不并入他人记忆。
13. **P2-2** store 拒绝跨 scope merge 与非法 memory fact。
14. consolidation 分区、记忆不归档、跨桶 id 拒绝。

## 13. 已知边界与后续工作

本期能解决「人 / 群 / 纠错追加 / 标签伪造 / 整理跨人」的大头；**不能单独解决系统混淆**。下一期在同一改造线继续：

1. **System Registry** —— 结构化系统档案（canonical_hosts / browser_profile / auth_mode / keepalive_task / forbidden）。
2. **任务 `system_key` 绑定** —— work item / scheduled task 创建时识别系统，恢复时确定性注入系统卡。
3. **登录态 preflight** —— `browser_navigate` / 输入凭据前校验系统、profile、保活态。
4. **运行时自述卡** —— 每轮注入「我是谁、宿主 OS、日志/任务/推送失败记录在哪查」。
5. **记忆语义召回** —— 按当前问题召回相关记忆，替代「最近 30 条固定注入」。
6. **危险进程命令收口** —— 拦截 `taskkill /im chrome.exe` 等全局杀进程。

## 附录：关键文件

- `src/knowledge/memory-scope.ts` —— 信任边界（新增）。
- `src/knowledge/store.ts` —— `saveMemoryFact` / `listMemoryForContext` / `fetchMemoryMeta` / `mergeEntries` / `stripMemoryTag` / `hasMemoryTag`。
- `src/knowledge/knowledge-service.ts` —— `saveMemory` / `listMemoryIndex(ctx)` / `search(query, memoryCtx)` / `runConsolidation` 分区改造。
- `src/knowledge/retrieval/local-retrieval.ts` —— 检索 scope 过滤。
- `src/engine/tools/save-knowledge.ts` —— `createRememberTool` 重写。
- `src/engine/engine.ts` —— `turnMemoryContext` / `withTurnMemoryPrefix`。
- `src/engine/definition.ts` / `src/engine/tools/knowledge.ts` —— `resolveMemoryContext` 透传。
- `src/db/sqlite.ts` —— 三列迁移 + 回填 + 索引；`scheduled_tasks`/`work_items` 加 `created_channel`。
- `src/db/scheduled-task-store.ts` / `src/db/work-item-store.ts` —— `created_channel` 持久化。
- `src/im/types.ts` / `electron/main.ts` / `src/scheduler/work-service.ts` —— scheduler/work actor 身份贯通。
- `scripts/test-scoped-memory.mjs` —— 14 用例回归。
