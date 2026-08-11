param(
  [ValidateRange(1, 255)]
  [int]$RestartExitCode = 75,
  [ValidateRange(1, 300)]
  [int]$RestartDelaySeconds = 5,
  [ValidateRange(1, 100)]
  [int]$MaxRestarts = 5,
  [ValidateRange(1, 1440)]
  [int]$RestartWindowMinutes = 10
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$restartTimes = [System.Collections.Generic.List[datetime]]::new()
Set-Location -LiteralPath $projectRoot

while ($true) {
  & npm.cmd start
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne $RestartExitCode) {
    Write-Host "Harness exited with code $exitCode; supervisor is stopping."
    exit $exitCode
  }

  $now = Get-Date
  $cutoff = $now.AddMinutes(-$RestartWindowMinutes)
  for ($index = $restartTimes.Count - 1; $index -ge 0; $index -= 1) {
    if ($restartTimes[$index] -lt $cutoff) {
      $restartTimes.RemoveAt($index)
    }
  }
  $restartTimes.Add($now)
  if ($restartTimes.Count -gt $MaxRestarts) {
    Write-Error "Harness requested more than $MaxRestarts restarts in $RestartWindowMinutes minutes; supervisor is stopping."
    exit 1
  }

  Write-Host "Harness requested a supervised restart; relaunching in $RestartDelaySeconds seconds."
  Start-Sleep -Seconds $RestartDelaySeconds
}
