# worker 上下文管理失效（2026-11-09 现场，交接文档）

> 状态：**根因已定位到日志层，代码级根因未确认，未修复**。
> 交接原因：盒子 SSH（UU 隧道 127.0.0.1:12223）不稳定，无法持续取证。
> 优先级建议：**P0**——所有长会话 worker 会周期性彻底废掉（任何消息进 400）。

---

## 一、现场症状（用户视角）

截图证据（2026-11-09 早，钉钉单聊 `dt:manager5792`）：

1. 用户发「这笔流水在哪个云区 -- 支付渠道下单的日志都在公众服务区」
2. Nova 先回了一条**完全无关**的「⚠️ 回合收尾盘点：本会话仍有 1 个后台进程在运行：
   `1571896b pid=12348 python C:\Users\hspcadmin\Desktop\Nova\sls_drv.py`
   完成后用 manage_process poll 确认退出码；需要立即终止用 manage_process kill」
3. 紧接着回「⚠️ 这次没能完成：本会话累计的内容超出了模型能一次处理的长促上限
   （已尝试自动压缩与裁剪仍未通过）」

用户原话：「对话应该是 Q&A，你不能在中间穿插一条完全无关的回复给我」
（收尾盘点这条已在 v0.2.213 改为静默自动清扫，但**盒子还跑 0.2.210，没生效**）

---

## 二、日志铁证：压缩彻底失效（核心问题）

盒子 `profiles/Nova/logs/main.log`，2026-11-09 凌晨，全部围绕
`worker:wmw62xecn29xe`（对账巡检 worker）：

```
[00:49:33] compacted worker:wmw62xecn29xe: 377 turns → summary (~209716 tokens before)
[00:51:46] compacted worker:wmw62xecn29xe: 377 turns → summary (~222199 tokens before)
[00:52:51] compacted worker:wmw62xecn29xe: 377 turns → summary (~234682 tokens before)
[00:55:43] compacted worker:wmw62xecn29xe: 377 turns → summary (~260745 tokens before)
[01:00:32] compacted worker:wmw62xecn29xe: 377 turns → summary (~273230 tokens before)
[01:20:47] compacted worker:wmw62xecn29xe: 377 turns → summary (~298016 tokens before)
```

三个铁证指向同一结论——**压缩不仅无效，还倒贴**：

1. **`377 turns` 六次一模一样**：压缩理应裁掉旧 turn，它一条没裁
2. **token 单调递增 209k → 298k**：每次「压缩」后 transcript 更大（summary 消息
   是追加的，旧内容没被移除）
3. **连续失败仍不断重试**：最终 litellm 直接拒绝
   `400: litellm.BadRequestError: Custom_openaiException - Input length ...`

相关时序（同一会话）：

```
[00:50:49] length-truncated empty run → compacting before retry
[00:52:59] 3 consecutive length-truncated empty runs → ending the turn instead of retrying into the same wall
[01:00:36] assistant msg: stopReason=error parts=[(empty)]
[01:00:42] no reply produced ... deterministic failure (400: Input length ...)
[01:20:47] context overflow reported in-turn: retrying on a compacted transcript
[01:20:56] no reply produced ... deterministic failure (400: Input length ...)
```

**现状**：该 worker 会话已完全不可用——任何消息进去都返回 400 超限。
但 `worker_tasks` 里它仍是历史任务，`work_items` 3db7f642 状态 `working`
（09:46 仍在更新）。

---

## 三、根因假设（较大把握，**未代码级验证**）

**嫌疑：压缩写错了 transcript（内核分裂）。**

背景事实（已在本仓库验证过）：

- 盒子 `engineKernel = durable`（`electron/main.ts:542` 默认），pi-session 为底层
- worker 会话刻意用 `SessionManager.inMemory()`（`src/engine/session-host.ts`），
  messages 表是唯一事实源，重建时 `rehydrateMessages(history.listMessages)` 灌回
- `compactWithLife` / `maybeCompact`（`src/engine/pi-compaction.ts` +
  `src/engine/engine.ts`）压缩的是 **VE 持有的 `agent.messages`**

假设链条：durable/pi-session 内核下，实际发给模型的 prompt 可能来自
`AgentSession` 自己的 transcript（或 harness 的 `conv.submit` 上下文），
而 compact 只改了 `agent.messages`——**两条 transcript 不同步**，于是：

- 日志打印「377 turns」（读的是没被改的那条，或压缩根本没落到实际使用的对象）
- 每次 compact 只是往其中一条追加 summary → token 只增不减
- 实际请求越压越大，最终 400

**验证切入点（按顺序）**：

1. `src/engine/pi-compaction.ts` 的 `maybeCompact` / `compactTurns`：
   确认它改的是哪个对象的 messages，以及 compact 后谁读这个对象
2. `src/engine/durable/runtime.ts` 的 `executeTurn` / `conv.submit`：
   确认 prompt 真正取自哪里（harness 的 generation 上下文 vs agent.state.messages）
3. `src/engine/durable/harness-host.ts`：harness 侧是否持有独立 transcript
4. 加一条**不变量日志**：compact 后立刻打印「实际将发送的 token 估算」——
   与「压缩前」对比；如果没下降，就是本 bug，且以后能第一时间发现

---

## 四、关联问题（同批现场暴露）

| 问题 | 状态 |
|---|---|
| 收尾盘点文案暴露内部工具名 + 清理推给用户 | **已修** v0.2.213（自动全杀 + 静默），但**盒子未升级** |
| 盒子版本落后：跑 0.2.210，211/212/213 未装 | 见第五节 |
| `sls_drv.py pid=12348` 从 11-08 一直活到 11-09 未被清理 | 旧逻辑只提示不杀；0.2.213 会杀掉 |
| 昨天修的 inject 门控 / 边界简报 / 中文错误文案 | 已发 0.2.210~213，**盒子未升级所以现场未验证** |

---

## 五、发布与部署现状（截至 2026-11-09 中午）

**代码侧全部已发布**：

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.2.209 | 中止英文文案中文化 + 步数默认无限 + 禁止未尝试就声明做不到 | GitHub + Gitee ✓ |
| v0.2.210 | worker 任务边界简报（不拿自己产物冒充） | ✓ |
| v0.2.211 | 边界文案区分「问结果」与「新请求」 | ✓ |
| v0.2.212 | inject 门控：done worker 不吞任务型新请求 | ✓ |
| v0.2.213 | 收尾自动清扫后台脚本（静默） | ✓ |

**盒子（192.168.2.144 / WINDOWS-JO4CMFA）实际**：`0.2.210.0`

升级失败原因（日志实锤）：

```
[21:35:18] update downloaded: version=0.2.212  ← 下载成功
[21:35:18] watchdog armed via WMI ...
（此后整夜无安装日志）
```

`watch-update.ps1` 的 phase0a 逻辑：等布防进程（`armPid`）退出，**超时 120 秒即
放弃安装**。Nova 整夜未退出 → 安装被放弃 → 今早仍是 0.2.210，pending 目录里还躺着
`Pi-Virtual-Employee-Setup-0.2.212-x64.exe`。

**已做的补救（未完成）**：

- 已在盒子下载 `0.2.213` 到 pending 目录，sha512 已核对一致
  （`DEL6Y2r9eB/LDvRTw1kBz9/bSxVJ5zyfM5qsjlJEfCq2o+TLfr66R3qfQSNZrZFGm91myJgrKXjMWq/UFM5UcQ==`）
- 已写 `/tmp/manual-upgrade.ps1` → 盒子 `C:\Users\hspcadmin\Desktop\Nova\manual-upgrade.ps1`
  （等 work_item 3db7f642 离开 working → 静默 3 分钟 → 确认 2 分钟无 llm 活动 →
  杀进程 → 重命名旧目录 → `/S` 静默安装 → 重启 Nova → 记录版本）
- 已后台启动，但 **SSH 隧道随即断开，无法确认是否执行**

---

## 六、接手后要做的（按优先级）

### P0 · 修复 compact 失效（本交接的核心）

1. 读 `src/engine/pi-compaction.ts` + `src/engine/durable/runtime.ts` 确认
   transcript 归属（第三节的验证切入点）
2. 加不变量断言：**compact 后实际 prompt 的 token 估算必须下降**，否则
   console.warn + 放弃继续压缩（不要往死里重试 6 次还 400）
3. 补测试：构造一个「compact 后 token 不降」的场景，断言系统不进入
   「compact → 仍超限 → 再 compact」的死循环

### P1 · 恢复盒子

```bash
# 隧道
sshpass -p '202606' ssh -p 12223 hspcadmin@127.0.0.1
# 查升级是否已执行
type "C:\Users\hspcadmin\AppData\Roaming\pi-virtual-employee\profiles\Nova\logs\manual-upgrade.log"
# 查版本
powershell -NoProfile -Command "(Get-Item 'C:\Users\hspcadmin\AppData\Local\Programs\Pi Virtual Employee\Pi Virtual Employee.exe').VersionInfo.ProductVersion"
```

若未执行：确认无活跃任务后，直接跑
`powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\hspcadmin\Desktop\Nova\manual-upgrade.ps1`

重启还有一个额外收益：`worker:wmw62xecn29xe` 那个爆炸的 in-memory transcript
会被重建（从 messages 表灌回干净文本），那个会话立刻恢复可用。

### P2 · 修 watchdog 的安装时机

`watch-update.ps1` phase0a 等 120 秒就放弃——而 **VE 是 7×24 常驻服务，可能几天
不退出**。这意味着自动更新实际上长期失效（用户以为在自动更新，其实一直旧版本）。
建议：布防时就**主动排空并重启**（先用现有 `hasUnfinishedTasks()` 判断空闲），
而不是被动等退出。

---

## 七、关键路径与命令速查

**盒子访问**：`sshpass -p '202606' ssh -p 12223 hspcadmin@127.0.0.1`
（UU 隧道，`127.0.0.1:12223` → `WINDOWS-JO4CMFA`；近期不稳定，常 banner exchange timeout）

**远程 Python**：`/tmp/run_remote.py` 的 `run_remote_py(code, filename, timeout)`
（写 `C:\Users\hspcadmin\Desktop\Nova\<filename>` 再执行；ps1 必须纯 ASCII）

**数据库**：`C:/Users/hspcadmin/AppData/Roaming/pi-virtual-employee/profiles/Nova/pi-employee.sqlite`
（只读打开用 `file:...?mode=ro`，uri=True）

**日志**：`profiles/Nova/logs/main.log`（`[engine] compacted ...` 是本次关键行）

**本仓库**：`/Users/jason/projects/opensource/pi-virtual-employee`（main 已到 0.2.213）

---

## 八、本次已确认的事实（避免重查）

- `withConversationContext` 的任务清单注入**原本只对 IM 会话生效**，worker: 会话
  跳过——已在 v0.2.210 增加 `withWorkerTaskBrief`（含隐边界规则），v0.2.211 修正
  边界语义（区分「问结果」与「新请求」）
- `inject()` 原本用 `recentForConversation`（不看状态取最新行）把一切消息吞进最近
  worker——v0.2.212 已加门控：只有 queued/running 无条件吞，done/error 只承接非任务型续聊
- worker 会话的记忆作用域**正确折回来源会话**（实测
  `person:dingtalk:<id>` + `conversation:dt:<id>`，与主会话一致）——记忆没问题，
  **有问题的是 transcript**
- `buildTurnInputFor` 已在 v0.2.210 接入 durable 边界（`RuntimeOptions.turnInput`），
  前缀永不入历史（`appendMessage` 保持原文）
