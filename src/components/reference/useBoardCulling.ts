// Culling du board (virtualisation SPATIALE) : ne monte que les items dont la bbox croise le viewport
// élargi d'une marge. Un board de référence porte vite des centaines de médias ; sans culling, autant
// de <video>/<img>/iframes vivent dans le DOM → autant de décodeurs, de couches composites et de
// requêtes de proxy, et le pan/zoom sature le GPU.
//
// La MARGE pré-monte ce qui borde l'écran (aucun item n'apparaît en retard au bord). L'HYSTÉRÉSIS
// évite de recalculer la zone à chaque frame de pan : on ne la refait que quand le viewport SORT de
// celle déjà montée, ou quand il est devenu BEAUCOUP plus petit qu'elle (cf. CULL_SHRINK).

import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardItem, BoardView } from "./referenceShared";

// En dessous de ce nombre d'items, tout reste monté : le culling ne rapporterait rien et provoquerait
// des re-montages inutiles (une vidéo remontée relance un encodage de proxy).
const CULL_MIN_ITEMS = 40;
// …mais ce raccourci ne vaut qu'à zoom MODÉRÉ. Magnifiée soixante fois, une seule image couvre déjà
// des dizaines de milliers de pixels : trente d'entre elles montées d'un coup suffisent à noyer le
// compositeur, sans jamais atteindre le seuil ci-dessus. C'est exactement la planche d'une trentaine
// d'images qui figeait la fenêtre après un gros zoom.
const CULL_ALWAYS_ZOOM = 2;
// Marge pré-montée autour du viewport, en fraction de sa taille, de chaque côté.
const CULL_MARGIN = 0.75;

// L'hystérésis doit jouer DANS LES DEUX SENS. « Recalculer quand le viewport sort de la zone » couvre
// le pan et le dézoom ; au ZOOM, jamais : le viewport rétrécit À L'INTÉRIEUR de la zone, la condition
// de sortie n'est donc plus jamais vraie et la zone reste figée à sa taille de vue d'ensemble. Tout
// ce qui avait été monté pour survoler la planche y restait monté, chacun mesurant alors des dizaines
// de milliers de pixels à l'écran — c'est ce qui figeait la fenêtre après un gros zoom.
// Une zone neuve vaut 2,5× le viewport : on resserre au-delà de 5×, ce qui laisse un facteur 2 de
// marge et borne les recalculs à un par doublement de zoom.
const CULL_SHRINK = 5;

// …et au DÉZOOM, la zone doit être refaite AVANT d'être débordée. Attendre que le viewport en sorte,
// c'était monter les entrants une fois déjà sous les yeux — le « rechargement » visible de toute la
// planche en dézoomant vite. On refait la zone dès que la réserve tombe sous ce ratio : les entrants
// montent encore hors champ, et il reste 60 % de croissance de viewport avant qu'un trou se voie.
const CULL_GROW = 1.6;

// PLAFOND GLOBAL D'ITEMS MONTÉS. MEDIA_BUDGET ne borne que les lecteurs ; images, notes et cadres ne
// sont bornés QUE par la zone, qui grandit comme 1/scale et couvre la planche entière à fort dézoom.
// Le plafond borne alors la mise en page et la composition. Depuis le LOD, une image dézoomée roule
// sur sa vignette (le décodage n'explose plus avec la taille de mise en page) : le plafond protège
// le nombre d'éléments, plus le poids de chacun — d'où 400, pour qu'une vue d'ensemble d'une grosse
// planche reste entière au lieu de trouer ses bords.
const ITEM_BUDGET = 400;

// PLAFOND DE LECTEURS MÉDIA. La zone couvre 2,5× le viewport en largeur ET en hauteur, soit 6,25×
// son aire : sur un board dense elle contient facilement plusieurs centaines d'items. Or Chromium
// cesse de créer un lecteur média au-delà d'environ 75 par frame, et le fait SANS erreur — passé ce
// seuil, des vidéos restent noires au hasard, sans rien dans la console.
//
// On borne donc les seuls items qui consomment un lecteur, en gardant les PLUS PROCHES du centre du
// viewport. Les images, notes et cadres ne comptent pas : ils ne coûtent qu'une couche de rendu. Le
// plafond dépasse largement ce qu'un écran affiche, donc ce qui tombe est pris dans la marge, jamais
// sous les yeux — et un item écarté n'est pas monté du tout, ce qui vaut mieux qu'un carré noir.
const MEDIA_BUDGET = 48;
const MEDIA_KINDS = new Set(["video", "sequence", "youtube", "embed"]);

// Au-delà de ce nombre, une sélection cesse d'épingler ses items au montage. Une PETITE sélection
// est un geste (drag de groupe, inspecteur) : son sujet ne doit pas disparaître sous les doigts. Un
// mur sélectionné entier (Ctrl+A, grand lasso) n'est PAS un geste : épingler des centaines d'items
// contournerait les deux plafonds ci-dessus et recréerait exactement le gel que le culling existe
// pour empêcher. La sélection reste entière dans le store — seul le montage est borné.
const FORCED_SELECTION_MAX = 16;

interface Rect { x: number; y: number; w: number; h: number }
// La zone retient le zoom auquel elle a été bâtie : c'est ce qui permet au filtrage de savoir s'il
// regarde une vue d'ensemble ou un détail magnifié, sans redemander la taille du viewport.
type Zone = Rect & { scale: number };

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Bbox monde d'un item. Un item pivoté est englobé par son cercle circonscrit (borne sûre, sans trigo). */
function itemBox(it: BoardItem): Rect {
  if (!it.rotation) return { x: it.x, y: it.y, w: it.w, h: it.h };
  const d = Math.hypot(it.w, it.h);
  return { x: it.x + it.w / 2 - d / 2, y: it.y + it.h / 2 - d / 2, w: d, h: d };
}

function overlaps(zone: Rect, it: BoardItem): boolean {
  const b = itemBox(it);
  return b.x < zone.x + zone.w && b.x + b.w > zone.x && b.y < zone.y + zone.h && b.y + b.h > zone.y;
}

/**
 * Ne garde au plus `max` items parmi ceux que `pick` désigne : les plus PROCHES du centre. Ce que
 * `forced` désigne traverse toujours, sans consommer le budget. L'ordre d'origine est préservé (le
 * plan d'empilement est celui du tableau).
 */
export function capNearest(
  list: BoardItem[],
  max: number,
  pick: (it: BoardItem) => boolean,
  dist: (it: BoardItem) => number,
  forced: (it: BoardItem) => boolean,
): BoardItem[] {
  const pool = list.filter((it) => pick(it) && !forced(it));
  if (pool.length <= max) return list;
  const keep = new Set(
    pool.slice().sort((a, b) => dist(a) - dist(b)).slice(0, max).map((it) => it.id),
  );
  return list.filter((it) => !pick(it) || forced(it) || keep.has(it.id));
}

/** Viewport (px écran) → rectangle en coordonnées board. */
function viewportBox(view: BoardView, w: number, h: number): Rect {
  return { x: -view.tx / view.scale, y: -view.ty / view.scale, w: w / view.scale, h: h / view.scale };
}

/** Zone à monter pour ce viewport : lui-même, élargi de la marge de chaque côté. */
export function zoneFor(v: Rect): Rect {
  return {
    x: v.x - v.w * CULL_MARGIN,
    y: v.y - v.h * CULL_MARGIN,
    w: v.w * (1 + CULL_MARGIN * 2),
    h: v.h * (1 + CULL_MARGIN * 2),
  };
}

/**
 * Faut-il refaire la zone montée ? Trois raisons, et il FAUT les trois : le viewport est sorti de la
 * zone (pan), la zone est devenue bien plus large que lui (zoom, cf. CULL_SHRINK), ou le viewport
 * est sur le point de la déborder (dézoom, cf. CULL_GROW — refaire APRÈS la sortie montait les
 * items une fois déjà visibles).
 */
export function needsResync(zone: Rect | null, v: Rect): boolean {
  if (!zone) return true;
  return !contains(zone, v)
    || zone.w > v.w * CULL_SHRINK || zone.h > v.h * CULL_SHRINK
    || zone.w < v.w * CULL_GROW || zone.h < v.h * CULL_GROW;
}

/**
 * @param items      items du board (hors calque de dessin)
 * @param selectedIds items toujours montés (gestes/inspecteur en cours), même hors écran
 * @param editingId   note en cours d'édition — idem
 */
export function useBoardCulling(items: BoardItem[], selectedIds: string[], editingId: string | null) {
  const [zone, setZone] = useState<Zone | null>(null);
  const zoneRef = useRef<Zone | null>(null);

  // Appelé à chaque changement de vue ET à chaque frame de pan impératif : ne touche à l'état React
  // que si la zone déjà montée ne convient plus (cf. needsResync).
  const syncViewport = useCallback((view: BoardView, width: number, height: number) => {
    if (!width || !height) return;
    const v = viewportBox(view, width, height);
    if (!needsResync(zoneRef.current, v)) return;
    const next: Zone = { ...zoneFor(v), scale: view.scale };
    zoneRef.current = next;
    setZone(next);
  }, []);

  const visible = useMemo(() => {
    if (!zone || (items.length < CULL_MIN_ITEMS && zone.scale <= CULL_ALWAYS_ZOOM)) return items;
    // Set, pas `includes` : le test est fait pour CHAQUE item, donc un tableau rendait le filtrage
    // quadratique — et c'est précisément quand on sélectionne tout un mur d'images que ça compte.
    const pinned = new Set(selectedIds.length <= FORCED_SELECTION_MAX ? selectedIds : []);
    // Un item sous geste ou en édition n'est jamais lâché, et ne consomme aucun budget : son sujet ne
    // doit pas disparaître sous les doigts.
    const forced = (it: BoardItem) => it.id === editingId || pinned.has(it.id);
    const kept = items.filter((it) => overlaps(zone, it) || forced(it));

    // Le centre de la zone est celui du viewport, à la marge près : ce qui tombe est donc pris dans
    // la périphérie, jamais sous les yeux.
    const cx = zone.x + zone.w / 2;
    const cy = zone.y + zone.h / 2;
    const dist = (it: BoardItem) => Math.hypot(it.x + it.w / 2 - cx, it.y + it.h / 2 - cy);

    // Plafond global d'abord, plafond média ensuite (plus strict) : les deux gardent les plus proches.
    return capNearest(
      capNearest(kept, ITEM_BUDGET, () => true, dist, forced),
      MEDIA_BUDGET,
      (it) => MEDIA_KINDS.has(it.kind),
      dist,
      forced,
    );
  }, [items, zone, selectedIds, editingId]);

  return { visible, syncViewport };
}
