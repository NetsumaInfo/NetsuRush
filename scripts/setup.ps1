<#
  NetsuRush — provisionnement du 1er lancement (Windows).
  Installe dans -Home (écrivable) les dépendances lourdes que l'installeur NSIS ne bundle pas :
    1. un Python de base (système si présent, sinon build standalone téléchargé)
    2. un venv .venv avec torch CUDA / ROCm / XPU ou CPU selon le matériel détecté
    3. ffmpeg GPL (NVENC / AMF / QSV + codecs CPU) téléchargé
    4. uniquement les packs et modèles choisis par l'utilisateur
  puis écrit nr.config.json (chemins absolus) lu par core/config.js.

  Idempotent : chaque étape saute si déjà faite. Réexécutable sans risque.
  Sortie pilotée par marqueurs consommés par core/setup.js :
    STAGE:<id>|<label>   PROGRESS:<0-100>   ERROR:<message>

  Usage : powershell -ExecutionPolicy Bypass -File setup.ps1 -NrHome <dir> -Resource <dir>
#>
# Chemins reçus par variables d'environnement (le quoting d'args Windows de child_process est
# fragile) ; -NrHome/-Resource restent acceptés en secours (exécution manuelle). PAS $Home : c'est
# une variable automatique PowerShell.
param(
  [string]$NrHome = $env:NR_SETUP_HOME,
  [string]$Resource = $env:NR_SETUP_RESOURCE,
  [string]$Lang = $env:NR_SETUP_LANG
)
$Lang = if ($Lang) { ($Lang.ToLower() -split '[-_]')[0] } else { 'fr' }
if ($Lang -notin @('fr', 'en', 'es', 'de', 'ja', 'zh')) { $Lang = 'fr' }

# Profil produit par core/hardware.js. En exécution manuelle ou en cas d'inventaire WMI impossible,
# le CPU est le choix sûr et universel ; aucun runtime constructeur n'est alors supposé.
$HardwareProfile = $null
try { if ($env:NR_SETUP_HARDWARE) { $HardwareProfile = $env:NR_SETUP_HARDWARE | ConvertFrom-Json } } catch {}
$MlBackend = if ($HardwareProfile) { [string]$HardwareProfile.initialMlBackend } else { 'cpu' }
if ($MlBackend -notin @('cuda', 'rocm', 'xpu', 'cpu')) { $MlBackend = 'cpu' }
$OnnxBackend = if ($HardwareProfile) { [string]$HardwareProfile.initialOnnxBackend } else { 'cpu' }
if ($OnnxBackend -notin @('cuda', 'directml', 'cpu')) { $OnnxBackend = 'cpu' }
# Dernière branche `onnxruntime-gpu` bâtie pour CUDA 12 — À MONTER EN MÊME TEMPS que l'index torch
# (`cu124` plus bas) et jamais séparément : une roue CUDA 13 sur un venv cu124 charge un provider qui
# échoue en silence et fait tourner visages/ASR/rembg sur processeur. Verrouillé par packaging.test.cjs.
$OnnxCuda12Pin = 'onnxruntime-gpu==1.20.2'

$SelectedModules = @('derush')
$SelectedModels = @()
try {
  if ($env:NR_SETUP_MODULES) { $SelectedModules = @($env:NR_SETUP_MODULES | ConvertFrom-Json) }
  if ($env:NR_SETUP_MODELS) { $SelectedModels = @($env:NR_SETUP_MODELS | ConvertFrom-Json) }
} catch {}
if ($SelectedModules -notcontains 'derush') { $SelectedModules = @('derush') + $SelectedModules }
function HasModule([string]$id) { return $SelectedModules -contains $id }
function HasModel([string]$id) { return $SelectedModels -contains $id }

$Text = @{
  fr = @{ missingHome='NR_SETUP_HOME manquant'; missingResource='NR_SETUP_RESOURCE manquant'; pythonSearch='Recherche de Python…'; pythonDownload='Téléchargement de Python (autonome)…'; venvCreate='Création de l''environnement Python…'; pipUpdate='Mise à jour de pip…'; torchInstall='Installation de PyTorch CUDA (~2,5 Go)…'; depsInstall='Installation des dépendances ML…'; optionalDeps='Installation des dépendances optionnelles…'; ffmpegDownload='Téléchargement de ffmpeg…'; modelsDownload='Téléchargement des modèles…'; voicePrepare='Préparation des modèles voix…'; resolvePrepare='Configuration du pont DaVinci Resolve…'; processPrepare='Préparation des modèles de traitement…'; facesPrepare='Préparation des modèles de visage…'; rotoPrepare='Préparation du Roto Studio (SAM 2)…'; configWrite='Écriture de la configuration…'; done='Installation terminée'; pythonFailed='Échec de l''installation autonome de Python'; venvFailed='Échec de la création de l''environnement Python'; torchFailed='Échec de l''installation de PyTorch CUDA (consultez le journal pip ci-dessus : réseau/proxy, disque plein ou version de Python sans paquet cu124)'; requirementsFailed='Échec de l''installation des dépendances (consultez le journal pip ci-dessus)'; ffmpegExtract='ffmpeg introuvable après extraction'; ffmpegMissing='ffmpeg n''est pas installé' }
  en = @{ missingHome='NR_SETUP_HOME is missing'; missingResource='NR_SETUP_RESOURCE is missing'; pythonSearch='Looking for Python…'; pythonDownload='Downloading standalone Python…'; venvCreate='Creating the Python environment…'; pipUpdate='Updating pip…'; torchInstall='Installing PyTorch CUDA (~2.5 GB)…'; depsInstall='Installing ML dependencies…'; optionalDeps='Installing optional dependencies…'; ffmpegDownload='Downloading ffmpeg…'; modelsDownload='Downloading models…'; voicePrepare='Preparing voice models…'; resolvePrepare='Configuring the DaVinci Resolve bridge…'; processPrepare='Preparing processing models…'; facesPrepare='Preparing face models…'; rotoPrepare='Preparing Roto Studio (SAM 2)…'; configWrite='Writing configuration…'; done='Installation complete'; pythonFailed='Standalone Python installation failed'; venvFailed='Could not create the Python environment'; torchFailed='PyTorch CUDA installation failed (see the pip log above: network/proxy, full disk, or Python version without a cu124 package)'; requirementsFailed='Dependency installation failed (see the pip log above)'; ffmpegExtract='ffmpeg was not found after extraction'; ffmpegMissing='ffmpeg is not installed' }
  es = @{ missingHome='Falta NR_SETUP_HOME'; missingResource='Falta NR_SETUP_RESOURCE'; pythonSearch='Buscando Python…'; pythonDownload='Descargando Python autónomo…'; venvCreate='Creando el entorno Python…'; pipUpdate='Actualizando pip…'; torchInstall='Instalando PyTorch CUDA (~2,5 GB)…'; depsInstall='Instalando dependencias de ML…'; optionalDeps='Instalando dependencias opcionales…'; ffmpegDownload='Descargando ffmpeg…'; modelsDownload='Descargando modelos…'; voicePrepare='Preparando modelos de voz…'; resolvePrepare='Configurando el puente de DaVinci Resolve…'; processPrepare='Preparando modelos de procesamiento…'; facesPrepare='Preparando modelos de rostro…'; rotoPrepare='Preparando Roto Studio (SAM 2)…'; configWrite='Guardando la configuración…'; done='Instalación completada'; pythonFailed='Falló la instalación autónoma de Python'; venvFailed='No se pudo crear el entorno Python'; torchFailed='Falló la instalación de PyTorch CUDA (consulta el registro de pip: red/proxy, disco lleno o versión de Python sin paquete cu124)'; requirementsFailed='Falló la instalación de dependencias (consulta el registro de pip)'; ffmpegExtract='No se encontró ffmpeg después de extraerlo'; ffmpegMissing='ffmpeg no está instalado' }
  de = @{ missingHome='NR_SETUP_HOME fehlt'; missingResource='NR_SETUP_RESOURCE fehlt'; pythonSearch='Python wird gesucht…'; pythonDownload='Eigenständiges Python wird heruntergeladen…'; venvCreate='Python-Umgebung wird erstellt…'; pipUpdate='pip wird aktualisiert…'; torchInstall='PyTorch CUDA wird installiert (~2,5 GB)…'; depsInstall='ML-Abhängigkeiten werden installiert…'; optionalDeps='Optionale Abhängigkeiten werden installiert…'; ffmpegDownload='ffmpeg wird heruntergeladen…'; modelsDownload='Modelle werden heruntergeladen…'; voicePrepare='Sprachmodelle werden vorbereitet…'; resolvePrepare='DaVinci-Resolve-Brücke wird eingerichtet…'; processPrepare='Verarbeitungsmodelle werden vorbereitet…'; facesPrepare='Gesichtsmodelle werden vorbereitet…'; rotoPrepare='Roto Studio (SAM 2) wird vorbereitet…'; configWrite='Konfiguration wird geschrieben…'; done='Installation abgeschlossen'; pythonFailed='Installation des eigenständigen Python ist fehlgeschlagen'; venvFailed='Python-Umgebung konnte nicht erstellt werden'; torchFailed='Installation von PyTorch CUDA ist fehlgeschlagen (siehe pip-Protokoll oben: Netzwerk/Proxy, voller Datenträger oder Python-Version ohne cu124-Paket)'; requirementsFailed='Installation der Abhängigkeiten ist fehlgeschlagen (siehe pip-Protokoll oben)'; ffmpegExtract='ffmpeg wurde nach dem Entpacken nicht gefunden'; ffmpegMissing='ffmpeg ist nicht installiert' }
  # Base64 keeps CJK text parseable by Windows PowerShell 5.1, which reads BOM-less scripts as ANSI.
  ja = (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('eyJtaXNzaW5nSG9tZSI6Ik5SX1NFVFVQX0hPTUUg44GM44GC44KK44G+44Gb44KTIiwibWlzc2luZ1Jlc291cmNlIjoiTlJfU0VUVVBfUkVTT1VSQ0Ug44GM44GC44KK44G+44Gb44KTIiwicHl0aG9uU2VhcmNoIjoiUHl0aG9uIOOCkuaknOe0ouOBl+OBpuOBhOOBvuOBmeKApiIsInB5dGhvbkRvd25sb2FkIjoi44K544K/44Oz44OJ44Ki44Ot44Oz54mIIFB5dGhvbiDjgpLjg4Djgqbjg7Pjg63jg7zjg4njgZfjgabjgYTjgb7jgZnigKYiLCJ2ZW52Q3JlYXRlIjoiUHl0aG9uIOeSsOWig+OCkuS9nOaIkOOBl+OBpuOBhOOBvuOBmeKApiIsInBpcFVwZGF0ZSI6InBpcCDjgpLmm7TmlrDjgZfjgabjgYTjgb7jgZnigKYiLCJ0b3JjaEluc3RhbGwiOiJQeVRvcmNoIENVREEg44KS44Kk44Oz44K544OI44O844Or44GX44Gm44GE44G+44GZ77yI57SEIDIuNSBHQu+8ieKApiIsImRlcHNJbnN0YWxsIjoiTUwg5L6d5a2Y6Zai5L+C44KS44Kk44Oz44K544OI44O844Or44GX44Gm44GE44G+44GZ4oCmIiwib3B0aW9uYWxEZXBzIjoi44Kq44OX44K344On44Oz44Gu5L6d5a2Y6Zai5L+C44KS44Kk44Oz44K544OI44O844Or44GX44Gm44GE44G+44GZ4oCmIiwiZmZtcGVnRG93bmxvYWQiOiJmZm1wZWcg44KS44OA44Km44Oz44Ot44O844OJ44GX44Gm44GE44G+44GZ4oCmIiwibW9kZWxzRG93bmxvYWQiOiLjg6Ljg4fjg6vjgpLjg4Djgqbjg7Pjg63jg7zjg4njgZfjgabjgYTjgb7jgZnigKYiLCJ2b2ljZVByZXBhcmUiOiLpn7Plo7Djg6Ljg4fjg6vjgpLmupblgpnjgZfjgabjgYTjgb7jgZnigKYiLCJyZXNvbHZlUHJlcGFyZSI6IkRhVmluY2kgUmVzb2x2ZSDjg5bjg6rjg4PjgrjjgpLoqK3lrprjgZfjgabjgYTjgb7jgZnigKYiLCJwcm9jZXNzUHJlcGFyZSI6IuWHpueQhuODouODh+ODq+OCkua6luWCmeOBl+OBpuOBhOOBvuOBmeKApiIsImZhY2VzUHJlcGFyZSI6IumhlOODouODh+ODq+OCkua6luWCmeOBl+OBpuOBhOOBvuOBmeKApiIsInJvdG9QcmVwYXJlIjoiUm90byBTdHVkaW/vvIhTQU0gMu+8ieOCkua6luWCmeOBl+OBpuOBhOOBvuOBmeKApiIsImNvbmZpZ1dyaXRlIjoi6Kit5a6a44KS5pu444GN6L6844KT44Gn44GE44G+44GZ4oCmIiwiZG9uZSI6IuOCpOODs+OCueODiOODvOODq+OBjOWujOS6huOBl+OBvuOBl+OBnyIsInB5dGhvbkZhaWxlZCI6IuOCueOCv+ODs+ODieOCouODreODs+eJiCBQeXRob24g44Gu44Kk44Oz44K544OI44O844Or44Gr5aSx5pWX44GX44G+44GX44GfIiwidmVudkZhaWxlZCI6IlB5dGhvbiDnkrDlooPjgpLkvZzmiJDjgafjgY3jgb7jgZvjgpPjgafjgZfjgZ8iLCJ0b3JjaEZhaWxlZCI6IlB5VG9yY2ggQ1VEQSDjga7jgqTjg7Pjgrnjg4jjg7zjg6vjgavlpLHmlZfjgZfjgb7jgZfjgZ/vvIjkuIroqJjjga4gcGlwIOODreOCsOOCkueiuuiqjeOBl+OBpuOBj+OBoOOBleOBhO+8muODjeODg+ODiOODr+ODvOOCr++8j+ODl+ODreOCreOCt+OAgeODh+OCo+OCueOCr+WuuemHj+S4jei2s+OAgeOBvuOBn+OBryBjdTEyNCDjg5Hjg4PjgrHjg7zjgrjpnZ7lr77lv5zjga4gUHl0aG9uIOODkOODvOOCuOODp+ODs++8iSIsInJlcXVpcmVtZW50c0ZhaWxlZCI6IuS+neWtmOmWouS/guOBruOCpOODs+OCueODiOODvOODq+OBq+WkseaVl+OBl+OBvuOBl+OBn++8iOS4iuiomOOBriBwaXAg44Ot44Kw44KS56K66KqN44GX44Gm44GP44Gg44GV44GE77yJIiwiZmZtcGVnRXh0cmFjdCI6IuWxlemWi+W+jOOBqyBmZm1wZWcg44GM6KaL44Gk44GL44KK44G+44Gb44KTIiwiZmZtcGVnTWlzc2luZyI6ImZmbXBlZyDjgYzjgqTjg7Pjgrnjg4jjg7zjg6vjgZXjgozjgabjgYTjgb7jgZvjgpMifQ=='))))
  zh = (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('eyJtaXNzaW5nSG9tZSI6Iue8uuWwkSBOUl9TRVRVUF9IT01FIiwibWlzc2luZ1Jlc291cmNlIjoi57y65bCRIE5SX1NFVFVQX1JFU09VUkNFIiwicHl0aG9uU2VhcmNoIjoi5q2j5Zyo5p+l5om+IFB5dGhvbuKApiIsInB5dGhvbkRvd25sb2FkIjoi5q2j5Zyo5LiL6L2954us56uL54mIIFB5dGhvbuKApiIsInZlbnZDcmVhdGUiOiLmraPlnKjliJvlu7ogUHl0aG9uIOeOr+Wig+KApiIsInBpcFVwZGF0ZSI6Iuato+WcqOabtOaWsCBwaXDigKYiLCJ0b3JjaEluc3RhbGwiOiLmraPlnKjlronoo4UgUHlUb3JjaCBDVURB77yI57qmIDIuNSBHQu+8ieKApiIsImRlcHNJbnN0YWxsIjoi5q2j5Zyo5a6J6KOF5py65Zmo5a2m5Lmg5L6d6LWW6aG54oCmIiwib3B0aW9uYWxEZXBzIjoi5q2j5Zyo5a6J6KOF5Y+v6YCJ5L6d6LWW6aG54oCmIiwiZmZtcGVnRG93bmxvYWQiOiLmraPlnKjkuIvovb0gZmZtcGVn4oCmIiwibW9kZWxzRG93bmxvYWQiOiLmraPlnKjkuIvovb3mqKHlnovigKYiLCJ2b2ljZVByZXBhcmUiOiLmraPlnKjlh4blpIfor63pn7PmqKHlnovigKYiLCJyZXNvbHZlUHJlcGFyZSI6Iuato+WcqOmFjee9riBEYVZpbmNpIFJlc29sdmUg5qGl5o6l4oCmIiwicHJvY2Vzc1ByZXBhcmUiOiLmraPlnKjlh4blpIflpITnkIbmqKHlnovigKYiLCJmYWNlc1ByZXBhcmUiOiLmraPlnKjlh4blpIfkurrohLjmqKHlnovigKYiLCJyb3RvUHJlcGFyZSI6Iuato+WcqOWHhuWkhyBSb3RvIFN0dWRpb++8iFNBTSAy77yJ4oCmIiwiY29uZmlnV3JpdGUiOiLmraPlnKjlhpnlhaXphY3nva7igKYiLCJkb25lIjoi5a6J6KOF5a6M5oiQIiwicHl0aG9uRmFpbGVkIjoi54us56uL54mIIFB5dGhvbiDlronoo4XlpLHotKUiLCJ2ZW52RmFpbGVkIjoi5peg5rOV5Yib5bu6IFB5dGhvbiDnjq/looMiLCJ0b3JjaEZhaWxlZCI6IlB5VG9yY2ggQ1VEQSDlronoo4XlpLHotKXvvIjor7fmn6XnnIvkuIrmlrkgcGlwIOaXpeW/l++8mue9kee7nC/ku6PnkIbjgIHno4Hnm5jlt7Lmu6HvvIzmiJYgUHl0aG9uIOeJiOacrOayoeaciSBjdTEyNCDova/ku7bljIXvvIkiLCJyZXF1aXJlbWVudHNGYWlsZWQiOiLkvp3otZbpobnlronoo4XlpLHotKXvvIjor7fmn6XnnIvkuIrmlrkgcGlwIOaXpeW/l++8iSIsImZmbXBlZ0V4dHJhY3QiOiLop6PljovlkI7mib7kuI3liLAgZmZtcGVnIiwiZmZtcGVnTWlzc2luZyI6IuWwmuacquWuieijhSBmZm1wZWcifQ=='))))
}
$CpuTorchFailed = @{
  fr = 'Échec de l''installation de PyTorch CPU (consultez le journal pip ci-dessus)'
  en = 'PyTorch CPU installation failed (see the pip log above)'
  es = 'Falló la instalación de PyTorch CPU (consulta el registro de pip)'
  de = 'Installation von PyTorch CPU fehlgeschlagen (siehe pip-Protokoll oben)'
  ja = 'PyTorch CPU installation failed (see the pip log above)'
  zh = 'PyTorch CPU installation failed (see the pip log above)'
}
$TorchBackendText = @{
  fr = @{ cuda='Installation de PyTorch NVIDIA (CUDA)…'; rocm='Installation de PyTorch AMD (ROCm)…'; xpu='Installation de PyTorch Intel (XPU)…'; cpu='Installation de PyTorch CPU…' }
  en = @{ cuda='Installing PyTorch for NVIDIA (CUDA)…'; rocm='Installing PyTorch for AMD (ROCm)…'; xpu='Installing PyTorch for Intel (XPU)…'; cpu='Installing PyTorch for CPU…' }
  es = @{ cuda='Instalando PyTorch para NVIDIA (CUDA)…'; rocm='Instalando PyTorch para AMD (ROCm)…'; xpu='Instalando PyTorch para Intel (XPU)…'; cpu='Instalando PyTorch para CPU…' }
  de = @{ cuda='PyTorch für NVIDIA (CUDA) wird installiert…'; rocm='PyTorch für AMD (ROCm) wird installiert…'; xpu='PyTorch für Intel (XPU) wird installiert…'; cpu='PyTorch für CPU wird installiert…' }
  ja = @{ cuda='Installing PyTorch for NVIDIA (CUDA)…'; rocm='Installing PyTorch for AMD (ROCm)…'; xpu='Installing PyTorch for Intel (XPU)…'; cpu='Installing PyTorch for CPU…' }
  zh = @{ cuda='Installing PyTorch for NVIDIA (CUDA)…'; rocm='Installing PyTorch for AMD (ROCm)…'; xpu='Installing PyTorch for Intel (XPU)…'; cpu='Installing PyTorch for CPU…' }
}
function T([string]$key) {
  $table = $Text[$Lang]
  if ($table -is [hashtable]) { return $table[$key] }
  return $table.PSObject.Properties[$key].Value
}

# Keep every marker UTF-8, including validation errors emitted before setup starts.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $NrHome) { Write-Output "ERROR:$(T 'missingHome')"; exit 1 }
if (-not $Resource) { Write-Output "ERROR:$(T 'missingResource')"; exit 1 }
# Enlève un éventuel préfixe verbatim Windows (\\?\) : Join-Path le rejette (« drive Null »).
$NrHome = $NrHome -replace '^\\\\\?\\', ''
$Resource = $Resource -replace '^\\\\\?\\', ''

# Sortie en UTF-8 : sinon PowerShell émet dans la codepage Windows (cp1252) et node, qui lit en
# UTF-8, affiche du charabia (« CrAcation », « Python�?� »). Force la console + le pipe en UTF-8.
# 'Continue' (pas 'Stop') : une commande NATIVE qui sort un code ≠ 0 (ex. la sonde « import torch »
# avant installation) ne doit PAS lever NativeCommandError. On vérifie nous-mêmes $LASTEXITCODE après
# chaque appel critique ; les cmdlets qui doivent échouer dur portent un -ErrorAction Stop explicite.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'  # masque la barre native d'Invoke-WebRequest (pollue stdout)

function Stage([string]$id, [string]$label) { Write-Output "STAGE:$id|$label" }
function Progress([int]$pct) { Write-Output "PROGRESS:$pct" }
function Info([string]$msg) { Write-Output $msg }
function Fail([string]$msg) { Write-Output "ERROR:$msg"; exit 1 }

# TLS 1.2 explicite : certaines machines testeur ont un .NET par défaut en TLS 1.0/1.1 → github/pytorch
# refusent la poignée de main (« The request was aborted: Could not create SSL/TLS secure channel »).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Téléchargement robuste : saute si la cible existe déjà et n'est pas vide. Retente sur coupure réseau
# (gros fichiers sur le réseau du testeur : reset/timeout fréquents) avec backoff. Reprend le .part.
function Download([string]$url, [string]$dest) {
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { Info "déjà présent: $(Split-Path $dest -Leaf)"; return }
  $dir = Split-Path $dest -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null }
  $tmp = "$dest.part"
  $attempts = 4
  for ($n = 1; $n -le $attempts; $n++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
      Move-Item -Force $tmp $dest -ErrorAction Stop
      return
    } catch {
      Remove-Item -Force $tmp -ErrorAction SilentlyContinue
      if ($n -eq $attempts) { throw }
      Info "téléchargement échoué ($(Split-Path $url -Leaf)), tentative $n/$attempts : $($_.Exception.Message)"
      Start-Sleep -Seconds ($n * 3)
    }
  }
}

# Fournit un fichier : déjà présent → rien ; copie bundlée (resources/vendor) présente → copie (offline) ;
# sinon télécharge. Évite tout aller-réseau quand l'asset est embarqué dans l'installeur.
function Provide([string]$local, [string]$url, [string]$dest) {
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { Info "déjà présent: $(Split-Path $dest -Leaf)"; return }
  if ($local -and (Test-Path $local) -and ((Get-Item $local).Length -gt 0)) {
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -Force $local $dest
    Info "copié (bundle): $(Split-Path $dest -Leaf)"
    return
  }
  Download $url $dest
}

# Extrait une archive 7z. bsdtar (livré dans System32 depuis Windows 10 1803) lit le 7z nativement
# via libarchive : le chercher AVANT 7-Zip supprime toute dépendance externe. L'ancienne version ne
# testait que `Get-Command 7z`, si bien qu'une machine avec 7-Zip installé mais hors PATH sautait
# quand même la voie gyan et retombait sur un build deux majeures en arrière.
# Rend le NOM de l'extracteur qui a réussi, chaîne vide sinon. Surtout : n'appelle PAS Info, car
# `Info` écrit dans le pipeline — son message partirait dans la valeur de retour de la fonction au
# lieu d'atteindre le flux de progression lu par le core. Le compte rendu se fait donc à l'appel.
function Expand-SevenZip([string]$archive, [string]$dest) {
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
  $bsdtar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $bsdtar) {
    & $bsdtar -xf $archive -C $dest 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return 'bsdtar' }
  }
  # 7-Zip n'est PAS toujours dans le PATH : on sonde aussi ses emplacements d'installation standard.
  $candidates = @('7z') + @(
    (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')
  )
  foreach ($exe in $candidates) {
    if ($exe -ne '7z' -and -not (Test-Path $exe)) { continue }
    if ($exe -eq '7z' -and -not (Get-Command 7z -ErrorAction SilentlyContinue)) { continue }
    & $exe x $archive "-o$dest" -y 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return '7-Zip' }
  }
  return ''
}

# Pose un binaire à la place d'un autre. Windows verrouille un exécutable EN COURS d'utilisation :
# jusqu'ici le setup ne faisait que créer un ffmpeg absent, il peut maintenant en REMPLACER un, donc
# ce cas devient atteignable (un encodage en vol pendant une réparation). On écarte alors l'ancien
# fichier sous un autre nom — un exécutable ouvert peut être renommé, pas écrasé — puis on copie.
function Install-Binary([string]$src, [string]$dest) {
  try { Copy-Item $src $dest -Force -ErrorAction Stop; return }
  catch {
    if (-not (Test-Path $dest)) { throw }
    $old = "$dest.old"
    Remove-Item -Force $old -ErrorAction SilentlyContinue
    Move-Item -Force $dest $old -ErrorAction Stop
    Copy-Item $src $dest -Force -ErrorAction Stop
    # Échoue tant que l'ancien processus vit ; le prochain passage du setup le ramassera.
    Remove-Item -Force $old -ErrorAction SilentlyContinue
  }
}

# Version PUBLIÉE annoncée par un binaire ffmpeg (« ffmpeg version 9.0-full_build » → « 9.0 »,
# « ffmpeg version n8.1-… » → « 8.1 »), chaîne vide sinon. Un build git rend « N-125157-g… », qui ne
# porte aucune version stable : il ressort vide et sera donc remplacé. UN SEUL lancement, aucun si le
# binaire est absent. Le résultat se garde dans une variable — le redemander à chaque test relançait
# ffmpeg pour une information déjà connue.
function Get-FfmpegVersion([string]$exe) {
  if (-not (Test-Path $exe)) { return '' }
  try {
    $line = (& $exe -hide_banner -version 2>$null | Select-Object -First 1)
    if ($line -match 'ffmpeg version n?(\d+\.\d+(\.\d+)?)') { return $matches[1] }
    return ''
  } catch { return '' }
}

# Une version convient-elle ? Fonction PURE, aucun lancement. Un correctif de la même mineure (9.0.1
# pour 9.0) est accepté : il ne change ni les options de ligne de commande ni les encodeurs. Règle
# identique à `ffmpegVersionAccepted` dans core/setup.js — analyser PUIS comparer des deux côtés,
# sinon les deux implémentations divergent sur les cas limites.
function Test-FfmpegVersionValue([string]$version, [string[]]$accepted) {
  if (-not $version) { return $false }
  foreach ($v in $accepted) {
    if ($version -eq $v -or $version.StartsWith("$v.")) { return $true }
  }
  return $false
}

$venvDir = Join-Path $NrHome '.venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
$runtime = Join-Path $NrHome 'runtime'
$ffDir = Join-Path $runtime 'ffmpeg'
$ffExe = Join-Path $ffDir 'ffmpeg.exe'
$ffProbe = Join-Path $ffDir 'ffprobe.exe'

# Version ffmpeg ÉPINGLÉE — source unique, lue par le provisionnement ET par test/packaging.test.cjs.
# `ffmpeg-release-full.7z` de gyan est une cible MOUVANTE : elle est passée à 9.0 le 4 août 2026 sans
# qu'une ligne du dépôt ne change, pendant que le repli restait sur 7.1 — deux majeures d'écart entre
# deux machines pour le même commit. Une URL versionnée rend l'installation reproductible et fait
# d'une montée de version une décision, pas un effet de bord.
$FfmpegVersion = '9.0'
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$FfmpegVersion-full_build.7z"
# Repli quand aucun extracteur 7z n'est disponible : BtbN ne publie qu'en zip, et n'a pas encore de
# build 9.0 (seulement master, 7.1 et 8.1). On prend 8.1 — stable, une majeure en arrière — et JAMAIS
# master : ses builds embarquent un libplacebo/Vulkan parfois incapable de s'initialiser, ce qui casse
# le moteur d'upscale Turbo (cf. core/shaderUpscale.js).
$FfmpegFallbackVersion = '8.1'
$FfmpegFallbackUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n$FfmpegFallbackVersion-latest-win64-gpl-$FfmpegFallbackVersion.zip"
# Versions qu'une installation DÉJÀ en place peut garder. Le repli est légitime : sans lui dans cette
# liste, chaque lancement du setup le jugerait périmé et retéléchargerait 160 Mo.
$FfmpegAccepted = @($FfmpegVersion, $FfmpegFallbackVersion)
$weights = Join-Path $NrHome 'weights'
$realdir = Join-Path $weights 'realesrgan'
$omniCkpt = Join-Path $weights 'OmniShotCut_ckpt.pth'
$faceDir = Join-Path $weights 'face'   # recherche visage RÉEL : YuNet + SFace (ONNX opencv_zoo)
$whisperDir = Join-Path $weights 'whisper-large-v3-turbo'   # module voix : ASR « Précis » (CTranslate2)
$parakeetDir = Join-Path $weights 'parakeet-tdt-0.6b-v3'    # module voix : ASR « Rapide » (ONNX)
$pyScripts = Join-Path $Resource 'python'

New-Item -ItemType Directory -Force -Path $NrHome, $runtime, $weights | Out-Null

# Espace disque, AVANT le premier téléchargement : l'environnement Python pèse à lui seul ~2,5 Go
# (PyTorch), les modèles davantage. Un disque plein se manifestait par un échec pip opaque à 80 %
# d'installation, après une heure d'attente. On le dit tout de suite, avec le chiffre.
$MinFreeGb = 3
try {
  $driveRoot = [IO.Path]::GetPathRoot($NrHome)
  $freeGb = [math]::Round((Get-PSDrive -Name $driveRoot.Substring(0, 1) -ErrorAction Stop).Free / 1GB, 1)
  Info "espace libre sur $driveRoot : $freeGb Go"
  if ($freeGb -lt $MinFreeGb) {
    Fail "Espace disque insuffisant sur $driveRoot : $freeGb Go libres, environ $MinFreeGb Go sont nécessaires rien que pour l'environnement Python (les modèles s'ajoutent)."
  }
} catch {
  Info "espace disque non mesurable : $($_.Exception.Message)"
}

# ── 1. Python de base ────────────────────────────────────────────────────────
Stage 'python' (T 'pythonSearch')
Progress 2
$basePy = $null
# UNIQUEMENT 3.10-3.12. ROCm Windows exige précisément Python 3.12.
# Si le testeur n'a que du 3.13 (ou rien), on bascule sur le build standalone 3.12 ci-dessous.
$pythonVersions = if ($MlBackend -eq 'rocm') { @('3.12') } else { @('3.12', '3.11', '3.10') }
foreach ($v in $pythonVersions) {
  try { & py "-$v" --version *> $null; if ($LASTEXITCODE -eq 0) { $basePy = @('py', "-$v"); break } } catch {}
}
if (-not $basePy) {
  # `python` nu : on n'accepte QUE 3.10-3.12 (sinon plusieurs wheels ML sont introuvables).
  try {
    $pv = (& python --version 2>&1) -replace '[^0-9.]', ''
    $pyOk = if ($MlBackend -eq 'rocm') { $pv -match '^3\.12\b' } else { $pv -match '^3\.(10|11|12)\b' }
    if ($LASTEXITCODE -eq 0 -and $pyOk) { $basePy = @('python') }
    elseif ($LASTEXITCODE -eq 0) { Info "python système $pv ignoré (NetsuRush exige 3.10-3.12) → standalone 3.12" }
  } catch {}
}
if (-not $basePy) {
  # Aucun Python système → build standalone autonome (astral python-build-standalone), 3.12 cpython.
  Stage 'python' (T 'pythonDownload')
  $pyHome = Join-Path $runtime 'python'
  $pyExe = Join-Path $pyHome 'python.exe'
  if (-not (Test-Path $pyExe)) {
    $url = 'https://github.com/astral-sh/python-build-standalone/releases/download/20240814/cpython-3.12.5+20240814-x86_64-pc-windows-msvc-install_only.tar.gz'
    $tgz = Join-Path $runtime 'python.tar.gz'
    Download $url $tgz
    Progress 8
    tar -xf $tgz -C $runtime
    Remove-Item -Force $tgz -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $pyExe)) { Fail (T 'pythonFailed') }
  $basePy = @($pyExe)
}
Info "python de base: $($basePy -join ' ')"
Progress 10

# ── 2. venv + torch adapté + requirements ────────────────────────────────────
# Un venv PÉRIMÉ (créé par une install antérieure avec un Python 3.13/3.14) doit être détruit :
# torch cu124 n'a pas de wheel ≥3.13, et basicsr (Real-ESRGAN) casse au build sur 3.13
# (get_version() lit exec()+locals(), comportement changé par PEP 667). On exige 3.10-3.12.
if (Test-Path $venvPy) {
  $venvVer = (& $venvPy --version 2>&1) -replace '[^0-9.]', ''
  $venvOk = if ($MlBackend -eq 'rocm') { $venvVer -match '^3\.12\b' } else { $venvVer -match '^3\.(10|11|12)\b' }
  if (-not $venvOk) {
    Info "venv périmé (Python $venvVer incompatible avec $MlBackend) → recréation"
    Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue
  }
}
if (-not (Test-Path $venvPy)) {
  Stage 'venv' (T 'venvCreate')
  # NE PAS écrire $basePy[1..($basePy.Length-1)] : si $basePy n'a qu'un élément (python standalone
  # ou « python » nu), PowerShell interprète 1..0 comme une plage DESCENDANTE [1,0] → injecte
  # $null + le chemin de l'exe en args → python tente d'exécuter python.exe et lit son en-tête PE.
  $pyArgs = @(if ($basePy.Length -gt 1) { $basePy[1..($basePy.Length - 1)] })
  & $basePy[0] @pyArgs -m venv $venvDir
  if (-not (Test-Path $venvPy)) { Fail (T 'venvFailed') }
}
Progress 14

Stage 'pip' (T 'pipUpdate')
& $venvPy -m pip install --upgrade pip --quiet
Progress 18

# Runtime PyTorch par constructeur, puis SONDE RÉELLE. ROCm Windows = liste AMD officielle seulement
# (décision prise par core/hardware.js) ; XPU = Intel Arc sous Windows 11. Un échec retombe sur CPU.
$installedTorch = ''
try {
  $installedTorch = (& $venvPy -c "import torch; hip=getattr(torch.version,'hip',None); xpu=hasattr(torch,'xpu') and torch.xpu.is_available(); print('rocm' if hip else ('xpu' if xpu else ('cuda' if getattr(torch.version,'cuda',None) else 'cpu')))" 2>$null).Trim()
} catch {}
$needTorch = (-not $installedTorch) -or ($MlBackend -ne 'cpu' -and $installedTorch -ne $MlBackend)
if ($needTorch) {
  $torchLabel = $TorchBackendText[$Lang][$MlBackend]
  Stage 'torch' $torchLabel
  # ~2,5 Go sur le réseau du tester : timeouts/coupures fréquents. On laisse pip retenter (--retries),
  # on allonge le timeout socket, et on CAPTURE la sortie pour la réinjecter dans le journal en cas
  # d'échec (sinon le message « installation de torch CUDA échouée » est opaque pour le debug).
  if ($MlBackend -eq 'rocm') {
    $rocmRoot = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1'
    $torchLog = & $venvPy -m pip install --no-cache-dir `
      "$rocmRoot/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl" `
      "$rocmRoot/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl" `
      "$rocmRoot/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl" `
      "$rocmRoot/rocm-7.2.1.tar.gz" --retries 5 --timeout 120 2>&1
    if ($LASTEXITCODE -eq 0) {
      $torchLog += & $venvPy -m pip install --no-cache-dir `
        "$rocmRoot/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl" `
        "$rocmRoot/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl" `
        "$rocmRoot/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl" --retries 5 --timeout 120 2>&1
    }
  } elseif ($MlBackend -eq 'xpu') {
    $torchLog = & $venvPy -m pip install --upgrade --force-reinstall torch torchvision torchaudio `
      --index-url https://download.pytorch.org/whl/xpu --retries 5 --timeout 120 2>&1
  } else {
    $torchIndex = if ($MlBackend -eq 'cuda') { 'https://download.pytorch.org/whl/cu124' } else { 'https://download.pytorch.org/whl/cpu' }
    $torchLog = & $venvPy -m pip install --upgrade torch torchvision --index-url $torchIndex --retries 5 --timeout 120 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    $torchLog | ForEach-Object { Info "pip torch> $_" }
    if ($MlBackend -ne 'cpu') {
      Info "backend $MlBackend indisponible → installation du repli CPU"
      $MlBackend = 'cpu'
      $torchLog = & $venvPy -m pip install --upgrade --force-reinstall torch torchvision `
        --index-url https://download.pytorch.org/whl/cpu --retries 5 --timeout 120 2>&1
    }
    if ($LASTEXITCODE -ne 0) { $torchLog | ForEach-Object { Info "pip torch cpu> $_" }; Fail $CpuTorchFailed[$Lang] }
  }
}
# Le package installé ne suffit pas : pilote absent ou GPU occupé peut rendre le backend inutilisable.
$actualTorch = (& $venvPy -c "import torch; hip=getattr(torch.version,'hip',None); c=torch.cuda.is_available(); x=hasattr(torch,'xpu') and torch.xpu.is_available(); print('rocm' if c and hip else ('cuda' if c else ('xpu' if x else 'cpu')))" 2>$null).Trim()
if ($actualTorch -notin @('cuda', 'rocm', 'xpu')) { $actualTorch = 'cpu' }
if ($actualTorch -ne $MlBackend) { Info "PyTorch $MlBackend non opérationnel → repli $actualTorch"; $MlBackend = $actualTorch }
# ONNX CUDA n'a de sens que si CUDA NVIDIA a passé la sonde. AMD/Intel conservent DirectML.
if ($OnnxBackend -eq 'cuda' -and $MlBackend -ne 'cuda') { $OnnxBackend = 'cpu' }
Progress 55

$req = Join-Path $pyScripts 'requirements-base.txt'
if (Test-Path $req) {
  Stage 'deps' (T 'depsInstall')
  $reqInstall = $req
  $reqCpu = $null
  if ($MlBackend -ne 'cuda') {
    # Les extras GPU de ces deux paquets installent onnxruntime-gpu/CUDA même sur AMD/Intel. Leur
    # variante CPU conserve la fonctionnalité sans gonfler inutilement le premier téléchargement.
    $reqCpu = Join-Path $env:TEMP "netsurush-requirements-cpu-$PID.txt"
    $reqText = [IO.File]::ReadAllText($req, [Text.Encoding]::UTF8)
    $reqText = $reqText -replace 'onnx-asr\[gpu,hub\]', 'onnx-asr[cpu,hub]'
    $reqText = $reqText -replace 'rembg\[gpu\]', 'rembg[cpu]'
    [IO.File]::WriteAllText($reqCpu, $reqText, [Text.UTF8Encoding]::new($false))
    $reqInstall = $reqCpu
  }
  $depsLog = & $venvPy -m pip install -r $reqInstall --retries 5 --timeout 120 2>&1
  if ($reqCpu) { Remove-Item -Force $reqCpu -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) {
    $depsLog | ForEach-Object { Info "pip deps> $_" }
    Fail (T 'requirementsFailed')
  }
} else { Fail "requirements-base.txt introuvable: $req" }

# TransNetV2 est le moteur de détection obligatoire (et non un modèle optionnel). Une installation
# pip peut toutefois annoncer un succès alors qu'un ancien venv conserve un paquet incomplet ou que
# l'import échoue à cause d'une dépendance binaire. Vérifier l'import réel maintenant : l'utilisateur
# obtient le journal pip ici et le setup reste en échec plutôt que de découvrir l'absence au premier
# clic sur « Détecter ».
$transnetCheck = & $venvPy -c "import transnetv2_pytorch; from transnetv2_pytorch import TransNetV2" 2>&1
if ($LASTEXITCODE -ne 0) {
  $transnetCheck | ForEach-Object { Info "pip transnet> $_" }
  Fail "TransNetV2 absent ou non importable (pip install transnetv2-pytorch a échoué)"
}
Info "TransNetV2 prêt"

$boardReq = Join-Path $pyScripts 'requirements-reference.txt'
if (-not (Test-Path $boardReq)) { Fail "pack NetsuBoard introuvable: $boardReq" }
Stage 'deps' "$(T 'depsInstall') · NetsuBoard"
$boardLog = & $venvPy -m pip install -r $boardReq --retries 5 --timeout 120 2>&1
if ($LASTEXITCODE -ne 0) {
  $boardLog | ForEach-Object { Info "pip NetsuBoard> $_" }
  Fail (T 'requirementsFailed')
}
$boardProbe = & $venvPy -c 'import yt_dlp, gallery_dl, curl_cffi' 2>&1
if ($LASTEXITCODE -ne 0) {
  $boardProbe | ForEach-Object { Info "probe NetsuBoard> $_" }
  Fail "NetsuBoard est installé mais ses outils de liens sont inutilisables"
}

# Packs installés uniquement pour les pages retenues au premier lancement. Les poids restent séparés :
# activer une page ne télécharge jamais automatiquement ses modèles optionnels.
$moduleRequirements = [ordered]@{
  search    = 'requirements-search.txt'
  upscale   = 'requirements-netsulab.txt'
  voice     = 'requirements-voice.txt'
}
foreach ($moduleId in $moduleRequirements.Keys) {
  if (-not (HasModule $moduleId)) { continue }
  $moduleReq = Join-Path $pyScripts $moduleRequirements[$moduleId]
  if (-not (Test-Path $moduleReq)) { Fail "pack de dépendances introuvable: $moduleReq" }
  Stage 'deps' "$(T 'depsInstall') · $moduleId"
  $moduleReqInstall = $moduleReq
  $moduleReqCpu = $null
  if ($MlBackend -ne 'cuda') {
    $moduleReqCpu = Join-Path $env:TEMP "netsurush-$moduleId-requirements-cpu-$PID.txt"
    $moduleReqText = [IO.File]::ReadAllText($moduleReq, [Text.Encoding]::UTF8)
    $moduleReqText = $moduleReqText -replace 'onnx-asr\[gpu,hub\]', 'onnx-asr[cpu,hub]'
    $moduleReqText = $moduleReqText -replace 'rembg\[gpu\]', 'rembg[cpu]'
    [IO.File]::WriteAllText($moduleReqCpu, $moduleReqText, [Text.UTF8Encoding]::new($false))
    $moduleReqInstall = $moduleReqCpu
  }
  $moduleLog = & $venvPy -m pip install -r $moduleReqInstall --retries 5 --timeout 120 2>&1
  if ($moduleReqCpu) { Remove-Item -Force $moduleReqCpu -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) {
    $moduleLog | ForEach-Object { Info "pip $moduleId> $_" }
    Fail (T 'requirementsFailed')
  }
}

# Raccord de la suppression d'objet (Roto Studio) : code stagé, pas un paquet pip. Seul un import
# réel dans le venv packagé valide à la fois le staging ET ses dépendances de base (cv2/numpy).
$seamCheck = & $venvPy -c "import sys; sys.path.insert(0, r'$pyScripts'); import nrroto.harmonize, nrroto.cleanplate, nrroto.video" 2>&1
if ($LASTEXITCODE -ne 0) {
  $seamCheck | ForEach-Object { Info "roto> $_" }
  Fail "Raccord de suppression d'objet non importable (nrroto incomplet ou dépendances manquantes)"
}
Info "Suppression d'objet prête"

# Un SEUL package ONNX Runtime à la fois : CUDA NVIDIA, DirectML AMD/Intel/DirectX 12, ou CPU.
# Les extras requirements installent d'abord une base cohérente ; on normalise ensuite le provider.
if ((HasModule 'voice') -or (HasModule 'upscale')) {
  Stage 'deps' "ONNX Runtime $OnnxBackend"
  & $venvPy -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-directml *> $null
  # La ROUE doit correspondre au CUDA de torch : à partir de 1.23, `onnxruntime-gpu` est bâti pour
  # CUDA 13 et son provider réclame `cublasLt64_13.dll`, introuvable dans un venv torch cu124. Le
  # paquet s'installe quand même, annonce `CUDAExecutionProvider`… et chaque session retombe sur CPU.
  # `$OnnxCuda12Pin` suit donc la dernière branche CUDA 12 tant que torch est en cu124.
  $onnxPackage = if ($OnnxBackend -eq 'cuda') { $OnnxCuda12Pin } elseif ($OnnxBackend -eq 'directml') { 'onnxruntime-directml' } else { 'onnxruntime' }
  $onnxLog = & $venvPy -m pip install $onnxPackage --retries 5 --timeout 120 2>&1
  if ($LASTEXITCODE -ne 0 -and $OnnxBackend -ne 'cpu') {
    $onnxLog | ForEach-Object { Info "pip onnx> $_" }
    Info "ONNX $OnnxBackend indisponible → repli CPU"
    $OnnxBackend = 'cpu'
    $onnxLog = & $venvPy -m pip install onnxruntime --retries 5 --timeout 120 2>&1
  }
  if ($LASTEXITCODE -ne 0) { $onnxLog | ForEach-Object { Info "pip onnx cpu> $_" }; Fail (T 'requirementsFailed') }
  # Le paquet installé ne prouve pas que le provider EXISTE (CUDA/cuDNN absent, roue CPU réinstallée
  # après coup par une dépendance). Sans cette sonde, nr.config.json annonçait « onnx: cuda » alors
  # que le runtime tournait sur CPU : diagnostic trompeur, et les installations suivantes tiraient
  # inutilement les variantes [gpu] des paquets. Même principe que la sonde torch plus haut.
  $wantedProvider = if ($OnnxBackend -eq 'cuda') { 'CUDAExecutionProvider' } elseif ($OnnxBackend -eq 'directml') { 'DmlExecutionProvider' } else { '' }
  if ($wantedProvider) {
    # `get_available_providers()` NE PROUVE RIEN : il énumère ce que la roue prétend savoir faire, pas
    # ce qui se charge. Mesuré : il annonçait `CUDAExecutionProvider` alors que TOUTE session retombait
    # sur CPU (DLL du provider introuvable). Seule une SESSION réelle tranche — sur un graphe minuscule
    # créé à la volée, donc sans dépendre d'un poids téléchargé. `prepare_onnx_dlls` reproduit ici ce
    # que fait le runtime (nrdevice), sinon la sonde échouerait là où l'application, elle, réussit.
    $probe = @'
import sys
sys.path.insert(0, sys.argv[1])
from nrdevice import prepare_onnx_dlls
prepare_onnx_dlls()
import onnxruntime as ort
ort.set_default_logger_severity(3)
# Graphe ONNX minimal (Identity, opset 13) sérialisé en dur : la sonde ne dépend ni d'un poids
# téléchargé ni du paquet `onnx`, absent du venv. Vérifié en session réelle.
m = (b'\x08\x07\x12\x02nr:?\n\x14\n\x01x\x12\x01y\x1a\x02nr"\x08Identity\x12\x01g'
     b'Z\x11\n\x01x\x12\x0c\n\n\x08\x01\x12\x06\n\x04\x08\x01\x10\x00'
     b'b\x11\n\x01y\x12\x0c\n\n\x08\x01\x12\x06\n\x04\x08\x01\x10\x00B\x04\n\x00\x10\r')
print(','.join(ort.InferenceSession(m, providers=[sys.argv[2], 'CPUExecutionProvider']).get_providers()))
'@
    $probeFile = Join-Path $env:TEMP 'nr_onnx_probe.py'
    Set-Content -LiteralPath $probeFile -Value $probe -Encoding UTF8
    $providers = & $venvPy $probeFile $pyScripts $wantedProvider 2>$null
    Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0 -or "$providers" -notmatch $wantedProvider) {
      Info "ONNX $OnnxBackend installé mais $wantedProvider ne se charge pas (session réelle : $providers) -> configuration en CPU"
      $OnnxBackend = 'cpu'
    }
  }
}

# Vérification RÉELLE des packs retenus. « Successfully installed » ne prouve rien : un paquet peut
# rester inimportable (binaire absent, numpy incompatible, deux distributions opencv concurrentes,
# provider ONNX mal apparié). On importe donc ce que chaque module utilisera vraiment — APRÈS la
# normalisation ONNX ci-dessus, sinon `rembg` serait sondé avant d'avoir son runtime définitif.
$packProbes = [ordered]@{
  search    = 'import transformers, sentencepiece, accelerate, faiss'
  upscale   = "import sys; sys.path.insert(0, r'$pyScripts'); from upscaler.backends import _patch_basicsr; _patch_basicsr(); import realesrgan, basicsr, spandrel, rembg"
  voice     = 'import faster_whisper, onnx_asr, silero_vad, soundfile, librosa'
}
foreach ($moduleId in $packProbes.Keys) {
  if (-not (HasModule $moduleId)) { continue }
  $probeLog = & $venvPy -c $packProbes[$moduleId] 2>&1
  if ($LASTEXITCODE -ne 0) {
    $probeLog | ForEach-Object { Info "verif $moduleId> $_" }
    Fail "Le module $moduleId est installé mais inutilisable : un import a échoué (journal ci-dessus)"
  }
  Info "module $moduleId vérifié"
}

# RIFE n'est pas compilé pendant le setup : Paramètres › Modèles installe le wheel Windows officiel
# précompilé et annulable. Cela évite d'exiger CMake, MSVC et le Vulkan SDK chez les testeurs.
Progress 72

# ── 3. ffmpeg GPL (NVENC / AMF / QSV / CPU) ─────────────────────────────────
# On remplace aussi un binaire DÉJÀ posé dont la version n'est plus acceptée : sans cette relecture,
# `Test-Path $ffExe` suffisait à conserver indéfiniment un build hérité (git-master, 7.1) et aucune
# installation existante ne serait jamais montée de version.
$ffCurrent = Get-FfmpegVersion $ffExe
if (-not (Test-FfmpegVersionValue $ffCurrent $FfmpegAccepted)) {
  if ($ffCurrent) { Info "ffmpeg remplacé (version installée: $ffCurrent)" }
  Stage 'ffmpeg' (T 'ffmpegDownload')
  # Dossier de décompression NEUF : les archives se déplient sous un nom qui porte leur version
  # (`ffmpeg-9.0-full_build/`), donc les extractions passées s'accumulaient dans runtime/ et la
  # recherche récursive de ffmpeg.exe pouvait retenir un binaire PÉRIMÉ au lieu du nouveau.
  $stage = Join-Path $runtime 'ffmpeg-stage'
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  $extractor = ''
  $sevenZip = Join-Path $runtime "ffmpeg-$FfmpegVersion.7z"
  try {
    Download $FfmpegUrl $sevenZip
    $extractor = Expand-SevenZip $sevenZip $stage
    if ($extractor) { Info "archive ffmpeg $FfmpegVersion extraite ($extractor)" }
    else { Info 'aucun extracteur 7z utilisable (bsdtar/7-Zip) : repli sur le build zip' }
  } catch {
    Info "build gyan $FfmpegVersion ignoré: $($_.Exception.Message)"
  }
  Remove-Item -Force $sevenZip -ErrorAction SilentlyContinue

  if (-not $extractor) {
    $zip = Join-Path $runtime 'ffmpeg.zip'
    Info "repli sur le build zip $FfmpegFallbackVersion"
    Download $FfmpegFallbackUrl $zip
    Expand-Archive -Path $zip -DestinationPath $stage -Force -ErrorAction Stop
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
  }

  $bin = Get-ChildItem -Path $stage -Recurse -Filter ffmpeg.exe | Select-Object -First 1
  if (-not $bin) { Fail (T 'ffmpegExtract') }
  New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
  Install-Binary $bin.FullName $ffExe
  Install-Binary (Join-Path $bin.Directory.FullName 'ffprobe.exe') $ffProbe
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  # Les extractions des versions antérieures du setup restaient sur le disque (~300 Mo par build).
  Get-ChildItem -Path $runtime -Directory -Filter 'ffmpeg-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

  # Le binaire posé annonce-t-il bien ce qui était visé ? Un repli légitime donne une autre version :
  # on le DIT au lieu d'échouer, sinon une machine sans extracteur 7z ne pourrait plus s'installer.
  # La version relue sert AUSSI à nr.config.json plus bas — d'où une seule lecture réutilisée.
  $ffCurrent = Get-FfmpegVersion $ffExe
  if (Test-FfmpegVersionValue $ffCurrent @($FfmpegVersion)) { Info "ffmpeg $FfmpegVersion installé" }
  else { Info "ffmpeg installé dans une version de repli: $ffCurrent" }
}
if (-not (Test-Path $ffExe)) { Fail (T 'ffmpegMissing') }
Progress 82

# ── 4. Modèles explicitement sélectionnés ────────────────────────────────────
# Les téléchargements génériques sont effectués ensuite par core/setup-models.js. Cette section ne
# garde que les assets vendorés/offline et les chemins historiques lus directement par les sidecars.
if ($SelectedModels.Count -gt 0) { Stage 'weights' (T 'modelsDownload') }
$realBase = 'https://github.com/xinntao/Real-ESRGAN/releases/download'
$realFiles = [ordered]@{
  anime   = @{ file='realesr-animevideov3.pth'; url="$realBase/v0.2.5.0/realesr-animevideov3.pth" }
  light   = @{ file='realesr-general-x4v3.pth'; url="$realBase/v0.2.5.0/realesr-general-x4v3.pth" }
  general = @{ file='RealESRGAN_x4plus.pth'; url="$realBase/v0.1.0/RealESRGAN_x4plus.pth" }
}
$realVendor = Join-Path $Resource 'vendor\weights\realesrgan'
foreach ($modelId in $realFiles.Keys) {
  if (-not (HasModel $modelId)) { continue }
  $asset = $realFiles[$modelId]
  New-Item -ItemType Directory -Force -Path $realdir | Out-Null
  try { Provide (Join-Path $realVendor $asset.file) $asset.url (Join-Path $realdir $asset.file) } catch { Info "modèle ignoré ($modelId): $($_.Exception.Message)" }
}
if (HasModel 'face-real') {
  New-Item -ItemType Directory -Force -Path $faceDir | Out-Null
  $faceFiles = [ordered]@{
    'face_detection_yunet_2023mar.onnx'   = 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'
    'face_recognition_sface_2021dec.onnx' = 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx'
  }
  foreach ($k in $faceFiles.Keys) {
    try { Provide (Join-Path $Resource "vendor\weights\face\$k") $faceFiles[$k] (Join-Path $faceDir $k) } catch { Info "poids visage ignoré ($k): $($_.Exception.Message)" }
  }
}
if (HasModel 'omnishotcut') {
  $omniSrc = Join-Path $Resource 'vendor\weights\OmniShotCut_ckpt.pth'
  if ((Test-Path $omniSrc) -and (-not (Test-Path $omniCkpt))) { Copy-Item $omniSrc $omniCkpt -Force }
  $omniPkg = Join-Path $Resource 'vendor\OmniShotCut'
  & $venvPy -c "import omnishotcut; import decord" *> $null
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-Path (Join-Path $omniPkg 'pyproject.toml'))) {
      Fail "OmniShotCut introuvable dans le bundle : $omniPkg"
    }
    $decordLog = & $venvPy -m pip install decord --retries 5 --timeout 120 2>&1
    if ($LASTEXITCODE -ne 0) {
      $decordLog | ForEach-Object { Info "pip decord> $_" }
      Fail "OmniShotCut incomplet : decord n'est pas installable"
    }
    $omniLog = & $venvPy -m pip install $omniPkg --no-deps --retries 5 --timeout 120 2>&1
    if ($LASTEXITCODE -ne 0) {
      $omniLog | ForEach-Object { Info "pip OmniShotCut> $_" }
      Fail "OmniShotCut absent ou non installable"
    }
  }
  $omniCheck = & $venvPy -c "import omnishotcut; import decord" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $omniCheck | ForEach-Object { Info "pip OmniShotCut> $_" }
    Fail "OmniShotCut absent ou non importable"
  }
  Info "OmniShotCut prêt"
}
Progress 98

# ── 4c. Modèles voix (best-effort) : faster-whisper turbo + Parakeet v3 ONNX + cuDNN 9 ──
if (HasModule 'voice') { Stage 'voice' (T 'voicePrepare') }
if (HasModel 'silero-vad') {
  $sileroLog = & $venvPy -m pip install 'silero-vad>=5.1' --retries 5 --timeout 120 2>&1
  if ($LASTEXITCODE -ne 0) { $sileroLog | ForEach-Object { Info "pip silero> $_" }; Fail (T 'requirementsFailed') }
}
# cuDNN 9 / cuBLAS servent uniquement au chemin NVIDIA. Le moteur CPU de faster-whisper reste
# disponible ailleurs sans télécharger ces bibliothèques massives et inutilisables.
if ((HasModule 'voice') -and $MlBackend -eq 'cuda') {
  try { & $venvPy -m pip install "nvidia-cudnn-cu12>=9,<10" "nvidia-cublas-cu12" --quiet } catch { Info "cuDNN voix ignoré: $($_.Exception.Message)" }
}
# Pré-téléchargement Whisper large-v3-turbo (CTranslate2) → sinon DL au 1er usage.
if ((HasModel 'whisper-turbo') -and (-not (Test-Path (Join-Path $whisperDir 'model.bin')))) {
  try { & $venvPy -c "from faster_whisper import download_model; download_model('large-v3-turbo', output_dir=r'$whisperDir')" } catch { Info "Whisper voix ignoré: $($_.Exception.Message)" }
}
# Pré-téléchargement Parakeet TDT v3 ONNX (onnx-asr pose les .onnx dans le dossier).
if ((HasModel 'parakeet-v3') -and (-not (Test-Path (Join-Path $parakeetDir 'encoder-model.onnx'))) -and -not (Test-Path (Join-Path $parakeetDir 'encoder-model.int8.onnx'))) {
  try { & $venvPy -c "import onnx_asr; onnx_asr.load_model('nemo-parakeet-tdt-0.6b-v3', r'$parakeetDir')" } catch { Info "Parakeet voix ignoré: $($_.Exception.Message)" }
}
# NOVA-VAD : confirmation anti-bruit PAR-DESSUS Silero (ce n'est PAS un segmenteur). Le CODE (dépôt
# MIT vendoré, ~200 Ko : extraction de features + classifieur) est livré dans l'installeur et posé
# AVEC le module voix — pas derrière un modèle à cocher, il est trop petit pour mériter un choix.
# Les POIDS sklearn, eux, n'existent pas publiquement (le dépôt HuggingFace ne contient qu'un README) :
# sans eux la couche s'annonce indisponible et Silero continue seul. Déposer nova_vad_rf.pkl +
# nova_vad_scaler.pkl dans <models> suffit alors à l'activer, sans réinstaller.
$novaDir = Join-Path $NrHome 'vendor\nova-vad'
$novaModels = Join-Path $novaDir 'models'
$novaBundle = Join-Path $Resource 'vendor\nova-vad'
if (HasModule 'voice') {
  if ((Test-Path (Join-Path $novaBundle 'src\classifier.py')) -and (-not (Test-Path (Join-Path $novaDir 'src\classifier.py')))) {
    try { Copy-Item -Recurse -Force $novaBundle $novaDir } catch { Info "NOVA-VAD (bundle) ignoré: $($_.Exception.Message)" }
  }
  # Features NOVA = sklearn (RF+GBT) + joblib ; librosa/soundfile viennent du pack voix.
  try { & $venvPy -m pip install scikit-learn joblib --quiet } catch { Info "NOVA-VAD deps ignorées: $($_.Exception.Message)" }
  if (Test-Path (Join-Path $novaDir 'src\classifier.py')) {
    New-Item -ItemType Directory -Force -Path $novaModels | Out-Null
    if (-not (Test-Path (Join-Path $novaModels 'nova_vad_rf.pkl'))) {
      Info "NOVA-VAD : code installé, poids absents (aucun modèle public) -> Silero seul. Déposez nova_vad_rf.pkl et nova_vad_scaler.pkl dans $novaModels"
    }
  }
}

# ── 4b. Python 3.13 pour le pont Resolve ─────────────────────────────────────
# fusionscript.dll de DaVinci Resolve (21) est une extension C compilée pour l'ABI Python 3.13 →
# le venv ML (souvent 3.10-3.12, contraint par les wheels torch) ne peut PAS l'importer. On dédie
# donc un interpréteur 3.13 au pont (DaVinciResolveScript est du pur Python, aucune dépendance pip).
Stage 'resolvepy' (T 'resolvePrepare')
$resolvePy = $null
# 1) Python 3.13 système (py launcher) si présent.
try { & py -3.13 --version *> $null; if ($LASTEXITCODE -eq 0) { $resolvePy = (& py -3.13 -c "import sys; print(sys.executable)").Trim() } } catch {}
# 2) sinon build standalone 3.13 téléchargé (léger, sans pip deps).
if (-not $resolvePy) {
  $rp313 = Join-Path $runtime 'python313'
  $rpExe = Join-Path $rp313 'python.exe'
  if (-not (Test-Path $rpExe)) {
    try {
      $url313 = 'https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.13.0+20241016-x86_64-pc-windows-msvc-install_only.tar.gz'
      $tgz313 = Join-Path $runtime 'python313.tar.gz'
      Download $url313 $tgz313
      $tmp313 = Join-Path $runtime '_py313tmp'
      if (Test-Path $tmp313) { Remove-Item -Recurse -Force $tmp313 }
      New-Item -ItemType Directory -Force -Path $tmp313 | Out-Null
      tar -xf $tgz313 -C $tmp313
      Move-Item (Join-Path $tmp313 'python') $rp313
      Remove-Item -Recurse -Force $tmp313 -ErrorAction SilentlyContinue
      Remove-Item -Force $tgz313 -ErrorAction SilentlyContinue
    } catch { Info "python 3.13 (Resolve) ignoré: $($_.Exception.Message)" }
  }
  if (Test-Path $rpExe) { $resolvePy = $rpExe }
}
if ($resolvePy) { Info "pont Resolve via: $resolvePy" } else { Info 'aucun Python 3.13 → pont Resolve indisponible (features projet hors ligne)' }
Progress 99

# ── 4d. Modèles traitements vidéo (best-effort) : RIFE (ncnn) + depth (HF) + rembg ──
if (HasModule 'upscale') { Stage 'process' (T 'processPrepare') }
$rembgDir = Join-Path $weights 'rembg'
$procHf   = Join-Path $weights 'proc-hf'
if (HasModule 'upscale') { New-Item -ItemType Directory -Force -Path $rembgDir, $procHf | Out-Null }
# rembg : AUCUN pré-DL de session. Ces poids se téléchargent à la demande depuis Paramètres ›
# Modèles (bouton Télécharger → new_session) ; les pré-poser rendait installés d'office trois
# modèles que l'utilisateur n'a pas choisis. Seul le dossier de cache est provisionné.
# depth : pré-DL Depth-Anything-V2-Small (HF) dans HF_HOME.
if (HasModel 'depth-anything-v2-small') {
  try { $env:HF_HOME = $procHf; & $venvPy -c "from transformers import pipeline; pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Small-hf')" } catch { Info "depth ignoré: $($_.Exception.Message)" }
}
# RIFE : runtime précompilé installé à la demande depuis Paramètres › Modèles.

# ── 4f. Recherche visage ANIMÉ (best-effort) : dghs-imgutils (détection YOLO anime + CCIP) ──
# imgutils exige `opencv-contrib-python` (une 3e dist cv2) et `numpy<2`. Installer normalement
# RÉINSTALLE opencv (échoue avec cv2.pyd verrouillé par un sidecar = WinError 5) ET rétrograde numpy
# pour tout le venv. On installe donc en 2 TEMPS : imgutils SANS ses deps (il n'exige alors ni opencv
# ni numpy<2 ; le cv2 déjà présent suffit à `import cv2`), puis ses deps PURES python (aucun conflit).
if (HasModel 'face-anime') { Stage 'faces' (T 'facesPrepare') }
$imgutilsPkg = if ($MlBackend -eq 'cuda') { 'dghs-imgutils[gpu]' } else { 'dghs-imgutils' }
if (HasModel 'face-anime') {
  try { & $venvPy -m pip install --no-deps $imgutilsPkg --quiet } catch { Info "imgutils ignoré: $($_.Exception.Message)" }
  try {
    & $venvPy -m pip install hbutils hfutils emoji pilmoji shapely pyclipper deprecation bchlib piexif pyrfc6266 urlobject --quiet
  } catch { Info "deps imgutils ignorées: $($_.Exception.Message)" }
}
# Pré-DL des modèles animé dans le cache HF partagé ($procHf, déjà câblé HF_HOME côté core) :
# déclenche les VRAIS téléchargements (détecteur v1.4 's' + CCIP) sur une image factice.
if (HasModel 'face-anime') { try {
  $env:HF_HOME = $procHf
  & $venvPy -c "from PIL import Image; from imgutils.detect import detect_faces; from imgutils.metrics import ccip_extract_feature; img = Image.new('RGB', (64, 64)); detect_faces(img, level='s', version='v1.4'); ccip_extract_feature(img)"
} catch { Info "modèles visage animé ignorés: $($_.Exception.Message)" } }

# ── 4e. Roto Studio : package SAM 2 (segmentation vidéo interactive) ──────────
# Le CODE de SAM 2 (build_sam2_video_predictor + configs Hydra sam2.1) ; les POIDS restent gérés
# par le gestionnaire de modèles in-app (Paramètres › Modèles → NR_HOME/models/segment). Best-effort
# et SANS compilation des kernels CUDA (SAM2_BUILD_CUDA=0 : galère sous Windows, post-proc masque
# retombe sur un chemin CPU, l'inférence GPU marche). Wheel vendoré préféré (offline) sinon git.
if ((HasModel 'sam2.1') -or (HasModel 'sam2.1-large')) { Stage 'roto' (T 'rotoPrepare') }
if ((HasModel 'sam2.1') -or (HasModel 'sam2.1-large')) { & $venvPy -c "import sam2" *> $null }
if (((HasModel 'sam2.1') -or (HasModel 'sam2.1-large')) -and $LASTEXITCODE -ne 0) {
  $env:SAM2_BUILD_CUDA = '0'
  $env:SAM2_BUILD_ALLOW_ERRORS = '1'
  $samVendor = Join-Path $Resource 'vendor\sam2'
  if (Test-Path $samVendor) {
    try { & $venvPy -m pip install $samVendor --no-build-isolation --quiet } catch { Info "SAM 2 (vendor) ignoré: $($_.Exception.Message)" }
  } else {
    # Tarball GitHub officiel (Meta, Apache-2.0) → pas besoin du binaire `git`. URL NUE : la dist
    # s'appelle « SAM-2 », un préfixe `sam2 @` casserait le name-match (retomberait sur un fork PyPI).
    try { & $venvPy -m pip install "https://github.com/facebookresearch/sam2/archive/refs/heads/main.tar.gz" --retries 3 --timeout 180 2>&1 | Out-Null } catch { Info "SAM 2 ignoré: $($_.Exception.Message)" }
  }
  & $venvPy -c "import sam2" *> $null
  if ($LASTEXITCODE -eq 0) { Info 'SAM 2 installé' } else { Info 'SAM 2 indisponible → Roto Studio limité (installer le package sam2 plus tard)' }
} elseif ((HasModel 'sam2.1') -or (HasModel 'sam2.1-large')) { Info 'SAM 2 déjà présent' }

# ── 5. nr.config.json ────────────────────────────────────────────────────────
Stage 'config' (T 'configWrite')
$cfg = [ordered]@{
  python        = $venvPy
  ffmpeg        = $ffExe
  ffprobe       = $ffProbe
  # Version réellement posée. C'est elle qui permet à core/setup.js de juger le runtime au démarrage
  # par une comparaison de chaînes, sans lancer ffmpeg : le contrôle rapide est traversé à CHAQUE
  # lancement, un processus de plus s'y paierait à chaque fois.
  ffmpegVersion = $ffCurrent
  setupRuntimeVersion = 3
  realesganDir  = $realdir
  mlBackend     = $MlBackend
  onnxBackend   = $OnnxBackend
}
if ($HardwareProfile) { $cfg.hardware = $HardwareProfile }
if ($resolvePy) { $cfg.resolvePython = $resolvePy }
if (Test-Path $omniCkpt) { $cfg.omnishotCkpt = $omniCkpt }
# Recherche visage RÉEL : dossier YuNet+SFace si les 2 poids sont là (sinon domaine réel sauté).
if ((Test-Path (Join-Path $faceDir 'face_detection_yunet_2023mar.onnx')) -and (Test-Path (Join-Path $faceDir 'face_recognition_sface_2021dec.onnx'))) { $cfg.faceDir = $faceDir }
# Module voix : chemins offline des modèles ASR si pré-téléchargés (sinon DL au 1er usage).
if (Test-Path (Join-Path $whisperDir 'model.bin')) { $cfg.whisperDir = $whisperDir }
if (Test-Path $parakeetDir) { $cfg.parakeetDir = $parakeetDir }
# Confirmation anti-bruit NOVA-VAD : le chemin est écrit dès que le CODE est posé. vad_nova constate
# lui-même l'absence de poids et rend `available:false` → déposer les .pkl plus tard suffit, alors
# qu'un chemin conditionné aux poids aurait exigé de relancer l'installation.
if (Test-Path (Join-Path $novaDir 'src\classifier.py')) { $cfg.novaDir = $novaDir }
# Module traitements vidéo : caches modèles rembg (removeBG) et HF (depth) si provisionnés.
if (Test-Path $rembgDir) { $cfg.rembgDir = $rembgDir }
if (Test-Path $procHf)   { $cfg.procHfHome = $procHf }
$cfgPath = Join-Path $NrHome 'nr.config.json'
# UTF-8 SANS BOM : Set-Content -Encoding UTF8 (PowerShell 5.1) ajoute un BOM → JSON.parse côté core
# lève sur ce caractère de tête et IGNORE la config (l'app redemandait l'installation à chaque fois).
[System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
Info "config écrite: $cfgPath"
Progress 100
Stage 'done' (T 'done')
exit 0

