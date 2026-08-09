// Autosave de la page ouverte : dès que `nbDirty` passe à true, débounce puis flush vers le core.
// Le changement de page flushe déjà (nbOpenPage) → ce hook couvre la frappe continue. Façon board Réf.
import { useEffect } from "react";
import { useApp } from "@/store";

export function useNotebookAutosave() {
  const dirty = useApp((s) => s.nbDirty);
  const flush = useApp((s) => s.nbFlushPage);
  const delayMs = useApp((s) => s.nbPrefs.autosaveMs);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => { void flush(); }, delayMs || 700);
    return () => clearTimeout(t);
  }, [dirty, flush, delayMs]);
}
