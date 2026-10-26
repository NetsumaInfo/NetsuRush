// Selection a grid exposes to its "Ranger" buttons, so a picker opened on one card can offer
// "this shot" or "the whole selection". The grid publishes a stable getter read only when a picker
// opens: passing the selection down as a prop would re-render every memoized card on each tick.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { CollectionShot } from "@/lib/bridge";

const RangeSelectionContext = createContext<(() => CollectionShot[]) | null>(null);

export function RangeSelectionProvider({ shots, children }: { shots: () => CollectionShot[]; children: ReactNode }) {
  // Rewritten on every render: the getter always reads the grid's current selection.
  const ref = useRef(shots);
  ref.current = shots;
  const get = useCallback(() => ref.current(), []);
  return <RangeSelectionContext.Provider value={get}>{children}</RangeSelectionContext.Provider>;
}

// Same identity the core dedupes on (shotKey in core/collections.js).
const shotKey = (s: CollectionShot) => `${s.path}|${s.inFrame != null ? `f${s.inFrame}` : `s${Number(s.in || 0).toFixed(3)}`}`;

// Snapshot taken when the picker mounts. The selection is `offer`ed only when the clicked card
// belongs to it and it holds more than that card: from an unselected card the selection is
// unrelated, and "the selection" would range every shot except the one clicked.
export function useRangeSelection(own: CollectionShot[]) {
  const get = useContext(RangeSelectionContext);
  const [snapshot] = useState(() => {
    const selection = get?.() ?? [];
    const ownKeys = new Set(own.map(shotKey));
    const includesOwn = selection.some((s) => ownKeys.has(shotKey(s)));
    return { selection, offer: includesOwn && selection.some((s) => !ownKeys.has(shotKey(s))) };
  });
  return snapshot;
}
