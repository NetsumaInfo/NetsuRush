// Culling du board (virtualisation SPATIALE) : ne monte que les items dont la bbox croise le viewport
// élargi d'une marge. Un board de référence porte vite des centaines de médias ; sans culling, autant
// de <video>/<img>/iframes vivent dans le DOM → autant de décodeurs, de couches composites et de
// requêtes de proxy, et le pan/zoom sature le GPU.
//
// La MARGE pré-monte ce qui borde l'écran (aucun item n'apparaît en retard au bord). L'HYSTÉRÉSIS est
// implicite : on ne recalcule la zone que quand le viewport SORT de celle déjà montée — donc au plus
// une fois tous les ~75% d'écran parcourus, jamais à chaque frame de pan.

import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardItem, BoardView } from "./referenceShared";

// En dessous de ce nombre d'items, tout reste monté : le culling ne rapporterait rien et provoquerait
// des re-montages inutiles (une vidéo remontée relance un encodage de proxy).
const CULL_MIN_ITEMS = 40;
// Marge pré-montée autour du viewport, en fraction de sa taille, de chaque côté.
const CULL_MARGIN = 0.75;

interface Rect { x: number; y: number; w: number; h: number }

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

/** Viewport (px écran) → rectangle en coordonnées board. */
function viewportBox(view: BoardView, w: number, h: number): Rect {
  return { x: -view.tx / view.scale, y: -view.ty / view.scale, w: w / view.scale, h: h / view.scale };
}

/**
 * @param items      items du board (hors calque de dessin)
 * @param selectedIds items toujours montés (gestes/inspecteur en cours), même hors écran
 * @param editingId   note en cours d'édition — idem
 */
export function useBoardCulling(items: BoardItem[], selectedIds: string[], editingId: string | null) {
  const [zone, setZone] = useState<Rect | null>(null);
  const zoneRef = useRef<Rect | null>(null);

  // Appelé à chaque changement de vue ET à chaque frame de pan impératif : ne touche à l'état React
  // que si le viewport a quitté la zone déjà montée.
  const syncViewport = useCallback((view: BoardView, width: number, height: number) => {
    if (!width || !height) return;
    const v = viewportBox(view, width, height);
    if (zoneRef.current && contains(zoneRef.current, v)) return;
    const next: Rect = {
      x: v.x - v.w * CULL_MARGIN,
      y: v.y - v.h * CULL_MARGIN,
      w: v.w * (1 + CULL_MARGIN * 2),
      h: v.h * (1 + CULL_MARGIN * 2),
    };
    zoneRef.current = next;
    setZone(next);
  }, []);

  const visible = useMemo(() => {
    if (!zone || items.length < CULL_MIN_ITEMS) return items;
    return items.filter(
      (it) => overlaps(zone, it) || it.id === editingId || selectedIds.includes(it.id),
    );
  }, [items, zone, selectedIds, editingId]);

  return { visible, syncViewport };
}
