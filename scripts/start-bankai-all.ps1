<#
  Starts the full local Bankai stack with one command:
    - Redis, if needed
    - ngrok tunnel to backend :4000
    - Quincy DeepSeek engine
    - Bankai backend API
    - Bankai backend worker
    - Bankai frontend

  Usage:
    .\scripts\start-bankai-all.ps1
    .\scripts\start-bankai-all.ps1 -QuincyPath C:\path\to\quincy-security-engine
    .\scripts\start-bankai-all.ps1 -NoNgrok

  This is a convenience wrapper around ..\dev.ps1. Services start in hidden
  PowerShell windows.
#>

param(
  [string]$QuincyPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "quincy-security-engine"),
  [string]$QuincyDeepSeekModelName = "deepseek/deepseek-v4-flash-0731",
  [string]$QuincyServiceApiToken = "",
  [switch]$NoNgrok
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$devScript = Join-Path $repoRoot "dev.ps1"

if (-not (Test-Path -LiteralPath $devScript)) {
  throw "Could not find dev.ps1 at $devScript."
}

if (-not (Test-Path -LiteralPath $QuincyPath)) {
  throw "QuincyPath was not found: $QuincyPath. Pass -QuincyPath C:\path\to\quincy-security-engine."
}

$devParams = @{
  QuincyPath = $QuincyPath
  QuincyDeepSeekModelName = $QuincyDeepSeekModelName
}
if (-not $NoNgrok) {
  $devParams.Ngrok = $true
}
if ($QuincyServiceApiToken) {
  $devParams.QuincyServiceApiToken = $QuincyServiceApiToken
}

Write-Host "Starting full Bankai stack..." -ForegroundColor Cyan
Write-Host "Quincy: $QuincyPath" -ForegroundColor Cyan
Write-Host "Quincy model: $QuincyDeepSeekModelName" -ForegroundColor Cyan
if ($NoNgrok) {
  Write-Host "ngrok: disabled" -ForegroundColor Yellow
} else {
  Write-Host "ngrok: enabled for backend port 4000" -ForegroundColor Cyan
}

& $devScript @devParams
