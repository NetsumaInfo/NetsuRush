// Le board de référence, déclaré comme surface collaborative (`docs/collab.md`).
//
// C'est TOUT ce que la collaboration a besoin de savoir d'un module : comment lister ses documents
// liés à un projet, comment en créer un quand une invitation est acceptée, comment le retirer quand
// le projet disparaît. Le panneau de compte, les invitations et les notifications s'en servent sans
// jamais connaître le board.
//
// Importé pour son EFFET DE BORD, au démarrage : les Paramètres doivent pouvoir nommer un board
// partagé même si l'onglet Référence n'a jamais été ouvert. D'où l'absence d'import du store ici —
// le boot ne doit pas tirer le board entier pour trois fonctions.

import { nr } from "@/lib/bridge";
import { registerCollabSurface, type CollabBinding } from "@/lib/collab/surfaces";
import i18n from "@/i18n";

export const BOARD_SURFACE = "board";

registerCollabSurface({
  id: BOARD_SURFACE,
  labelKey: "surface.board",

  async listBindings(): Promise<CollabBinding[]> {
    const scenes = (await nr.reference?.listScenes()) ?? [];
    return scenes
      .filter((scene) => scene.collaboration?.projectId)
      .map((scene) => ({
        projectId: scene.collaboration!.projectId,
        subjectId: scene.id,
        name: scene.name,
      }));
  },

  async adopt(projectId, suggestedName): Promise<CollabBinding> {
    // Vide À DESSEIN : le document partagé fait foi et son contenu arrive par le réseau. Écrire des
    // items ici créerait une seconde copie modifiable de la même vérité.
    const name = suggestedName || i18n.t("collab:invites.shared");
    const saved = await nr.reference?.saveScene({
      name,
      items: [],
      view: null,
      collaboration: { projectId },
    });
    if (!saved?.ok || !saved.id) {
      throw new Error(saved?.error || i18n.t("collab:projects.failed"));
    }
    return { projectId, subjectId: saved.id, name };
  },

  async forget(binding) {
    await nr.reference?.deleteScene(binding.subjectId);
  },

  onRemoved(projectId) {
    // Le board affiché peut projeter le document qui vient de disparaître : le laisser dessus le
    // ferait peindre une projection morte. Import dynamique — cette fonction n'est appelée qu'après
    // une suppression, le store n'a rien à faire dans le bundle de démarrage.
    void import("./useReferenceBoard").then(({ useBoard }) => {
      if (useBoard.getState().collabProjectId === projectId) useBoard.getState().newScene();
    });
  },
});
