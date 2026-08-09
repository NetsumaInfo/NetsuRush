// Choix « Modèle » d'upscale du board (Paramètres + popup d'item) : liste RÉELLEMENT utilisable.
// Un modèle IA n'apparaît que si ses poids sont installés (le core est l'autorité) et si son runtime
// est compatible ; un shader Turbo adossé à un modèle ONNX suit le même statut que ce modèle.
// Source unique : les deux écrans lisent cette liste, sinon un défaut réglé ici serait refusé là-bas.

import { useMemo } from "react";
import type { ShaderModel } from "@/lib/bridge";
import { BOARD_UP_CHOICES, shaderRuntimeModel, isRtxShader, RTX_RUNTIME_IDS, type BoardUpChoice } from "@/components/upscale/upscaleShared";
import { useInstalledModels } from "@/components/upscale/ModelPicker";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";

// `allowTurbo` = faux sur une image : les shaders traitent un flux vidéo uniquement.
// `ready` = statut d'installation connu — tant qu'il est faux, aucun réglage ne doit être réécrit
// (au boot la liste paraîtrait vide et écraserait le modèle choisi par l'utilisateur).
export function useBoardUpChoices(allowTurbo: boolean): { ready: boolean; choices: BoardUpChoice[] } {
  const { ready, has } = useInstalledModels();
  const { status } = useCompatibility();
  const choices = useMemo(
    () => BOARD_UP_CHOICES.filter((c) => {
      if (c.engine === "turbo") {
        if (!allowTurbo || !isModelCompatible(c.value, status)) return false;
        if (isRtxShader(c.value as ShaderModel)) return RTX_RUNTIME_IDS.every(has);
        const runtime = shaderRuntimeModel(c.value as ShaderModel);
        return !runtime || has(runtime);
      }
      return has(c.value) && isModelCompatible(c.value, status);
    }),
    [allowTurbo, has, status],
  );
  return { ready, choices };
}
