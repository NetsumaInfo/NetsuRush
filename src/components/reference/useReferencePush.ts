// Réception des items poussés vers le board (ex. « Envoyer vers le board » depuis le Media Pool
// ou un résultat de recherche, et transfert vers la fenêtre détachée). Le payload est volontairement
// minimal : un chemin disque + titre.

import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import type { BoardHandle } from "./ReferenceBoard";

interface PushPayload {
  type: "path";
  path: string;
  title?: string;
}

export function useReferencePush(boardRef: React.RefObject<BoardHandle | null>) {
  useEffect(() => {
    return nr.reference?.onPush?.((payload) => {
      const p = payload as PushPayload | null;
      if (p?.type === "path" && p.path) boardRef.current?.addPath(p.path, p.title);
    });
  }, [boardRef]);
}
