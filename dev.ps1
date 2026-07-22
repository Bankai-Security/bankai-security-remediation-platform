<#
  Starts everything needed for local development in one go:
    - Redis                    (via Docker, only if nothing's already on 6379)
    - ngrok tunnel to :4000    (only with -Ngrok - see below)
    - backend API              (backend: npm run dev, port 4000)
    - backend repo-scan worker (backend: npm run worker, needs Redis)
    - frontend                 (frontend: npm run dev, port 5173)

  Each piece runs in its own PowerShell window so logs stay readable and any
  one of them can be restarted/closed independently. Close the window (or
  hit Ctrl+C inside it) to stop that piece. The Redis container (if this
  script started it) keeps running afterward - stop it yourself with
  'docker stop bankai-redis' when you're done.

  -Ngrok exposes the backend (port 4000) publicly, which GitHub needs to
  reach for push/pull_request/workflow_run webhooks (repo connect,
  push-triggered rescans, the CI self-healing loop) and for the GitHub
  OAuth callback. It's opt-in, not default, because it rewrites
  backend\.env's BACKEND_PUBLIC_URL on every run: on a free ngrok account
  the public URL is different each time (no reserved domain), so this
  script updates it for you instead of you hand-pasting a new URL into
  .env every session. It does NOT re-register webhooks for repos you
  already connected in an earlier session - those still point at the old
  ngrok URL until you reconnect the repo (or re-run the manual webhook
  setup) from the app. It also does not touch your GitHub OAuth App's
  callback URL on GitHub's side - update that by hand if it points at an
  ngrok URL from a previous session. Requires ngrok on PATH and already
  authenticated ('ngrok config add-authtoken ...') - see https://ngrok.com.

  Usage:
    .\dev.ps1                     # starts Redis (if needed) + backend API + worker + frontend
    .\dev.ps1 -NoWorker           # skip the repo-scan worker and the Redis check
    .\dev.ps1 -Ngrok              # also tunnel the backend and refresh BACKEND_PUBLIC_URL in backend\.env
    .\dev.ps1 -Ngrok -NoWorker    # combine both
#>

param(
  [switch]$NoWorker,
  [switch]$Ngrok
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backendEnvPath = Join-Path $root "backend\.env"

function Start-DevWindow {
  param(
    [string]$Title,
    [string]$WorkingDirectory,
    [string]$Command
  )
  $inner = "`$host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$WorkingDirectory'; $Command"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $inner | Out-Null
  Write-Host "  Started: $Title" -ForegroundColor Green
}

# Queries ngrok's local agent API (only reachable once an agent is up) for
# an already-open https tunnel pointed at $Port. Returns $null if no agent
# is running yet, or none of its tunnels target that port.
function Get-NgrokTunnelUrl {
  param([int]$Port)
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -Method Get -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
  $match = $resp.tunnels | Where-Object { $_.proto -eq "https" -and $_.config.addr -match ":$Port$" } | Select-Object -First 1
  if ($match) { return $match.public_url }
  return $null
}

# Starts (or reuses) an ngrok tunnel to localhost:$Port and returns its
# public https URL, or $null if ngrok isn't available / never came up.
# ngrok's free tier allows exactly one agent session per account, so this
# reuses an already-running agent's tunnel instead of blindly starting a
# second one (which would just fail with ERR_NGROK_108).
function Start-Ngrok {
  param([int]$Port)

  $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
  if (-not $ngrokCmd) {
    Write-Host "ngrok isn't on PATH - install it from https://ngrok.com/download and run 'ngrok config add-authtoken ...' first. Skipping the tunnel; BACKEND_PUBLIC_URL will be left as-is." -ForegroundColor Yellow
    return $null
  }

  $existing = Get-NgrokTunnelUrl -Port $Port
  if ($existing) {
    Write-Host "Reusing an ngrok tunnel that's already running: $existing" -ForegroundColor Green
    return $existing
  }

  # An agent might be running but tunneling something else (e.g. a
  # different port from another project) - starting a second one would hit
  # the free-tier one-agent-session limit, so don't try.
  try {
    $agentAlreadyUp = [bool](Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -Method Get -TimeoutSec 2 -ErrorAction Stop)
  } catch {
    $agentAlreadyUp = $false
  }
  if ($agentAlreadyUp) {
    Write-Host "An ngrok agent is already running but isn't tunneling port $Port - open http://127.0.0.1:4040 to see what it's pointed at, or stop it and re-run this script. Skipping; BACKEND_PUBLIC_URL will be left as-is." -ForegroundColor Yellow
    return $null
  }

  Write-Host "Starting ngrok tunnel to localhost:$Port..." -ForegroundColor Yellow
  Start-DevWindow -Title "Bankai: ngrok tunnel" -WorkingDirectory $root -Command "ngrok http $Port"

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $url = Get-NgrokTunnelUrl -Port $Port
    if ($url) {
      Write-Host "ngrok tunnel is up: $url" -ForegroundColor Green
      return $url
    }
  }

  Write-Host "ngrok didn't report a tunnel within 20s - check the 'Bankai: ngrok tunnel' window for errors (e.g. an unauthenticated agent, or an existing session elsewhere)." -ForegroundColor Yellow
  return $null
}

# Rewrites (or appends) BACKEND_PUBLIC_URL in backend\.env in place. Written
# as UTF-8 without a BOM to match the file's existing encoding - Node's
# --env-file-if-exists loader is picky about that.
function Set-BackendPublicUrl {
  param([string]$EnvPath, [string]$Url)

  if (-not (Test-Path $EnvPath)) {
    Write-Host "backend\.env doesn't exist yet, so BACKEND_PUBLIC_URL couldn't be written - copy backend\.env.example to backend\.env first, then re-run with -Ngrok. The tunnel is up at $Url in the meantime." -ForegroundColor Yellow
    return
  }

  $lines = Get-Content -Path $EnvPath
  $newLine = "BACKEND_PUBLIC_URL=$Url"
  $found = $false
  $updated = $lines | ForEach-Object {
    if ($_ -match '^\s*BACKEND_PUBLIC_URL\s*=') {
      $found = $true
      $newLine
    } else {
      $_
    }
  }
  if (-not $found) {
    $updated = @($updated) + $newLine
  }

  [System.IO.File]::WriteAllLines($EnvPath, [string[]]$updated, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Updated backend\.env: BACKEND_PUBLIC_URL=$Url" -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $root "backend\node_modules"))) {
  Write-Host "backend\node_modules is missing - run 'npm install' in backend\ first." -ForegroundColor Yellow
}
if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
  Write-Host "frontend\node_modules is missing - run 'npm install' in frontend\ first." -ForegroundColor Yellow
}
if (-not (Test-Path (Join-Path $root "backend\.env"))) {
  Write-Host "backend\.env is missing - copy backend\.env.example to backend\.env and fill it in first." -ForegroundColor Yellow
}

if (-not $NoWorker) {
  $redisOk = (Test-NetConnection -ComputerName "localhost" -Port 6379 -WarningAction SilentlyContinue -InformationLevel Quiet)
  if (-not $redisOk) {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($dockerCmd) {
      Write-Host "Redis isn't reachable on localhost:6379 - starting it via Docker (container 'bankai-redis')..." -ForegroundColor Yellow
      $existing = docker ps -a --filter "name=^/bankai-redis$" --format "{{.Names}}" 2>$null
      if ($existing -eq "bankai-redis") {
        docker start bankai-redis | Out-Null
      } else {
        docker run -d --name bankai-redis -p 6379:6379 redis | Out-Null
      }
      # Give it a moment to come up, then re-check.
      $ready = $false
      for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if (Test-NetConnection -ComputerName "localhost" -Port 6379 -WarningAction SilentlyContinue -InformationLevel Quiet) {
          $ready = $true
          break
        }
      }
      if ($ready) {
        Write-Host "Redis is up (docker container 'bankai-redis')." -ForegroundColor Green
      } else {
        Write-Host "Started the Redis container but it isn't answering on 6379 yet - the worker will retry its connection." -ForegroundColor Yellow
      }
    } else {
      Write-Host "Redis isn't reachable on localhost:6379 and Docker isn't installed - the worker needs Redis (REDIS_URL in backend\.env). Starting it anyway; it'll retry its connection." -ForegroundColor Yellow
    }
  }
}

$ngrokUrl = $null
if ($Ngrok) {
  # Must happen before the backend window starts below: `npm run dev` reads
  # backend\.env once at process startup (tsx's --env-file-if-exists), so
  # BACKEND_PUBLIC_URL needs to be in the file before that process launches,
  # not updated afterward.
  $ngrokUrl = Start-Ngrok -Port 4000
  if ($ngrokUrl) {
    Set-BackendPublicUrl -EnvPath $backendEnvPath -Url $ngrokUrl
  }
}

Write-Host "Starting Bankai dev environment..." -ForegroundColor Cyan

Start-DevWindow -Title "Bankai: backend API (4000)" -WorkingDirectory (Join-Path $root "backend") -Command "npm run dev"

if (-not $NoWorker) {
  Start-DevWindow -Title "Bankai: repo-scan worker" -WorkingDirectory (Join-Path $root "backend") -Command "npm run worker"
}

Start-DevWindow -Title "Bankai: frontend (5173)" -WorkingDirectory (Join-Path $root "frontend") -Command "npm run dev"

Write-Host ""
Write-Host "All set. Frontend: http://localhost:5173  Backend: http://localhost:4000" -ForegroundColor Cyan
if ($ngrokUrl) {
  Write-Host "Public tunnel: $ngrokUrl  (GitHub webhook target: $ngrokUrl/api/webhooks/github/<projectId>)" -ForegroundColor Cyan
  Write-Host "If your GitHub OAuth App's callback URL is still pointed at an older ngrok URL, update it at https://github.com/settings/developers before testing 'Connect your GitHub account'." -ForegroundColor Yellow
  Write-Host "Repos connected in an earlier session still have their webhook pointed at the OLD ngrok URL - reconnect them from the app if you need push-triggered rescans or the CI self-healing loop working again." -ForegroundColor Yellow
}
Write-Host "Each service is running in its own window - close a window (or Ctrl+C inside it) to stop that piece." -ForegroundColor Cyan
