param(
  [switch]$Runtime,
  [switch]$UserData
)

$ErrorActionPreference = 'SilentlyContinue'
$localRoot = Join-Path $env:LOCALAPPDATA 'NetsuRush'
$dataRoot = Join-Path $env:USERPROFILE '.netsurush'
$appProfileLocal = Join-Path $env:LOCALAPPDATA 'com.netsurush.app'
$appProfileRoaming = Join-Path $env:APPDATA 'com.netsurush.app'
$cepExtension = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.netsurush.panel'
$configPath = Join-Path $localRoot 'nr.config.json'

function Remove-Tree([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
}

function Remove-File([string]$Path) {
  if ($Path -and (Test-Path -LiteralPath $Path)) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
}

function Remove-CustomCache([string]$Root) {
  if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return }
  try {
    $resolved = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path.TrimEnd('\')
    $blocked = @(
      [IO.Path]::GetPathRoot($resolved).TrimEnd('\'),
      $env:USERPROFILE.TrimEnd('\'),
      $env:LOCALAPPDATA.TrimEnd('\'),
      $env:APPDATA.TrimEnd('\'),
      $env:TEMP.TrimEnd('\')
    )
    if ($blocked -contains $resolved) { return }
    $marker = Join-Path $resolved '.netsurush-cache-root'
    if (-not (Test-Path -LiteralPath $marker)) { return }
    $markedRoot = ([IO.File]::ReadAllText($marker)).Trim().TrimEnd('\')
    if (-not [string]::Equals($markedRoot, $resolved, [StringComparison]::OrdinalIgnoreCase)) { return }
    Remove-Tree (Join-Path $resolved 'thumbs')
    Remove-Tree (Join-Path $resolved 'proxies')
    Remove-File $marker
    Remove-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
  } catch {}
}

$customCache = $null
try {
  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.cache -and $config.cache.dir) { $customCache = [string]$config.cache.dir }
  }
} catch {}

if ($Runtime) {
  Remove-CustomCache $customCache

  foreach ($name in @(
    '.venv', 'runtime', 'weights', 'models', 'realesrgan', 'bin', 'roto-cache'
  )) { Remove-Tree (Join-Path $localRoot $name) }
  foreach ($name in @('nr.config.json', 'export-caps.json')) { Remove-File (Join-Path $localRoot $name) }

  Remove-Tree $appProfileLocal
  Remove-Tree $appProfileRoaming
  Remove-Tree $cepExtension

  foreach ($name in @(
    'netsurush-proxies', 'netsurush-voice', 'netsurush-upscale-test',
    'netsurush-seq-frames', 'netsurush-roto', 'netsurush-pipeline'
  )) { Remove-Tree (Join-Path $env:TEMP $name) }

  foreach ($name in @('thumbs', 'cache', 'realesrgan')) { Remove-Tree (Join-Path $dataRoot $name) }
  # Index FAISS : pur cache (reconstruit a la reindexation) et souvent le plus gros fichier du
  # dossier. Il etait le SEUL a survivre a un nettoyage de caches, faute d'etre dans un sous-dossier.
  Get-ChildItem -LiteralPath $dataRoot -Filter 'faiss_*' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-File $_.FullName }
}

if ($UserData) {
  # $dataRoot emporte aussi la base SQLite. Ce n'est PAS un cache : elle porte le roster de
  # personnages nommes (characters_v1 / character_samples_v1), saisi a la main. La supprimer avec
  # les prerequis detruisait ce travail alors que la case des donnees personnelles etait decochee.
  Remove-Tree $dataRoot
  Remove-Tree (Join-Path $localRoot 'snapshots')
}

if ($Runtime -and $UserData) {
  Remove-Tree $localRoot
} else {
  Remove-Item -LiteralPath $localRoot -Force -ErrorAction SilentlyContinue
}

exit 0
