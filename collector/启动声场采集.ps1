$ErrorActionPreference = 'Stop'
$receiverRoot = $PSScriptRoot
$existing = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output '端口 8000 已在使用；采集页面：http://localhost:8000'
    exit 0
}
$pythonPath = (Get-Command python -ErrorAction Stop).Source
$logDirectory = Join-Path $receiverRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$env:PYTHONUTF8 = '1'
$receiverProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-u', 'receiver.py') -WorkingDirectory $receiverRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "$stamp.out.log") -RedirectStandardError (Join-Path $logDirectory "$stamp.error.log") -PassThru
Set-Content -LiteralPath (Join-Path $receiverRoot '.collector.pid') -Value $receiverProcess.Id -Encoding ascii
Write-Output "声场采集服务已启动（进程 $($receiverProcess.Id)）。页面：http://localhost:8000"
