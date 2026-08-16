# dsh-im-bridge 一键状态检查
# 用法: powershell -ExecutionPolicy Bypass -File scripts/status.ps1
$ErrorActionPreference = "SilentlyContinue"

function Test-Port([int]$Port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1500)) { $c.EndConnect($iar); return $true }
    } catch { }
    finally { $c.Close() }
    return $false
}

Write-Host ""
Write-Host "========== dsh-im-bridge 状态检查 ==========" -ForegroundColor Cyan

# 1. 插件安装
$prof = Join-Path $env:USERPROFILE ".dsh\profiles\web"
if (Test-Path (Join-Path $prof "dsh-im-bridge\package.json")) {
    Write-Host "[OK ] 插件已安装: $prof\dsh-im-bridge" -ForegroundColor Green
} else {
    Write-Host "[!! ] 插件未安装" -ForegroundColor Red
}
try {
    $pkg = Get-Content (Join-Path $prof "package.json") -Raw | ConvertFrom-Json
    if ($pkg.dsh.profile.bundles -contains "dsh-im-bridge") {
        Write-Host "[OK ] bundle 已注册 (dsh.profile.bundles)" -ForegroundColor Green
    } else {
        Write-Host "[!! ] bundle 未注册" -ForegroundColor Red
    }
} catch { Write-Host "[!! ] 无法读取 profile package.json" -ForegroundColor Red }

# 2. DSH Web
if (Test-Port 3080) {
    Write-Host "[OK ] DSH Web 运行中 (3080)" -ForegroundColor Green
    Write-Host "      ⚠ 注意: 重启 DSH Web 后插件才会真正激活" -ForegroundColor Yellow
} else {
    Write-Host "[!! ] DSH Web 未运行 (3080)" -ForegroundColor Red
}

# 3. QQ / NapCat
if (Test-Port 3001) {
    Write-Host "[OK ] NapCat WebSocket 已监听 (3001) — QQ 通道就绪" -ForegroundColor Green
} else {
    Write-Host "[-- ] NapCat 未运行 (3001 未监听) — QQ 通道不可用" -ForegroundColor Yellow
    Write-Host "      启动 NapCat → WebUI → 网络配置 → 开启 WebSocket 服务器 (127.0.0.1:3001)" -ForegroundColor DarkYellow
}

# 4. WeChatFerry
if (Test-Port 10086) {
    Write-Host "[OK ] WeChatFerry 已监听 (10086) — 微信通道就绪" -ForegroundColor Green
} else {
    Write-Host "[-- ] WeChatFerry 未运行 (10086 未监听) — 微信通道不可用" -ForegroundColor Yellow
    Write-Host "      需要: 微信 3.9.12.17 + wcf.exe 管理员运行 'wcf.exe start 10086'" -ForegroundColor DarkYellow
}

# 5. 插件运行日志（在 DSH 日志里）
Write-Host ""
Write-Host "验证: 重启 DSH Web 后日志出现 [dsh-im-bridge] 即成功；" -ForegroundColor Cyan
Write-Host "      在 QQ/微信里对机器人发 /status 可看实时状态" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
