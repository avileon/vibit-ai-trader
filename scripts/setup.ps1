# VIBIT AI Trader - one-shot Windows setup (PowerShell 5.1+ / 7)
# Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "Project folder: $(Get-Location)" -ForegroundColor Cyan

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# 1. Docker running?
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $dockerOk) { Fail "Docker Desktop is not running. Start Docker Desktop, wait for 'Engine running', then run this script again." }

# 2. .env with generated secrets (only if missing)
function RandBytes($n) { $b = New-Object byte[] $n; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); return $b }
function RandHex($n) { -join ((RandBytes $n) | ForEach-Object { $_.ToString('x2') }) }
if (-not (Test-Path .env)) {
  $envText = Get-Content .env.example -Raw
  $envText = $envText -replace '(?m)^MASTER_KEY=.*$', ("MASTER_KEY=" + [Convert]::ToBase64String((RandBytes 32)))
  $envText = $envText -replace '(?m)^MYSQL_ROOT_PASSWORD=.*$', ("MYSQL_ROOT_PASSWORD=" + (RandHex 24))
  $envText = $envText -replace '(?m)^MYSQL_PASSWORD=.*$', ("MYSQL_PASSWORD=" + (RandHex 24))
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $envText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ".env created with random secrets (keep a copy of MASTER_KEY in your password manager)." -ForegroundColor Green
} else {
  Write-Host ".env already exists - keeping it." -ForegroundColor Yellow
}

# 3. Build and start
Write-Host "Building and starting containers (first time: 3-8 minutes)..." -ForegroundColor Cyan
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail "docker compose failed. Copy the red output and send it to Claude." }

# 4. Wait for health
Write-Host "Waiting for the system to become healthy..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    if ($h.status -eq 'ok' -and $h.worker.alive) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 5
}
if (-not $ok) { docker compose ps; Fail "System did not become healthy in 5 minutes. Run: docker compose logs api worker --tail 50" }
Write-Host "Healthy: DB ok, paper mode, worker alive." -ForegroundColor Green

# 5. Admin user (password is typed interactively, min 12 chars)
$email = Read-Host "Admin email"
docker compose exec -it api node dist/scripts/createAdmin.js --email $email --name Admin
if ($LASTEXITCODE -ne 0) { Fail "Admin creation failed." }

# 6. Demo data
$demo = Read-Host "Load DEMO data to preview the UI? (Y/n)"
if ($demo -ne 'n') { docker compose exec api node dist/db/seedDemo.js }

& "$PSScriptRoot\healthcheck.ps1"
Start-Process 'http://localhost:3000'
Write-Host "Done. Open http://localhost:3000" -ForegroundColor Green
