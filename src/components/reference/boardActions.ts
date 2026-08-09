// Action « Envoyer vers le board de référence » utilisable depuis n'importe où (Media Pool,
// résultats de recherche). Ajoute l'item au board local, le pousse vers une éventuelle fenêtre
// détachée, et bascule l'app sur l'onglet Référence.

import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { useBoard } from "./useReferenceBoard";
import { kindFromPath, displaySrc, fitSize, probeNat } from "./referenceShared";

// Pose les items déposés depuis l'extérieur en cascade (pas de viewport connu hors de la board).
export async function sendPathToBoard(filePath: string, title?: string): Promise<void> {
  const kind = kindFromPath(filePath);
  if (!kind) return;
  const src = displaySrc(kind, filePath);
  const nat = await probeNat(kind, src);
  const { w, h } = fitSize(nat.w, nat.h);
  const off = (useBoard.getState().items.length % 8) * 30;
  useBoard.getState().addItem({
    kind,
    ref: filePath,
    src,
    x: 80 + off,
    y: 80 + off,
    w,
    h,
    rotation: 0,
    natW: nat.w || undefined,
    natH: nat.h || undefined,
    title: title ?? filePath.replace(/^.*[\\/]/, ""),
  });
  nr.reference?.push({ type: "path", path: filePath, title });
  useApp.getState().setTab("reference");
}
