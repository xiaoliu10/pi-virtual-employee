# VE 与新版 scoped memory 的记忆机制调研与设计

> 真实意图：判断 2026-10-14 完成的 pi-scoped-memory v1 能否改善 VE 的跨会话记忆，重点是纠错、范围隔离、注入成本与检索安全。
> 日期：2026-10-14
> 状态：待评审（只做设计，未改业务代码）

## 0. 结论（先看）

**值得借鉴的是机制，不是存储实现。**

推荐在 VE 现有 SQLite / KnowledgeService / 混合检索之上分三步演进：

1. **先修纠错语义（最高优先级，小切片）**：`remember` 同标题重写应是“一条事实的纠正覆盖”，不能继续把新旧偏好追加在一起。
2. **再做服务端推导的 scope / owner**：把记忆分为 `profile`、`person`、`conversation`，owner 从平台验证身份和会话 ID 推导，禁止模型自报身份。
3. **最后做摘要与检索隔离**：always-on 索引使用独立 summary；全文检索、自动整理都必须按 scope/owner 过滤，避免 A 客户/群的记忆泄漏到 B 会话。

不建议把 pi-scoped-memory 的 Markdown 目录、`memory_write` 工具或文件索引直接搬进 VE：VE 已有 SQLite、FTS5/BM25、可选向量、RRF、审核状态、lineage、版本、归档和自动整理；复制一套文件存储会形成第二套事实源。

---

## 1. 现状与接入点

### 1.1 VE 当前数据流

```text
IM/控制台 actor（平台验证身份）
  → buildTools(..., knowledge, resolveActor, conversationId)
  → remember(title, content)
  → KnowledgeService.saveMemory()
  → KnowledgeContentStore.saveLearned(tags="memory")
  → kb_entries + kb_chunks
  → BM25 / 可选 vector / RRF 检索
  → listMemoryIndex(30)
  → EmployeeEngine.promptPartsFor(conversationId)
  → buildSystemPrompt() 的“长期记忆”段
```

代码事实：

- 每个 Electron profile 使用独立 `userData/pi-employee.sqlite`：`electron/main.ts:141,416,419`。
- `remember` 工具目前只有 `title`、`content` 两个字段：`src/engine/tools/save-knowledge.ts:143-196`。
- `saveMemory()` 直接调用 `saveLearned({ tags: "memory" })`：`src/knowledge/knowledge-service.ts:113-121`。
- 同标题已存在时，`saveLearned()` 把新正文 append 到旧正文后：`src/knowledge/store.ts:149-176`。
- always-on 索引取最近 30 条，每条用正文归一化后的前 100 字：`src/knowledge/knowledge-service.ts:123-130`、`src/knowledge/store.ts:121-134`。
- prompt 虽然有 `conversationId`，但调用 `listMemoryIndex()` 时没有 actor / scope 参数：`src/engine/engine.ts:2080-2082`。
- prompt 告诉模型“同标题重存即更新”：`src/engine/prompt.ts:66-70`；这与 append 实现矛盾。
- 本地检索已经融合 BM25 与 vector，并读取 confidence / review / archived / superseded 元数据：`src/knowledge/retrieval/local-retrieval.ts:55-125`。
- 自动整理候选包含 `learned`、`derived`、`research`：`src/knowledge/store.ts:421-429`；若未来加入 owner，不能跨 owner 合并。

### 1.2 已实测的当前缺陷

用真实生产代码（esbuild bundle `KnowledgeContentStore`，真实 `node:sqlite`）做了合成探针：

1. 保存“请用英文回复”。
2. 同标题保存“纠正：以后请用中文回复”。

结果：

- 返回同一个 entry id，`merged=true`。
- 数据库正文同时包含英文旧偏好和中文纠正。
- `listMemory()[0].content` 仍以旧偏好开头。
- always-on snippet 取正文前 100 字，因此旧偏好仍可能被注入。

这不是文案问题，而是“纠错覆盖”契约没有实现。

### 1.3 VE 已有的可复用基础

- `kb_entries` 已有 `version`、`lineage`、`confidence`、`review_status`、`hit_count`、`superseded_by`、`archived`：见 schema 与迁移 `src/db/sqlite.ts`。
- 软归档、恢复、按 id 修订、派生合并已经存在：`src/knowledge/store.ts`、`src/knowledge/knowledge-service.ts`。
- 检索层已经有 entry metadata 后过滤和 pending 降权：`src/knowledge/retrieval/local-retrieval.ts:78-108`。
- 权限信任锚是平台签名 payload 中的 senderId：`src/security/permissions.ts`；记忆 owner 必须沿这个信任边界推导。

---

## 2. 外部调研

### 2.1 pi-scoped-memory v1（本机新包，2026-10-14）

本地仓库：`/Users/jason/projects/opensource/pi-virtual-employee/../pi-scoped-memory`，提交：

- `567b181` 仓库骨架
- `db74452` v1：双层注入、类型路由、frontmatter、关键词检索
- `19d557d` 包名迁入 `@wengine-ai` scope
- `216c558` 迁移指南

已实现机制：

- **两层 root**：全局 `~/.pi/agent/memory`，项目层 `~/.pi/agent/memory-projects/<slug>-<sha16>`；项目 root 由规范化 cwd 的 SHA-256 前 16 位决定，Bash `cd` 不改变 root：`src/paths.ts:20-42`。
- **路径 containment**：只允许 root 下一层文件，事实名限 kebab-case：`src/paths.ts:49-68`。
- **类型默认路由**：`user|feedback → global`，`project|reference → project`，显式 `target` 可覆盖：`src/store.ts:9-19`。
- **一事一文件 + MEMORY.md 索引 pointer**：`writeFact()` 更新事实文件和索引：`src/store.ts:28-61`。
- **会话开始冻结快照**：读取全局和项目索引，拼入一个 Scoped Memory 块：`src/inject.ts:22-68`；扩展在 `session_start` 构建、`before_agent_start` 追加：`index.ts:14-27`。
- **索引上限**：每层最多 200 行 / 25,000 字符：`src/inject.ts:13-14,39-48`。
- **关键词检索**：跨 project/global 扫 Markdown，做大小写不敏感子串匹配：`src/store.ts:84-113`。

不能照抄的问题：

- 它的 `renderFact()` 遇到已有 `originSessionId` 时返回旧文件原文，而 `writeFact()` 仍返回成功并更新 MEMORY.md 的 description。真实生产探针证实：第二次写入后正文仍是旧 body，索引摘要却变成新 description。VE 不能复制这个“成功但未覆盖”的策略。
- `sanitizeInjected()` 虽从 `inject.ts` re-export，但 `buildMemoryBlock()` 没有调用它；不能把“已做注入消毒”当作既成事实。
- 关键词检索是文件扫描，不如 VE 现有 FTS/vector/RRF；v1 也没有 qmd 语义检索（README 将其列为 v2）。
- 文件 root 适合 coding agent 的 cwd，不适合 VE 的“人 / 钉钉群 / profile / 定时任务创建人”身份模型。

### 2.2 ZCode v2 memory 设计

上游设计文档：

- <https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/design/v2/memory/README.md>
- 本地 API 拉取副本：`/tmp/zcode-memory/README.md`

可借鉴点：

- project key 同样使用 `basename slug + SHA-256[:16]`，workspace identity 优先于本地路径；会话初始化后冻结，命令执行中的 `cd` 不切换记忆 root。
- 一个事实一个 Markdown 文件；错误事实应更新/删除，而不是无限追加历史版本。
- `user`、`feedback`、`project`、`reference` 四类事实区分用户偏好、协作反馈、项目决策、外部指针。
- 只有 Main-equivalent runtime 获得 project memory；普通 child / workflow child 不默认继承，避免子任务扩大记忆读写面。
- Recall 使用 manifest + selector，而不是每轮把所有事实塞进 prompt。
- headless `-p` 明确关闭成功 turn 后的后台 Extraction，避免无人值守运行意外写记忆。

不适合直接照搬：

- ZCode 的 project root 以 workspace/cwd 为核心；VE 的隔离核心是平台身份与 IM conversation。
- ZCode v2 的 selector / Dream / 自动抽取较重，VE 已有 KnowledgeService consolidation，不应平行再造。

### 2.3 pi-memory 的反面证据

- README 记录 stable snapshot 的原因：per-turn 重注入会从首个差异 token 开始破坏 prefix cache；但长时写入不刷新又需要工具读取权威内容。
- Issue #50：<https://github.com/jayzeng/pi-memory/issues/50>  
  即使记忆块字节稳定，若扩展用“替换整个 systemPrompt”的方式注入，仍可能破坏其他 structured section 的缓存保留。VE 当前自己组装 prompt，暂不走 pi extension hook；后续升级 SDK 注入点时应优先追加独立 section，避免整体替换。
- Issue #48：<https://github.com/jayzeng/pi-memory/issues/48>  
  compaction handoff 把 scratchpad 完整复制到 daily log，语义检索被过期副本淹没。教训：**记忆索引和自动交接副本不能混在同一个可检索事实集合里**，历史快照默认不应与当前事实同权。

---

## 3. 外部做法到 VE 的适配判断

| 外部做法 | VE 现状 | 接入点 | 判断 |
|---|---|---|---|
| global/project 两层 root | profile SQLite 单库，记忆无 owner | `kb_entries` 增加 scope/owner，查询带身份上下文 | **借鉴语义，不搬目录** |
| cwd hash root | VE 不信任 cwd，信任平台 senderId/chatId | `InboundActor.senderId`、`channel`、`chatType`、conversationId | 改为身份/会话 hash 或规范化 key |
| 一事一文件 | 一条 KB entry + chunks | `remember` 使用 replace 更新同一事实 | **立即借鉴** |
| 独立 description hook | snippet 从正文前 100 字截取 | `kb_entries` 增加 `summary` 或先用 title | 第二阶段 |
| session_start 冻结快照 | VE 写入后 bump revision，让 live session 立即拿到新记忆 | `memoryRevision` | 保留即时纠错；KV 稳定以后再评估 |
| keyword 文件搜索 | FTS5/BM25 + vector + RRF | `LocalRetrievalProvider` | VE 现有方案更强，不降级 |
| selector/recall | always-on 30 条 + search | `search_knowledge_base` 或新 `search_memory` | 第三阶段做 scope-aware recall |
| child 不默认继承 project memory | VE scheduler 跟随创建人权限 | scheduler actor / tool build | scope 必须随创建人身份传入 |
| 自动 Extraction | 已有 consolidation / auto-learn | `listConsolidationCandidates`、consolidation txn | 加 scope 分组，禁止跨 owner 合并 |

---

## 4. 方案对比

### 方案 A：直接安装/移植 pi-scoped-memory

- 改动面：Electron 内引入 pi extension 运行方式或复制文件存储，与 KnowledgeService 并行。
- 优点：全局/项目分层和工具形态上线快。
- 缺点：
  - VE 不是 pi-coding-agent extension host；直接运行扩展的适配成本高。
  - Markdown 与 SQLite 形成两套记忆源，UI、检索、导入导出、清理策略都会分叉。
  - cwd scope 不能表达钉钉用户/群/创建人。
  - 关键词扫描弱于现有混合检索。
  - 上游 v1 的覆盖写入缺陷需要先修。
- 结论：**不推荐**。

### 方案 B：在现有 KB 上补“记忆类型契约”（只修纠错）

- 改动面：`remember` 不再走 append 的 `saveLearned()`，改为专用 replace/upsert；测试修正。
- 优点：切片最小，立即消除旧偏好压过纠正的问题。
- 缺点：仍然没有 person/conversation 隔离，A 群记忆可进入 B 群 prompt/检索。
- 结论：**作为第一阶段，推荐立即做**。

### 方案 C：KB 单库内实现 scoped memory（推荐）

- 改动面：schema + store + engine prompt + remember tool + retrieval filter + consolidation partition + UI。
- 优点：
  - 沿用 SQLite、事务、chunk/vector、审核、归档、版本和现有 UI。
  - scope/owner 由服务端身份推导，符合 VE RBAC 模型。
  - 不需要迁移 Markdown，也不会把客户数据放到项目目录。
- 缺点：需要一次性把 always-on 索引、全文检索、自动整理三条读路径都加过滤，不能只改写入。
- 结论：**推荐目标方案**，但按 B → scope → summary/recall 分阶段交付。

---

## 5. 推荐设计：单库 scoped memory

### 5.1 Scope 模型

新增枚举：

```text
profile       — 当前 VE profile 的共享/管理者级长期事实
person        — 某个平台身份的个人偏好/纠正（跨同身份单聊/群聊）
conversation  — 某个 IM 群/会话的局部事实
```

字段建议：

```sql
ALTER TABLE kb_entries ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'profile';
ALTER TABLE kb_entries ADD COLUMN memory_owner TEXT;
ALTER TABLE kb_entries ADD COLUMN memory_summary TEXT;
```

- 非 memory 条目：`memory_scope='profile'`、`memory_owner=NULL`，不参与记忆语义。
- 旧 memory 条目：迁移为 `profile`。这些数据原本就被无差别注入所有会话，迁移成 profile 保持可见性，不改变现有授权。
- 新 person owner：推荐 `${channel}:${chatType}:${senderId}` 或稳定 platform staffId；不要用显示名。
- conversation owner：使用服务端已验证的 conversation ID；群 ID 不向模型索要。
- 定时任务：使用任务创建人的 actor 上下文；没有创建人的旧任务按 profile 只读或不写 person memory。

### 5.2 写入权限与默认路由

`remember` 参数保持简单，scope 尽量由服务端推导，模型只能给“意图”，不能给 owner：

```text
桌面控制台/admin 单聊：默认 profile
IM 普通成员：默认 person
IM 群内：默认 person；明确说“记住本群/这个项目组……”时才 conversation
明确“所有客户/所有群/以后全局……”：要求 admin，否则降级 person 并说明
```

执行侧：

- 工具注册仍由 `learn` capability 控制。
- 工具内部再做数据域授权：viewer 只能写自己的 person；operator/admin 才能写 conversation；profile 写需要 admin。
- owner key 从 `resolveActor(conversationId)` 与 `conversationId` 生成，忽略模型传入的 staffId/群号。
- 拒绝时返回普通工具拒绝，不要求对方提供 ID。

### 5.3 纠错覆盖

新增专用路径，不复用 `saveLearned()` 的 append：

- identity key：`(tags 含 memory, memory_scope, memory_owner, normalized(title))`。
- `remember` 默认找到同 scope/owner/title 的 live entry 并整体替换 content/summary，`version=version+1`，重建 chunks。
- 需要保留审计时不把旧正文拼进当前正文；旧版本可依赖后续历史表，或沿用 `superseded_by`/lineage 建立新版本条目。
- `saveLearned()` 保留给普通自动知识沉淀；不能让普通知识 append 规则决定记忆纠错。
- 同一事实的旧 chunk/vector 必须在同一事务里替换，避免检索仍命中旧正文。

最小验收：

1. 英文偏好 → 中文纠正后，entry 正文只包含中文纠正。
2. always-on 索引只出现新 summary。
3. FTS/vector 不再检索到旧偏好正文。
4. 同标题但 owner 不同的两条事实互不覆盖。

### 5.4 Always-on 注入

当前：最近 30 条 memory，每条 `title — content.slice(0,100)`。

建议：

```sql
WHERE archived=0
  AND tags LIKE '%,memory,%'
  AND (
    memory_scope='profile'
    OR (memory_scope='person' AND memory_owner=:personKey)
    OR (memory_scope='conversation' AND memory_owner=:conversationKey)
  )
ORDER BY
  CASE memory_scope WHEN 'conversation' THEN 0 WHEN 'person' THEN 1 ELSE 2 END,
  updated_at DESC
LIMIT 30
```

- 使用 `memory_summary`；为空时暂时用 title，不用正文前 100 字。
- prompt 中明确这些是“历史记忆，可能过时；与当前用户明确要求冲突时，以当前消息为准；不得覆盖权限/真实取数规则”。
- 记忆来自其他用户输入，应按不可信数据包裹，不能让其中的“忽略规则/泄露密钥”文本提权。
- 写入后继续 bump `memoryRevision`，保证纠正当轮之后生效；pi-scoped 的 session 内冻结快照可作为未来 KV cache 优化，而非第一阶段目标。

### 5.5 检索隔离

`search_knowledge_base` 与任何外接/本地检索都必须保证：

- 普通业务知识：按现状返回。
- profile memory：在当前 profile 内可见。
- person/conversation memory：只在 owner 匹配时返回。

推荐在 `KnowledgeService.search(query, memoryContext)` 传入：

```ts
interface MemoryScopeContext {
  personKey?: string;
  conversationKey?: string;
}
```

实现顺序：

1. `LocalRetrievalProvider` 拿到 chunk 后，对 manual source 批量读取 entry 的 scope/owner。
2. 过滤不可见 memory；非 memory 条目不受影响。
3. vector/FTS 已取出的越界命中只在本进程过滤，不返回 snippet。
4. 若后续对召回率有要求，再把 scope/owner 放入 chunk metadata 并下推到 SQL/KNN 过滤。

外接知识库不保存 VE 私域 memory；memory 只留本地 SQLite。

### 5.6 自动整理 / consolidation

必须禁止跨 scope 合并：

- 候选按 `(memory_scope, memory_owner)` 分组。
- merge/generalize 只能在同组内发生。
- person A 与 person B 标题相同也不是重复条目。
- conversation 记忆整理后若要提升为 person/profile，必须经过显式授权，不自动提升。
- handoff、daily、压缩摘要等过程材料不要作为 memory entry 入库；它们可以进入会话日志/遥测，但不能和当前长期事实同权检索。

### 5.7 文件级改动清单

第一阶段（纠错）：

- `src/knowledge/store.ts`：新增 `replaceMemory()` / `upsertMemoryFact()`，同 scope/owner/title 覆盖并重建 chunks。
- `src/knowledge/knowledge-service.ts`：`saveMemory()` 改走专用 replace 路径；补 mode/scope 预留。
- `src/engine/tools/save-knowledge.ts`：更新工具描述，明确“纠正覆盖”；返回 replaced/created。
- `scripts/test-knowledge-store.mjs`：增加旧正文不残留、chunk 替换、snippet 正确的真实 SQLite 测试。
- `src/engine/prompt.ts`：修正文案，避免承诺未实现的行为。

第二阶段（scope）：

- `src/db/sqlite.ts`：三列迁移与索引。
- `src/db/history-store.ts` 或共享 identity helper：集中生成 stable person/conversation key。
- `src/engine/definition.ts`、`src/engine/tools/save-knowledge.ts`：向 remember 注入 actor/conversation 上下文与数据域授权。
- `src/engine/engine.ts`：promptPartsFor 按当前 actor/conversation 取记忆。
- `src/knowledge/knowledge-service.ts`、`retrieval/local-retrieval.ts`：检索 scope filter。
- UI：记忆列表展示 scope/owner，管理员可按人/群筛选或归档。

第三阶段（summary/recall）：

- schema/工具：summary 必填或服务端生成；新 `search_memory` 或在 KB search 中明确 memory 命中。
- consolidation：按 scope 分组、过期记忆归档。
- prompt/KV：评估会话内快照和写入后的定向刷新，不整体替换 system prompt。

---

## 6. 分阶段实施

### Slice 1：可验证的纠错覆盖（建议下一张 PR）

- 不改 schema/owner，只把 `remember` 从 append 改为 title 级 replace。
- 真实 SQLite 断言：旧 content 与旧 chunk 均不可检索，新 snippet 生效。
- 风险小，可独立回滚。

### Slice 2：scope/owner 写入与注入

- 加字段和迁移，默认旧 memory=profile。
- 新写入按 actor 打 owner。
- always-on 索引先过滤；若检索过滤来不及同 PR 完成，应把 person/conversation memory 的全文检索暂时关闭，不能先写后漏。

### Slice 3：检索与整理闭环

- LocalRetrievalProvider 过滤。
- consolidation 同组合并。
- UI 管理与迁移工具。

### Slice 4：可选增强

- 独立 summary / selector recall。
- 会话内稳定快照与写入后缓存边界。
- 记忆过期、prompts 注入消毒和 secret/PII 扫描。

---

## 7. 风险与回滚

- **误覆盖业务知识**：只对 tags=`memory` 的显式 `remember` 路径启用 replace；普通 `save_to_knowledge` 保持原语义。
- **owner key 不稳定**：优先使用平台稳定 staffId；显示名只作展示。迁移期旧数据保持 profile，不强行归人。
- **检索越权**：scope PR 必须同时覆盖 always-on 与 search；做不到时宁可先不写 person/conversation 记忆。
- **自动整理跨人合并**：加 scope 后 consolidation 不分组即视为阻断缺陷。
- **prompt injection**：客户文本进入记忆后仍是数据，不是指令；profile admin 规则也要通过受保护 prompt/权限层生效，不能只靠记忆文本。
- **回滚**：新增列可保留；代码回滚后旧版本会忽略 scope 列，但可能重新读到全部 memory。因此 scope 上线前应确认版本覆盖率，或在回滚包中临时把新 scope 条目归档。

---

## 8. 盲区与待拍板

1. **群内普通成员是否允许写 conversation memory？**
   - 保守方案：只有 operator/admin 能写群记忆，viewer 只写 person memory。
   - 宽松方案：参与者都能写，但需要群管理员整理/归档。建议先保守。
2. **同一人在多个群的个人记忆是否共享？**
   - 建议共享 person scope；群事实单独 conversation scope。
3. **旧记忆迁移是否要尝试按标题/正文自动归人？**
   - 不建议。没有可靠 owner 证据，自动归属比保留 profile 更危险。
4. **summary 由模型写还是服务端截取？**
   - 建议模型提供一行 summary，服务端限长；为空时用 title，不用正文首句。
5. **是否新增 `search_memory` 工具？**
   - 短期可复用 scope-aware `search_knowledge_base`；长期若要把个人记忆与业务知识的置信度/排序分开，再新增工具更清晰。

## 9. 最终建议

**下一步只做 Slice 1：修正 `remember` 的纠正覆盖。** 这是当前已经有真实代码证据、收益明确、改动面最小的缺陷。scope/owner 是正确的中期方向，但它是安全边界改造，必须把 prompt、检索和 consolidation 三条读路径一起设计，不能只加两个字段。
