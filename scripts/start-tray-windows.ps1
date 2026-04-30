param(
  [string]$ConfigPath = "",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies "System.Windows.Forms", "System.Drawing" -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class BridgeIconNativeMethods {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}

public sealed class BridgeMenuColorTable : ProfessionalColorTable {
  private readonly bool dark;

  public BridgeMenuColorTable(bool darkTheme) {
    dark = darkTheme;
  }

  private Color Bg { get { return dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(250, 250, 250); } }
  private Color Bg2 { get { return dark ? Color.FromArgb(38, 38, 38) : Color.FromArgb(246, 246, 246); } }
  private Color Hover { get { return dark ? Color.FromArgb(55, 55, 55) : Color.FromArgb(230, 240, 255); } }
  private Color Border { get { return dark ? Color.FromArgb(72, 72, 72) : Color.FromArgb(214, 214, 214); } }

  public override Color ToolStripDropDownBackground { get { return Bg; } }
  public override Color ImageMarginGradientBegin { get { return Bg; } }
  public override Color ImageMarginGradientMiddle { get { return Bg; } }
  public override Color ImageMarginGradientEnd { get { return Bg; } }
  public override Color MenuBorder { get { return Border; } }
  public override Color MenuItemBorder { get { return Hover; } }
  public override Color MenuItemSelected { get { return Hover; } }
  public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
  public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
  public override Color MenuStripGradientBegin { get { return Bg; } }
  public override Color MenuStripGradientEnd { get { return Bg2; } }
  public override Color SeparatorDark { get { return Border; } }
  public override Color SeparatorLight { get { return Border; } }
}

public sealed class BridgeMenuRenderer : ToolStripProfessionalRenderer {
  private readonly bool dark;
  private readonly Color textColor;
  private readonly Color selectedTextColor;
  private readonly Color separatorColor;

  public BridgeMenuRenderer(bool darkTheme) : base(new BridgeMenuColorTable(darkTheme)) {
    dark = darkTheme;
    RoundedEdges = true;
    textColor = dark ? Color.FromArgb(242, 242, 242) : Color.FromArgb(32, 32, 32);
    selectedTextColor = dark ? Color.FromArgb(255, 255, 255) : Color.FromArgb(20, 20, 20);
    separatorColor = dark ? Color.FromArgb(78, 78, 78) : Color.FromArgb(220, 220, 220);
  }

  protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
    e.TextColor = e.Item.Selected ? selectedTextColor : textColor;
    base.OnRenderItemText(e);
  }

  protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
    using (Pen pen = new Pen(separatorColor)) {
      int y = e.Item.Height / 2;
      e.Graphics.DrawLine(pen, 8, y, e.Item.Width - 8, y);
    }
  }
}
"@

if ($PSScriptRoot) {
  $scriptDir = $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  $scriptDir = (Get-Location).Path
}
$repoDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))

function Resolve-BridgePath {
  param(
    [string]$Value,
    [string]$BaseDir
  )

  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $Value))
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $repoDir "config.json"
  $ConfigPath = Resolve-BridgePath $ConfigPath $repoDir
} else {
  $ConfigPath = Resolve-BridgePath $ConfigPath (Get-Location).Path
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}

$serverPath = Join-Path $repoDir "server.js"
$iconIcoPath = Join-Path $repoDir "assets\app-icon.ico"
$iconPngPath = Join-Path $repoDir "assets\app-icon.png"
$script:bridgeProcess = $null

function Quote-CommandArg {
  param([string]$Value)
  return "`"$($Value -replace '"', '\"')`""
}

function Get-HealthUrl {
  try {
    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    $hostName = $config.listen.host
    $port = $config.listen.port
    if (-not $hostName -or $hostName -eq "0.0.0.0") {
      $hostName = "127.0.0.1"
    }
    if (-not $port) {
      $port = 8787
    }
    return "http://${hostName}:${port}/health"
  } catch {
    return "http://127.0.0.1:8787/health"
  }
}

function Trim-ReasoningCacheToHalf {
  $trimScriptPath = Join-Path $repoDir "scripts\trim-reasoning-cache.js"
  $arguments = "$(Quote-CommandArg $trimScriptPath) --config $(Quote-CommandArg $ConfigPath) --ratio 0.5"
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = $arguments
  $startInfo.WorkingDirectory = $repoDir
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  while (-not $process.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()

  $result = $null
  if ($stdout.Trim()) {
    try {
      $result = $stdout | ConvertFrom-Json
    } catch {
      throw "Cache trim helper returned invalid output."
    }
  }

  if ($process.ExitCode -ne 0 -or -not $result -or -not $result.ok) {
    $message = if ($result -and $result.message) { $result.message } elseif ($stderr.Trim()) { $stderr.Trim() } else { "Cache trim helper failed." }
    throw $message
  }

  if ($result.message) {
    return $result.message
  }

  return "Cache: $([Math]::Round($result.beforeSizeBytes / 1MB, 2)) MB -> $([Math]::Round($result.afterSizeBytes / 1MB, 2)) MB. Removed $($result.removedEntries) entries."
}

function Start-Bridge {
  if ($script:bridgeProcess -and -not $script:bridgeProcess.HasExited) {
    return
  }

  $arguments = "$(Quote-CommandArg $serverPath) --config $(Quote-CommandArg $ConfigPath)"
  $script:bridgeProcess = Start-Process `
    -FilePath $NodePath `
    -ArgumentList $arguments `
    -WorkingDirectory $repoDir `
    -WindowStyle Hidden `
    -PassThru
}

function Stop-Bridge {
  if ($script:bridgeProcess -and -not $script:bridgeProcess.HasExited) {
    try {
      $shutdownUrl = $healthUrl -replace "/health$", "/shutdown"
      Invoke-WebRequest -Uri $shutdownUrl -Method Post -UseBasicParsing -TimeoutSec 2 | Out-Null
    } catch {
      # Fall back to terminating the child process below.
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds(2000)
    while (-not $script:bridgeProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 50
    }

    if (-not $script:bridgeProcess.HasExited) {
      Stop-Process -Id $script:bridgeProcess.Id -Force
    }
  }
}

function Get-TrayIcon {
  if (Test-Path -LiteralPath $iconIcoPath) {
    return New-Object System.Drawing.Icon($iconIcoPath)
  }

  if (Test-Path -LiteralPath $iconPngPath) {
    $bitmap = New-Object System.Drawing.Bitmap($iconPngPath)
    $handle = $bitmap.GetHicon()
    try {
      return ([System.Drawing.Icon]::FromHandle($handle)).Clone()
    } finally {
      [BridgeIconNativeMethods]::DestroyIcon($handle) | Out-Null
      $bitmap.Dispose()
    }
  }

  return [System.Drawing.SystemIcons]::Application
}

function Test-WindowsLightTheme {
  try {
    $value = Get-ItemPropertyValue `
      -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" `
      -Name "AppsUseLightTheme" `
      -ErrorAction Stop
    return ([int]$value -ne 0)
  } catch {
    return $true
  }
}

function New-MenuFont {
  $preferredFonts = @("Segoe UI Variable Text", "Segoe UI")
  foreach ($fontName in $preferredFonts) {
    $font = New-Object System.Drawing.Font($fontName, 9.5, [System.Drawing.FontStyle]::Regular)
    if ($font.Name -eq $fontName) {
      return $font
    }
    $font.Dispose()
  }

  return New-Object System.Drawing.Font([System.Drawing.SystemFonts]::MenuFont.FontFamily, 9.5)
}

$healthUrl = Get-HealthUrl
$isDarkTheme = -not (Test-WindowsLightTheme)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = Get-TrayIcon
$notifyIcon.Text = "DeepSeek V4 Claude Code Bridge"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Renderer = New-Object BridgeMenuRenderer($isDarkTheme)
$menu.ShowImageMargin = $false
$menu.Font = New-MenuFont
$menu.Padding = New-Object System.Windows.Forms.Padding(4)
if ($isDarkTheme) {
  $menu.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
  $menu.ForeColor = [System.Drawing.Color]::FromArgb(242, 242, 242)
} else {
  $menu.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 250)
  $menu.ForeColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
}

$openHealthItem = $menu.Items.Add("Open health")
$trimCacheItem = $menu.Items.Add("Trim cache to half")
$restartItem = $menu.Items.Add("Restart bridge")
$exitItem = $menu.Items.Add("Exit")

foreach ($item in @($openHealthItem, $trimCacheItem, $restartItem, $exitItem)) {
  $item.AutoSize = $false
  $item.Width = 188
  $item.Height = 30
  $item.Padding = New-Object System.Windows.Forms.Padding(8, 0, 8, 0)
}

$openHealthItem.add_Click({
  Start-Process $healthUrl
})

$trimCacheItem.add_Click({
  try {
    Stop-Bridge
    $message = Trim-ReasoningCacheToHalf
    Start-Bridge
    $notifyIcon.ShowBalloonTip(3000, "DeepSeek V4 Bridge", "$message Bridge restarted.", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    Start-Bridge
    $notifyIcon.ShowBalloonTip(5000, "DeepSeek V4 Bridge", "Cache trim failed: $($_.Exception.Message)", [System.Windows.Forms.ToolTipIcon]::Error)
  }
})

$restartItem.add_Click({
  try {
    Stop-Bridge
    Start-Bridge
    $notifyIcon.ShowBalloonTip(1500, "DeepSeek V4 Bridge", "Bridge restarted.", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $notifyIcon.ShowBalloonTip(3000, "DeepSeek V4 Bridge", $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
  }
})

$exitItem.add_Click({
  Stop-Bridge
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.add_DoubleClick({
  Start-Process $healthUrl
})

$notifyIcon.ContextMenuStrip = $menu

try {
  Start-Bridge
  [System.Windows.Forms.Application]::Run()
} finally {
  Stop-Bridge
  $notifyIcon.Visible = $false
  $notifyIcon.Icon.Dispose()
  $notifyIcon.Dispose()
}
