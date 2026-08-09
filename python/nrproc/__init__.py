"""NetsuRush — package du hub de traitements vidéo (interpolation / depth / removeBG).

Pendant d'`upscaler` pour les 3 nouveaux modes du hub (le point d'entrée reste
python/process.py). Découpé par responsabilité, chaque module ne possède qu'un sujet :

  media     probe + ouverture des process ffmpeg décode/encode (rawvideo bgr24 / rgba alpha)
            + écriture PNG. Réutilise upscaler.codecs (DRY, pas de redéfinition).
  runner    cache paresseux d'UN modèle en VRAM par (mode, model) — évince au changement de clé
            (borne la VRAM, comme upscaler.backends.get_upsampler). Imports lourds DANS les fonctions.
  interp    cmd_interpolate : RIFE ncnn-vulkan → frames intermédiaires (factor× ou fps cible / slow-mo).
  depth     cmd_depth : transformers depth-estimation → carte de profondeur (gray/colormap).
  seg       cmd_removebg : rembg → sortie alpha (ProRes 4444 / WebM alpha / séquence PNG).
  frame     cmd_frame : aperçu d'UNE frame (orig + traité) pour les 3 modes.

Pipeline streamé (pas de dump PNG sur disque) :
  ffmpeg décode rawvideo bgr24 -> moteur (RIFE / depth / rembg) -> ffmpeg encode (codec/alpha choisi).

Sortie = fichier rendu (importé au Media Pool par le core, JAMAIS via buildTimeline). Tous les
imports lourds (rife_ncnn_vulkan_python, transformers, rembg) sont paresseux : un wheel manquant
renvoie un dict propre {ok:False, error:...} au lieu de casser l'import du package.
"""
