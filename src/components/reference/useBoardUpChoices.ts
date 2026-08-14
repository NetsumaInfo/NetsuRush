// Choix « Modèle » d'upscale du board (Paramètres + popup d'item) : liste RÉELLEMENT utilisable.
// Un modèle IA n'apparaît que si ses poids sont installés (le core est l'autorité) et si son runtime
// est compatible ; un shader Turbo adossé à un modèle ONNX suit le même statut que ce modèle.
// Source unique : les deux écrans lisent cette liste, sinon un défaut réglé ici serait refusé là-bas.

import { useMemo } from "react";
import type { ShaderModel } from "@/lib/bridge";
import { BOARD_UP_CHOICES, shaderRuntimeModel, isRtxShader, RTX_RUNTIME_IDS, type BoardUpChoice } from "@/components/upscale/upscaleShared";
import { useInstalledModels } from "@/components/upscale/ModelPicker";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";

// `target` = ce qui sera traité. Les shaders GLSL valent AUSSI pour une image fixe (une frame, même
// filtre libplacebo) — les réserver à la vidéo privait l'image des moteurs les plus rapides. Seul
// RTX VSR reste vidéo : son CLI ne traite que des fichiers vidéo entiers.
// `ready` = statut d'installation connu — tant qu'il est faux, aucun réglage ne doit être réécrit
// (au boot la liste paraîtrait vide et écraserait le modèle choisi par l'utilisateur).
export function useBoardUpChoices(target: "video" | "image" | "any"): { ready: boolean; choices: BoardUpChoice[] } {
  const { ready, has } = useInstalledModels();
  const { status } = useCompatibility();
  const choices = useMemo(
    () => BOARD_UP_CHOICES.filter((c) => {
      if (c.engine === "turbo") {
        if (!isModelCompatible(c.value, status)) return false;
        if (isRtxShader(c.value as ShaderModel)) return target !== "image" && RTX_RUNTIME_IDS.every(has);
        const runtime = shaderRuntimeModel(c.value as ShaderModel);
        return !runtime || has(runtime);
      }
      return has(c.value) && isModelCompatible(c.value, status);
    }),
    [target, has, status],
  );
  return { ready, choices };
}
