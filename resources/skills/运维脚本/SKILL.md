---
name: 运维脚本
description: 在部署机（Windows/Linux）上写、跑、排查脚本之前必读。两部分：①安全四铁律——目标先行/默认演练/持有检查（含 Playwright pipe 判据）/契约登记，写杀进程、清理文件、批量操作、登录态保活类脚本时强制遵守，附 PowerShell/Bash 双平台模板；②语法坑——cmd 分词、引号地狱、GBK 乱码、参数传递、长任务后台化，遇到「命令跑不通/参数传不对/输出乱码/Cannot find module」时先读。
---
# 运维脚本

## 内置工具优先（结构性强制，2026-11-10 裁定）

清理/杀进程**必须优先用内置工具**：`manage_process scan`（四道持有判定出候选）→ 凭 ticket `manage_process kill_pid` 定点结束（需当前消息含「确认」）；长任务启动时 `register_contract` 登记、结束时 `remove_contract` 注销。手写清理脚本只是**兑底**路径，且命中危险模式（ms-playwright + 杀进程原语、killall/pkill、Stop-Process -Name、管道 Stop-Process/管道 $_.Kill()、taskkill /im|/t）会被 run_command/run_script 的执行闸**直接拦截**（.ps1/.sh/.py/.cmd/.bat/.js/.mjs/.cjs 内容都扫）——不是靠自觉，是结构上过不去。
下面的四铁律保留：它们是内置工具判定逻辑的「为什么」，也是内置工具不可用时手写兑底脚本的规范。

这个技能回答两个问题：

1. **写对了会不会误伤**（第一部分：安全四铁律）——每条对应一次真实事故
2. **命令怎么写对**（第二部分：语法坑）——每条对应一次真实的失败

写运维脚本的价值不在「能跑通」，而在跑错时**不会连带毁掉别的东西**、失败时**能一次定位**。

---

# 第一部分：安全四铁律

## 何时用

- 写/改任何**破坏性**脚本：杀进程、删文件、清缓存、停服务、覆盖配置
- 写**长时间后台**任务脚本
- 写操作**登录态/profile/凭据**的脚本
- 排查「任务莫名被杀 / 文件莫名丢失 / 服务被重启」

不适用：一次性只读查询（`ls`、`Get-Process` 看看），不用套这套流程。

## 铁律 1：目标先行

任何破坏性操作**之前**，先生成并打印影响面清单，人（或模型自己）看过再动手。

```
❌ foreach ($p in $procs) { $p.Kill() }        // 直接杀，你根本不知道杀了几个
✅ 先 Get-Process ... | Format-Table 打印，确认目标，再执行
```

清单必须含：目标标识（PID / 路径 / 名称）、**为什么它该被处理**、数量。

## 铁律 2：默认演练

不加显式确认参数 = 只打印不执行。

```
❌ 脚本跑起来就动手，靠人记得加参数才不删
✅ 默认 dry-run；要真跑必须 -Execute / --execute / EXECUTE=1
```

注意：PowerShell 原生 `-WhatIf` **默认是关的**，别指望它替你兜底——模板靠**自有**
`-Execute` 开关实现默认演练，`SupportsShouldProcess` 只是叠加的二次保险。

## 铁律 3：持有检查

**目标是否被别的任务正在使用？** 这一步能挡掉绝大多数「脚本杀掉了正常任务」。

四类持有判据，**按权威度排序**（能判前面的就不靠后面）：

| 持有形式 | 怎么判断 | 结论 |
|---|---|---|
| 调试通道连接中 | 命令行含 `--remote-debugging-port` **或 `--remote-debugging-pipe`**。**注意 Playwright 的 Chromium 默认用 pipe 不是 port**，只查 port 会漏掉全部 Playwright 会话（review 实证） | 正在跑，别动 |
| 父进程存活 | 自动化浏览器的父进程是 node driver/Python 脚本——**父活即任务活**。PS 查 `Win32_Process.ParentProcessId` 后 `Get-Process -Id $ppid`；Bash 读 `/proc/$pid/stat` 第 4 字段再探 `/proc/$ppid` | 有主，别动 |
| 刚启动 | 启动时间 < N 分钟。**N 必须大于任务契约的最长生命周期**（保活类长任务用 10 分钟反而制造「超时=残留」的错觉，所以它只兜底、绝不作主判据） | 可能正在跑，别动 |
| 契约登记在册 | 见铁律 4 | 有主，别动 |

## 铁律 4：契约登记

超过 2 分钟的后台任务，启动时登记：**用途、预期时长、什么条件下可以终止**。
任何清理/退出逻辑先查这张表，有活跃登记就不杀。

登记载体（二选一，别空谈）：

- **VE 内**：`manage_process` 的 sessionId 台账就是现成的任务表——清理前先 `manage_process(action="list")` 交叉核对；
- **独立脚本**：约定一个契约文件（一行一条：PID、用途、预期结束时间、可终止条件），启动时追加，结束时删除，清理脚本读它。

这是「更新/退出清理把长任务连根拔掉」的结构性解法——不是靠清理逻辑写得更小心。

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
业务连续失败，且从日志看像「登录脚本自己挂了」，排查方向被带偏。

**犯了哪几条**：铁律 1（没列目标）、铁律 2（没有 dry-run）、铁律 3（没查持有）。
注意：如果照抄网上只查 `--remote-debugging-port` 的「修复版」，长寿命的 Playwright
任务**还是会被杀**——Playwright 默认用 `--remote-debugging-pipe`，该修复版对启动
超过 N 分钟的会话完全漏判。正确写法见下方模板（pipe 判据 + 父进程判据双保险）。

### 案例 2：应用退出/更新清理，连带杀掉后台任务

更新安装前 `taskkill /T`（树杀）会把应用子进程一起带走，
正在跑的长任务直接消失。解法是铁律 4 的契约登记 + 退出前主动排空。

## 模板

### PowerShell（适用：Windows。依赖 `Get-CimInstance Win32_Process`，macOS/Linux 的 pwsh 无此 cmdlet）

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
    # 通配：chrome* 同时覆盖 chrome 与 chrome-headless-shell（Playwright ≥1.49 的
    # headless 默认进程名，写死 'chrome' 会永远扫不到它）
    [string]$ProcessName = 'chrome*',
    # 启动不足该分钟数视为"正在跑"。必须 > 任务契约的最长生命周期
    [int]$MinAgeMinutes = 10,
    # 不加此开关永远只演练
    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$now = Get-Date
$candidates = @()

foreach ($p in (Get-Process $ProcessName -ErrorAction SilentlyContinue)) {
    # 提权/退出竞态会让 Path/StartTime/CIM 抛异常（实测繁忙机器上 1/3 进程如此）：
    # 整段兜底——读不懂的进程一律 SKIP，绝不进候选
    try {
        if (-not $p.Path -or ($p.Path -notlike '*ms-playwright*')) { continue }
        $proc    = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction Stop
        $cmdline = $proc.CommandLine
        $ppid    = $proc.ParentProcessId
        $ageMin  = if ($p.StartTime) { ($now - $p.StartTime).TotalMinutes } else { $null }
    } catch {
        $candidates += [pscustomobject]@{ PID = $p.Id; AgeMin = $null; Path = '<unreadable>'; Verdict = 'SKIP: 无法读取（提权或已退出）' }
        continue
    }

    # 铁律 3 持有检查：调试通道 → 父进程 → 年龄（按权威度排序）
    $parentAlive = if ($ppid) { [bool](Get-Process -Id $ppid -ErrorAction SilentlyContinue) } else { $false }
    $verdict =
        if ($cmdline -and ($cmdline -match '--remote-debugging-(port|pipe)')) {
            'SKIP: 调试通道占用中（driver 在连）'
        } elseif ($parentAlive) {
            'SKIP: 父进程（driver）存活'
        } elseif ($null -eq $ageMin) {
            'SKIP: 启动时间不可读'
        } elseif ($ageMin -lt $MinAgeMinutes) {
            "SKIP: 启动仅 $([int]$ageMin) 分钟"
        } else {
            'CANDIDATE: 疑似残留'
        }

    $candidates += [pscustomobject]@{
        PID     = $p.Id
        AgeMin  = if ($null -ne $ageMin) { [int]$ageMin } else { $null }
        Path    = $p.Path
        Verdict = $verdict
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

### Bash（适用：Linux。依赖 `/proc` 与 GNU `stat`；macOS 行为不同勿直接照搬）

```bash
#!/usr/bin/env bash
# 清理残留的自动化浏览器进程（默认只演练，不杀）
set -Eeuo pipefail
shopt -s nullglob

MIN_AGE_SEC="${MIN_AGE_SEC:-600}"    # 必须 > 任务契约的最长生命周期
EXECUTE="${EXECUTE:-0}"              # 0 = 演练
# 铁律 4：契约登记文件（一行一个 PID；由任务启动脚本写入、结束时删除）
CONTRACTS_FILE="${CONTRACTS_FILE:-/tmp/ve-task-contracts.txt}"

cleanup() { :; }
trap cleanup EXIT

printf '%-8s %-8s %s\n' PID AGE_S VERDICT
killable=()
unreadable=0

# 直接遍历 /proc 的 exe 链接，不做进程名预筛——pgrep 按名筛会漏
# （实测主进程 comm 被截断成 "Google Chrome f"，pgrep chrome 扫不到）
for exe_link in /proc/[0-9]*/exe; do
    pid=${exe_link#/proc/}; pid=${pid%/exe}
    exe=$(readlink "$exe_link" 2>/dev/null) || { unreadable=$((unreadable + 1)); continue; }
    [[ "$exe" == *ms-playwright* ]] || continue

    args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo '')
    age='?'

    # 铁律 3 持有检查：调试通道 → 父进程 → 年龄 → 契约（按权威度排序）
    verdict='CANDIDATE: 疑似残留'
    if [[ "$args" == *--remote-debugging-port* || "$args" == *--remote-debugging-pipe* ]]; then
        verdict='SKIP: 调试通道占用中（driver 在连）'      # pipe 是 Playwright 默认，只查 port 必漏
    else
        ppid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null || echo '')
        if [[ -n "$ppid" && -d "/proc/$ppid" ]]; then
            verdict='SKIP: 父进程（driver）存活'
        fi
    fi
    if [[ "$verdict" == CANDIDATE* ]]; then
        # 年龄未知（已退出/无权限）绝不往"杀"的方向兜——一律 SKIP
        if ! start_epoch=$(stat -c %Y "/proc/$pid" 2>/dev/null); then
            verdict='SKIP: 年龄未知（已退出或无权限）'
        else
            age=$(( $(date +%s) - start_epoch ))
            (( age < MIN_AGE_SEC )) && verdict="SKIP: 启动仅 ${age}s"
        fi
    fi
    if [[ "$verdict" == CANDIDATE* && -f "$CONTRACTS_FILE" ]] \
        && grep -qx "$pid" "$CONTRACTS_FILE" 2>/dev/null; then
        verdict='SKIP: 契约登记在册'
    fi

    printf '%-8s %-8s %s\n' "$pid" "$age" "$verdict"
    [[ "$verdict" == CANDIDATE* ]] && killable+=("$pid")
done

if (( unreadable > 0 )); then
    echo "注意：$unreadable 个进程 exe 不可读（无权限），已计入跳过——它们不等于不存在。" >&2
fi

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

# 真杀：TERM → 等待 → KILL 升级；失败聚合，退出码如实反映
failed=0
for pid in "${killable[@]}"; do
    if ! kill -TERM "$pid" 2>/dev/null; then
        echo "TERM 发送失败: $pid" >&2
        failed=$((failed + 1))
        continue
    fi
    for _ in 1 2 3 4 5; do
        [[ -d "/proc/$pid" ]] || break
        sleep 1
    done
    if [[ -d "/proc/$pid" ]]; then
        kill -KILL "$pid" 2>/dev/null && echo "TERM 无效，已升级 KILL: $pid"
    else
        echo "已停止: $pid"
    fi
done

if (( failed > 0 )); then
    echo "$failed 个进程处理失败" >&2
    exit 1
fi
exit 0
```

## 双平台对照：危险写法 → 安全写法

| 意图 | ❌ 危险 | ✅ 安全 |
|---|---|---|
| 杀进程 | `killall chrome` | 列 PID → 逐个 `kill -TERM` |
| 杀进程 | `Stop-Process -Name chrome` | `Stop-Process -Id $pid` |
| 模式杀 | `pkill -f pattern`（无 scope） | 先列清单，再按 PID |
| 只查 port | `-match '--remote-debugging-port'` | 匹配 `--remote-debugging-(port\|pipe)` + 父进程判据 |
| 删文件 | `rm -rf $dir/*` | 先 `ls` 清单 + 校验 `$dir` 非空非 `/` |
| 删文件 | `Remove-Item -Recurse -Force` | `-WhatIf` 先跑，路径变量先断言 |
| 覆盖 | `> config.json` | 备份原文件 → 写临时文件 → 原子替换 |
| 批量 | `foreach { action }` 无反馈 | 每步 print 目标 + 结果，失败不中断后续 |
| 后台任务 | 直接起，被杀才知道 | 登记契约（用途/时长/可终止条件） |

## 交脚本前自检清单

- [ ] 破坏性操作前打印了目标清单（PID/路径/数量）？
- [ ] 默认是演练，真跑需要显式开关？
- [ ] 持有检查用了**调试通道（port+pipe）/父进程存活/年龄阈值/契约登记**四道判据？
- [ ] 长任务登记了契约（载体落地：manage_process 台账或契约文件）？
- [ ] 「读不到的进程」走 SKIP 不走候选（年龄未知、exe 不可读、StartTime 抛异常）？
- [ ] 失败不静默：清理脚本自身有非零退出码 + 逐条原因？
- [ ] 敏感值不进日志（凭据、token、密码只读不回显）？
- [ ] 幂等：重复执行结果一致，不会越跑越乱？

---

# 第二部分：语法坑（Windows 部署机为主；Linux 部署可只看长任务一节）

这部分是**实战教训汇总**，每条都对应一次真实的失败。写脚本或跑命令前先扫一遍，
能省掉大量「猜参数、改引号、重试」的回合。

## 铁律：参数永远不要写在命令行里

命令行参数在 Windows 上有三层互相叠加的风险：

1. **`cmd.exe` 会重新分词**——参数里有空格就被拆成两个；
2. **引号要吃两层**——给 PowerShell 引一次，给上层 JS/TS 再转一次，漏一个反斜杠就崩；
3. **中文参数乱码**——命令行走 ANSI 代码页（CP936），UTF-8 的中文到脚本里就成了问号。

**正确做法，优先级从高到低：**

| 场景 | 用什么 |
|---|---|
| 要给脚本传参数 | **`run_script`**（参数自动写 JSON 文件，命令行只剩路径） |
| 脚本要跑但不想碰 shell | **`codemode`**（QuickJS 沙箱，对象传参，不经过 cmd） |
| 必须用 `run_command` | 参数先写文件，命令只传**文件路径**，零参数 |

`run_script` 的用法：

```
run_script(script="C:\Users\me\job.py", params={account: "...", note: "含 空格 和 \"引号\""})
```

脚本侧读参数：

```python
import argparse, json
p = argparse.ArgumentParser(); p.add_argument("--params-file", required=True)
cfg = json.load(open(p.parse_args().params_file, encoding="utf-8"))
```

```powershell
param([string]$ParamsFile)
$cfg = Get-Content $ParamsFile -Raw -Encoding UTF8 | ConvertFrom-Json
```

## 输出乱码

**`chcp 65001` 不够用。** 它只改控制台代码页，子进程往**管道**写东西时用的仍是
ANSI 代码页（CP936）。所以 `tasklist`、`dir`、`systeminfo` 的中文输出照样是 GBK。

VE 的 `run_command` 现在会自动识别并按 GBK 解码（见 `chunk-decoder.ts`），
但如果仍见到乱码，**不要硬猜**，用这些替代：

- 让程序输出到文件，再读文件（文件可以显式指定 UTF-8）；
- Python 加 `-X utf8` 或设 `PYTHONUTF8=1`；
- 目录/文件元数据用 `list_directory`（原生支持中文路径）。

## PowerShell 特有坑

**`Start-Process` 的路径必须加引号。** 不加引号时含空格的路径被拆开，
报错信息误导性极强：

```
Start-Process C:\Users\me\My Project\app.exe     # ❌ Cannot find module '...\My'
Start-Process "C:\Users\me\My Project\app.exe"   # ✅
```

**复杂脚本用 EncodedCommand 而不是 `-Command`**，彻底避开引号：

```bash
# 本地把脚本转成 base64（UTF-16LE），再喂给 powershell
iconv -f UTF-8 -t UTF-16LE script.ps1 | base64 -w0
```

```
powershell -NoProfile -EncodedCommand <base64>
```

**`.ps1` 默认受执行策略限制**，要加 `-ExecutionPolicy Bypass`（`run_script` 已自动加）。

**SSH 会话看不到 RDP 桌面窗口**（跨会话隔离）。要操作 GUI 只能用浏览器/CDP 或
计划任务在交互会话里跑。

## 长任务必须后台化

同步 `run_command` 有硬超时（默认 300 秒），超时会被**强制杀进程树**。

```python
# ❌ 900 秒的超时，杀掉只完成一半
run_command("python long_job.py")

# ✅
run_command("python long_job.py", background=True)   # 立刻返回 sessionId
manage_process(action="poll", sessionId=..., waitSec=120)
manage_process(action="log",  sessionId=..., offset=0)
```

**不要把「拿到 sessionId」当成「任务完成」**——它只表示进程已创建。
第一次要 `poll` 或读日志确认真的跑起来了。

应用退出会终止后台进程，重启后不可续接。需要跨重启的采集，自己设计断点续跑
（状态写文件），不要靠 `nohup` 或自制脱管 launcher。

> 与第一部分铁律 4 呼应：后台化的下一步就是**契约登记**——把用途、预期时长、
> 可终止条件写进 manage_process 台账或契约文件，更新/退出清理才不会把它连根拔掉。

## 诊断顺序（照着查，别乱试）

命令跑不通时，按这个顺序排查，每一步都能排除一类原因：

1. **脚本本身能跑吗** → 不带参数直接跑一次，确认不是逻辑错误
2. **参数传递** → 改成 `run_script` 或写文件传参，排除分词/引号
3. **编码** → 输出重定向到文件再读，排除 GBK 显示问题
4. **权限** → `whoami`、确认工作目录可写
5. **超时** → 看返回里是不是 `timed_out`，是就改 `background=True`

## 反面清单（别做这些）

- ❌ 用 `python -c "..."` 内联代码——括号会被拦截，且引号必须转两层
- ❌ 在命令行里传含空格/中文/引号的值
- ❌ 见到乱码就重试同一命令（不会变好）
- ❌ 把 `sessionId` 当完成信号
- ❌ 超时后原样重跑——先改后台或让脚本可续跑
- ❌ 用 `Start-Process` 不带引号
- ❌ 无差别杀进程（`killall` / `Stop-Process -Name` / 按 path 前缀批量 Kill）——见第一部分铁律
- ❌ 持有检查只查 `--remote-debugging-port`——Playwright 默认用 pipe，长任务必漏
