// Canal de géométrie VIVANTE : pendant un geste (déplacement, redimensionnement, rotation), la
// géométrie d'un item vit dans l'état local de `usePointerTransform` et n'atteint le store qu'au
// relâchement. Deux choses doivent pourtant suivre le geste en direct :
//   - les tracés LIÉS à l'item (une flèche entre deux images doit se tendre pendant le glissé) ;
//   - les guides de l'aimant.
// Ce canal vit HORS de React et hors du store zustand : rien ne s'y abonne tant qu'aucun tracé n'est
// lié et que l'aimant n'accroche rien, donc un board ordinaire ne paie strictement rien.

import { useSyncExternalStore } from "react";
import type { Geom } from "./referenceShared";
import type { SnapGuide } from "./boardSnap";

export interface LiveState {
  geom: Record<string, Geom>;
  guides: SnapGuide[];
}

const EMPTY: LiveState = { geom: {}, guides: [] };
let state: LiveState = EMPTY;
const subs = new Set<() => void>();

function emit() {
  for (const cb of subs) cb();
}

export function getLive(): LiveState {
  return state;
}

export function subscribeLive(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

// Géométrie vivante d'un ou plusieurs items (remplace l'entrée précédente).
export function setLiveGeom(entries: Record<string, Geom>): void {
  state = { ...state, geom: { ...state.geom, ...entries } };
  emit();
}

export function setLiveGuides(guides: SnapGuide[]): void {
  if (!guides.length && !state.guides.length) return;
  state = { ...state, guides };
  emit();
}

// Fin de geste : on repasse la main au store (qui vient d'être commité).
export function clearLive(): void {
  if (state === EMPTY) return;
  state = EMPTY;
  emit();
}

export function useLive(): LiveState {
  return useSyncExternalStore(subscribeLive, getLive, getLive);
}
