<#
  Starts Quincy locally as Bankai's primary remediation engine, configured to
  use Gemini for patch generation instead of the fake model.

  Usage:
    .\scripts\start-quincy-gemini.ps1 -QuincyPath C:\path\to\quincy-security-engine

  The script reads GEMINI_API_KEY from the current environment first, then
  falls back to backend\.env in this Bankai repo. Quincy uses
  GEMINI_MODEL_NAME (or the -GeminiModelName parameter) and intentionally
  does not inherit Bankai's general GEMINI_MODEL default. It also points
  TMP/TEMP at .quincy-runtime\tmp so Docker scanner volume mounts avoid
  Windows AppData temp paths, which are a common source of "Access is
  denied" errors.
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$QuincyPath,

  [int]$Port = 8000,

  [string]$GeminiModelName = "",

  [string]$ServiceApiToken = "",

  [switch]$RestartIfRunning,

  [switch]$SkipDockerCheck
)

$ErrorActionPreference = "Stop"
$BankaiRoot = Split-Path -Parent $PSScriptRoot
$QuincyRoot = (Resolve-Path -LiteralPath $QuincyPath).Path
$RuntimeRoot = Join-Path $BankaiRoot ".quincy-runtime"
$TempRoot = Join-Path $RuntimeRoot "tmp"
$DataRoot = Join-Path $RuntimeRoot "data"

New-Item -ItemType Directory -Force -Path $TempRoot, $DataRoot | Out-Null

function Test-ExistingQuincyServer {
  param([int]$Port)

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/openapi.json" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }

    $openApi = $response.Content | ConvertFrom-Json
    return $openApi.info.title -eq "Quincy Security Engine"
  } catch {
    return $false
  }
}

function Stop-ExistingQuincyServer {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -and $connection.OwningProcess -ne $PID) {
      Write-Host "Stopping existing Quincy process $($connection.OwningProcess) on port $Port..." -ForegroundColor Yellow
      Stop-Process -Id $connection.OwningProcess -Force
    }
  }
}

function Read-DotEnvValue {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $envFile = Get-Item -LiteralPath $Path
  if ($envFile.Length -gt 1MB) {
    throw "backend\.env is unexpectedly large ($([Math]::Round($envFile.Length / 1MB, 1)) MB). Move it aside and recreate it from backend\.env.example before starting Quincy."
  }
  $line = [System.IO.File]::ReadLines($Path) | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$([regex]::Escape($Name))\s*=", "").Trim().Trim('"').Trim("'")
}

if (Test-ExistingQuincyServer -Port $Port) {
  if ($RestartIfRunning) {
    Stop-ExistingQuincyServer -Port $Port
    Start-Sleep -Seconds 1
  } else {
    Write-Host "Quincy is already running on http://127.0.0.1:$Port" -ForegroundColor Green
    exit 0
  }
}

$GeminiApiKey = $env:GEMINI_API_KEY
if (-not $GeminiApiKey) {
  $GeminiApiKey = Read-DotEnvValue -Path (Join-Path $BankaiRoot "backend\.env") -Name "GEMINI_API_KEY"
}
if (-not $GeminiApiKey) {
  throw "GEMINI_API_KEY is required. Set it in this shell or in backend\.env before starting Quincy."
}
if ($GeminiApiKey -eq "replace-me") {
  throw "GEMINI_API_KEY is still set to the placeholder value 'replace-me'. Put your real Gemini API key in backend\.env before starting Quincy."
}

$BackendEnvPath = Join-Path $BankaiRoot "backend\.env"
if (-not $GeminiModelName) {
  $GeminiModelName = $env:GEMINI_MODEL_NAME
}
if (-not $GeminiModelName) {
  $GeminiModelName = Read-DotEnvValue -Path $BackendEnvPath -Name "GEMINI_MODEL_NAME"
}
if (-not $GeminiModelName) {
  $GeminiModelName = "gemini-3.1-pro-preview"
}

$Python = Join-Path $QuincyRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
  $PythonCmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $PythonCmd) { throw "Could not find $Python or python on PATH." }
  $Python = $PythonCmd.Source
}

if (-not $SkipDockerCheck) {
  $Docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $Docker) { throw "Docker CLI is required for Quincy sandbox/scanner validation." }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw "Docker is installed but not usable from this shell. Start Docker Desktop and retry." }

  $mountPath = $TempRoot.Replace("\", "/")
  docker run --rm -v "${mountPath}:/workspace" alpine:3.20 sh -lc "echo ok > /workspace/quincy-docker-check.txt"
  if ($LASTEXITCODE -ne 0) {
    throw "Docker could not mount $TempRoot. Check Docker Desktop file-sharing/permissions, then retry."
  }
}

$env:MODEL_PROVIDER = "gemini"
$env:GEMINI_API_KEY = $GeminiApiKey
$env:GEMINI_MODEL_NAME = $GeminiModelName
$env:REVIEW_MODEL_PROVIDER = ""
$env:TMP = $TempRoot
$env:TEMP = $TempRoot
$env:DB_BACKEND = "sqlite"
$env:DB_PATH = Join-Path $DataRoot "quincy.db"
$env:KNOWLEDGE_DB_PATH = Join-Path $DataRoot "knowledge.db"
$env:UNDERSTANDING_DB_DIR = Join-Path $DataRoot "understanding"
$env:SCAN_CACHE_DIR = Join-Path $DataRoot "scan_cache"
$env:SYMBOL_INDEX_DB_DIR = Join-Path $DataRoot "symbol_index"
$env:HISTORICAL_KB_DB_PATH = Join-Path $DataRoot "historical_kb.db"
$env:SEMGREP_EXECUTION = "docker"
$env:SERVICE_API_TOKEN = $ServiceApiToken

Write-Host "Starting Quincy with Gemini on http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "Runtime data: $RuntimeRoot" -ForegroundColor Cyan
Write-Host "Model: $GeminiModelName" -ForegroundColor Cyan

Set-Location $QuincyRoot
& $Python -c "import asyncio, uvicorn; asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy()); uvicorn.run('quincy.api.app:create_app', factory=True, host='127.0.0.1', port=$Port)"
