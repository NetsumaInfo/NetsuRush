# Signe l'extension CEP NetsuRush (adobe-cep/) en un paquet .zxp distribuable.
# Un ZXP signé s'installe SANS PlayerDebugMode (contrairement à install-cep.ps1 qui pose le
# code non signé + le flag debug). Requiert ZXPSignCmd d'Adobe :
#   https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
#
# Usage :
#   scripts\sign-cep.ps1 -ZxpSignCmd C:\tools\ZXPSignCmd.exe [-Cert cert.p12] [-Password pass]
# Sans -Cert : génère un certificat auto-signé (suffisant pour tester l'install ZXP ; pour
# une distribution publique via Adobe Exchange, utiliser un vrai certificat de code signing).

param(
  [Parameter(Mandatory = $true)][string]$ZxpSignCmd,
  [string]$Cert = "",
  [string]$Password = "netsurush",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "..\adobe-cep"
$dist = Join-Path $PSScriptRoot "..\dist-cep"
if (-not $Out) { $Out = Join-Path $dist "NetsuRush.zxp" }

if (-not (Test-Path $ZxpSignCmd)) { Write-Error "ZXPSignCmd introuvable : $ZxpSignCmd" }
if (-not (Test-Path (Join-Path $src "CSXS\manifest.xml"))) { Write-Error "Source du panneau introuvable : $src" }

New-Item -ItemType Directory -Force -Path $dist | Out-Null

# Certificat auto-signé si aucun fourni.
if (-not $Cert) {
  $Cert = Join-Path $dist "netsurush-selfsigned.p12"
  if (-not (Test-Path $Cert)) {
    Write-Host "Génération d'un certificat auto-signé → $Cert"
    & $ZxpSignCmd -selfSignedCert FR IDF NetsuRush NetsuRush $Password $Cert
    if ($LASTEXITCODE -ne 0) { Write-Error "Échec de la génération du certificat (code $LASTEXITCODE)" }
  }
}

if (Test-Path $Out) { Remove-Item -Force $Out }
Write-Host "Signature de l'extension → $Out"
& $ZxpSignCmd -sign $src $Out $Cert $Password -tsa https://timestamp.digicert.com
if ($LASTEXITCODE -ne 0) { Write-Error "Échec de la signature (code $LASTEXITCODE)" }

Write-Host ""
Write-Host "ZXP signé : $Out"
Write-Host "Installe-le avec Anastasiy's Extension Manager (ZXPInstaller) ou UPIA — pas besoin de PlayerDebugMode."
