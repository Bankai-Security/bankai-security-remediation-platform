param([Parameter(Mandatory=$true)][string]$QuincyPath)
$ErrorActionPreference = 'Stop'
$engineRoot = (Resolve-Path -LiteralPath $QuincyPath).Path
$entries = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') | ConvertFrom-Json
foreach ($entry in $entries) {
  $target = [IO.Path]::GetFullPath((Join-Path $engineRoot $entry.path))
  if (-not $target.StartsWith($engineRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes engine directory' }
  $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $entry.path))
  if (-not $source.StartsWith($PSScriptRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes bundle' }
  if ((Get-FileHash -LiteralPath $source).Hash.ToLower() -ne $entry.after) { throw "Bundle hash mismatch: $($entry.path)" }
  if (Test-Path -LiteralPath $target) {
    $actual = (Get-FileHash -LiteralPath $target).Hash.ToLower()
    if ($actual -ne $entry.before -and $actual -ne $entry.after) { throw "Existing changes need review: $($entry.path)" }
  } elseif ($entry.before) { throw "Expected existing file: $($entry.path)" }
}
foreach ($entry in $entries) {
  $target = Join-Path $engineRoot $entry.path
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry.path) -Destination $target
}
Write-Output 'Installed verified deadline and progress files. Restart Quincy when active work is safely drained.'
