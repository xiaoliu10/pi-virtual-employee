# 更新卡死手动修复 Runbook（供管理员/运维在部署机上执行）

适用症状：`updater.log` 出现 `install requested` 后长时间无 `startup: pending install ... SUCCEEDED`，
且存在存活的 `Pi-Virtual-Employee-Setup*` 安装器进程（NSIS 卡在卸载旧版本步骤）。

该序列与 0.2.29+ 的内置自愈 watchdog 等价——人工执行它已连续成功 7 次（12-14 秒完成安装）。

## 静默装最新版（PowerShell 管理员）

```powershell
# 变量
$ver  = "0.2.30"   # 改成 latest.yml 里的版本号
$base = "https://gitee.com/xiaoliu10/pi-virtual-employee/releases/download/latest"
$dl   = "$env:USERPROFILE\Downloads\Pi-Virtual-Employee-Setup-$ver-x64.exe"

# 1) 下载安装包 + latest.yml
Invoke-WebRequest "$base/Pi-Virtual-Employee-Setup-$ver-x64.exe" -OutFile $dl
Invoke-WebRequest "$base/latest.yml" -OutFile "$env:TEMP\latest.yml"

# 2) sha512 校验（latest.yml 里是 base64；不匹配立即停止）
$line   = (Get-Content "$env:TEMP\latest.yml" | Select-String 'sha512: ' | Select-Object -First 1).Line
$expect = ($line -split 'sha512:\s*')[1].Trim()
$hex    = (Get-FileHash $dl -Algorithm SHA512).Hash
$bytes  = for ($i = 0; $i -lt $hex.Length; $i += 2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }
$actual = [Convert]::ToBase64String($bytes)
if ($actual -ne $expect) { throw "sha512 MISMATCH — 不要安装，重新下载" }
'sha512 MATCH'

# 3) 杀应用全部实例 + 残留安装器（NSIS 按映像名杀，两个 profile 一起下）
Get-Process 'Pi Virtual Employee' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process | Where-Object { $_.ProcessName -like 'Pi-Virtual-Employee-Setup*' } | Stop-Process -Force
Start-Sleep -Seconds 3

# 4) 静默安装（实测 12-14 秒）
$p = Start-Process -FilePath $dl -ArgumentList '/S' -PassThru
$p.WaitForExit(300000) | Out-Null
"install exit code = $($p.ExitCode)"

# 5) 重启全部 profile（按实际部署增减）
$exe = "$env:LOCALAPPDATA\Programs\Pi Virtual Employee\Pi Virtual Employee.exe"
Start-Process -FilePath $exe -ArgumentList @('--profile', 'work')
Start-Sleep -Seconds 15
Start-Process -FilePath $exe -ArgumentList @('--profile', 'home')
```

## 验证

1. `logs\updater.log` 末尾应出现 `startup: pending install ... SUCCEEDED (running <新版本>)`；
2. 40 秒后钉钉 443 出站正常（bot 能回复）即恢复完成。

## 0.2.30 起的新更新流程（预期日志）

0.2.30 起，应用不再用进程内 `quitAndInstall`（该路径在本机 7/7 卡死），更新由
独立 watchdog 执行同一序列。下一次版本更新时 `updater.log` 应依次出现：

```
install handed to watchdog: app quitting now; watchdog runs installer /S after exit
watchdog phase0a: waiting for app to exit (max 120s)
watchdog phase1: app exited; killing stale installers and running the update silently
watchdog phase1: silent install exited code=0
watchdog: service relaunched (update installed, or previous version restored after a wedged install)
```

若出现以上行且无卡死，说明自动更新已根治；若某步失败，把 `updater.log`
（和 `update-watchdog\watch-update.ps1` 是否存在）反馈给 vendor 对症修。
