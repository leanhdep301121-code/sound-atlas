$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot '.collector.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output '没有本启动脚本记录的进程。'; exit 0 }
$receiverPid = [int](Get-Content -LiteralPath $pidPath -Raw)
$receiverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$receiverPid"
if ($receiverProcess -and $receiverProcess.Name -match '^python(w)?\.exe$' -and $receiverProcess.CommandLine -match 'receiver\.py') {
    Stop-Process -Id $receiverPid
    Write-Output '采集接收与同步已停止，采集计划和数据库已保留。'
} else { Write-Output '记录的进程已结束，不会操作其他程序。' }
