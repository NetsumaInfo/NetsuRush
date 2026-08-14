// Niveau de détail des IMAGES du board.
//
// Une planche porte vite trente bannières en pleine définition. Chromium décode chacune en bitmap —
// 1920×1080 = 8 Mo de RAM — alors qu'elle s'affiche sur 140 px de large. Passé quelques centaines de
// mégaoctets, son cache d'images décodées évince, et les images redeviennent BLANCHES jusqu'à ce
// qu'un repaint (un survol, un déplacement) les redécode. Rien n'est perdu : tout est redécodé en
// boucle, et c'est ce qui donne l'impression d'un bug d'affichage sur les grandes sélections.
//
// Tant qu'une image est affichée PETITE, on montre donc la vignette du core : même pipeline et même
// cache disque que le reste de l'app, générée une fois pour toutes. Dès qu'on zoome dessus, retour à
// la source pleine — la vignette ne doit jamais se voir.
//
// La source pleine reste affichée le temps que la vignette arrive : un premier rendu déjà correct
// vaut mieux qu'un carré vide, et une fois l'échange fait Chromium libère le gros bitmap.

import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";
import { displaySrc, type BoardItem } from "./referenceShared";

// La source doit être au moins 2× plus définie que sa taille d'affichage pour que l'échange se voie
// sur la mémoire sans se voir à l'écran.
const LOD_MIN_RATIO = 2;
// Au-delà, l'item n'est plus une vignette sur la planche : la source pleine est justifiée.
const LOD_MAX_W = 640;
// Zoom à partir duquel on repasse partout en pleine définition (on regarde une image de près).
const LOD_ZOOM = 1.6;

// Un média animé garde sa source : une vignette n'est qu'une image fixe, l'animation serait perdue.
const ANIMATED_RE = /\.(gif|webp|avif|apng)(?:$|[?#])/i;

// ref disque → source d'affichage réduite (null = pas de vignette disponible pour cette source).
const resolved = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Cet item gagne-t-il à être affiché en vignette ? Pure et exportée pour être testable. */
export function lodEligible(item: BoardItem): boolean {
  return item.kind === "image"
    && !!item.ref
    && !/^(https?:|data:|blob:)/i.test(item.ref)
    && !ANIMATED_RE.test(item.ref)
    && !item.loading
    && !item.missing
    && item.w > 0
    && item.w <= LOD_MAX_W
    && (item.natW ?? 0) >= item.w * LOD_MIN_RATIO;
}

/** Vignette d'une source disque, mise en cache. Les demandes simultanées partagent le même appel. */
function thumbFor(ref: string): Promise<string | null> {
  const known = resolved.get(ref);
  if (known !== undefined) return Promise.resolve(known);
  const running = inflight.get(ref);
  if (running) return running;
  // `time: 0` = la frame unique d'une image fixe ; priorité basse, la planche est déjà lisible.
  const job = Promise.resolve(nr.thumbnail?.(ref, 0, "low"))
    .then((r) => (typeof r === "string" && r ? displaySrc("image", r) : null))
    .catch(() => null)
    .then((src) => {
      resolved.set(ref, src);
      inflight.delete(ref);
      return src;
    });
  inflight.set(ref, job);
  return job;
}

/**
 * Source à afficher pour cette image, et si c'est la source PLEINE (l'appelant s'en sert pour ne pas
 * confondre l'échec d'une vignette avec un média disparu).
 */
export function useImageLod(item: BoardItem): { src: string; full: boolean } {
  // Sélecteur BOOLÉEN sur le zoom : les items ne se re-rendent qu'au franchissement du seuil, pas à
  // chaque cran de molette (un board de plusieurs centaines d'items ne survivrait pas à l'inverse).
  const zoomedIn = useBoard((s) => s.view.scale >= LOD_ZOOM);
  const wants = !zoomedIn && lodEligible(item);
  const [thumb, setThumb] = useState<string | null>(() => (wants ? resolved.get(item.ref) ?? null : null));

  useEffect(() => {
    if (!wants) return;
    let alive = true;
    void thumbFor(item.ref).then((src) => { if (alive) setThumb(src); });
    return () => { alive = false; };
  }, [wants, item.ref]);

  if (!wants || !thumb) return { src: item.src, full: true };
  return { src: thumb, full: false };
}
