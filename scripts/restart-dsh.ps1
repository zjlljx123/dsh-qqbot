# 重启 DSH Web（加载 dsh-im-bridge 插件）
# 用法:
#   手动: powershell -ExecutionPolicy Bypass -File restart-dsh.ps1
#   页面按钮调用: powershell ... -File restart-dsh.ps1 -Delay 3
param([int]$Delay = 0)
$ErrorActionPreference = "Stop"

if ($Delay -gt 0) {
    Write-Host "== $Delay 秒后重启 DSH ==" -ForegroundColor Cyan
    Start-Sleep -Seconds $Delay
}

Write-Host "== 1/3 结束旧 DSH 进程 ==" -ForegroundColor Cyan
$old = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "dsh[\\/]lib[\\/]bin\.js web" }
if ($old) {
    $old | ForEach-Object { Write-Host "  结束 PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
} else {
    Write-Host "  没有找到旧的 DSH web 进程"
}

Write-Host "== 2/3 检查 NapCat（3001 端口）==" -ForegroundColor Cyan
$c = New-Object System.Net.Sockets.TcpClient
try {
    $iar = $c.BeginConnect("127.0.0.1", 3001, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(1500)) { $c.EndConnect($iar); Write-Host "  NapCat OneBot (3001) 正常" -ForegroundColor Green }
    else { Write-Host "  警告: 3001 未监听，NapCat 可能没在运行" -ForegroundColor Yellow }
} catch { Write-Host "  警告: 3001 未监听，NapCat 可能没在运行" -ForegroundColor Yellow }
finally { $c.Close() }

Write-Host "== 3/3 启动 DSH Web（新窗口）==" -ForegroundColor Cyan
Start-Process cmd -ArgumentList "/k", "npx -y @deepseek-ai/dsh web" -WorkingDirectory "D:\work\DshWorkspace"
Write-Host "  新窗口启动中，浏览器打开 http://127.0.0.1:3080"
Write-Host "  看到 [dsh-im-bridge] QQ 已连接 (ws://127.0.0.1:3001) 即成功" -ForegroundColor Green
