param(
  [string]$TaskName = "DeepSeekV4OpenCodeClaudeCodeBridge",
  [string]$ConfigPath = "",
  [string]$NodePath = "",
  [ValidateSet("Auto", "ScheduledTask", "StartupShortcut")]
  [string]$Mode = "Auto"
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

$shortcutNodePath = $NodePath
$nodewPath = Join-Path (Split-Path -Parent $NodePath) "nodew.exe"
if (Test-Path -LiteralPath $nodewPath) {
  $shortcutNodePath = $nodewPath
}

$serverPath = Join-Path $repoDir "server.js"
$arguments = "`"$serverPath`" --config `"$ConfigPath`""

function Install-ScheduledTaskAutostart {
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
}

function Install-StartupShortcutAutostart {
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    throw "Could not resolve the current user's Startup folder."
  }

  $shortcutPath = Join-Path $startupDir "$TaskName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $shortcutNodePath
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $repoDir
  $shortcut.Description = "Start DeepSeek V4 OpenCode Claude Code Bridge."
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  Start-Process `
    -FilePath $shortcutNodePath `
    -ArgumentList $arguments `
    -WorkingDirectory $repoDir `
    -WindowStyle Hidden

  Write-Host "Installed and started Windows Startup shortcut: $shortcutPath"
  Write-Host "Node: $shortcutNodePath"
  Write-Host "Config: $ConfigPath"
}

if ($Mode -eq "ScheduledTask") {
  Install-ScheduledTaskAutostart
} elseif ($Mode -eq "StartupShortcut") {
  Install-StartupShortcutAutostart
} else {
  try {
    Install-ScheduledTaskAutostart
  } catch {
    Write-Warning "Scheduled Task autostart failed: $($_.Exception.Message)"
    Write-Warning "Falling back to the current user's Startup folder shortcut."
    Install-StartupShortcutAutostart
  }
}
