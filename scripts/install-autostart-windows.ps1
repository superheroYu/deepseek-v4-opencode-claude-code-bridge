param(
  [string]$TaskName = "DeepSeekV4OpenCodeClaudeCodeBridge",
  [string]$ConfigPath = "",
  [string]$NodePath = "",
  [ValidateSet("Auto", "ScheduledTask", "StartupShortcut", "StartupTray")]
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
$hiddenLauncherPath = Join-Path $repoDir "scripts\start-hidden-windows.vbs"
$trayLauncherPath = Join-Path $repoDir "scripts\start-tray-windows.ps1"

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

  $targetPath = $shortcutNodePath
  $targetArguments = $arguments

  if ($shortcutNodePath -eq $NodePath) {
    $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
    if (-not (Test-Path -LiteralPath $wscriptPath)) {
      $wscriptCommand = Get-Command wscript.exe -ErrorAction Stop
      $wscriptPath = $wscriptCommand.Source
    }

    $targetPath = $wscriptPath
    $targetArguments = "`"$hiddenLauncherPath`" `"$ConfigPath`" `"$NodePath`""
  }

  $shortcutPath = Join-Path $startupDir "$TaskName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $targetPath
  $shortcut.Arguments = $targetArguments
  $shortcut.WorkingDirectory = $repoDir
  $shortcut.Description = "Start DeepSeek V4 OpenCode Claude Code Bridge."
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  Start-Process `
    -FilePath $targetPath `
    -ArgumentList $targetArguments `
    -WorkingDirectory $repoDir `
    -WindowStyle Hidden

  Write-Host "Installed and started Windows Startup shortcut: $shortcutPath"
  Write-Host "Target: $targetPath"
  Write-Host "Node: $NodePath"
  Write-Host "Config: $ConfigPath"
}

function Install-StartupTrayAutostart {
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    throw "Could not resolve the current user's Startup folder."
  }

  $powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $powershellPath)) {
    $powershellCommand = Get-Command powershell.exe -ErrorAction Stop
    $powershellPath = $powershellCommand.Source
  }

  $shortcutPath = Join-Path $startupDir "$TaskName.lnk"
  $shortcutArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayLauncherPath`" -ConfigPath `"$ConfigPath`" -NodePath `"$NodePath`""
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = $shortcutArguments
  $shortcut.WorkingDirectory = $repoDir
  $shortcut.Description = "Start DeepSeek V4 OpenCode Claude Code Bridge tray launcher."
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  Start-Process `
    -FilePath $powershellPath `
    -ArgumentList $shortcutArguments `
    -WorkingDirectory $repoDir `
    -WindowStyle Hidden

  Write-Host "Installed and started Windows Startup tray shortcut: $shortcutPath"
  Write-Host "Target: $powershellPath"
  Write-Host "Node: $NodePath"
  Write-Host "Config: $ConfigPath"
}

if ($Mode -eq "ScheduledTask") {
  Install-ScheduledTaskAutostart
} elseif ($Mode -eq "StartupShortcut") {
  Install-StartupShortcutAutostart
} elseif ($Mode -eq "StartupTray") {
  Install-StartupTrayAutostart
} else {
  try {
    Install-ScheduledTaskAutostart
  } catch {
    Write-Warning "Scheduled Task autostart failed: $($_.Exception.Message)"
    Write-Warning "Falling back to the current user's Startup folder shortcut."
    Install-StartupShortcutAutostart
  }
}
