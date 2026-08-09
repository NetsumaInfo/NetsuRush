"""Roto Studio (segmentation interactive multi-objets + export alpha) — package du daemon
`roto.py serve`. Séparé de nrproc/ car la segmentation interactive tient une SESSION persistante
par vidéo : frames extraites, memory bank SAM2 tenue entre les clics. Les libs lourdes (sam2,
torch, PIL) sont importées PARESSEUSEMENT → l'import du package ne casse jamais si un wheel manque.

Modules : session (orchestration/état) · sam_engine (SAM2 : points → masque, propagation) ·
overlay (overlay teinté data-URI + mattes disque) · export_alpha (ffmpeg alphamerge/matte/PNG seq) ·
minimax (suppression d'objet) ·
cleanplate (fond réel récupéré dans les images voisines) · harmonize (raccord couleur/netteté/grain
de la zone reconstruite) · video (writer ffmpeg partagé des deux moteurs de suppression).
Matting fin (MatAnyone) : contrat en place, moteur à venir.

Contrat (JSON-lines, 1 requête/ligne sur stdin, 1 réponse/ligne sur stdout, id repassé) :
  open        {video, in?, out?}                → {ok, frames, w, h, fps}
  addPoint    {frame, x, y, label(0/1), obj}    → {ok, mask}   (overlay data-URI de la frame)
  clearPoints {frame?, obj?}                    → {ok, mask?}  (rejoue les points restants)
  mask        {frame}                           → {ok, mask}   (live ou mattes propagées)
  propagate   {}                                → {ok, frames} (mattes écrites sur disque)
  refine      {engine}                          → {ok}         (matte fin — à venir)
  export      {format, out?}                    → {ok, output} (prores_4444/webm_alpha/matte_mp4/png_seq)
  objectRemove{engine, out?, frame?}            → {ok, output|preview} (inpaint : minimax-remover)
Progression sur stderr (STAGE:*), relayée en SSE roto:progress par le core."""

__all__ = ["session", "sam_engine", "overlay", "export_alpha"]
