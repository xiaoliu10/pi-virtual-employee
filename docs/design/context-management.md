# VE 上下文管理：Inline & Spill 与 Chain of Recall

状态：设计稿 v1（2026-11-07）。方法论来源：上下文组织三步法（Inline & Spill + 局部性）与 Chain of Recall 多跳检索。

## 0. 原则

- **浪费上下文窗口，就是浪费模型的智能。** 注入太多稀释注意力；注入太少增加工具往返。每一类对象都要显式回答：什么 Inline（直接进窗口）、什么 Spill（窗口外留引用，按需读取）。
- **每个对象有唯一 ID，注入时内联相关对象的 ID**——ID 把对象连成引用图，模型从当前事件出发逐跳召回（Chain of Recall）。
- **每次工具召回的结果同样遵循 Inline & Spill**：返回摘要 + 下一跳的 ID，而不是全文或空引用。
- 上下文注入必须服务于「这一轮真正需要什么」：按局部性（时间/空间/因果相邻）渐进 Inline，而不是平铺全量。

## 1. VE 的对象图与 ID

| 对象 | 唯一 ID | 与其他对象的引用边 |
|---|---|---|
| IM 会话 | `dt:<sender>` / `dt:group:<cid>` | → 成员（staffId）、→ 该会话产生的 worker_tasks（source_conversation）、→ KB 记忆条目（memory_owner） |
| Worker 会话 | `worker:<taskId>`（durable 会话） | → source_conversation（来源会话）、→ createdBy（person）、→ 结果文本 |
| 定时/自主任务 | `sched:<id>` / `work:<itemId>` | → conversation_id（来源会话）、→ created_by（person）→ 派生任务（origin_conversation 链） |
| Person | `person:<family>:<staffId>` | → 其所有 person 级记忆、其发起的任务 |
| 记忆/知识条目 | kb_entries.id（memory_scope + memory_owner） | → owner（person/conversation/profile） |

这张图已经存在（schema 层面），缺的是**注入时刻按边内联**。

## 2. 现状盘点（Inline / Spill 对照）

### 已有且正确的 Inline
- 系统提示词（缓存会话）：身份、能力开关、技能内联（`formatInlineSkills`）、**profile 级记忆索引**（`listMemoryIndex`，带 snippet 摘要）。
- 每轮 turn 前缀：**person/conversation 级记忆按相关性召回**（`listScopedMemoryIndex(ctx, limit, message)`——按当前消息排序，只带相关条目，显式声明「可能过时，以当前消息为准」）。这是教科书式的 Inline：局部性（相关性）+ 摘要 + 防注入护栏。
- 转录重建：`rehydrateMessages` 有界尾部、轮对齐——时间局部性的 Spill（旧消息不进窗口）。
- 压缩：`maybeCompact` 按可用窗口计量，压缩摘要=Spill 的指针形式。
- 知识检索工具：BM25+向量 RRF，返回 topK 摘要——模型按需跳转的第一跳。
- 长任务进度旁路总结（progressBriefDetailed）：不把全部转录塞给总结模型，取 `progressContextSlice`。

### 已识别的断链（本文档立项的问题）
1. **durable 轮重建身份时丢 `memoryConversationId`**（runtime.ts RouteDoc 无此字段 → `actorContext()` 重建的 actor 缺失 → scheduler channel + 无显式 id = undefined → conversation 级记忆不可见）。**这正是 Chain of Recall 的断裂：worker 会话 → source_conversation 的边在轮内工具执行时丢了。** 修复：RouteDoc 增加 memoryConversationId/memoryChannel 字段，executeTurn 写入、actorContext 恢复；变异测试钉住「durable 轮内 resolveMemoryContext 必须含 conversationOwner」。
2. **worker done 后追问落新会话**：source_conversation → 最近 worker 会话的边只在 worker 存活时存在。语义裁定（待定）：done 短窗内的任务型消息是否优先续旧会话（对话连续性）vs 开新会话（干净上下文）。倾向：短窗（如 2h）内同一 source_conversation 的追问注入旧会话作为新 turn（对话天然延续），超过则新会话——但旧会话的**结果摘要**（标题+一句结论）要 Inline 进新会话的首轮前缀。
3. **双 profile 竞争消费钉钉**：消息随机落到没有上文的 profile → 对象图整体缺失（那台机器上没有该会话的历史）。根除 = 凭据分离（Orion 换钉钉应用）。

### 还没有 Inline 的对象（按三步法补齐的清单）
| 对象 | 现状 | 改进（Inline 什么） |
|---|---|---|
| 会话成员 | 只有 listMembers 工具（模型每次显式调） | 群会话首轮内联**活跃成员摘要**（名字+staffId，最近发言者靠前，≤10 人；大群只 Inline 最近发言的 5 人）——「目标按姓名解析」依赖它，省一跳 |
| 相关旧任务 | 无 | 会话前缀内联**该会话最近 N 个任务的结果标题**（一句话），ID 附上——用户说「上次那个对账」时模型有第一跳的抓手 |
| worker 结果 | push 全文（应该的） | 结果 push 后，把 `{taskId, 标题, 一行结论}` 写入 source_conversation 的可检索层（kb 或 history meta），成为后续 Inline 的素材 |
| 工具召回结果 | topK 摘要 ✓ | 命中条目内联**同 source 的兄弟条目 ID**（同一个人/同一会话的记忆）——一跳变半跳 |

### Spill 纪律（防止把上面做爆）
- 每个注入块的预算常量化（现有 MEMORY_RECALL_LIMIT / PROFILE_MEMORY_LIMIT 模式），超限截断留指针。
- Inline 的是「摘要 + ID」，不是全文；全文永远走工具。
- 每轮注入总预算（turn prefix 各块之和）设上限，超预算按局部性优先级裁剪：当前消息相关性 > 时间相邻 > 空间相邻。

## 3. Chain of Recall 在 VE 的落点

模型视角的逐跳路径（目标：任何旧上下文 ≤3 跳可达）：

```
当前消息
 ├─(Inline) turn 记忆前缀 → 相关记忆条目（含 owner 兄弟条目 ID）
 ├─(Inline) 会话前缀 → 最近任务结果摘要 + worker:<id>
 │    └─(工具) task_detail(worker:<id>) → 完整指令+结果 → 内联 createdBy person、source_conversation
 ├─(工具) memory_search(query) → 命中摘要 + 兄弟条目
 └─(工具) listMembers / listConversations → 摘要 + ID
```

配套最小改动：
- worker/sched/work 的**结果落库时写一行检索友好的摘要**（标题=任务名，snippet=结论首行），使知识检索成为第二跳入口。
- 工具返回体统一带 `related: [{id, kind, summary}]` 字段（先做 memory_search 与 task_detail 两个高频工具）。

## 4. 实施顺序

1. **P0 修断链**：RouteDoc 携带 memoryConversationId（§2.1）+ 变异测试。不做这个，其他 Inline 都会被同一根因吃掉。
2. **P0 凭据分离**（盒子）：对象图跨 profile 缺失无法用注入弥补。
3. **P1 会话前缀扩展**：群活跃成员摘要 + 会话最近任务摘要（含预算与裁剪测试）。
4. **P2 结果摘要落库 + 工具返回带 related**：补全 Chain of Recall 的第二跳。
5. **P3 worker done 短窗续聊语义**（需产品裁定）。

每步的验收测试都遵循同一模式：变异验证（删掉注入代码测试必须红）+ 预算上限断言。
