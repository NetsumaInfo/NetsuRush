<#
  Provisionne les ressources ML distribuees avec la release (OmniShotCut, poids et NOVA-VAD).
  Ces fichiers ne sont pas versionnes dans le depot : ils sont fournis comme asset de release
  puis extraits dans vendor/ avant le staging de l'installateur.

  NOTE: ASCII pur, comme les autres scripts de build Windows PowerShell 5.1.
#>
param(
  [string]$Dest = "$PSScriptRoot/../vendor",
  [string]$Url = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-VendorRuntime([string]$Path) {
  $required = @(
    (Join-Path $Path 'OmniShotCut\pyproject.toml'),
    (Join-Path $Path 'weights\OmniShotCut_ckpt.pth'),
    (Join-Path $Path 'weights\realesrgan')
  )
  foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath $item)) { return $false }
  }
  return $true
}

if (Test-VendorRuntime $Dest) {
  Write-Host "ressources ML deja presentes ($Dest)"
  exit 0
}

if (-not $Url) {
  throw @"
ressources ML absentes de $Dest et aucune URL de telechargement configuree.

Relancer avec -Url <adresse de l'asset netsurush-vendor-runtime.zip>.
"@
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "netsurush-vendor-$(Get-Random).zip"
Write-Host 'Telechargement des ressources ML...'
try {
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  Expand-Archive -Path $tmp -DestinationPath $Dest -Force
  if (-not (Test-VendorRuntime $Dest)) {
    throw 'archive telechargee incomplete : OmniShotCut et poids attendus dans vendor'
  }
} finally {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "ressources ML -> $Dest"
