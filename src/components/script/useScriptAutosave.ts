// Autosave debouncé : à chaque modification (dirty), planifie une sauvegarde silencieuse.
// `save` doit être stable (useCallback). Le doc change de référence à chaque mutation → l'effet
// se relance et re-debounce correctement.

import { useEffect } from "react";
import { useScript } from "./useScript";

export function useScriptAutosave(save: () => void, ms = 600) {
  const dirty = useScript((s) => s.dirty);
  const doc = useScript((s) => s.doc);
  useEffect(() => {
    if (!dirty || !doc) return;
    const t = setTimeout(() => save(), ms);
    return () => clearTimeout(t);
  }, [dirty, doc, save, ms]);
}
