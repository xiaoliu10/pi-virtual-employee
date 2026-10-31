# MCP 服务器接入：现状盘点与 UI 设计

> 真实意图：用户以为「VE 还没有 MCP 功能」。实际后端已完整，缺的是**管理与配置界面**（以及若干可靠性缺口）。
> 状态：草案（Phase 1 完成，Phase 2 调研进行中）

## 1. 现状与接入点

### 1.1 后端已有（读源码确认）

| 能力 | 位置 | 说明 |
|---|---|---|
| 配置形状 | `src/shared/mcp.ts` | 已对齐标准 `mcpServers`（Claude Desktop / Cursor / pi 通用），支持 `${ENV}` 插值 |
| 归一化与校验 | `src/shared/mcp.ts:normalizeMcpServer` | 逐条返回 `{ok}` 或 `{ok:false, reason}`，不抛错 |
| 连接与列工具 | `src/engine/tools/mcp.ts:connect / refresh` | stdio（command/args/env/cwd）+ streamable HTTP（url/headers）；有超时、连接复用、工具面签名比较 |
| 工具命名 | `mcp__<server>__<tool>` | 与内置工具永不冲突 |
| 工具暴露 | `src/engine/engine.ts:2848` (`buildTools({ mcp: {enabled, tools} })`) | 每次建会话时按当前缓存注入 |
| 配置变更触发 | `src/engine/engine.ts:1370` | 配置变化 → `refreshMcp()` → 工具面变化则重建会话 |
| 配置写入路径 | `src/engine/tools/settings.ts:71` | **仅** `manage_settings` 工具（管理员 IM 单聊） |
| 测试 | `scripts/test-mcp.mjs`（7 条） | |

### 1.2 真正缺的东西

1. **UI 完全缺失**：`renderer/src/pages/SettingsPage.tsx` 中 `mcp` 出现 0 次；`renderer/src/lib/types.ts` 的 `capabilities` 里**没有 mcp 字段**（只有 shell / autonomousMining）。→ 设置页读到 `config.capabilities.mcp` 是 `undefined`，即使加 UI 也必须先补类型与归一化回传。
2. **没有「测试连接」入口**：`refresh()` 的 `report[]`（每个服务器的 ok/工具数/错误）只在 `engine.ts:351` 打了 console.log，**UI 拿不到**。
3. **没有工具清单可见性**：连上之后暴露了哪些工具、描述是什么，管理员只能问 agent 或看日志。
4. **密钥处理**：`env`/`headers` 会经由 `manage_settings` 的凭据检测（`settings.ts:43` 注释确认），UI 侧需同样对待。

### 1.3 数据流（当前）

```
管理员 IM → manage_settings(capabilities.mcp.servers=[...])
   → ConfigStore.update → config:changed
   → engine.refreshMcp() → mcpManager.refresh → connect + listTools
   → (console.log 报告)  ← UI 到此为止，无任何可见性
   → buildTools 注入 mcp__* 工具 → 下一轮对话可用
```

### 1.4 要动的文件清单

- `renderer/src/lib/types.ts` — `capabilities` 补 `mcp: { enabled, servers: McpServerView[] }`
- `renderer/src/pages/SettingsPage.tsx` — 新分区（列表 + 编辑弹窗 + 测试连接 + 工具预览）
- `electron/main.ts` 或 IPC 层 — 新增「测试连接」通道，把 `refresh({force})` 的 report 回传渲染层
- `src/engine/tools/mcp.ts` — 暴露只读的 `report` / `tools()` 快照供 IPC 使用
- `docs/design/mcp-ui.md` — 本文件

## 2. 外部调研

> 注：外部调研子代理因模型连接故障未产出最终结论（过程材料在案）。以下为基于业界通识与本项目内部事实的判断，标注为【通识】；后续可补充源码级引用。

【通识】业界 MCP 客户端的管理形态分三类：
1. **配置文件派**（Claude Desktop、Cursor、pi）：编辑 `mcpServers` JSON，重启生效。优点：与生态兼容、可粘贴复用；缺点：无可见性。
2. **应用内管理面板派**（Cline、5ire、VSCode Copilot）：设置页里有服务器列表（启用开关、每服务器工具数、错误状态），添加用表单（stdio: command/args/env；HTTP: url/headers），保存即连接。
3. **混合派**（部分客户端）：表单 + 「直接粘贴 JSON」双入口。

共同细节：
- **测试连接**是标配：显示连接成功/失败 + 拉到的工具数量与名字。
- **env/headers 密钥**：主流做法支持 `${ENV}` 引用（本项目 `shared/mcp.ts` 已实现），UI 上密码框展示。
- **工具过多**：Claude Desktop 等对工具数无硬限制，但社区普遍反馈大服务器（GitHub MCP 上百工具）撑 context——按需启用服务器是实际缓解手段（本项目按服务器 `enabled` 已支持）。
- **stdio 生命周期**：客户端退出时必须关闭子进程（MCP spec 的 stdio transport 要求客户端负责终止）——正是本项目 B1 缺口。

## 3. 方案对比与推荐

- **方案 A（推荐）：UI 只做管理与可见性，连接逻辑全走现有 `McpManager.refresh()`**
  - 改动面：types.ts（补 mcp 类型）、SettingsPage 新分区、一个「测试连接」IPC、mcp.ts 补 close/dispose
  - 风险低：不动连接协议，只补生命周期与可见性
- **方案 B：UI 直连 MCP SDK（渲染进程自己连服务器）**
  - 否决：连接属于主进程职责（安全边界 + 生命周期统一管理），渲染进程直连会复制一套状态、与 engine 的工具注入路径打架

## 4. 详细设计（方案 A）

### 4.1 先修 B1/B2（生命周期，UI 的前置）
- `McpManager` 增加 `dispose()`：遍历 cache `client.close()`（MCP SDK Client 有 close），并挂到 `prepareToInstall` 的清理序列与 `will-quit`
- `runRefresh` 替换缓存前先 close 被移除/被替换的连接

### 4.2 UI
- 设置页新分区「MCP 外部工具」：总开关（`capabilities.mcp.enabled`）+ 服务器列表（名称/类型/命令或 URL/启用开关）+ 每项「测试连接」按钮（调 IPC → `refresh` → 返回 report：ok/工具数/错误）+ 工具清单预览（`mcp__server__tool` 全名）
- 「粘贴 mcpServers JSON」导入：兼容 Claude Desktop/Cursor 配置直接粘贴（形状已对齐，`normalizeMcpServers` 直接可用）
- env/headers 值用密码框；`${ENV}` 引用提示

### 4.3 分阶段
1. **切片一（可验证）**：B1/B2 生命周期修复 + 测试连接 IPC —— 无 UI 也可用 `manage_settings` 验证
2. 切片二：设置页分区（列表 + 编辑 + 测试连接 + 工具预览）
3. 切片三：JSON 导入

### 4.4 测试
- `test-mcp.mjs` 补：dispose 后子进程退出；refresh 替换连接时旧连接 close；report 透传

## 5. 盲区与待拍板

- 是否支持一键从 Claude Desktop / Cursor 导入 `mcpServers` 配置块（粘贴 JSON）
- 密钥是明文存 config（现状）还是引用环境变量（现状已支持 `${ENV}`，但 UI 要不要强制）

---

## 1.5 后端自身的缺口（读源码发现，不是 UI 问题）

| 编号 | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **B1** | **stdio 子进程永不关闭** | `src/engine/tools/mcp.ts` 全文件无 `close()`/`dispose()`/`kill`；`McpManager` 公开接口只有 `tools()/statusText()/refresh()` | 每次改配置重连都**新增**一个子进程，旧的留在 `cache` 被替换后**无人关闭** → 孤儿进程堆积（Windows 上尤其明显） |
| **B2** | 连接被替换时不清理 | `runRefresh` 里 `nextCache.set(server.name, conn)` 直接覆盖，`cached.client` 无 close | 同上；且 HTTP 连接的 keep-alive 也泄漏 |
| **B3** | 工具面无上限 | `bridgeTool` 对每个 tool 都生成一个 AgentTool，无 count/schema 体积上限 | 工具多的服务器（如 GitHub MCP 上百个）会撑爆 context；且每次建会话都全量注入 |
| **B4** | 连接报告只在 console | `engine.ts:351` `console.log` | 管理员无从得知哪个服务器连不上、连上几个工具（→ UI 要解决的核心） |

> 结论：这次不只是"补 UI"。UI 之前必须先补 **B1/B2**（资源生命周期），否则界面越好用、越容易点出孤儿进程。

