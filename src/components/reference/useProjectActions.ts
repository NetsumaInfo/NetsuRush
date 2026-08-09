// Actions de DOCUMENT du board : enregistrer, enregistrer sous, ouvrir un projet .netsu.
//
// Partagées par l'onglet, la fenêtre détachée et le mode épinglé — qui n'ont pas la même barre
// d'outils mais rendent tous le même menu contextuel. Les recâbler dans chaque vue les ferait
// diverger : c'est déjà arrivé au « Enregistrer », que la fenêtre détachée ouvrait sur un dialogue
// de scène quand l'onglet, lui, écrivait directement.

import { useCallback } from "react";
import { nr } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";
import type { useScenePersistence } from "./useScenePersistence";

export function useProjectActions(
  persistence: ReturnType<typeof useScenePersistence>,
  onOpened?: () => void,
) {
  /**
   * Ctrl+S. Un board déjà lié à un fichier y retourne ; une scène de la bibliothèque se réécrit ;
   * un board tout neuf demande OÙ l'enregistrer plutôt qu'un simple nom — c'est la question qui
   * manquait, et un nom sans emplacement ne dit toujours pas où le projet se trouve.
   */
  const save = useCallback(() => {
    const st = useBoard.getState();
    if (st.filePath && !st.fileReadonly) return void persistence.saveProject();
    if (st.sceneId) return void persistence.save();
    return void persistence.saveProjectAs();
  }, [persistence]);

  const saveAs = useCallback(() => void persistence.saveProjectAs(), [persistence]);

  const openRecent = useCallback(
    async (filePath: string) => {
      if (await persistence.openProject(filePath)) onOpened?.();
    },
    [persistence, onOpened],
  );

  const openProject = useCallback(async () => {
    const src = await nr.reference?.chooseNetsu();
    if (!src) return;
    await openRecent(src);
  }, [openRecent]);

  return { save, saveAs, openProject, openRecent };
}
