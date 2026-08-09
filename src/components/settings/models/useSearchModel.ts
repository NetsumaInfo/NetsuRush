import { useCallback, useEffect, useRef, useState } from "react";
import { nr, type SearchModelEntry, type SearchModelState } from "@/lib/bridge";

// Variante SigLIP active + bascule. Les index sont SÉPARÉS par variante (colonne `model` des
// embeddings) : basculer ne détruit rien, mais la variante choisie repart de son propre index —
// donc d'une ré-indexation complète si elle est vide. Le core relance les daemons de recherche.
export interface SearchModelPicker {
  state: SearchModelState | null;
  busy: string | null;
  error: string | null;
  entry: (id: string) => SearchModelEntry | undefined;
  use: (id: string) => Promise<boolean>;
}

export function useSearchModel(): SearchModelPicker {
  const [state, setState] = useState<SearchModelState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    nr.searchModelState()
      .then((next) => { if (alive.current) setState(next); })
      .catch(() => { /* hors application : le sélecteur reste masqué */ });
    return () => { alive.current = false; };
  }, []);

  const use = useCallback(async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      const next = await nr.searchSetModel(id);
      if (!alive.current) return false;
      if (!next.ok) {
        setError(next.error || id);
        return false;
      }
      setState(next);
      return true;
    } catch (cause) {
      if (alive.current) setError(String(cause));
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const entry = useCallback((id: string) => state?.models.find((m) => m.id === id), [state]);

  return { state, busy, error, entry, use };
}
