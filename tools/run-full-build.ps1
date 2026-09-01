# Orchestrates the zooms 1-6, satellite+topographic final build for all
# three maps via the existing server job API (so the web UI's live-tile
# viewer, already wired to a running final-build job, shows tiles as they're
# generated - no need to duplicate that logic here). Prevents system sleep
# for the duration and alerts (sound + popup) when the job finishes or fails.

$ErrorActionPreference = "Stop"
$logFile = Join-Path $PSScriptRoot "..\logs\full-build-1-6.log"
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PowerState {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
$ES_DISPLAY_REQUIRED = [uint32]"0x00000002"

function Write-Log($message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message"
    $line | Out-File -FilePath $logFile -Append -Encoding utf8
    Write-Host $line
}

function Show-Alert($message, $isFailure) {
    for ($i = 0; $i -lt ($(if ($isFailure) { 8 } else { 4 })); $i++) {
        [console]::beep($(if ($isFailure) { 400 } else { 1000 }), 350)
        Start-Sleep -Milliseconds 150
    }
    try {
        $wshell = New-Object -ComObject WScript.Shell
        $wshell.Popup($message, 0, "DayZ Map Build", 64) | Out-Null
    } catch {
        Write-Log "Could not show popup: $($_.Exception.Message)"
    }
}

[PowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED) | Out-Null
Write-Log "Sleep prevention enabled."

try {
    $body = @{
        maps    = "all"
        zooms   = @(1, 2, 3, 4, 5, 6)
        modes   = @("satellite", "topographic")
        version = "full-v1-zoom1-6"
        workers = 8
    } | ConvertTo-Json

    Write-Log "Starting final-build job: all maps, zooms 1-6, satellite+topographic, 8 workers."
    $job = Invoke-RestMethod -Uri "http://localhost:8080/api/map-render/final-build" -Method Post -Body $body -ContentType "application/json"
    $jobId = $job.id
    Write-Log "Job started: $jobId"

    $status = $job
    while ($true) {
        Start-Sleep -Seconds 30
        try {
            $status = Invoke-RestMethod -Uri "http://localhost:8080/api/map-render/jobs/$jobId" -Method Get
        } catch {
            Write-Log "Poll failed (server may be restarting): $($_.Exception.Message)"
            continue
        }
        $completed = $status.progressSummary.completed
        $total = $status.progressSummary.total
        $pct = if ($total -gt 0) { [math]::Round(100 * $completed / $total, 1) } else { 0 }
        Write-Log "status=$($status.status) progress=$completed/$total ($pct%) currentMap=$($status.current.mapId) zoom=$($status.current.zoom)"
        if ($status.status -in @("complete", "failed", "cancelled")) { break }
    }

    Write-Log "Job finished with status: $($status.status)"
    if ($status.error) { Write-Log "Error: $($status.error)" }

    if ($status.status -eq "complete") {
        Show-Alert "DayZ map build complete: all 3 maps, zooms 1-6, satellite + topographic.`nLog: $logFile" $false
    } else {
        Show-Alert "DayZ map build FAILED or was cancelled.`nStatus: $($status.status)`nSee log: $logFile" $true
    }
}
catch {
    Write-Log "Fatal error: $($_.Exception.Message)"
    Show-Alert "DayZ map build script crashed: $($_.Exception.Message)`nSee log: $logFile" $true
    throw
}
finally {
    [PowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Log "Sleep prevention disabled."
}
