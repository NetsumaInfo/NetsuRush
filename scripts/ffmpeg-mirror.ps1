<#
  Builds the ffmpeg archive that NetsuRush mirrors on its own GitHub releases.

  The setup used to pull ffmpeg from gyan.dev, a single host with no CDN: that download alone
  dominated the install time, and the published archive is a moving target that can change major
  version without a line of this repository changing.

  This script turns one upstream build into a pinned release asset:
    * downloads the upstream archive (shared build: ffmpeg.exe and ffprobe.exe stay tiny and share
      their av*.dll, instead of two ~180 MB static binaries),
    * proves the binary carries what the app needs -- the libplacebo filter, without which the
      Turbo upscale engine (core/shaderUpscale.js) has no renderer, and a hardware encoder,
    * keeps ffmpeg, ffprobe and their DLLs, drops the rest (ffplay, docs, presets),
    * repacks as a plain zip, so scripts/setup.ps1 needs no external extractor at all,
    * prints the SHA-256 to pin, and writes it into setup.ps1 with -Apply.

  Redistributing a GPL build makes you the distributor: the matching sources must be available.
  SOURCES.md is written next to the payload with the exact upstream archive, and the ffmpeg source
  tarball is downloaded so it can be attached to the same release.

  Usage: powershell -ExecutionPolicy Bypass -File scripts/ffmpeg-mirror.ps1 -Apply

  NOTE: pure ASCII, like build.ps1 and fetch-mpv.ps1. This script is run by Windows PowerShell 5.1,
  which reads a BOM-less .ps1 as cp1252; an accent would break the parse.
#>
param(
  # Pinned ffmpeg version. Must stay in sync with $FfmpegVersion in scripts/setup.ps1 and with
  # FFMPEG_ACCEPTED_VERSIONS in core/setup.js (test/packaging.test.cjs locks the two together).
  [string]$Version = '9.0',
  # Upstream build to repack. Shared by default; a static build works too, there is simply no DLL.
  [string]$SourceUrl = '',
  [string]$OutDir = '',
  # Write the computed SHA-256 into $FfmpegSha256 in scripts/setup.ps1.
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
if (-not $SourceUrl) { $SourceUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$Version-full_build-shared.7z" }
if (-not $OutDir) { $OutDir = Join-Path $root 'build\ffmpeg-mirror' }

$tag = "ffmpeg-$Version-win64"
$stage = Join-Path $OutDir 'stage'
$payload = Join-Path $OutDir $tag
$zipPath = Join-Path $OutDir "$tag.zip"
$srcUrl = "https://ffmpeg.org/releases/ffmpeg-$Version.tar.xz"
$srcPath = Join-Path $OutDir "ffmpeg-$Version.tar.xz"

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# curl.exe ships in System32 since Windows 10 1803 and saturates the link; Invoke-WebRequest copies
# the stream through managed code and caps at a few MB/s, which is the very problem this fixes.
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
function Fetch([string]$url, [string]$dest) {
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { Write-Host "    already there: $(Split-Path $dest -Leaf)"; return }
  if (Test-Path $curl) {
    & $curl -L --fail --retry 3 --retry-delay 2 --progress-bar -o $dest $url
    if ($LASTEXITCODE -ne 0) { throw "curl $LASTEXITCODE on $url" }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

Remove-Item -Recurse -Force $stage, $payload -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutDir, $stage, $payload | Out-Null

Step 'Downloading the upstream archive'
Write-Host "    $SourceUrl"
$upstream = Join-Path $OutDir (Split-Path $SourceUrl -Leaf)
Fetch $SourceUrl $upstream

Step 'Extracting'
# bsdtar (System32) reads 7z and zip natively through libarchive, so no 7-Zip is needed to BUILD
# the mirror either. The installed setup only ever sees the zip produced below.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $upstream -C $stage
if ($LASTEXITCODE -ne 0) { throw "cannot extract $upstream" }

$bin = Get-ChildItem -Path $stage -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if (-not $bin) { throw "no ffmpeg.exe inside $upstream" }

Step 'Checking the binary'
$reported = (& $bin.FullName -hide_banner -version 2>$null | Select-Object -First 1)
if ($reported -notmatch "ffmpeg version n?$([regex]::Escape($Version))") {
  throw "the binary reports '$reported', not version $Version"
}
# libplacebo is the Turbo engine's renderer: a build without it installs fine and then fails on the
# first upscale, which is exactly the kind of breakage a mirror must not freeze in place.
$filters = & $bin.FullName -hide_banner -filters 2>$null
if (-not ($filters | Select-String -SimpleMatch 'libplacebo' -Quiet)) { throw 'build without libplacebo: the Turbo engine would not run' }
$encoders = & $bin.FullName -hide_banner -encoders 2>$null
if (-not ($encoders | Select-String -Pattern 'h264_nvenc|hevc_nvenc|h264_amf|h264_qsv' -Quiet)) { throw 'build without any hardware encoder' }
Write-Host "    $reported"
Write-Host '    libplacebo: present, hardware encoder: present'

Step 'Building the payload'
$kept = Get-ChildItem -Path $bin.Directory.FullName -File |
  Where-Object { $_.Name -ne 'ffplay.exe' -and ($_.Extension -in @('.exe', '.dll')) }
foreach ($f in $kept) { Copy-Item $f.FullName (Join-Path $payload $f.Name) -Force }
$kept | ForEach-Object { Write-Host ("    {0,-28} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)) }

Step 'Downloading the ffmpeg sources (GPL obligation)'
try { Fetch $srcUrl $srcPath }
catch { Write-Warning "sources not fetched ($($_.Exception.Message)) -- attach them to the release manually" }

@"
# ffmpeg $Version -- corresponding sources

NetsuRush redistributes a GPL build of ffmpeg. This file records where the exact binary comes from.

- Upstream archive repacked here: $SourceUrl
- ffmpeg sources: $srcUrl
- Build recipe: gyan.dev's build scripts, https://github.com/GyanD/codexffmpeg

Only ffmpeg.exe, ffprobe.exe and their shared libraries are kept. Licence: GPL-3.0-or-later; see
docs/licensing.md in the NetsuRush repository.
"@ | Set-Content -Path (Join-Path $payload 'SOURCES.md') -Encoding UTF8

Step 'Compressing'
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
Compress-Archive -Path $payload -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)

if ($Apply) {
  Step 'Pinning into scripts/setup.ps1'
  $setupPath = Join-Path $root 'scripts\setup.ps1'
  $setup = Get-Content -Raw $setupPath
  $patched = [regex]::Replace($setup, "\`$FfmpegSha256 = '[0-9A-Fa-f]*'", "`$FfmpegSha256 = '$hash'")
  if ($patched -eq $setup) { Write-Warning 'no $FfmpegSha256 line replaced -- check setup.ps1' }
  else {
    # UTF8 with BOM on purpose: setup.ps1 is accented and PowerShell 5.1 reads a BOM-less file as
    # cp1252. Set-Content -Encoding UTF8 writes the BOM under 5.1, which is what that file needs.
    Set-Content -Path $setupPath -Value $patched -NoNewline -Encoding UTF8
    Write-Host '    checksum written'
  }
}

Write-Host ''
Write-Host "Archive : $zipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA-256 : $hash" -ForegroundColor Green
Write-Host ''
Write-Host 'Publish (both assets in the SAME release):'
Write-Host "  gh release create $tag `"$zipPath`" `"$srcPath`" --prerelease --title `"ffmpeg $Version (win64)`" --notes `"ffmpeg $Version build redistributed by NetsuRush. SHA-256: $hash`""
if (-not $Apply) { Write-Host 'Then run again with -Apply to pin the checksum into setup.ps1.' }
