# worker 上下文管理失效（2026-11-09 现场，交接文档）

> 状态：**根因已代码级实锤（同日第二轮排查），未修复**。
> 优先级建议：**P0**——所有长会话 worker 会周期性彻底废掉（任何消息进 400）；
> 所有会话跨重建即失忆（40 行以外的历史无任何摘要兜底）。

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

## 三、根因（代码级实锤，2026-11-09 第二轮排查）

三层机制叠加，每层都有代码位置：

### A. durable worker 的压缩从未到达模型（投影/事实源分裂）

- `maybeCompact`（`src/engine/context.ts:831`）只改**内存投影**
  `agent.state.messages = [system, summary, recent...]`
- durable worker 的实际请求从 **durable transcript** 构建：worker 会话创建时
  把 DB messages 表**无界全量** import 进 durable transcript
  （`src/engine/durable/runtime.ts:372` 起：`history.listMessages(id)` 是
  `ORDER BY created_at ASC` 无 LIMIT，逐行 `tx.appendEntry`）
- 于是 compact「成功」日志照打、请求照样全量 → 400 → in-turn recovery
  再 compact（再改投影）→ 请求还是全量 → 循环
- 日志完全吻合：`377 turns` 六次不变（每次都从全量 DB 重建投影再裁）、
  `209k→298k` 单调递增（每轮 +12k 新内容入库）、litellm 连续 400

### B. 压缩摘要不落库：任何重建 = 彻底失忆

- summary 只存在于内存投影；DB `messages` 表没有任何 compaction 记录
  （`src/db/history-store.ts` grep compaction 为空）
- 会话重建（skills/memory/config 任何 revision bump、重启、空闲清理）→
  `getOrCreateSession`（`engine.ts:1304`）→ `rehydrateMessages(listMessages())`
  只取 **tail 40 行**（`context.ts:32` `REHYDRATE_MAX_MESSAGES = 40`）、turn-aligned
- 40 行以外的一切——**包括压缩摘要本身**——永久消失，没有任何摘要兜底。
  这是「上下文一直在丢」的直接来源：worker 长任务中途任何一次重建，
  早期任务上下文全没了

### C. A 与 B 互相放大

A 让长任务 worker 在「忘事（刚被裁）」与「400（全量灌回）」之间震荡；
B 保证每次重建后即使想恢复也没有摘要可用——压缩的成果既到不了模型，
也活不过重建。legacy 主会话同样有 B（同一条 rehydrate 路径），只是主会话
消息少、很少触发 compact，暴露得晚。

### 修复方向（两件事缺一不可）

1. **压缩落库**：compact 成功后把 summary 写入 messages 表（特殊 role），
   被裁行标记 archived（软删）；`rehydrateMessages` 改为「从最新 summary 行起
   + tail 40」——重建不再失忆，历史表不再无限膨胀
2. **durable import 尊重压缩视图**：durable transcript 构建从最后一个 summary
   行起灌（或 harness 侧加 keepRecentTokens 窗口）——压缩真正作用到请求

### 验证锚点（修复后必须过）

- 不变量断言：compact 后「下一次真实请求的 token 估算」必须小于压缩前；
  否则 console.warn 且放弃继续压缩（不再进入 6 连败循环）
- 重启前 worker 投影行数 vs 重启后 rehydrate 行数：摘要必须保留

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
