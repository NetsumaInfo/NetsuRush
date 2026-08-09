import { useEffect, useRef, useState } from "react";
import type { CutSpan } from "@/lib/bridge";
import { nextSegId, type Segment } from "./cutStudioShared";
import type { ShotDetection } from "./useShotDetection";

const span = (s: Segment): CutSpan => ({ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame });

// Sélection + opérations d'édition de la grille de plans (fusionner, retirer). Partagé par la barre
// d'outils, le clic droit et les raccourcis clavier → une seule implémentation de chaque geste.
export function useCutActions(det: ShotDetection, clipPath: string) {
  const { segments, setSegments, active, setActive, setActiveUrl, recordMerge, recordRemoval } = det;
  const [sel, setSel] = useState<Set<number>>(new Set());
  // Ancre de la sélection par plage (Maj+clic) : dernier plan cliqué SANS Maj.
  const anchorRef = useRef<number | null>(null);

  // La détection/cache repart de zéro à chaque changement de clip ou de modèle : la sélection
  // (héritée du rush précédent) doit aussi être vidée, en miroir du reset des plans.
  useEffect(() => { setSel(new Set()); anchorRef.current = null; }, [clipPath, det.model]);

  // Clic simple / Ctrl+clic = bascule ; Maj+clic = étend la plage depuis l'ancre.
  function toggleSel(id: number, mods?: { shift?: boolean; ctrl?: boolean }) {
    const idx = segments.findIndex((s) => s.id === id);
    if (mods?.shift && anchorRef.current != null) {
      const from = segments.findIndex((s) => s.id === anchorRef.current);
      if (from >= 0 && idx >= 0) {
        const [lo, hi] = from < idx ? [from, idx] : [idx, from];
        setSel((prev) => {
          const n = new Set(prev);
          for (let i = lo; i <= hi; i++) n.add(segments[i].id);
          return n;
        });
        return;
      }
    }
    anchorRef.current = id;
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function selectAll() {
    setSel((s) => (s.size === segments.length ? new Set() : new Set(segments.map((x) => x.id))));
  }
  function deselect() { setSel(new Set()); }

  function mergeSelected() {
    const chosen = segments.filter((s) => sel.has(s.id)).sort((a, b) => a.in - b.in);
    if (chosen.length < 2) return;
    const last = chosen[chosen.length - 1];
    const merged = { in: chosen[0].in, out: last.out, inFrame: chosen[0].inFrame, outFrame: last.outFrame };
    setSegments((arr) => [...arr.filter((s) => !sel.has(s.id)), { id: nextSegId(), ...merged }].sort((a, b) => a.in - b.in));
    setSel(new Set());
    recordMerge(merged);   // fusion gardée « pour toujours » → rejouée à la réouverture/re-détection
  }

  // Écarte la sélection (ou, à défaut, le plan en cours de lecture) de la découpe.
  function removeSelected() {
    const chosen = sel.size ? segments.filter((s) => sel.has(s.id)) : active ? [active] : [];
    if (!chosen.length) return;
    const ids = new Set(chosen.map((s) => s.id));
    setSegments((arr) => arr.filter((s) => !ids.has(s.id)));
    setSel(new Set());
    // Le plan retiré était à l'écran → vider le lecteur, sinon il continue de jouer un plan absent.
    if (active && ids.has(active.id)) { setActive(null); setActiveUrl(null); }
    recordRemoval(chosen.map(span));
  }

  return { sel, setSel, toggleSel, selectAll, deselect, mergeSelected, removeSelected };
}
