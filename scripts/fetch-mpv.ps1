<#
  Provisionne le runtime du lecteur natif (libmpv + ses DLL soeurs ffmpeg/libplacebo) dans
  vendor/mpv/. build.ps1 recopie ensuite ce dossier vers src-tauri/resources/windows/, ou
  src-tauri/src/player/mpv_ffi.rs va le charger au demarrage.

  Ces 51 Mo de binaires ne sont PAS versionnes : mpv est GPL-2.0-or-later, ffmpeg LGPL/GPL, et
  les embarquer dans un depot AGPL melangeait des licences sans fournir les sources
  correspondantes. Ils sont distribues en asset de release, comme node.exe l'est par nodejs.org.

  Idempotent : ne retelecharge rien si vendor/mpv est deja complet.

  NOTE: ASCII pur, comme build.ps1. Ce script est lance par Windows PowerShell 5.1, qui lit un
  .ps1 sans BOM en cp1252 ; un accent casserait le parse.
#>
param(
  [string]$Dest = "$PSScriptRoot/../vendor/mpv",
  # Asset de release contenant les DLL + leurs licences + les revisions de source exactes.
  # Vide = pas encore publie : le script echoue alors avec la marche a suivre.
  [string]$Url = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Les DLL que le chargeur exige reellement (mpv_ffi.rs + le filtre libplacebo de
# core/shaderUpscale.js). Verifier le dossier entier serait fragile : le nombre de DLL de support
# suit la construction de mpv, pas notre code.
$required = @('libmpv-2.dll', 'libplacebo-360.dll')

# avcodec est verifie par MOTIF, jamais par nom exact : son suffixe porte la version majeure de la
# libavcodec embarquee par mpv (61 = ffmpeg 7.x, 63 = ffmpeg 9.x). Epingler ce numero faisait juger
# le runtime incomplet des qu'un build mpv plus recent arrivait, alors qu'aucune ligne de notre code
# ne nomme ce fichier : c'est libmpv qui le charge. Cette DLL est propre a mpv et n'a aucun rapport
# avec le ffmpeg CLI epingle par setup.ps1 -- les deux evoluent separement.
$requiredPatterns = @('avcodec-*.dll')

function Test-MpvRuntime([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  foreach ($dll in $required) {
    $file = Join-Path $Path $dll
    if (-not (Test-Path $file) -or (Get-Item $file).Length -le 0) { return $false }
  }
  foreach ($pattern in $requiredPatterns) {
    $hit = Get-ChildItem -Path $Path -Filter $pattern -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -gt 0 } | Select-Object -First 1
    if (-not $hit) { return $false }
  }
  return $true
}

if (Test-MpvRuntime $Dest) {
  Write-Host "runtime mpv deja present ($Dest)"
  exit 0
}

if (-not $Url) {
  throw @"
runtime mpv absent de $Dest et aucune URL de telechargement configuree.

Deux facons de le fournir :
  1. Decompresser netsurush-mpv-runtime-<version>.zip dans vendor/mpv/
  2. Relancer avec -Url <adresse de l'asset de release>

Le paquet contient libmpv-2.dll, libplacebo-360.dll et les DLL ffmpeg qui les accompagnent.
Sans lui, l'application se construit mais son lecteur video natif reste indisponible.
"@
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "netsurush-mpv-$(Get-Random).zip"
Write-Host "Telechargement du runtime mpv..."
try {
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  # -Force : une extraction partielle precedente ne doit pas bloquer la reprise.
  Expand-Archive -Path $tmp -DestinationPath $Dest -Force
  if (-not (Test-MpvRuntime $Dest)) {
    throw "archive telechargee incomplete : $($required -join ', ') attendus dans $Dest"
  }
} finally {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "runtime mpv -> $Dest"
