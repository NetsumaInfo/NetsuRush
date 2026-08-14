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
//
// Le critère est en pixels ÉCRAN, pas en unités board : c'est la taille affichée qui décide si une
// vignette se voit. Une première version comparait la taille board à un seuil fixe, avec un unique
// palier de zoom global : toute la planche basculait d'un coup au franchissement, trente images se
// redécodaient dans la même frame, et à fort dézoom des items d'un pixel gardaient leur source pleine.

import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";
import { displaySrc, type BoardItem } from "./referenceShared";

// La source doit être BEAUCOUP plus définie que sa taille d'affichage : la vignette ne doit jamais
// s'apercevoir, même en approchant un peu. Marge volontairement large.
const LOD_MIN_RATIO = 4;
// Hauteur écran au-delà de laquelle la source pleine est justifiée. Le cran de vignette le plus bas
// fait 360 px de haut (cf. core/thumbPresets.js) : à 180 px la vignette reste suréchantillonnée ×2,
// donc invisible même sur un écran à forte densité.
const LOD_MAX_SCREEN_H = 180;

// Un média animé garde sa source : une vignette n'est qu'une image fixe, l'animation serait perdue.
const ANIMATED_RE = /\.(gif|webp|avif|apng)(?:$|[?#])/i;

// ref disque → source d'affichage réduite (null = pas de vignette disponible pour cette source).
const resolved = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Cet item gagne-t-il à être affiché en vignette, à ce zoom ? Pure et exportée pour être testable.
 * `zoom` est une MAJORATION du zoom réel (cf. `zoomCeil`) : on surestime donc la taille écran, ce qui
 * fait sortir du mode vignette un peu trop tôt plutôt qu'un peu trop tard.
 */
export function lodEligible(item: BoardItem, zoom: number): boolean {
  const screenW = item.w * zoom;
  return item.kind === "image"
    && !!item.ref
    && !/^(https?:|data:|blob:)/i.test(item.ref)
    && !ANIMATED_RE.test(item.ref)
    && !item.loading
    && !item.missing
    && screenW > 0
    && item.h * zoom <= LOD_MAX_SCREEN_H
    && (item.natW ?? 0) >= screenW * LOD_MIN_RATIO;
}

/**
 * Zoom arrondi à l'OCTAVE supérieure (puissance de 2 ≥ scale). La taille écran entre dans la décision,
 * donc chaque item doit suivre le zoom — et s'abonner à sa valeur exacte re-rendrait toute la planche
 * à chaque cran de molette. L'octave est un entier qui ne change qu'une fois par doublement.
 */
export function zoomCeil(scale: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(scale, 1e-6)));
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
  // Sélecteur quantifié : la valeur ne change qu'une fois par doublement de zoom, donc la planche ne
  // se re-rend pas à chaque cran de molette (plusieurs centaines d'items n'y survivraient pas).
  const zoom = useBoard((s) => zoomCeil(s.view.scale));
  const wants = lodEligible(item, zoom);
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
