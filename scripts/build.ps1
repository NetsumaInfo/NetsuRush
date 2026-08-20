<#
  Build de l'installeur standalone NetsuRush (.exe NSIS).
  1. type-check + build du renderer (dist/)
  2. recupere node.exe portable (sidecar du core)
  3. stage core/ + python/ + setup.ps1 + vendor/ dans src-tauri/resources/ (bundles en ressources Tauri)
  4. tauri build -> src-tauri/target/release/bundle/nsis/*-setup.exe

  Le destinataire lance l'installeur ; au 1er demarrage l'app provisionne le venv torch
  CUDA + ffmpeg + poids manquants (cf. scripts/setup.ps1) dans %LOCALAPPDATA%\NetsuRush.

  NOTE: ce fichier est ASCII pur a dessein. Il est lance DIRECTEMENT par Windows PowerShell 5.1
  (sans BOM => lecture cp1252) ; tout caractere accentue ou tiret long casserait le parse.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$buildMutex = New-Object System.Threading.Mutex($false, 'Local\NetsuRushBuild')
try { $hasBuildLock = $buildMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $hasBuildLock = $true }
if (-not $hasBuildLock) {
  $buildMutex.Dispose()
  throw 'un autre build NetsuRush est deja en cours'
}

try {
$res = Join-Path $root 'src-tauri\resources'
$stageCore = Join-Path $res 'core'
$stagePy = Join-Path $res 'python'
$stageScripts = Join-Path $res 'scripts'
$stageVendor = Join-Path $res 'vendor'
$stageShaders = Join-Path $res 'shaders'
$stageWindows = Join-Path $res 'windows'
$stageDist = Join-Path $res 'dist'
$stageCep = Join-Path $res 'adobe-cep'
$outDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$artifactFilter = "$($manifest.name)_$($manifest.version)_*-setup.exe"

Write-Host '== 1/5 Verifications (core + i18n) =='
npm run check:core
if ($LASTEXITCODE -ne 0) { throw 'verification core echouee' }
npm run check:i18n
if ($LASTEXITCODE -ne 0) { throw 'verification i18n echouee' }

Write-Host '== 2/5 Renderer (tsc + vite build) =='
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build renderer echoue' }

Write-Host '== 3/5 node.exe (sidecar core) + runtime mpv (lecteur natif) =='
& (Join-Path $PSScriptRoot 'fetch-node.ps1')
if ($LASTEXITCODE -ne 0) { throw 'fetch-node echoue' }
# Runtime du lecteur natif : les DLL ne sont pas versionnees (mpv GPL, ffmpeg LGPL/GPL). Elles
# vivent dans vendor\mpv, que fetch-mpv.ps1 provisionne. Le stage vers resources\windows a lieu
# plus bas, avec les autres ressources.
& (Join-Path $PSScriptRoot 'fetch-mpv.ps1')
if ($LASTEXITCODE -ne 0) { throw 'fetch-mpv echoue' }

Write-Host '== 4/5 Stage des ressources (core/python/scripts/vendor) =='
$required = @(
  'core\server.js',
  'python\requirements.txt',
  'scripts\setup.ps1',
  'scripts\uninstall-cleanup.ps1',
  'adobe-cep\CSXS\manifest.xml',
  'vendor\OmniShotCut\pyproject.toml',
  'vendor\nova-vad\src',
  'vendor\weights\OmniShotCut_ckpt.pth',
  'vendor\weights\realesrgan',
  # vendor\shaders n'est PAS exige : l'etape 4 telecharge les shaders (fetch-shaders.ps1) quand la
  # copie locale manque. L'exiger ici rendait ce repli inatteignable et cassait le build d'un clone
  # neuf, ou vendor/ est absent (gitignore).
  # Lecteur natif (commandes player_* -> src/lib/nativePlayer.ts) : libmpv et ses DLL soeurs sont
  # cherchees dans <install>\resources\windows par src-tauri/src/player/mpv_ffi.rs. Elles ne sont
  # PAS versionnees (licences GPL/LGPL distinctes de celle du projet) : fetch-mpv.ps1 vient de les
  # poser dans vendor\mpv, d'ou l'etape de stage plus bas les recopie.
  'vendor\mpv\libmpv-2.dll',
  'vendor\mpv\libplacebo-360.dll'
)
foreach ($relative in $required) {
  if (-not (Test-Path (Join-Path $root $relative))) {
    throw "ressource obligatoire absente : $relative"
  }
}
foreach ($d in @($stageCore, $stagePy, $stageScripts)) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
# core/ : code CommonJS uniquement (exclut nr.config.json local + caches eventuels).
Copy-Item -Recurse -Force (Join-Path $root 'core\*') $stageCore
Get-ChildItem -Path $stageCore -Recurse -Filter 'nr.config.json' | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $stageCore -Recurse -Directory -Filter '__pycache__' |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# python/ : scripts ML (exclut __pycache__).
Copy-Item -Recurse -Force (Join-Path $root 'python\*') $stagePy
Get-ChildItem -Path $stagePy -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# setup.ps1 : provisionnement 1er lancement. Reecrit en UTF-8 AVEC BOM : Windows PowerShell 5.1
# (celui que le core spawn) lit un .ps1 sans BOM comme cp1252 -> les accents deviennent du charabia.
# Le BOM force la lecture UTF-8. Lecture via .NET pour ne pas dependre de l'ANSI.
$ps1Text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'setup.ps1'), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $stageScripts 'setup.ps1'), $ps1Text, [System.Text.UTF8Encoding]::new($true))
$uninstallText = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'uninstall-cleanup.ps1'), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $stageScripts 'uninstall-cleanup.ps1'), $uninstallText, [System.Text.UTF8Encoding]::new($true))

# vendor/ SELECTIF -> resources/vendor : seules les ressources runtime utiles. setup.ps1 y puise
# OmniShotCut (package + poids ckpt : AUCUN download, source unique) et prefere les poids Real-ESRGAN /
# cascade bundles au telechargement (install offline-first). On EXCLUT mpv/_mpvsrc (lecteur natif
# abandonne, ~335 Mo). NOVA-VAD est petit et utilise par le module voix : il est inclus.
if (Test-Path $stageVendor) { Remove-Item -Recurse -Force $stageVendor }
New-Item -ItemType Directory -Force -Path $stageVendor | Out-Null
# `sam2` est OPTIONNEL : setup.ps1 prefere un paquet LOCAL (installation hors ligne du Roto Studio) et
# retombe sinon sur le tarball GitHub officiel. Le stager quand il existe rend ce chemin atteignable ;
# les trois autres sont deja valides par $required ci-dessus.
foreach ($v in @('OmniShotCut', 'weights', 'nova-vad', 'sam2')) {
  $srcV = Join-Path $root "vendor\$v"
  if (-not (Test-Path $srcV)) { continue }
  Copy-Item -Recurse -Force $srcV (Join-Path $stageVendor $v)
}
# .git / egg-info / build pip locaux des packages : inutiles dans le bundle (pip install -e les
# regenere). Le .git SURTOUT : tauri lit chaque fichier des ressources et bute sur les packs .git
# (verrou / Acces refuse os error 5) en plus de bloater l'installeur de centaines de Mo.
Get-ChildItem -Path $stageVendor -Recurse -Force -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('.git', 'build', 'egg-info', '__pycache__') -or $_.Name -like '*.egg-info' } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# dist/ (renderer builde) -> resources/dist : sert la vue remote du panneau CEP en production
# (core/appstatic.js expose /app quand NR_RESOURCE_DIR/dist/index.html existe).
if (Test-Path $stageDist) { Remove-Item -Recurse -Force $stageDist }
New-Item -ItemType Directory -Force -Path $stageDist | Out-Null
Copy-Item -Recurse -Force (Join-Path $root 'dist\*') $stageDist

# adobe-cep/ -> resources/adobe-cep : source du panneau CEP en bundle (core/adobe.js installPanel
# lit NR_RESOURCE_DIR/adobe-cep quand l'app est packagee ; sans ce stage l'install echoue).
if (Test-Path $stageCep) { Remove-Item -Recurse -Force $stageCep }
New-Item -ItemType Directory -Force -Path $stageCep | Out-Null
Copy-Item -Recurse -Force (Join-Path $root 'adobe-cep\*') $stageCep

# Shaders Turbo (GLSL libplacebo, MIT) -> resources/shaders (lus via NR_RESOURCE_DIR/shaders).
# Prefere la copie locale vendor/shaders (offline garanti) ; sinon telechargement best-effort.
if (Test-Path $stageShaders) { Remove-Item -Recurse -Force $stageShaders }
$localShaders = Join-Path $root 'vendor\shaders'
if (Test-Path $localShaders) {
  New-Item -ItemType Directory -Force -Path $stageShaders | Out-Null
  Copy-Item -Recurse -Force (Join-Path $localShaders '*') $stageShaders
} else {
  try { & (Join-Path $PSScriptRoot 'fetch-shaders.ps1') $stageShaders }
  catch { throw "fetch-shaders echoue : $_" }
}

# Runtime du lecteur natif -> resources\windows (chemin exact ou mpv_ffi.rs charge libmpv-2.dll).
# Source = vendor\mpv, garanti present par fetch-mpv.ps1 a l'etape 3.
if (Test-Path $stageWindows) { Remove-Item -Recurse -Force $stageWindows }
New-Item -ItemType Directory -Force -Path $stageWindows | Out-Null
Copy-Item -Force (Join-Path $root 'vendor\mpv\*.dll') $stageWindows

Write-Host '== 5/5 tauri build (NSIS) =='
# Signature Authenticode. Elle est OPT-IN par NETSURUSH_SIGN_COMMAND et n'est deliberement pas figee
# dans tauri.conf.json : un signCommand permanent ferait echouer tout build sur une machine sans
# outil de signature. Tauri lance la commande sur CHAQUE binaire du paquet, %1 = le fichier a signer.
# Sans signature l'installeur reste diffusable, mais il repart de zero en reputation SmartScreen a
# chaque version et se fait noter beaucoup plus durement par les classifieurs de Defender.
# Details et choix de certificat : docs\code-signing.md
$signConfig = Join-Path $root 'src-tauri\tauri.sign.conf.json'
if (Test-Path $signConfig) { Remove-Item -Force $signConfig }
$tauriArgs = @()
if ($env:NETSURUSH_SIGN_COMMAND) {
  $overlay = @{ bundle = @{ windows = @{ signCommand = $env:NETSURUSH_SIGN_COMMAND } } }
  $json = $overlay | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($signConfig, $json, [System.Text.UTF8Encoding]::new($false))
  $tauriArgs = @('--config', $signConfig)
  Write-Host "  signature Authenticode ACTIVE : $env:NETSURUSH_SIGN_COMMAND"
} else {
  Write-Warning 'NETSURUSH_SIGN_COMMAND absent : installeur NON SIGNE (SmartScreen avertira).'
}
# Supprime seulement l'artefact de la version courante : ainsi un ancien setup ne peut jamais
# transformer un build incomplet en faux succes, tout en preservant les versions precedentes.
if (Test-Path $outDir) {
  Get-ChildItem -Path $outDir -Filter $artifactFilter -File -ErrorAction SilentlyContinue |
    Remove-Item -Force
}
if ($tauriArgs.Count -gt 0) { npm run tauri build -- @tauriArgs } else { npm run tauri build }
if ($LASTEXITCODE -ne 0) { throw 'tauri build echoue' }

$out = Get-ChildItem -Path $outDir -Filter $artifactFilter -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $out -or $out.Length -le 0) { throw "installeur NSIS introuvable ou vide : $artifactFilter" }
Write-Host "`nInstalleur pret : $($out.FullName)" -ForegroundColor Green
} finally {
  $buildMutex.ReleaseMutex()
  $buildMutex.Dispose()
}
