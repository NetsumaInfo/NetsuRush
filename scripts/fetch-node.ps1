<#
  Récupère un node.exe portable (win-x64) dans src-tauri/resources/bin/ pour le bundle.
  La coquille Tauri release spawn ce node.exe sur core/server.js (le destinataire n'installe pas Node).
  Exécuté par build.ps1 avant `tauri build`. Idempotent.

  VERSION MINIMALE 22.13 : `node:sqlite` n'est utilisable sans le drapeau --experimental-sqlite qu'à
  partir de cette version. En dessous (22.11 par exemple), TOUTES les bases du core — bibliothèque,
  collections, carnet, scripts, board, index de cache — retombaient en silence sur leur repli JSON
  dans l'application packagée, alors que le Node du développeur (plus récent) les servait en SQLite.
#>
param([string]$Version = '22.23.2')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
$binDir = Join-Path $root 'src-tauri\resources\bin'
$dest = Join-Path $binDir 'node.exe'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Vérifie la version, l'architecture ET le module natif que le core exige réellement : un node.exe
# sans `node:sqlite` produit une application qui compile mais dégrade toutes ses bases en JSON.
function Test-NodeBinary([string]$Path) {
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -le 0) { return $false }
  try {
    # Guillemets SIMPLES dans le JS : Windows PowerShell entoure de guillemets doubles tout argument
    # contenant une espace sans échapper ceux qu'il contient → un `require("…")` arriverait tronqué.
    $probe = "let sqlite=false;try{sqlite=!!require('node:sqlite').DatabaseSync}catch{}" +
      "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,sqlite:sqlite}))"
    # --no-warnings : `node:sqlite` émet un ExperimentalWarning sur stderr, que $ErrorActionPreference
    # = 'Stop' transforme en NativeCommandError → le binaire valide serait déclaré cassé.
    $raw = (& $Path --no-warnings -e $probe 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $false }
    $info = $raw | ConvertFrom-Json
    return $info.version -eq "v$Version" -and $info.arch -eq 'x64' -and $info.sqlite
  } catch {
    return $false
  }
}

if (Test-NodeBinary $dest) { Write-Host "node.exe v$Version x64 deja present ($dest)"; exit 0 }
if (Test-Path $dest) { Remove-Item -Force $dest }

$url = "https://nodejs.org/dist/v$Version/win-x64/node.exe"
Write-Host "Telechargement de node.exe v$Version..."
$tmp = "$dest.part"
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  Move-Item -Force $tmp $dest
  if (-not (Test-NodeBinary $dest)) { throw "node.exe telecharge invalide (version $Version x64 attendue)" }
} catch {
  Remove-Item -Force $tmp, $dest -ErrorAction SilentlyContinue
  throw
}
Write-Host "node.exe -> $dest"
