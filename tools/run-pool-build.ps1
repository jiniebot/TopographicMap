# Orchestrates the remaining distributed-pool maps (livonia already active,
# sakhal queued next) to completion: prevents sleep, polls the current
# distributed job, creates the next map's job when one finishes, and alerts
# when everything is done. Workers (local + remote) are expected to already
# be running against the coordinator - this only sequences jobs and watches.

$ErrorActionPreference = "Stop"
$logFile = Join-Path $PSScriptRoot "..\logs\pool-build.log"
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
$coordinator = "http://localhost:8080"
$version = "full-v1-zoom1-6"
$zooms = @(1, 2, 3, 4, 5, 6)
$modes = @("satellite", "topographic")
$remainingMaps = @("livonia", "sakhal")  # chernarus already complete via dedup

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PoolPowerState {
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
        $wshell.Popup($message, 0, "DayZ Render Pool", 64) | Out-Null
    } catch { Write-Log "Could not show popup: $($_.Exception.Message)" }
}

[PoolPowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED) | Out-Null
Write-Log "Sleep prevention enabled. Watching pool queue: $($remainingMaps -join ', ')"

try {
    foreach ($mapId in $remainingMaps) {
        Write-Log "Creating distributed job for $mapId..."
        $body = @{ mapId = $mapId; zooms = $zooms; modes = $modes; version = $version } | ConvertTo-Json
        $created = $null
        try {
            $created = Invoke-RestMethod -Uri "$coordinator/api/render-pool/jobs" -Method Post -Body $body -ContentType "application/json"
        } catch {
            Write-Log "Job creation for $mapId failed (may already be active or complete): $($_.Exception.Message)"
        }

        # Find whichever job is currently active for this map (either the one
        # just created, or one already running from a prior step).
        $jobId = $null
        if ($created) { $jobId = $created.jobId }
        if (-not $jobId) {
            $status = Invoke-RestMethod -Uri "$coordinator/api/render-pool/status" -Method Get
            if ($status.activeJobId) { $jobId = $status.activeJobId }
        }
        if (-not $jobId) { Write-Log "$mapId : no active job found and none created - skipping (likely already fully complete)."; continue }

        Write-Log "Watching job $jobId for $mapId"
        $job = $null
        while ($true) {
            Start-Sleep -Seconds 30
            try {
                $job = Invoke-RestMethod -Uri "$coordinator/api/render-pool/jobs/$jobId" -Method Get
            } catch {
                # The job only lives in the coordinator's memory - a server
                # restart (new code, crash recovery, etc.) wipes it even
                # though the underlying render progress on disk is intact.
                # A 404 here isn't a real failure; re-resolve or recreate
                # the job for this map (dedup means recreating is a no-op
                # for already-completed tiles) and keep watching instead of
                # treating a coordinator restart as the whole run failing.
                Write-Log "$mapId : lost job $jobId ($($_.Exception.Message)) - attempting to recreate/re-resolve"
                $recreated = $null
                try {
                    $body2 = @{ mapId = $mapId; zooms = $zooms; modes = $modes; version = $version } | ConvertTo-Json
                    $recreated = Invoke-RestMethod -Uri "$coordinator/api/render-pool/jobs" -Method Post -Body $body2 -ContentType "application/json"
                } catch {
                    try {
                        $status2 = Invoke-RestMethod -Uri "$coordinator/api/render-pool/status" -Method Get
                        if ($status2.activeJobId) { $recreated = @{ jobId = $status2.activeJobId } }
                    } catch { Write-Log "$mapId : re-resolve also failed, will retry in 30s" }
                }
                if ($recreated) { $jobId = $recreated.jobId; Write-Log "$mapId : now watching job $jobId" }
                continue
            }
            Write-Log "$mapId status=$($job.status) pending=$($job.counts.pending) leased=$($job.counts.leased) complete=$($job.counts.complete) broken=$($job.counts.broken) workers=$($job.workers.Count)"
            if ($job.status -in @("complete", "complete-with-errors")) { break }
        }
        Write-Log "$mapId finished: $($job.status)"
    }

    Write-Log "All queued maps finished."
    Show-Alert "DayZ render pool finished all queued maps (livonia, sakhal).`nLog: $logFile" $false
}
catch {
    Write-Log "Fatal error: $($_.Exception.Message)"
    Show-Alert "DayZ render pool watcher crashed: $($_.Exception.Message)`nSee log: $logFile" $true
    throw
}
finally {
    [PoolPowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Log "Sleep prevention disabled."
}
