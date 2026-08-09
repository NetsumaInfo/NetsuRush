# fetch-shaders.ps1 — provisionne les shaders GLSL du moteur d'upscale "Turbo" (ffmpeg libplacebo)
# et les deux modèles ArtCNN R exécutés en ONNX depuis le même sélecteur.
# Tout est sous licence MIT (ArtCNN, Anime4K) → bundlable. Idempotent (re-télécharge sans casser).
# Cible : vendor/shaders/ (dev, gitignored) ou le dossier passé en argument (packaging → resources/shaders).
param([string]$Dest = "$PSScriptRoot/../vendor/shaders")

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$art = "https://raw.githubusercontent.com/Artoriuz/ArtCNN/main/GLSL"
$a4k = "https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl"

function Get-File($url, $out) {
  Write-Host "  $([System.IO.Path]::GetFileName($out))"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

Write-Host "Shaders Turbo → $Dest"
# ArtCNN (anime, CNN GLSL) : deux tailles de réseau × trois entraînements — neutre, DS (débruite et
# accentue), DN (débruite et adoucit). Ce sont les six seuls shaders publiés par le dépôt.
foreach ($net in @("C4F32", "C4F16")) {
  foreach ($suffix in @("", "_DS", "_DN")) {
    $name = "ArtCNN_$net$suffix.glsl"
    Get-File "$art/$name" "$Dest/$name"
  }
}
# ArtCNN R : les poids officiels n'existent qu'en ONNX. Ils sont néanmoins fournis dans le même
# paquet de ressources pour qu'aucun téléchargement manuel/premier usage ne soit nécessaire.
$artRelease = "https://github.com/Artoriuz/ArtCNN/releases/download/v1.6.2"
Get-File "$artRelease/ArtCNN_R16F96.onnx" "$Dest/ArtCNN_R16F96.onnx"
Get-File "$artRelease/ArtCNN_R8F64.onnx"  "$Dest/ArtCNN_R8F64.onnx"

# Anime4K : deux meilleurs presets officiels HQ. FFmpeg libplacebo n'accepte qu'un
# custom_shader_path ; on concatène les passes dans l'ordre exact des presets officiels.
$a4kFiles = @{
  clamp = "Restore/Anime4K_Clamp_Highlights.glsl"
  restoreVl = "Restore/Anime4K_Restore_CNN_VL.glsl"
  restoreM = "Restore/Anime4K_Restore_CNN_M.glsl"
  softVl = "Restore/Anime4K_Restore_CNN_Soft_VL.glsl"
  softM = "Restore/Anime4K_Restore_CNN_Soft_M.glsl"
  upscaleVl = "Upscale/Anime4K_Upscale_CNN_x2_VL.glsl"
  upscaleM = "Upscale/Anime4K_Upscale_CNN_x2_M.glsl"
  down2 = "Upscale/Anime4K_AutoDownscalePre_x2.glsl"
  down4 = "Upscale/Anime4K_AutoDownscalePre_x4.glsl"
}
foreach ($entry in $a4kFiles.GetEnumerator()) {
  Get-File "$a4k/$($entry.Value)" "$Dest/_a4k_$($entry.Key).glsl"
}
$modeAa = @(
  "$Dest/_a4k_clamp.glsl", "$Dest/_a4k_restoreVl.glsl", "$Dest/_a4k_upscaleVl.glsl",
  "$Dest/_a4k_restoreM.glsl", "$Dest/_a4k_down2.glsl", "$Dest/_a4k_down4.glsl",
  "$Dest/_a4k_upscaleM.glsl"
)
$modeBb = @(
  "$Dest/_a4k_clamp.glsl", "$Dest/_a4k_softVl.glsl", "$Dest/_a4k_upscaleVl.glsl",
  "$Dest/_a4k_down2.glsl", "$Dest/_a4k_down4.glsl", "$Dest/_a4k_softM.glsl",
  "$Dest/_a4k_upscaleM.glsl"
)
Get-Content -LiteralPath $modeAa | Set-Content -Encoding UTF8 "$Dest/Anime4K_ModeAA_HQ.glsl"
Get-Content -LiteralPath $modeBb | Set-Content -Encoding UTF8 "$Dest/Anime4K_ModeBB_HQ.glsl"
Remove-Item "$Dest/_a4k_*.glsl" -Force
# Licences (attribution).
Get-File "https://raw.githubusercontent.com/Artoriuz/ArtCNN/main/LICENSE" "$Dest/LICENSE_ArtCNN.txt"
Get-File "https://raw.githubusercontent.com/bloc97/Anime4K/master/LICENSE" "$Dest/LICENSE_Anime4K.txt"
Write-Host "OK — shaders Turbo prêts."
