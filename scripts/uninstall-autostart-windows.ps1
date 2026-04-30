param(
  [string]$TaskName = "DeepSeekV4OpenCodeClaudeCodeBridge"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed Windows autostart task: $TaskName"
} else {
  Write-Host "Windows autostart task not found: $TaskName"
}

$startupDir = [Environment]::GetFolderPath("Startup")
if ($startupDir) {
  $shortcutPath = Join-Path $startupDir "$TaskName.lnk"
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Removed Windows Startup shortcut: $shortcutPath"
  } else {
    Write-Host "Windows Startup shortcut not found: $shortcutPath"
  }
}

Write-Host "Windows autostart cleanup complete."
