// Pousse l'état « changements non enregistrés » vers le main process (garde-fou de fermeture :
// rappel d'enregistrer avant de quitter). Non enregistré = board non vide ET (jamais lié à une
// scène nommée OU édité depuis le dernier enregistrement). L'autosave d'une scène nommée remet
// `dirty` à false → plus d'avertissement une fois la scène à jour.

import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";

export function useUnsavedWarning() {
  useEffect(() => {
    const compute = (s = useBoard.getState()) =>
      s.items.some((it) => it.kind !== "draw") && (s.sceneId == null || s.dirty);

    let last: boolean | null = null;
    const push = (s: ReturnType<typeof useBoard.getState>) => {
      const next = compute(s);
      if (next !== last) {
        last = next;
        nr.reference?.setDirty(next);
      }
    };

    push(useBoard.getState());
    const unsub = useBoard.subscribe(push);
    return () => {
      unsub();
      nr.reference?.setDirty(false);
    };
  }, []);
}
