// « Collaborer » du board : le dialogue partagé, plus ce que seul le board sait faire — soigner ses
// médias, entrer dans la bibliothèque de scènes, lier le projet à la scène, et défaire tout ça
// quand la publication échoue.

import { useTranslation } from "react-i18next";
import { CollaborationDialog } from "@/components/collab/CollaborationDialog";
import { abortProject } from "@/lib/collab/client";
import { createCollaborativeProject } from "@/lib/collab/session";
import { importBoardAssets } from "@/lib/collab/board/media";
import { diffBoard } from "@/lib/collab/board/operations";
import { BOARD_SURFACE } from "./collabSurface";
import { prepareShareMedia } from "./boardMediaActions";
import { useBoard } from "./useReferenceBoard";
import { useScenePersistence } from "./useScenePersistence";

export function BoardCollaborationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useTranslation("collab");
  const persistence = useScenePersistence();
  const projectId = useBoard((state) => state.collabProjectId);
  const role = useBoard((state) => state.collabRole);
  const filePath = useBoard((state) => state.filePath);
  const sceneId = useBoard((state) => state.sceneId);

  // Un board ouvert depuis un .netsu est CONVERTI au passage, pas refusé. Le seul vrai blocage est
  // un board jamais enregistré : il n'y a rien à convertir.
  const blockerKey = projectId || sceneId || filePath ? null : "board.noScene";

  async function share() {
    const before = {
      sceneId: useBoard.getState().sceneId,
      filePath: useBoard.getState().filePath,
    };
    // Un board converti traîne souvent des chemins absolus morts (dossier compagnon déplacé ou
    // vidé). Avant que la publication ne juge : chemins soignés quand les octets vivent ailleurs,
    // retéléchargement depuis le lien d'origine sinon, marquage du reste. Fait AVANT l'adoption :
    // la scène stockée — celle contre laquelle le natif autorise les imports — ne doit connaître
    // que des chemins vivants.
    await prepareShareMedia().catch(() => undefined);
    const source = useBoard.getState().items;
    const adoption = await persistence.adoptIntoLibrary();
    let created: { projectId: string } | null = null;
    try {
      created = await createCollaborativeProject({
        surface: BOARD_SURFACE,
        subjectId: adoption.sceneId,
        seed: async (project) => {
          const assets = await importBoardAssets(project, source);
          return { ops: diffBoard([], source, assets.resolve), missing: assets.missing };
        },
      });
      if (adoption.adopted) persistence.completeAdoption(adoption.sceneId);
      await persistence.bindCollaboration(created.projectId);
      return created;
    } catch (failure) {
      // Défaire la copie de bibliothèque et remettre le board sur son fichier : sinon chaque essai
      // raté laisse un board identique de plus sur l'accueil — dont un qui ne possède aucun
      // document. Un projet créé à l'instant et lié à rien part avec.
      if (created) await abortProject(created.projectId).catch(() => undefined);
      if (adoption.adopted) await persistence.abortAdoption(before);
      throw failure;
    }
  }

  return (
    <CollaborationDialog
      open={open}
      onOpenChange={onOpenChange}
      projectId={projectId}
      role={role}
      onShare={share}
      blockerKey={blockerKey}
      noticeKey={filePath ? "board.willAdopt" : null}
      onRemoved={() => {
        const state = useBoard.getState();
        if (state.sceneId) void persistence.remove(state.sceneId);
        state.newScene();
      }}
    />
  );
}
