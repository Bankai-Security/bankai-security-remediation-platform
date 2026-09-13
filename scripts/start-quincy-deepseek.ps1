<#
  Starts Quincy locally as Bankai's primary remediation engine, configured to
  use DeepSeek for patch generation instead of the fake model.

  Usage:
    .\scripts\start-quincy-deepseek.ps1 -QuincyPath C:\path\to\quincy-security-engine

  The script reads OPENROUTER_API_KEY from the current environment first, then
  falls back to backend\.env, then the Quincy checkout's .env. Both services use
  OPENROUTER_MODEL_NAME (or the -DeepSeekModelName override). It also points
  TMP/TEMP at .quincy-runtime\tmp so Docker scanner volume mounts avoid
  Windows AppData temp paths, which are a common source of "Access is
  denied" errors.
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$QuincyPath,

  [int]$Port = 8000,

  [string]$DeepSeekModelName = "",

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

$DeepSeekApiKey = $env:OPENROUTER_API_KEY
if (-not $DeepSeekApiKey) {
  $DeepSeekApiKey = Read-DotEnvValue -Path (Join-Path $BankaiRoot "backend\.env") -Name "OPENROUTER_API_KEY"
  if (-not $DeepSeekApiKey) { $DeepSeekApiKey = Read-DotEnvValue -Path (Join-Path $QuincyRoot ".env") -Name "OPENROUTER_API_KEY" }
}
if (-not $DeepSeekApiKey) {
  throw "OPENROUTER_API_KEY is required. Set it in this shell or in backend\.env before starting Quincy."
}
if ($DeepSeekApiKey -eq "replace-me") {
  throw "OPENROUTER_API_KEY is still set to the placeholder value 'replace-me'. Put your real DeepSeek API key in backend\.env before starting Quincy."
}

$BackendEnvPath = Join-Path $BankaiRoot "backend\.env"
if (-not $DeepSeekModelName) {
  $DeepSeekModelName = $env:OPENROUTER_MODEL_NAME
}
if (-not $DeepSeekModelName) {
  $DeepSeekModelName = Read-DotEnvValue -Path $BackendEnvPath -Name "OPENROUTER_MODEL_NAME"
}
if (-not $DeepSeekModelName) {
  $DeepSeekModelName = Read-DotEnvValue -Path (Join-Path $QuincyRoot ".env") -Name "OPENROUTER_MODEL_NAME"
}
if (-not $DeepSeekModelName) {
  $DeepSeekModelName = "deepseek/deepseek-v4-flash-0731"
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

$env:MODEL_PROVIDER = "openrouter"
$env:OPENROUTER_API_KEY = $DeepSeekApiKey
$env:OPENROUTER_MODEL_NAME = $DeepSeekModelName
$baseUrl = $env:OPENROUTER_BASE_URL
if (-not $baseUrl) { $baseUrl = Read-DotEnvValue -Path $BackendEnvPath -Name "OPENROUTER_BASE_URL" }
if (-not $baseUrl) { $baseUrl = Read-DotEnvValue -Path (Join-Path $QuincyRoot ".env") -Name "OPENROUTER_BASE_URL" }
$env:OPENROUTER_BASE_URL = if ($baseUrl) { $baseUrl } else { "https://openrouter.ai/api/v1" }
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

Write-Host "Starting Quincy with DeepSeek on http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "Runtime data: $RuntimeRoot" -ForegroundColor Cyan
Write-Host "Model: $DeepSeekModelName" -ForegroundColor Cyan

Set-Location $QuincyRoot
& $Python -c "import asyncio, uvicorn; asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy()); uvicorn.run('quincy.api.app:create_app', factory=True, host='127.0.0.1', port=$Port)"
