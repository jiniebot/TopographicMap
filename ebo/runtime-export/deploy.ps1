$ErrorActionPreference = 'Stop'
$serverRoot = 'C:\Program Files (x86)\Steam\steamapps\common\DayZServer'
$sourceMission = Join-Path $serverRoot 'mpmissions\dayzOffline.sakhal'
$targetMission = $sourceMission
$exportRoot = $PSScriptRoot

if (!(Test-Path -LiteralPath $sourceMission)) { throw "Sakhal mission not found: $sourceMission" }
$backup = Join-Path $exportRoot 'original-init.c'
if (!(Test-Path -LiteralPath $backup)) {
	Copy-Item -LiteralPath (Join-Path $sourceMission 'init.c') -Destination $backup
}
Copy-Item -LiteralPath (Join-Path $exportRoot 'init.c') -Destination (Join-Path $targetMission 'init.c') -Force
Copy-Item -LiteralPath (Join-Path $exportRoot 'serverDZ-export.cfg') -Destination (Join-Path $serverRoot 'serverDZ-export.cfg') -Force
New-Item -ItemType Directory -Path (Join-Path $exportRoot 'profile') -Force | Out-Null
Write-Host "Deployed diagnostic mission: $targetMission"
Write-Host "Profile output: $(Join-Path $exportRoot 'profile')"
