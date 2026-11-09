---
name: ops-script-safety
description: 写或改运维脚本（杀进程、清理文件、容器/服务启停、批量操作、登录态保活）之前必读。强制「目标先行、默认演练、持有检查、契约登记」四条铁律，覆盖 PowerShell 与 Bash 双平台。遇到要写 kill/清理/覆盖/批量删除类脚本时先读这里。
---
# 运维脚本安全规范

写运维脚本的价值不在"能跑通"，而在**跑错时不会连带毁掉别的东西**。
这份技能每一条都对应一次真实事故；照做能省掉"脚本把正常任务杀掉"这类返工。

## 何时用

- 写/改任何**破坏性**脚本：杀进程、删文件、清缓存、停服务、覆盖配置
- 写**长时间后台**任务脚本
- 写操作**登录态/profile/凭据**的脚本
- 排查"任务莫名被杀 / 文件莫名丢失 / 服务被重启"

不适用：一次性只读查询（`ls`、`Get-Process` 看看），不用套这套流程。

---

## 四条铁律（平台无关）

### 铁律 1：目标先行

任何破坏性操作**之前**，先生成并打印影响面清单，人（或模型自己）看过再动手。

```
❌ foreach ($p in $procs) { $p.Kill() }        // 直接杀，你根本不知道杀了几个
✅ 先 Get-Process ... | Format-Table 打印，确认目标，再执行
```

清单必须含：目标标识（PID / 路径 / 名称）、**为什么它该被处理**、数量。

### 铁律 2：默认演练

不加显式确认参数 = 只打印不执行。`-WhatIf` 不是可选项，是默认值。

```
❌ 脚本跑起来就动手，靠人记得加参数才不删
✅ 默认 dry-run；要真跑必须 -Force / --execute / DRY_RUN=0
```

### 铁律 3：持有检查

**目标是否被别的任务正在使用？** 这一步能挡掉绝大多数"脚本杀掉了正常任务"。

要检查的三类持有：

| 持有形式 | 怎么判断 | 结论 |
|---|---|---|
| 调试端口连接中 | 命令行含 `--remote-debugging-port` / 有 driver 在连 | 正在跑，别动 |
| 刚启动 | 启动时间 < N 分钟（建议 10） | 大概率正在跑，别动 |
| 任务登记在册 | 后台任务表里有活跃登记（见铁律 4） | 有主，别动 |

### 铁律 4：契约登记

超过 2 分钟的后台任务，启动时登记：**用途、预期时长、什么条件下可以终止**。
任何清理/退出逻辑先查这张表，有活跃登记就不杀。

这是"更新/退出清理把长任务连根拔掉"的结构性解法——不是靠清理逻辑写得更小心。

---

## 事故案例（必读，都是真的）

### 案例 1：清理脚本无差别杀进程，杀掉正在跑的业务任务

```powershell
# ❌ 反面教材
$procs = Get-Process chrome -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.Path -like '*ms-playwright*') { $p.Kill() }   # 所有 Playwright 浏览器，一律杀
}
```

后果：正在登录的自动化任务被杀两次（跑了 49 秒、62 秒各被杀一次），
业务连续失败，且从日志看像"登录脚本自己挂了"，排查方向被带偏。

**犯了哪几条**：铁律 1（没列目标）、铁律 2（没有 dry-run）、铁律 3（没查持有）。

正确写法见下方模板。

### 案例 2：应用退出/更新清理，连带杀掉后台任务

更新安装前 `taskkill /T`（树杀）会把应用子进程一起带走，
正在跑的长任务直接消失。解法是铁律 4 的契约登记 + 退出前主动排空。

---

## 模板

### PowerShell

```powershell
<#
.SYNOPSIS
    清理残留的自动化浏览器进程（默认只演练，不杀）
.EXAMPLE
    .\kill-residual-browser.ps1                 # 只列清单
    .\kill-residual-browser.ps1 -Execute        # 真杀
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # 只处理名字匹配的进程
    [string]$ProcessName = 'chrome',
    # 启动不足该分钟数的进程视为"正在跑"，跳过
    [int]$MinAgeMinutes = 10,
    # 不加此开关永远只演练
    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$now = Get-Date
$candidates = @()

foreach ($p in (Get-Process $ProcessName -ErrorAction SilentlyContinue)) {
    $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue).CommandLine

    $ageMin   = ($now - $p.StartTime).TotalMinutes
    $isDebug  = $cmdline -and ($cmdline -match '--remote-debugging-port')
    $isFresh  = $ageMin -lt $MinAgeMinutes
    $isPw     = $p.Path -and ($p.Path -like '*ms-playwright*')

    if (-not $isPw) { continue }

    $reason = if ($isDebug) { 'SKIP: 调试端口占用中（有任务在连）' }
              elseif ($isFresh) { "SKIP: 启动仅 $([int]$ageMin) 分钟（可能正在跑）" }
              else { 'CANDIDATE: 疑似残留' }

    $candidates += [pscustomobject]@{
        PID    = $p.Id
        AgeMin = [int]$ageMin
        Path   = $p.Path
        Verdict = $reason
    }
}

if ($candidates.Count -eq 0) { Write-Host '没有匹配的进程。'; return }

# 铁律 1：先列清单
$candidates | Format-Table -AutoSize

$killable = $candidates | Where-Object { $_.Verdict -like 'CANDIDATE*' }
if ($killable.Count -eq 0) { Write-Host '全部被跳过（都可能有主）。'; return }

# 铁律 2：默认演练
if (-not $Execute) {
    Write-Host "`n[演练] 将处理 $($killable.Count) 个进程。加 -Execute 才真杀。"
    return
}

foreach ($c in $killable) {
    if ($PSCmdlet.ShouldProcess("PID $($c.PID)", '停止进程')) {
        try { Stop-Process -Id $c.PID -ErrorAction Stop; Write-Host "已停止 $($c.PID)" }
        catch { Write-Warning "停止 $($c.PID) 失败: $($_.Exception.Message)" }
    }
}
```

### Bash

```bash
#!/usr/bin/env bash
# 清理残留自动化浏览器进程（默认只演练，不杀）
set -Eeuo pipefail

PROC_NAME="${PROC_NAME:-chrome}"
MIN_AGE_SEC="${MIN_AGE_SEC:-600}"     # 启动不足 10 分钟视为"正在跑"
EXECUTE="${EXECUTE:-0}"               # 0 = 演练

cleanup() { :; }                       # 占位：需要清理临时文件时写这里
trap cleanup EXIT

# 铁律 1：先列清单
printf '%-8s %-10s %-45s %s\n' PID AGE_S PATH VERDICT
killable=()

while read -r pid args; do
    [[ -n "$pid" ]] || continue

    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || echo '?')
    [[ "$exe" == *ms-playwright* ]] || continue

    start_epoch=$(stat -c %Y "/proc/$pid" 2>/dev/null || echo 0)
    age=$(( $(date +%s) - start_epoch ))

    verdict='CANDIDATE: 疑似残留'
    # 铁律 3：持有检查
    if [[ "$args" == *--remote-debugging-port* ]]; then
        verdict='SKIP: 调试端口占用中'
    elif (( age < MIN_AGE_SEC )); then
        verdict="SKIP: 启动仅 ${age}s"
    fi

    printf '%-8s %-10s %-45s %s\n' "$pid" "$age" "${exe:0:45}" "$verdict"
    [[ "$verdict" == CANDIDATE* ]] && killable+=("$pid")
done < <(pgrep -a "$PROC_NAME" 2>/dev/null || true)

if (( ${#killable[@]} == 0 )); then
    echo '没有可清理的进程。'
    exit 0
fi

# 铁律 2：默认演练
if [[ "$EXECUTE" != "1" ]]; then
    echo
    echo "[演练] 将处理 ${#killable[@]} 个进程: ${killable[*]}"
    echo "真杀: EXECUTE=1 $0"
    exit 0
fi

for pid in "${killable[@]}"; do
    if kill -TERM "$pid" 2>/dev/null; then
        echo "已发送 TERM: $pid"
    else
        echo "发送失败: $pid" >&2
    fi
done
```

---

## 双平台对照：危险写法 → 安全写法

| 意图 | ❌ 危险 | ✅ 安全 |
|---|---|---|
| 杀进程 | `killall chrome` | 列 PID → 逐个 `kill -TERM` |
| 杀进程 | `Stop-Process -Name chrome` | `Stop-Process -Id $pid` |
| 模式杀 | `pkill -f pattern`（无 scope） | `pgrep -a` 先看，再按 PID |
| 删文件 | `rm -rf $dir/*` | 先 `ls` 清单 + 校验 `$dir` 非空非 `/` |
| 删文件 | `Remove-Item -Recurse -Force` | `-WhatIf` 先跑，路径变量先断言 |
| 覆盖 | `> config.json` | 备份原文件 → 写临时文件 → 原子替换 |
| 批量 | `foreach { action }` 无反馈 | 每步 print 目标 + 结果，失败不中断后续 |
| 后台任务 | 直接起，被杀才知道 | 登记契约（用途/时长/可终止条件） |

---

## 自检清单（交脚本前逐条打勾）

- [ ] 破坏性操作前打印了目标清单（PID/路径/数量）？
- [ ] 默认是演练，真跑需要显式开关？
- [ ] 检查了"是否被其他任务持有"（调试端口 / 近期启动 / 任务登记）？
- [ ] 长任务登记了契约（用途、预期时长、可终止条件）？
- [ ] 路径变量做了断言（非空、非根目录、存在性）。
- [ ] 敏感值不进日志（凭据、token、密码只读不回显）？
- [ ] 失败时**不静默**：退出码 + 原因写清楚，别让上层以为成功了？
- [ ] 幂等：重复执行结果一致，不会越跑越乱？

---

## 相关技能

- `windows-script-automation`：Windows 平台语法坑（引号地狱、GBK 乱码、参数传递）。
  两个技能互补——**那个解决"命令怎么写对"，这个解决"写对了会不会误伤"**。
