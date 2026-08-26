import { useEffect, useRef, useState } from "react";
import type { CutSpan } from "@/lib/bridge";
import { nextSegId, type Segment } from "./cutStudioShared";
import type { ShotDetection } from "./useShotDetection";

const span = (s: Segment): CutSpan => ({ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame });

// Sélection + opérations d'édition de la grille de plans (fusionner, retirer). Partagé par la barre
// d'outils, le clic droit et les raccourcis clavier → une seule implémentation de chaque geste.
//
// La grille peut enchaîner plusieurs rushs : la sélection les traverse librement (elle sert à
// exporter), mais toute ÉDITION reste enfermée dans son rush — deux plans de fichiers différents
// n'ont pas de bornes communes, il n'y a rien à en unir.
export function useCutActions(det: ShotDetection, flowKey: string) {
  const { segments, setSegments, active, setActive, setActiveUrl, recordMerge, recordRemoval, pathOf } = det;
  const [sel, setSel] = useState<Set<number>>(new Set());
  // Ancre de la sélection par plage (Maj+clic) : dernier plan cliqué SANS Maj.
  const anchorRef = useRef<number | null>(null);

  // La détection/cache repart de zéro à chaque changement de flux ou de modèle : la sélection
  // (héritée des rushs précédents) doit aussi être vidée, en miroir du reset des plans.
  useEffect(() => { setSel(new Set()); anchorRef.current = null; }, [flowKey, det.model]);

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

  // Fusion RUSH PAR RUSH : une sélection qui traverse le flux produit une union par rush concerné,
  // jamais une union entre fichiers. Le résultat prend la PLACE du premier plan absorbé — trier la
  // grille par `in` la mélangerait, puisque les secondes d'un rush n'ont rien à voir avec celles du
  // suivant. C'est ce qui garde le défilement identique à celui d'un rush unique.
  function mergeSelected() {
    const chosen = segments.filter((s) => sel.has(s.id));
    if (chosen.length < 2) return;
    const byPath = new Map<string, Segment[]>();
    for (const s of chosen) {
      const path = pathOf(s);
      const group = byPath.get(path);
      if (group) group.push(s); else byPath.set(path, [s]);
    }
    // Un seul plan sélectionné dans un rush : rien à y unir, il reste tel quel.
    const groups = [...byPath].filter(([, g]) => g.length >= 2);
    if (!groups.length) return;

    const merged = new Map<number, Segment>();   // id du premier absorbé → plan fusionné
    const absorbed = new Set<number>();
    for (const [path, group] of groups) {
      const ordered = [...group].sort((a, b) => a.in - b.in);
      const first = ordered[0], last = ordered[ordered.length - 1];
      const union = { in: first.in, out: last.out, inFrame: first.inFrame, outFrame: last.outFrame };
      merged.set(group[0].id, { id: nextSegId(), ...union, path });
      for (const s of group) absorbed.add(s.id);
      recordMerge(path, union);   // fusion gardée « pour toujours » → rejouée à la réouverture/re-détection
    }
    setSegments((arr) => arr.flatMap((s) => {
      const m = merged.get(s.id);
      if (m) return [m];
      return absorbed.has(s.id) ? [] : [s];
    }));
    setSel(new Set());
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
    recordRemoval(chosen.map((s) => ({ path: pathOf(s), span: span(s) })));
  }

  return { sel, setSel, toggleSel, selectAll, deselect, mergeSelected, removeSelected };
}
