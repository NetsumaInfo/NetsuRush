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
//
// DEUX RÈGLES rendent la bascule invisible, et elles comptent autant que le critère lui-même :
//  1. On ne change JAMAIS le `src` d'un <img> à l'écran vers une source non décodée. Chromium vide
//     l'élément à l'instant de l'affectation et ne repeint qu'après décodage : entre les deux, la
//     case est blanche. Multiplié par la planche, c'est un clignotement général à chaque palier.
//     La cible est donc chargée ET décodée hors écran, puis échangée d'un coup.
//  2. Les seuils d'entrée et de sortie diffèrent. Avec un seuil unique, un aller-retour de molette
//     autour de la valeur faisait basculer la planche à chaque cran.

import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";
import { displaySrc, type BoardItem } from "./referenceShared";

// La source doit être BEAUCOUP plus définie que sa taille d'affichage : la vignette ne doit jamais
// s'apercevoir, même en approchant un peu. Marge volontairement large.
const LOD_MIN_RATIO = 4;
// Bande morte du basculement, en hauteur ÉCRAN. On PASSE en vignette sous 180 px : le cran de
// vignette le plus bas fait 360 px de haut (cf. core/thumbPresets.js), elle reste donc
// suréchantillonnée ×2, invisible même sur un écran à forte densité. On n'en SORT qu'au-delà de 360,
// soit une octave pleine de marge — la largeur exacte du pas de zoom quantifié.
const LOD_ENTER_SCREEN_H = 180;
const LOD_LEAVE_SCREEN_H = 360;

// Un média animé garde sa source : une vignette n'est qu'une image fixe, l'animation serait perdue.
const ANIMATED_RE = /\.(gif|webp|avif|apng)(?:$|[?#])/i;

// ref disque → source d'affichage réduite (null = pas de vignette disponible pour cette source).
const resolved = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Cet item doit-il être affiché en vignette, à ce zoom ? Pure et exportée pour être testable.
 * `zoom` est une MAJORATION du zoom réel (cf. `zoomCeil`) : on surestime donc la taille écran, ce qui
 * fait sortir du mode vignette un peu trop tôt plutôt qu'un peu trop tard.
 * `onThumb` = état actuel : il décide lequel des deux seuils s'applique (bande morte).
 */
export function lodEligible(item: BoardItem, zoom: number, onThumb: boolean): boolean {
  const screenW = item.w * zoom;
  return item.kind === "image"
    && !!item.ref
    && !/^(https?:|data:|blob:)/i.test(item.ref)
    && !ANIMATED_RE.test(item.ref)
    && !item.loading
    && !item.missing
    && screenW > 0
    && item.h * zoom <= (onThumb ? LOD_LEAVE_SCREEN_H : LOD_ENTER_SCREEN_H)
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
 * Charge et DÉCODE une source hors écran. Résout `true` quand elle est prête à être peinte, donc
 * échangeable sans frame blanche. `decode()` couvre le chargement ET le décodage : sans lui, une
 * image « chargée » peut encore coûter un décodage au premier paint, ce qu'on cherche justement à
 * sortir du champ.
 */
function preload(src: string): Promise<boolean> {
  const img = new Image();
  img.src = src;
  return (img.decode?.() ?? Promise.resolve()).then(() => { decoded.add(src); return true; }, () => false);
}

// Sources dont le décodage a RÉUSSI dans cette session. L'échec d'une vignette n'est pas rattrapé
// (la récupération d'un média est réservée à la source pleine, sous peine de faire passer un cache
// de vignettes nettoyé pour une planche perdue) : au montage, on ne repart donc sur une vignette que
// si elle a déjà été peinte, sinon une entrée purgée entre-temps laisserait une case cassée à vie.
const decoded = new Set<string>();

/**
 * Source de DÉPART, au montage. Rien n'est encore à l'écran, donc rien à préserver : on prend
 * directement la bonne. Démarrer systématiquement sur la source pleine ferait décoder le gros bitmap
 * pour une seule frame — et le culling remonte les items à chaque dézoom, donc à chaque dézoom.
 */
function firstSrc(item: BoardItem): string {
  const thumb = resolved.get(item.ref);
  return thumb && decoded.has(thumb) && lodEligible(item, zoomCeil(useBoard.getState().view.scale), false)
    ? thumb
    : item.src;
}

/**
 * Source à afficher pour cette image, et si c'est la source PLEINE (l'appelant s'en sert pour ne pas
 * confondre l'échec d'une vignette avec un média disparu).
 */
export function useImageLod(item: BoardItem): { src: string; full: boolean } {
  // Sélecteur quantifié : la valeur ne change qu'une fois par doublement de zoom, donc la planche ne
  // se re-rend pas à chaque cran de molette (plusieurs centaines d'items n'y survivraient pas).
  const zoom = useBoard((s) => zoomCeil(s.view.scale));
  // Source AFFICHÉE, distincte de la source VOULUE : elle ne change qu'une fois la cible décodée.
  const [shown, setShown] = useState(() => firstSrc(item));
  const [thumb, setThumb] = useState<string | null>(() => resolved.get(item.ref) ?? null);

  // L'item a changé de fichier (récupération d'un média, remplacement) : il n'y a plus rien à
  // préserver, et garder l'ancienne image afficherait un AUTRE fichier. Réinitialisation pendant le
  // rendu — React relance aussitôt, sans peindre l'état intermédiaire.
  const [base, setBase] = useState(item.src);
  if (base !== item.src) {
    setBase(item.src);
    setShown(firstSrc(item));
    setThumb(resolved.get(item.ref) ?? null);
  }

  const onThumb = shown !== item.src;
  const wants = lodEligible(item, zoom, onThumb);

  // Résolution de la vignette : elle n'est pas encore affichée pour autant.
  useEffect(() => {
    if (!wants || thumb) return;
    let alive = true;
    void thumbFor(item.ref).then((src) => { if (alive) setThumb(src); });
    return () => { alive = false; };
  }, [wants, thumb, item.ref]);

  const target = wants ? thumb : item.src;
  useEffect(() => {
    if (!target || target === shown) return;
    let alive = true;
    void preload(target).then((ok) => {
      // Une source pleine en échec doit tout de même être affichée : c'est l'`onError` du <img> qui
      // déclenche la récupération du média. Une vignette en échec, elle, est simplement ignorée —
      // garder la source pleine vaut mieux qu'un carré cassé.
      if (alive && (ok || target === item.src)) setShown(target);
    });
    return () => { alive = false; };
  }, [target, shown, item.src]);

  return { src: shown, full: shown === item.src };
}
