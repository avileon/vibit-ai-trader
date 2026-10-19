# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\healthcheck.ps1 [url]
param([string]$Url = 'http://localhost:3000')
try { $h = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 10 } catch { Write-Host "FAIL: API unreachable ($Url)" -ForegroundColor Red; exit 1 }
$h | ConvertTo-Json -Depth 4
if ($h.status -ne 'ok') { Write-Host 'FAIL: database' -ForegroundColor Red; exit 1 }
if ($h.tradingMode -ne 'paper') { Write-Host 'FAIL: not paper' -ForegroundColor Red; exit 1 }
if (-not $h.worker.alive) { Write-Host 'FAIL: worker heartbeat stale' -ForegroundColor Red; exit 1 }
Write-Host 'OK' -ForegroundColor Green
