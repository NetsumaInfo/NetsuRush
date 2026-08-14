// Actions « palette » du board : extraire les couleurs d'une sélection de médias et poser le bloc
// résultant sur la planche, puis pouvoir le régénérer tant que ses sources existent.
// La mécanique d'extraction vit dans `palette.ts` ; ici, uniquement le lien avec le board.

import i18n from "@/i18n";
import { useBoard } from "./useReferenceBoard";
import { extractPalette } from "./palette";
import { boundsOf } from "./boardArrange";
import { makePaletteItem, PALETTE_HEIGHT, PALETTE_SWATCH, type BoardItem } from "./referenceShared";

// Médias exploitables : image, vidéo, séquence (une iframe n'expose pas ses pixels).
function sourceItems(items: BoardItem[], ids: string[]): BoardItem[] {
  const picked = ids.length ? items.filter((it) => ids.includes(it.id)) : items;
  return picked.filter((it) => (it.kind === "image" || it.kind === "video" || it.kind === "sequence") && !it.missing);
}

// Extrait la palette de la sélection (ou de tout le board si rien n'est sélectionné) et pose le bloc
// juste en dessous, à la largeur de ce qui a servi à l'extraire.
export async function extractPaletteToBoard(): Promise<void> {
  const st = useBoard.getState();
  const src = sourceItems(st.items, st.selectedIds);
  if (!src.length) {
    st.setNotice({ kind: "error", text: i18n.t("reference:palette.noSource") });
    return;
  }

  st.setNotice({ kind: "ok", text: i18n.t("reference:palette.working"), sticky: true });
  const res = await extractPalette(src, st.prefs.paletteSize);
  if (!res.colors.length) {
    st.setNotice({ kind: "error", text: i18n.t(res.coreDown ? "reference:palette.failedCore" : "reference:palette.failed") });
    return;
  }

  const b = boundsOf(src);
  const item = makePaletteItem(b.x, b.y + b.h + 24, res.colors, src.map((it) => it.id));
  item.w = Math.max(res.colors.length * 48, Math.min(b.w || res.colors.length * PALETTE_SWATCH, res.colors.length * PALETTE_SWATCH));
  item.h = PALETTE_HEIGHT;
  useBoard.getState().addItem(item);
  st.setNotice({
    kind: "ok",
    text: res.skipped
      ? i18n.t("reference:palette.doneSkipped", { count: res.colors.length, skipped: res.skipped })
      : i18n.t("reference:palette.done", { count: res.colors.length }),
  });
}

// Recalcule un bloc palette existant à partir de ses médias d'origine (ceux encore présents).
export async function regeneratePalette(paletteId: string): Promise<void> {
  const st = useBoard.getState();
  const block = st.items.find((it) => it.id === paletteId);
  if (!block) return;
  const src = sourceItems(st.items, block.sourceIds ?? []);
  if (!src.length) {
    st.setNotice({ kind: "error", text: i18n.t("reference:palette.sourcesGone") });
    return;
  }
  st.setNotice({ kind: "ok", text: i18n.t("reference:palette.working"), sticky: true });
  const res = await extractPalette(src, st.prefs.paletteSize);
  if (!res.colors.length) {
    st.setNotice({ kind: "error", text: i18n.t(res.coreDown ? "reference:palette.failedCore" : "reference:palette.failed") });
    return;
  }
  useBoard.getState().patchItem(paletteId, { colors: res.colors });
  st.setNotice({ kind: "ok", text: i18n.t("reference:palette.done", { count: res.colors.length }) });
}
