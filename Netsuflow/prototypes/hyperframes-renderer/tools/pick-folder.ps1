# Opens the Windows folder chooser and writes the chosen path to stdout.
#
# Nothing is written when the user cancels, which is how the caller tells the
# two apart: a path or nothing, never an error for a cancel.
#
# Host matters. Measured on this machine: pwsh's FolderBrowserDialog exposes
# AutoUpgradeEnabled, InitialDirectory and ShowPinnedPlaces, which is the modern
# IFileDialog-based chooser; Windows PowerShell 5.1 exposes only Description,
# RootFolder and SelectedPath, which is the old tree. The caller prefers pwsh
# and falls back, so this script has to work under both — every property the
# older host lacks is set behind a capability check rather than assumed.

param(
  [string] $Initial = '',
  [string] $Title = 'Dossier de destination',
  [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog

if ($SelfTest) {
  # Proves the assembly loads, the apartment is STA and the type constructs —
  # the three things that actually fail — without putting a window on screen.
  $dialog.Dispose()
  [Console]::Out.Write('OK')
  exit 0
}

$dialog.Description = $Title
$dialog.ShowNewFolderButton = $true

$has = { param($name) $null -ne $dialog.PSObject.Properties[$name] }
if (& $has 'UseDescriptionForTitle') { $dialog.UseDescriptionForTitle = $true }

if ($Initial -and (Test-Path -LiteralPath $Initial -PathType Container)) {
  $dialog.SelectedPath = $Initial
  if (& $has 'InitialDirectory') { $dialog.InitialDirectory = $Initial }
}

# The service that spawns this has no window of its own, so the chooser can open
# behind everything on the desktop and look like nothing happened. A topmost
# owner form, invisible and never in the taskbar, forces it to the front.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()

try {
  $result = $dialog.ShowDialog($owner)
} finally {
  $owner.Close()
  $owner.Dispose()
}

if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::Out.Write($dialog.SelectedPath)
}
$dialog.Dispose()
exit 0
