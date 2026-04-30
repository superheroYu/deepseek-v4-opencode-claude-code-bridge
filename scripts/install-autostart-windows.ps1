param(
  [string]$TaskName = "DeepSeekV4OpenCodeClaudeCodeBridge",
  [string]$ConfigPath = "",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $scriptDir "..")).Path

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $repoDir "config.json"
}
$ConfigPath = (Resolve-Path $ConfigPath).Path

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}

$serverPath = Join-Path $repoDir "server.js"
$arguments = "`"$serverPath`" --config `"$ConfigPath`""

$action = New-ScheduledTaskAction `
  -Execute $NodePath `
  -Argument $arguments `
  -WorkingDirectory $repoDir

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Start DeepSeek V4 OpenCode Claude Code Bridge for the current user." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started Windows autostart task: $TaskName"
Write-Host "Node: $NodePath"
Write-Host "Config: $ConfigPath"
