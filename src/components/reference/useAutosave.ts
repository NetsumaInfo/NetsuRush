// Filet de sécurité : restaure le dernier board au montage (si vide) et autosave silencieux
// (debouncé) à chaque modification tant qu'aucune scène nommée n'est active.

import { useEffect, useRef } from "react";
import { useBoard } from "./useReferenceBoard";
import type { useScenePersistence } from "./useScenePersistence";

export function useAutosave(
  persistence: ReturnType<typeof useScenePersistence>,
  opts?: { restore?: boolean }, // false → autosave seul (la fenêtre détachée charge le handoff)
) {
  const restore = opts?.restore !== false;
  const restored = useRef(false);

  useEffect(() => {
    if (!restore || restored.current) return;
    restored.current = true;
    if (useBoard.getState().items.length === 0) void persistence.loadAuto();
  }, [persistence, restore]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useBoard.subscribe((s) => {
      if (!s.dirty || !s.save.enabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void persistence.saveAuto(), s.save.ms);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [persistence]);
}
