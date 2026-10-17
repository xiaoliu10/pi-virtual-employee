# VE 内核迁移设计：接入 pi-coding-agent（AgentSession 包裹方案）

> 状态：**设计定稿，待 Phase 0 spike 验证后开工**（2026-10-17）
> 决策记录：用户拍板方向——VE 换 pi-coding-agent 内核，pi runtime 独立分发（默认 GitHub、网络不通走国内源），解决安装包体积红线，统一 VE 与 desktop 内核，插件生态共用。
> 关联：`docs/design/pi-quality-infrastructure.md`（desktop 侧质量插件）、`docs/design/settle-verify-gate.md`（VE 收尾验证门禁）、pi 官方文档 `docs/sdk.md` / `docs/extensions.md`。

---

## 1. 背景与动机

### 1.1 为什么换

| 动机 | 说明 |
| --- | --- |
| 插件生态直装 | VE 目前直包 pi-agent-core 裸内核，没有扩展运行时——pi-quality-gates 等插件装不进 VE。换 AgentSession 后 `tool_call`/`tool_result`/`agent_before_settle` 事件链是平台原生的 |
| 甩掉 vendor 负担 | `src/engine/pi-compaction.ts`（558 行）是从 pi-coding-agent 1.1.0 手工拷贝的压缩原语，上游每次移动模块边界（0.99.1→1.1.0 有前科）都要人工对齐 |
| 内核统一 | VE（1.1.0 裸内核）、desktop（spawn pi CLI 1.2.0）、CLI 用户三方各自演化；统一后插件、行为、心智一致 |
| 分发解耦 | runtime 独立分发后，安装包与 pi 版本解耦：pi 升级 = 换 runtime 版本号，不用重打安装包 |

### 1.2 包大小问题怎么解的

现状：Windows 安装包 96.5 MiB，顶着 Gitee 100 MiB 单资产红线——这是当年 vendor 压缩模块而不是依赖 pi-coding-agent 的全部原因。

方案：**pi-coding-agent 及其依赖树不进安装包**，作为独立 runtime 在用户机器上由引导器安装（详见 §6）。安装包保持现状体积。

### 1.3 明确不改的

- **Engine facade 不变**：`EmployeeRuntime` 接口（`getOrCreateSession/send/dropSession/...`）与其全部调用方（work-service、链路 runner、IM manager、transport/http）零改动——这是回滚安全的前提。
- **orchestrator 不变**：marker 协议、work-service 窗口循环、链路 runner、调度器、推送模板全部不动。
- **数据库不变**：VE SQLite（history/telemetry/work_items/knowledge…）仍是唯一持久化权威。

---

## 2. 目标与非目标

### 目标

1. VE 主进程内运行 pi-coding-agent 的 `AgentSession`，扩展运行时原生可用（pi 插件直装）。
2. pi runtime 独立分发：npmmirror（主）→ Gitee（备）→ GitHub（兜底）来源链，锁版本、带校验、可回退。
3. `src/engine/pi-compaction.ts` vendor 退役，压缩原语改为运行时 import 真包。
4. 47 套件测试迁移后全绿；现有现场行为（退化门禁/压缩口径/遥测/记忆注入）语义保持。
5. 单盒灰度通过后全量推送。

### 非目标

- 不做 desktop 的子进程 RPC 形态（VE 保持进程内）。
- 不迁移到 pi 的 jsonl 会话持久化（VE SQLite 仍是权威，见 D2）。
- 不引入 pi 的编码工具（read/bash/edit）——VE 工具集全部自研，继续自研。
- 不在本迁移中改任何 IM/RBAC/调度行为。

---

## 3. 关键架构事实（本设计的前提发现）

**`AgentSession` 本身就是包在 pi-agent-core `Agent` 外面的一层。**

```ts
// pi-coding-agent dist/core/agent-session.d.ts:112
export interface AgentSessionConfig {
    agent: Agent;                    // ← 就是 VE 现在直接用的那个类
    sessionManager: SessionManager;
    settingsManager: SettingsManager;
    cwd: string;
    scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
    resourceLoader: ResourceLoader;
    customTools?: ToolDefinition[];  // SDK 自定义工具（扩展运行时之外注册）
    modelRuntime: ModelRuntime;
    initialActiveToolNames?: string[];
    // ...
}
```

这改变了迁移的 invasive 程度：**不是"换掉循环"，而是"在循环外面加一层会话壳"**。VE 的 Agent 构建管线（自定义工具、resolveModel、streamFn 会话亲和）可以基本保留。

由此有三个迁移深度选项：

| 选项 | 内容 | 结论 |
| --- | --- | --- |
| A. 全盘 SDK | `createAgentSession()` 全托管：pi 的循环/重试/压缩/工具 | ❌ VE 的重试/退化门禁/压缩口径与 pi 内建语义冲突，行为回归不可控 |
| B. 包裹式（**选定**） | 保留 VE 自建 `Agent`（工具/模型/streamFn 不动），外面套 `AgentSession` 拿扩展运行时 + SessionManager + 压缩原语真依赖 | ✅ 增量可控，facade 不变，行为重挂面最小 |
| C. 仅事件模拟 | 不引入 AgentSession，VE 自己模拟 3 个扩展事件 | ❌ 不是真 pi 插件生态，白做 |

---

## 4. 现状盘点与文件处置总表

### 4.1 引擎层现状（src/engine/，合计 12,871 行）

| 文件 | 行数 | 职责 | 处置 |
| --- | --- | --- | --- |
| `engine.ts` | 2,670 | EmployeeEngine facade：会话生命周期、send() 管线（:1828-2140）、重试/退化门禁、遥测、auth/model/skills、mine/progress | **大改（内部），facade API 冻结**（见 4.2） |
| `context.ts` | 747 | token 估算（estimateTokensSafe CJK 口径）、两道压缩闸门、切点、 FINAL_SUMMARY、溢出恢复 | **保留**（压缩口径一行不动），压缩执行入口改调真包原语 |
| `pi-compaction.ts` | 558 | vendor 自 pi-coding-agent 1.1.0 的压缩原语 | **Phase 3 退役**：import 改 runtime 真包；vendor 文件删除（§8.2） |
| `definition.ts` | 418 | 30+ 工具工厂组装 + 权限检查（checkPermission）+ onEvent 遥测挂点 | **保留**，末端加 AgentTool→ToolDefinition 适配（§7.4） |
| `prompt.ts` | 271 | 系统提示词组装 | **保留**；注入方式见 §8.6 |
| `progress.ts` | 277 | 心跳旁路进度总结 | **保留** |
| `tools/*.ts` | ~8,000 | 30+ 工具工厂（AgentTool 形状） | **保留不动**（形状兼容见 §7.4） |
| `credential-store.ts` | — | 凭据存储（auth.json） | **保留**（spike S3 决定是否桥 ModelRuntime） |

### 4.2 Engine facade API 冻结表（签名一个都不能变）

调用方：`electron/main.ts`（:469 构造 + work/scheduler runner）、`src/im/manager.ts`（15 处）、`src/transport/http.ts`、各测试 harness。

```
getOrCreateSession(conversationId): Agent        // 返回类型不变（Agent 仍是自建管线）
send(agent, message, ctx?): Promise<SendResult>  // SendResult 含 reply/error/deterministic/toolCalls
dropSession / activeSessionCount / isReadOnlyConversation
steerConversation / abortSession / resetSession / markTurnAbort
turnIdleMs / turnStallSnapshot / isConversationStreaming
compactSession(conversationId): Promise<string>
noteAuthorizationNeeded / confirmAuthorization / isAuthorizationPhrase
authCatalog / authLogin / authLoginStatus / authLoginAnswer / authLoginCancel / authLogout / authQuota
availableModels / setDefaultModel / setConversationModel / clearConversationModel / testModelConnection
listSkills / refreshSkills / invalidate / markSkillsChanged / markMemoryChanged / markConfigChanged
complete(systemPrompt, userPrompt, opts)         // 心跳总结/prompt lab 用的旁路 LLM 调用
mineRecentWork / progressBrief / briefProgress / runEvalTurn / buildPromptWithRules
setTelemetryStore / setPromptLab / setProposalStore / setComputerService / setPlaywrightCliPath
setRequestTimeoutMs / setUpdateOperations / appVersion
```

`SendCtx`（:81）与 `SendResult`（:60）结构冻结。

---

## 5. 目标架构

```
┌─ Electron main ─────────────────────────────────────────────────┐
│                                                                  │
│  runtime bootstrap（新增，§6）                                    │
│    userData/pi-runtime/  ← npmmirror/Gitee/GitHub 装机 + 自检     │
│         │ 动态 import（绝对路径，不进 bundle）                     │
│         ▼                                                        │
│  EmployeeEngine（facade 冻结）                                    │
│    ├─ getOrCreateSession(convId)                                 │
│    │    ├─ Agent（自建：工具/resolveModel/streamFn 亲和）←不变     │
│    │    └─ AgentSession（新）：agent + inMemory SessionManager    │
│    │         + extension runtime ← pi-quality-gates 等插件挂这里   │
│    ├─ send() 管线：session.prompt() 替代 agent.prompt()           │
│    │    重试/退化门禁/遥测/记忆前缀 保持在 VE 包装层 ←不变          │
│    └─ 压缩：VE 闸门（context.ts 口径不变）→ 真包原语执行            │
│                                                                  │
│  orchestrator（work-service / 链路 runner / IM）← 全部不动         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Phase 1：pi runtime 独立分发（引导器）

### 6.1 目录与清单

```
<userData>/pi-runtime/
  runtime.json          # { platform, arch, pi: "1.2.0", node: "electron-内嵌", installedAt, sha256 }
  node_modules/         # npm ci 产物：@earendil-works/pi-coding-agent 及全依赖树
  .lockfile             # 锁定版本的 package-lock.json（随 VE 安装包内置）
```

- 锁定文件 `resources/pi-runtime-lock/package.json` + `package-lock.json` **随 VE 安装包内置**（几 KB）：钉死 pi 版本与全依赖树 SHA。pi 升级 = VE 发版更新这份 lock。
- 引导器源码：新增 `src/runtime/bootstrap.ts`（约 300 行）。

### 6.2 来源链（顺序即优先级）

| 序 | 来源 | 地址 | 说明 |
| --- | --- | --- | --- |
| 1 | **npmmirror** | `https://registry.npmmirror.com` | 阿里 CDN，国内最稳；现场盒子 GitHub 不通是实证（gh-proxy.com 才通），所以它是**默认第一**而非兜底 |
| 2 | Gitee | VE 自托管 runtime tarball（若 ≤100 MiB 单资产） | 与 VE 更新同源 |
| 3 | GitHub | `registry.npmjs.org` / GitHub Releases | 海外/代理环境 |
| 4 | 自定义 | `general.piRegistryUrl` 设置项 | 用户自带代理/私有源 |

实现：`npm ci --registry <源>` 逐源尝试（`--omit=dev --no-audit --no-fund`）；一个源整体失败（含任一包 404/超时）才切下一个。复用 `electron/update-download-retry.ts` 的退避重试基建。

### 6.3 node 二进制：不下载

复用 desktop 已验证的 **`ELECTRON_RUN_AS_NODE`** 技巧：VE 自带的 Electron 二进制就是 node 运行时。两种用法：

- **进程内（主路径）**：主进程直接 `import(<userData>/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js)`——不涉及 node 二进制。
- **版本自检**：`spawn(process.execPath, [cli, '--version'], { env: { ELECTRON_RUN_AS_NODE: '1' } })`，输出必须等于 lock 里的 pi 版本（照抄 desktop prepare-runtime 的防谎报逻辑：spawn 前删 `PI_PACKAGE_DIR`/`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`）。

> 【spike S5】验证 ELECTRON_RUN_AS_NODE 下 pi 1.2.0 CLI/SDK 完整可用（desktop 只用它做过 --version 检查）。

### 6.4 安装流程（首次启动 / 版本变更时）

```
启动 → 读 runtime.json
  ├─ 存在且 pi 版本 == lock 要求 且 --version 自检通过 → 直接用
  ├─ 不存在/版本不符/自检失败 → 引导安装：
  │     ① 逐源 npm ci（进度事件发给设置页 UI）
  │     ② --version 自检（防谎报 env 清理）
  │     ③ 关键导出冒烟（import + createAgentSessionFromServices 干跑，见 6.5）
  │     ④ 写 runtime.json（原子：临时文件 + rename）
  ├─ 安装失败 → 重试链走完 → 明确报错：
  │     「pi 运行时安装失败（已试 npmmirror/Gitee/GitHub）。请检查网络或在设置中配置 piRegistryUrl 后重试。」
  │     引擎不启动（不许带病运行——裸内核回退路线在 Phase 4 灰度期保留，见 §12）
  └─ 【灰度期专属】设置项 general.engineKernel: "legacy" | "pi-session"（默认 legacy）
        legacy = 现行裸内核路径原样保留，灰度切量用；Phase 4 结束后删除
```

### 6.5 完整性校验

- `npm ci` 本身由 lockfile 保证树确定性；
- 装完对 `node_modules/@earendil-works/pi-coding-agent/dist/index.js` 等关键文件做 SHA-256 抽查（清单内置）；
- 冒烟干跑（§6.4 ③）兜底一切静态校验漏掉的坏。

### 6.6 涉及文件（Phase 1 交付物）

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src/runtime/bootstrap.ts` | 新增 | 引导器：ensureRuntime(lock) → { status: 'ready'|'installed'|'failed', indexPath } |
| `src/runtime/verify.ts` | 新增 | --version 自检（ELECTRON_RUN_AS_NODE + 防谎报 env）、SHA 抽查、冒烟干跑 |
| `resources/pi-runtime-lock/{package.json,package-lock.json}` | 新增 | 版本锁定（钉 pi 1.2.0 全树） |
| `electron/main.ts` | 小改 | 启动序列最前面插 `ensureRuntime()`；灰度开关读取；失败时错误页 |
| `src/db/config-store.ts` | 小改 | `general.piRegistryUrl`、`general.engineKernel` 设置项 |
| `renderer/src/pages/SettingsPage.tsx` | 小改 | runtime 状态卡片（版本/来源/重装按钮/进度） |
| `package.json`（构建） | 小改 | 打包带入 pi-runtime-lock |
| `scripts/test-runtime-bootstrap.mjs` | 新增 | 引导器测试：源切换/校验失败/原子写/断点（本地 http mock 三个源） |

---

## 7. Phase 2：内核替换（Engine facade 后换芯）

### 7.1 依赖变更

```jsonc
// package.json —— pi 包不出现在 dependencies！运行时由 bootstrap 装到 userData。
// 类型开发期依赖走 devDependencies（不进打包产物）：
"devDependencies": {
  "@earendil-works/pi-coding-agent": "1.2.0"   // 仅类型 + 测试用
}
```

主进程对 runtime 的引用一律 `await import(path.join(runtimeDir, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'))`（【spike S4】验证 Electron main 下动态 import 的 ESM/CJS 互操作与打包器排除配置）。

### 7.2 会话生命周期：getOrCreateSession 改造

现状（`engine.ts:886`）：`new Agent({...})` 存 `Map<conversationId, Agent>`。

改造（`engine.ts` 内部，facade 签名不变）：

```ts
// 新增 src/engine/session-host.ts
interface SessionHost {
  agent: Agent;            // VE 自建管线（原 getOrCreateSession 的构造体，原样保留）
  session: AgentSession;   // 包裹层（扩展运行时宿主）
}

// getOrCreateSession 内部：
// 1) agent = this.buildAgent(conversationId)      ← 原 :886-940 构造代码原样抽出
// 2) session = new AgentSession({
//      agent,                                     // ← 自建 Agent 直接传入（§3 前提事实）
//      sessionManager: SessionManager.inMemory(), // 【决策 D2】持久化仍归 VE SQLite
//      settingsManager: SettingsManager.inMemory(),
//      cwd: userData,                             // 不指向任何项目目录（无编码语义）
//      customTools: tools.map(toToolDefinition),  // §7.4 适配
//      modelRuntime: minimalModelRuntime,         // 【spike S3】最小实现或桥接
//      resourceLoader: minimalResourceLoader,     // 内联扩展宿主（§9）
//    })
// 3) session.bindExtensions(...)；扩展注册的 onEvent 桥接进 VE 遥测
```

【决策 D2】**SessionManager 用 inMemory()**：VE SQLite 已承载历史/保留清理/检索/scoped memory/mining 全链路，改由 pi jsonl 持久化意味着双写或迁移两条大工程且无收益。放弃 pi 的分支/fork 能力（VE 无此需求）。

【spike S1】验证 inMemory SessionManager + 自建 Agent + customTools 组合下：prompt/steer/abort/compact 正常、扩展事件对 customTools 触发。

### 7.3 send() 管线逐段映射（engine.ts:1828-2140）

| 段 | 现状（行号） | 处置 |
| --- | --- | --- |
| 会话前缀/记忆注入（withTurnMemoryPrefix） | send() 入口 | **不动**（VE 包装层，包的是 session.prompt() 而非 agent.prompt()） |
| prompt 调用 | `agent.prompt(message, visionImages)`（:2399） | 改 `session.prompt(message)`；vision 图片走 `session.steer/prompt` 的 images 参数或 PromptOptions【spike S6 验证形态】 |
| 流式聚合 → reply | Agent 事件流（:438 起） | 改 `session.subscribe(listener)`：`message_end` 取权威正文；`AgentSessionEvent` 映射表见 §8.4 |
| 瞬时重试（TRANSIENT_RETRIES=10 退避） | send() 内 :2371 起 | **保留**（VE 包装层）；pi 自带 auto-retry 需关闭避免双保险——【spike S7】SettingsManager RetrySettings 可配关闭则配，否则文档化重叠语义 |
| LENGTH_EMPTY_GIVE_UP + 退化门禁（#83） | send() 内 :162/:172 | **不动**（输入是 reply 文本 + stopReason，来源换成 session 事件而已） |
| 上下文溢出恢复 recoverFromContextOverflow | context.ts:213 + send() | **不动**（truncateToFit 操作 agent.state.messages——Agent 还是自建的，成立） |
| 会话亲和 streamFn | Agent 构造注入 | **不动**（Agent 自建，streamFn 原样） |
| 遥测（turn_events/tool_events） | recordTurnTelemetry(:2073)/recordToolTelemetry(:2056) | turn 层不动；tool 层从 definition onEvent 迁到 session `tool_execution_start/end` 事件（refused 判定随事件字段【spike S8】），迁完前双挂不丢数 |
| deadline/abort | agent.abort()（:438） | 改 `session.abort()`（返回 Promise，等 idle）；markTurnAbort 语义保留 |
| 空回复计数 emptyReplies | send() 内 | 不动 |

### 7.4 工具注册：AgentTool → ToolDefinition 适配

30+ 工具工厂（`definition.ts` 组装，`AgentTool<TSchema>` 形状：`execute(toolCallId, params, signal, onUpdate)`）**一行不改**。新增适配层：

```ts
// 新增 src/engine/tools/tool-adapter.ts（~80 行）
import type { ToolDefinition } from "<runtime>/pi-coding-agent";
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name, label: tool.label, description: tool.description,
    parameters: tool.parameters,          // typebox schema，两侧同源（pi-agent-core 也依赖 typebox）
    execute: tool.execute,                // 签名同构（toolCallId, params, signal, onUpdate）
    annotations: tool.annotations,
  };
}
```

权限检查（`checkPermission`/`permissionRefusal`）在工具 execute 内部，**不迁移**——refused 语义、遥测 refused 计数、RBAC 全部原样。扩展（如 pi-quality-gates）通过 `tool_call` 事件看到 VE 工具并可 block——平台原生能力，与 VE 自身权限层正交。

### 7.5 模型与凭据

- `resolveModel`（:630）/ models registry / credential-store / authLogin 全链路 **保留**——Agent 是自建的，模型解析不经过 pi 的 ModelRegistry。
- `AgentSessionConfig.modelRuntime` 必填 →【spike S3】验证 `createAgentSessionFromServices` 或最小 ModelRuntime stub（只满足 config 类型，不参与实际模型调用——模型调用走 Agent 的 streamFn）。若 stub 不可行，备选：把 VE models registry 桥接成 ModelRuntime（工作量 +3~5 天，Phase 2 内消化）。
- `setConversationModel` 等三方法：改的是自建 Agent 的 model，session 层同步 `session.setModel()` 仅在 pi 内建功能需要时调用（当前无）。

### 7.6 Phase 2 涉及文件

| 文件 | 动作 |
| --- | --- |
| `src/engine/session-host.ts` | 新增（~250 行）：SessionHost 构建、扩展宿主接线、事件桥 |
| `src/engine/tools/tool-adapter.ts` | 新增（~80 行） |
| `src/engine/engine.ts` | 内部改造：getOrCreateSession 抽出 buildAgent；send() 调用点 agent.prompt→session.prompt；abort/compact 走 session；Map 值类型 Agent→SessionHost |
| `src/engine/imports.ts` | 新增（~40 行）：runtime 动态 import 的唯一入口（类型重导出 + 路径解析），全仓库禁止直接 import pi-coding-agent |
| `electron/main.ts` | 小改：ensureRuntime 结果传给 Engine；灰度开关 |
| 其余调用方 | **零改动**（facade 冻结） |

---

## 8. Phase 3：行为重挂映射表

逐行为：现状位置 → 新落点 → 方式 → 钉住它的测试。

| # | 行为 | 现状 | 新落点 | 方式 | 测试 |
| --- | --- | --- | --- | --- | --- |
| 1 | CJK token 估算（0.2.67） | context.ts:134 estimateTokensSafe | **不变**（VE 闸门自己算） | 保留 | test-context |
| 2 | 两道压缩闸门（0.2.93） | engine.ts 闸门 + context.ts usableContextWindow:152 | 不变 | 保留 | test-context |
| 3 | 压缩执行（generateSummary 等） | pi-compaction.ts vendor | **改 import 真包**（`imports.ts` 统一出口），`DEFAULT_COMPACTION_SETTINGS/shouldCompact/generateSummary/convertToLlm` 全部来自 runtime 包 | vendor 退役（§8.2） | test-context + 新增 smoke |
| 4 | 压缩切点（0.2.69/0.2.80） | context.ts findCompactionCut:355 / findForcedCompactionCut:390 | 不变 | 保留 | test-context |
| 5 | 输出上限推导（0.2.95） | engine.ts :54/:1714 | 不变 | 保留 | test-engine-* |
| 6 | #83 退化门禁 + LENGTH_EMPTY_GIVE_UP | engine.ts :162/:172 | 不变（输入源 stopReason 换 session 事件） | 保留 | test-engine-retry（29 用例） |
| 7 | 瞬时重试（TRANSIENT_RETRIES=10） | engine.ts :147 | 不变；pi auto-retry 关闭【S7】 | 保留 | test-engine-retry |
| 8 | 遥测 turn/tool_events + degenerate_reply | telemetry-store + recordToolTelemetry | tool 层挂点迁 session 事件【S8】；turn 层不动 | 迁移 | test-engine-auth + 新增 |
| 9 | 会话亲和 streamFn（header 链） | Agent 构造注入 | 不变（Agent 自建） | 保留 | test-model-affinity |
| 10 | scoped memory 注入（withTurnMemoryPrefix / remember fail-closed） | engine.ts send 入口 + save-knowledge.ts | **不变**（包装层） | 保留 | test-scoped-memory（14 用例） |
| 11 | 心跳旁路总结（complete()） | engine.ts :815 | 不变（旁路自己起临时 Agent，不经 session） | 保留 | test-progress |
| 12 | 历史双写/保留清理/检索 | history-store + engine :980 | **不变**（VE SQLite 权威，D2） | 保留 | test-history-prune |
| 13 | 登录态/凭据/模型切换 | engine authCatalog/authLogin 系 + resolveModel | 不变 | 保留 | test-im-models |
| 14 | RBAC/工具权限 | definition.ts checkPermission | 不变（execute 内部） | 保留 | test-engine-auth |
| 15 | 收尾验证门禁（#84） | work-service/main.ts + settle-gate.ts | **不变**（SendResult.toolCalls 来源换事件统计，其余零改动） | 保留 | test-work-service 55 |
| 16 | marker 协议/自主链 | work-service/autonomous/main.ts | **零改动** | 保留 | test-autonomous 18 |

### 8.1 行为零回归的验证方式

上表 16 项中 13 项"保留/不变"——它们的测试套件原样跑绿即证明零回归。真正要新写验证的只有 #3（vendor→真包等价性）、#8（遥测挂点迁移）两项。

### 8.2 vendor 退役步骤（#3 详设）

1. `imports.ts` 暴露 `getCompactionPrimitives()`：从 runtime 包 import `generateSummary/shouldCompact/DEFAULT_COMPACTION_SETTINGS/convertToLlm/estimateTokens/estimateContextTokens/compact/findCutPoint`（pi-coding-agent 1.2.0 dist/index.d.ts 已确认导出全集）。
2. `pi-compaction.ts` 内部实现逐函数替换为 re-export from runtime（VE 的宿主加固——拒绝 aborted/error/length summary——包在 re-export 外层，**不丢**）。
3. 全测试跑绿后删除 vendor 文件体（保留 `BranchSummaryMessage`/`CompactionSummaryMessage` 等 VE 自有类型，迁至 `context.ts`）。
4. `third-party/pi-LICENSE.txt` 更新为 runtime 分发许可声明。

### 8.3 steer 语义对齐

现状 `agent.steer({role:'user',...})`（engine.ts:966）→ `session.steer(text, images)`（agent-session.d.ts:568）。注意 AgentSession 的 steer 在 streaming 外会 reject——VE 的 /steer 命令已有 `isConversationStreaming` 守卫（:988），语义映射保持：streaming 中 steer，空闲则普通轮。

### 8.4 事件映射表（session.subscribe → VE 消费）

| AgentSessionEvent | VE 消费 |
| --- | --- |
| `message_update`（text_delta） | （当前无流式 UI 依赖，忽略；transport/http 未来可用） |
| `message_end` | reply 正文聚合（替代现 Agent 事件流 :438 段） |
| `tool_execution_start/end` | recordToolTelemetry（含 onUpdate 部分结果，#8） |
| `agent_start/end/settled` | isConversationStreaming/turnIdleMs 状态机 |
| `session_before_compact/session_compact(_failed)` | 压缩闸门遥测 + 失败计数 |
| `turn_end` / `agent_before_settle` | **留给插件**（verify-gate 类）；VE 自身逻辑不用 |

---

## 9. 插件生态启用（Phase 3.5）

1. **InlineExtension 宿主**：`minimalResourceLoader` 注入 VE 内置扩展工厂（当前为空数组，机制先通）。
2. **用户插件目录**：`<userData>/pi-extensions/`，设置页管理（装/卸/启停）——对齐 desktop 插件市场资源格式（pi-package，npm keywords）。
3. **首个共线验证**：pi-quality-gates（desktop 侧已建 repo）作为互操作测试用例：VE 会话中 `tool_call` 标脏 → `agent_before_settle` 触发其检查器（【spike S9】验证其编辑类工具判定——VE 工具名与 EDIT_TOOLS 集合可能不匹配，需要它支持可配置工具名或 VE 侧映射）。
4. 插件失败隔离：扩展 handler 抛错按 pi 语义 fail-open 放行 + VE 侧审计日志，**不得** wedge 无人值守轮次（继承 CC #102649 教训）。

---

## 10. 测试迁移清单（47 套件逐个处置）

| 套件 | 钉的行为 | 处置 |
| --- | --- | --- |
| test-engine-retry（29） | 重试/退化门禁（#6/#7） | **保留**（harness 的 esbuild bundle 入口改经 imports.ts，让真包可注入 stub——测试不打真实 runtime） |
| test-engine-auth / test-im-commands / test-im-models | facade/RBAC/模型 | 保留，构造注入 stub session |
| test-context | 压缩口径（#1/#2/#4） | 保留；压缩原语来源改 stub |
| test-scoped-memory（14） | 记忆链路（#10） | 保留 |
| test-work-service（55）/ test-autonomous（18）/ test-work-e2e（3） | orchestrator（#15/#16） | **零改动**（facade 之下对它们不可见） |
| test-model-affinity | streamFn（#9） | 保留 |
| test-progress | 心跳（#11） | 保留 |
| test-history-prune | 历史（#12） | 保留 |
| test-runtime-bootstrap（新增） | 引导器（§6） | 新写：三源 mock/校验失败/原子写 |
| test-session-host（新增） | SessionHost/事件桥（§7.2） | 新写：事件映射表 §8.4 逐行断言 |
| 其余 scheduler/knowledge/updater 等 | 与内核无关 | 零改动 |

harness 策略：所有测试**不依赖真实 pi runtime**——imports.ts 提供注入点（`__setRuntimeStub()`），stub 实现 AgentSession 的最小接口。真实包只进 Phase 0 spike 与灰度验证。

---

## 11. 分期计划与验收标准

| 期 | 内容 | 工期 | 验收 |
| --- | --- | --- | --- |
| **Phase 0** | spike：S1–S9（§14）逐条出结论 | 1 周 | 每条 spike 有书面结论（可行/不可行/代价），不可行项有替代路径 |
| **Phase 1** | runtime 引导器 | 1–2 周 | 三源切换/断网降级/校验失败/原子写测试全绿；真机（Windows 盒子）首启装机成功 |
| **Phase 2** | 内核替换（facade 后换芯） | 2–3 周 | 47 套件绿（含新增 2 套件）；typecheck/build/immutable 绿；本地手测 IM 全链路 |
| **Phase 3** | 行为重挂 + vendor 退役 | 3–4 周 | §8 表 16 项逐项验收；#3 等价性对比测试（同输入 vendor vs 真包输出一致） |
| **Phase 3.5** | 插件生态 | 1 周 | pi-quality-gates 在 VE 会话内触发 settle 拦截（S9 结论落地） |
| **Phase 4** | 灰度 | 1 周 + 观察 | Nova 盒子切 `engineKernel: "pi-session"` 观察 ≥7 天：degenerate_reply 遥测、压缩触发率、无回归报告 → 全量 + 删 legacy 路径 |

总计 **9–12 周**。每期独立 PR、独立可回滚。

---

## 12. 灰度与回滚

- **灰度开关**：`general.engineKernel`（legacy | pi-session，默认 legacy）。两套路径共存到 Phase 4 结束——facade 之下 Engine 内部分支，orchestrator 无感。
- **单盒灰度**：Nova（10.188.130.144）先切，观察项：压缩触发率（对比 legacy 基线）、degenerate_reply 计数、turn_events 成功率、内存水位（AgentSession 常驻增量）。
- **回滚**：
  - 运行时级：设置切回 legacy → 重启即回（pi-runtime 目录残留无害）。
  - 版本级：VE updater 回滚 tag（既有机制）。
  - 代码级：各期独立 PR，revert 单期不牵连其他期。
- **legacy 路径退役**：Phase 4 验收后一个版本删除（连同 vendor 残留类型迁移确认）。

---

## 13. 风险登记册

| # | 风险 | 概率 | 影响 | 对策 |
| --- | --- | --- | --- | --- |
| R1 | 首启装机失败 → 盒子不可用 | 中 | 高 | 三源链 + 续传 + 明确报错指引 + 灰度期 legacy 回退；**不许带病启动** |
| R2 | pi-tui/quickjs WASM 在 Electron main 进程 import 有副作用（TTY 探测、native 崩溃） | 中 | 高 | 【S4】spike 先行；不可行则 fallback：runtime 装到 userData、由 VE spawn **子进程 RPC**（desktop 模式），进程内换芯改为薄客户端（工期 +2 周） |
| R3 | session.prompt 内建重试与 VE 重试层双保险叠加（轮次/成本翻倍） | 中 | 中 | 【S7】配 RetrySettings 关闭；文档化最终语义 |
| R4 | ModelRuntime stub 不可行，被迫桥接全量模型系统 | 中 | 中 | 【S3】spike 先行；备选桥接方案已列（+3~5 天） |
| R5 | 上游 1.2.0→1.3.0 再移模块边界 | 低（锁版本） | 低 | 版本只随 VE 发版走；imports.ts 单点出口，升级面可控 |
| R6 | npmmirror 同步延迟导致 lock 版本装不到 | 低 | 中 | 源链自动降级 Gitee/GitHub；lock 版本选择避开 npmmirror 未同步窗口（发布前查） |
| R7 | 插件 wedge 无人值守轮次 | 低 | 高 | §9.4 fail-open + 审计；灰度期禁用第三方插件（仅白名单 InlineExtension） |
| R8 | 内存：多会话 × AgentSession 常驻 | 中 | 中 | 【S8】spike 测常驻增量；超预算则 LRU 卸载空闲会话（复用 activeSessionCount 守卫） |

---

## 14. Phase 0 spike 清单（开工先决，逐条出书面结论）

| # | 问题 | 验证方法 | 产出 |
| --- | --- | --- | --- |
| S1 | 自建 Agent + SessionManager.inMemory() + customTools 组合可行性 | 本地脚本：构造最小 AgentSession，prompt/steer/abort/compact 各一遍 | 可行性 + 最小配置清单 |
| S2 | 扩展事件对 customTools 是否触发（tool_call/tool_result） | 注册 InlineExtension 监听，执行一个 customTool | 事件触达矩阵 |
| S3 | ModelRuntime 最小 stub 或 createAgentSessionFromServices 绕过 | 类型对齐 + 干跑 | stub 代码或桥接方案 |
| S4 | 动态 import userData 下 pi-coding-agent（Electron main）+ 打包排除 | Electron 主进程真机脚本；检查 pi-tui/quickjs import 链 | 可行性；R2 fallback 判定 |
| S5 | ELECTRON_RUN_AS_NODE 跑 pi 1.2.0 CLI --version + 基本命令 | desktop prepare-runtime 模式复刻 | 自检脚本 |
| S6 | vision images 经 session.prompt/steer 的传参形态 | 读 PromptOptions.d.ts + 实测 | send() 视觉链路改法 |
| S7 | RetrySettings 可否关闭 session 内建重试 | settings-manager.d.ts + 实测 | 重试语义最终稿 |
| S8 | session 事件流的 refused/失败信息完整度（遥测映射） | 触发权限拒绝 + 工具异常，核对事件字段 | 遥测迁移方案 |
| S9 | pi-quality-gates 在 VE 的可加载性（EDIT_TOOLS 工具名匹配） | 装 ExtensionsRunner 干跑 | 插件适配清单 |
| S10 | npmmirror 上 pi-coding-agent@1.2.0 全树可用性与体积 | registry API + 试装 | 来源链定稿 + runtime 体积 |

---

## 15. 附录：API 速查（pi-coding-agent 1.2.0，已核实）

```ts
// 创建（工厂路线）
const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model, thinkingLevel, scopedModels,
  noTools: "all" | "builtin", tools: string[], excludeTools: string[],
  customTools: ToolDefinition[], settingsManager, sessionManager, resourceLoader,
});
// 直接构造（VE 路线，传自建 Agent）
new AgentSession(config /* AgentSessionConfig，agent: Agent 必传 */);

// 会话操作
session.prompt(text, options?)      // streaming 中调用会 reject（须 steer/followUp）
session.steer(text, images?, opts?) // 插入当前轮之后
session.followUp(text, images?, opts?) // 当前 run 结束后接续
session.abort(): Promise<void>      // 等待 idle
session.waitForIdle()
session.compact(customInstructions?): Promise<CompactionResult>
session.setModel(model, options?)
session.subscribe(listener): () => void   // message_update/message_end/tool_execution_*/agent_*/session_*
session.getActiveToolNames(); session.bindExtensions(bindings); session.dispose()

// 压缩原语（顶层导出，vendor 退役的目标源）
compact, generateSummary, generateSummaryWithUsage, shouldCompact, findCutPoint,
findTurnStartIndex, estimateTokens, calculateContextTokens, DEFAULT_COMPACTION_SETTINGS

// 扩展运行时（VE 插件宿主）
createExtensionRuntime, ExtensionRunner, defineTool, wrapRegisteredTool(s)
pi.on(...)  // session_*/tool_call/tool_result/turn_end/agent_before_settle/context/... ~150 种
pi.registerTool / pi.registerCommand
// turn_end 与 agent_before_settle 可链 custom/custom_message/context_edit/compaction entry
// 并返回 { continue: true } —— CC Stop-hook 强制返工的等价物（verify-gate 类插件的挂点）
```

版本对齐：VE 现 pin pi-agent-core **1.1.0**；本迁移 lock pi-coding-agent **1.2.0**（其依赖 pi-agent-core ^1.2.0）——**Agent 内核随之升级到 1.2.0**，engine.ts 对 1.1.0 API 的依赖面（Agent/AgentLoop/事件类型）需在 Phase 2 对照 1.2.0 d.ts 过一遍差异（预计小：同小版本系）。
