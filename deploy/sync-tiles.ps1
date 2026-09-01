# Thin wrapper so sync-tiles.sh can be run from PowerShell instead of
# opening a WSL shell manually. Requires WSL2 with rsync/ssh installed
# (see deploy/nginx/jiniebot-tiles.local.conf's header for setup).
#
# Usage:
#   $env:TILES_SSH_HOST = "user@host"
#   .\deploy\sync-tiles.ps1 chernarus

param(
    [Parameter(Mandatory = $true)][string]$MapId
)

if (-not $env:TILES_SSH_HOST) {
    Write-Error "Set `$env:TILES_SSH_HOST = 'user@host' before running this."
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$wslRepoRoot = wsl.exe wslpath -a "$repoRoot"

wsl.exe bash -c "cd '$wslRepoRoot' && TILES_SSH_HOST='$env:TILES_SSH_HOST' bash deploy/sync-tiles.sh '$MapId'"
exit $LASTEXITCODE
