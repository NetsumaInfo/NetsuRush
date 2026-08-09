import { useCallback, useEffect, useState } from "react";
import { nr, type BugContext } from "@/lib/bridge";
import { logCaught } from "@/lib/appConsole";

// Specs lues par le service (GPU, pilote, backend IA : ce que le testeur ne connaît pas).
// `refresh` sert quand la mesure part avant que le service soit prêt.
export function useBugContext(): { context: BugContext | null; loading: boolean; refresh: () => void } {
  const [context, setContext] = useState<BugContext | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    void nr
      .bugContext()
      .then((r) => setContext(r && r.ok ? (r as BugContext) : null))
      .catch((e) => {
        logCaught("rapport", "lecture des specs machine", e);
        setContext(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return { context, loading, refresh: load };
}
