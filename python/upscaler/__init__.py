"""NetsuRush — package d'upscaling vidéo/image Real-ESRGAN (encode GPU + mux audio).

Découpé par responsabilité (le point d'entrée reste python/upscale.py) :
  log       écriture des marqueurs de progression sur stderr (STAGE:*)
  models    registre des modèles, dossier de poids, téléchargement, construction d'arch
  backends  upsamplers (RealESRGANer + SpandrelUpsampler) + cache du worker persistant
  codecs    mapping codec/audio → arguments ffmpeg d'encodage
  media     probe + ouverture des process ffmpeg décode/encode + écriture PNG
  pipeline  boucle streamée décode→enhance→encode (factorisée upscale/gif)
  commands  handlers des 4 commandes (upscale/frame/image/gif) + valeurs par défaut

Pipeline streamé (pas de dump PNG sur disque) :
  ffmpeg décode rawvideo bgr24 -> RealESRGANer.enhance(frame) -> ffmpeg encode (codec choisi)
  + ré-attache l'audio du segment source.

Modèles, tous orientés vidéo :
  anime    realesr-animevideov3   (SRVGGNetCompact 16 conv) — animé/dessin
  general  RealESRGAN_x4plus      (RRDBNet 23 blocs)        — réel, meilleure qualité
  light    realesr-general-x4v3   (SRVGGNetCompact 32 conv) — léger/rapide, denoise (-dn)
  fallin   2x_Fallin_Soft         (CUGAN, via Spandrel)     — anime 2×, anti-artefacts

2 backends : "realesrgan" (RealESRGANer, archs RRDB/SRVGG) et "spandrel" (charge n'importe quel
.pth/.safetensors d'OpenModelDB — CUGAN ici). Même interface .enhance(bgr, outscale).
"""
