# Installe le panneau CEP NetsuRush (adobe-cep/) pour Premiere Pro / After Effects (2020+).
# - Copie l'extension dans %APPDATA%\Adobe\CEP\extensions\com.netsurush.panel
# - Active PlayerDebugMode (CSXS 9..12) : Adobe charge les extensions non signees (dev/beta)
# Usage : powershell -ExecutionPolicy Bypass -File scripts\install-cep.ps1 [-Remove]
param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$extId = "com.netsurush.panel"
$src = Join-Path $PSScriptRoot "..\adobe-cep"
$dst = Join-Path $env:APPDATA "Adobe\CEP\extensions\$extId"

if ($Remove) {
  if (Test-Path $dst) {
    Remove-Item -Recurse -Force $dst
    Write-Host "Panneau desinstalle : $dst"
  } else {
    Write-Host "Panneau non installe."
  }
  exit 0
}

if (-not (Test-Path (Join-Path $src "CSXS\manifest.xml"))) {
  Write-Error "Source introuvable : $src (lancer depuis le depot NetsuRush)"
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src "*") $dst
# .debug (ports de remote-debug) : Copy-Item * ignore parfois les fichiers caches -> copie explicite
Copy-Item -Force (Join-Path $src ".debug") $dst -ErrorAction SilentlyContinue

foreach ($v in 9, 10, 11, 12, 13, 14) {
  New-Item -Path "HKCU:\Software\Adobe\CSXS.$v" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.$v" -Name "PlayerDebugMode" -Value "1" -Type String
}

Write-Host "Panneau installe : $dst"
Write-Host "Redemarre Premiere Pro / After Effects puis ouvre Fenetre > Extensions > NetsuRush."
