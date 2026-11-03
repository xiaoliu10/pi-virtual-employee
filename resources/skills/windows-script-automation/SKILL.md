---
name: windows-script-automation
description: 在 Windows 部署机上写/跑脚本时必读。覆盖 cmd 分词、引号、GBK 乱码、PowerShell 特性、参数传递、长任务后台化。遇到「命令跑不通 / 参数传不对 / 输出乱码 / Cannot find module / SyntaxError」时先读这里。
---
# Windows 脚本自动化踩坑手册

这份技能是**实战教训汇总**，每条都对应一次真实的失败。写脚本或跑命令前先扫一遍，
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
