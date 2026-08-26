# fetch-shaders.ps1 — provisionne les shaders GLSL du moteur d'upscale "Turbo" (ffmpeg libplacebo)
# et les deux modèles ArtCNN R exécutés en ONNX depuis le même sélecteur.
# Tout est sous licence MIT (ArtCNN) → bundlable. Idempotent (re-télécharge sans casser).
# Cible : vendor/shaders/ (dev, gitignored) ou le dossier passé en argument (packaging → resources/shaders).
param([string]$Dest = "$PSScriptRoot/../vendor/shaders")

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$art = "https://raw.githubusercontent.com/Artoriuz/ArtCNN/main/GLSL"

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

# Licence (attribution).
Get-File "https://raw.githubusercontent.com/Artoriuz/ArtCNN/main/LICENSE" "$Dest/LICENSE_ArtCNN.txt"

# Reliquats d'Anime4K, retiré du produit : un dossier de dev déjà peuplé garderait des .glsl que
# plus rien ne lit, et le paquet les embarquerait avec leur licence.
Get-ChildItem -Path $Dest -Filter "Anime4K_*.glsl" -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item "$Dest/LICENSE_Anime4K.txt" -Force -ErrorAction SilentlyContinue

Write-Host "OK — shaders Turbo prêts."
