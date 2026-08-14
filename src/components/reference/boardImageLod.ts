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

import { useCallback, useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { onThumbsCleared } from "@/lib/thumbCache";
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

// ref disque → source d'affichage réduite. Seuls les SUCCÈS y entrent : un échec ponctuel (timeout
// pendant la tempête d'un premier dézoom) mémorisé désactiverait le LOD de ce média à vie.
const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

// Une purge du cache de vignettes (Paramètres) supprime les fichiers sur disque : sans invalidation,
// `resolved` continuerait de servir des URL mortes — cases cassées jusqu'au redémarrage.
onThumbsCleared(() => { resolved.clear(); decoded.clear(); });

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

// Plafond des demandes de vignettes en vol. Chaque RPC est un fetch sur l'origine du core, que
// Chromium borne à ~6 connexions : sans plafond, le premier dézoom d'une grosse planche empile des
// centaines de fetches et TOUT autre RPC (autosave, proxy, annulation d'encodage) attend derrière.
const THUMB_INFLIGHT_MAX = 4;
let thumbRunning = 0;
const thumbWaiting: (() => void)[] = [];
function thumbGate<T>(job: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => {
    thumbRunning++;
    return job().finally(() => {
      thumbRunning--;
      thumbWaiting.shift()?.();
    });
  };
  if (thumbRunning < THUMB_INFLIGHT_MAX) return run();
  return new Promise<T>((res, rej) => { thumbWaiting.push(() => run().then(res, rej)); });
}

/** Vignette d'une source disque, mise en cache. Les demandes simultanées partagent le même appel. */
function thumbFor(ref: string): Promise<string | null> {
  const known = resolved.get(ref);
  if (known !== undefined) return Promise.resolve(known);
  const running = inflight.get(ref);
  if (running) return running;
  // `time: 0` = la frame unique d'une image fixe ; priorité basse, la planche est déjà lisible.
  const job = thumbGate(() => Promise.resolve(nr.thumbnail?.(ref, 0, "low")))
    .then((r) => (typeof r === "string" && r ? displaySrc("image", r) : null))
    .catch(() => null)
    .then((src) => {
      if (src) resolved.set(ref, src);
      inflight.delete(ref);
      return src;
    });
  inflight.set(ref, job);
  return job;
}

/**
 * Amorce `resolved` en UN RPC pour toutes les images locales d'une scène. Sans lui, chaque session
 * repart de zéro : au premier dézoom, chaque image monte en source PLEINE (le gros bitmap se décode
 * pour quelques frames), puis un RPC par item apprend que la vignette existait déjà sur disque.
 */
export function primeBoardThumbs(refs: string[]): void {
  const wanted = [...new Set(refs)].filter(
    (r) => r && !resolved.has(r) && !inflight.has(r)
      && !/^(https?:|data:|blob:)/i.test(r) && !ANIMATED_RE.test(r),
  );
  if (!wanted.length) return;
  void Promise.resolve(nr.thumbsResolve?.(wanted.map((path) => ({ path, time: 0 }))))
    .then((res) => {
      for (const r of res ?? []) if (r?.file) resolved.set(r.path, displaySrc("image", r.file));
    })
    .catch(() => { /* amorçage best-effort : repli sur le chemin paresseux par item */ });
}

/**
 * Charge et DÉCODE une source hors écran. Résout `true` quand elle est prête à être peinte, donc
 * échangeable sans frame blanche. `decode()` couvre le chargement ET le décodage : sans lui, une
 * image « chargée » peut encore coûter un décodage au premier paint, ce qu'on cherche justement à
 * sortir du champ.
 */
function preload(src: string): Promise<boolean> {
  if (decoded.has(src)) return Promise.resolve(true);
  const img = new Image();
  img.src = src;
  return (img.decode?.() ?? Promise.resolve()).then(() => { decoded.add(src); return true; }, () => false);
}

// Sources dont le décodage a RÉUSSI dans cette session : leur préchargement est gratuit, donc les
// échanges vers elles sont immédiats (un aller-retour de zoom ne redécode pas ce qu'il vient de voir).
const decoded = new Set<string>();

/**
 * Source de DÉPART, au montage. Rien n'est encore à l'écran, donc rien à préserver : on prend
 * directement la bonne — une vignette se peint plus vite qu'une source pleine, et démarrer plein
 * ferait décoder le gros bitmap pour une seule frame, à chaque remontage du culling.
 *
 * Jugé au seuil de SORTIE (`onThumb`) : le culling remonte les items en plein pan/zoom, et juger un
 * remontage au seuil d'entrée reconvertissait silencieusement toute la bande morte (180–360 px
 * écran) en sources pleines. Une vignette morte (cache purgé sur disque) n'est pas un risque : son
 * erreur de chargement retombe sur la source pleine (cf. `onError` du hook).
 */
function firstSrc(item: BoardItem): string {
  const thumb = resolved.get(item.ref);
  return thumb && lodEligible(item, zoomCeil(useBoard.getState().view.scale), true)
    ? thumb
    : item.src;
}

/**
 * Source à afficher pour cette image, et si c'est la source PLEINE (l'appelant s'en sert pour ne pas
 * confondre l'échec d'une vignette avec un média disparu). `onError` : à brancher sur l'erreur du
 * <img> — une vignette morte (fichier purgé sur disque) retombe sur la source pleine et sort des
 * caches ; renvoie false quand l'échec concerne la source pleine, que l'appelant doit traiter
 * (récupération de média).
 */
export function useImageLod(item: BoardItem): { src: string; full: boolean; onError: () => boolean } {
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

  // Vignette en erreur au chargement (cache disque purgé entre-temps) : repli immédiat sur la
  // source pleine et oubli de l'entrée morte — jamais de case cassée qui attend un rezoom.
  const onError = useCallback(() => {
    if (shown === item.src) return false;
    resolved.delete(item.ref);
    decoded.delete(shown);
    setThumb(null);
    setShown(item.src);
    return true;
  }, [shown, item.src, item.ref]);

  return { src: shown, full: shown === item.src, onError };
}
