// Native ratio measured BY THE ELEMENT THAT PAINTS → item geometry.
//
// Ingestion poses a media at a provisional size (a square for an image, 16:9 for a video) and
// reshapes it once its ratio is probed. That probe is a separate load: it can come back empty when
// the source answers late or not at all (core busy on a folder import, stream still starting), and
// the item then keeps its provisional box. Under `object-cover` that box CROPS the media — a
// portrait poster imported as a square shows its middle band only.
//
// The <img>/<video> on screen has the true dimensions, always: reshaping from there is the last
// resort that no failed probe can defeat, and it also repairs a board saved with a wrong box.
//
// The reshape keeps the item's AREA and centre: an item the user already scaled keeps its size on
// the board, it only stops being cropped. Runs at most once per ratio — geometry then matches, and
// resizing keeps the aspect locked.

import { useBoard } from "./useReferenceBoard";
import type { BoardItem } from "./referenceShared";

export function fitNatSize(id: string, natW: number, natH: number): void {
  if (!natW || !natH) return;
  const it = useBoard.getState().items.find((i) => i.id === id);
  // A cropped item's box differs from the source ratio ON PURPOSE — that is what the crop is.
  if (!it || it.crop) return;
  const patch: Partial<BoardItem> = {};
  if (it.natW !== natW || it.natH !== natH) { patch.natW = natW; patch.natH = natH; }
  const ratio = natW / natH;
  if (it.w > 0 && it.h > 0 && Math.abs(it.w / it.h - ratio) > 0.01) {
    const w = Math.round(Math.sqrt(it.w * it.h * ratio));
    const h = Math.round(w / ratio);
    Object.assign(patch, { w, h, x: it.x + (it.w - w) / 2, y: it.y + (it.h - h) / 2 });
  }
  // `record: false` — a measurement is not a user edit, it must not eat an undo step.
  if (Object.keys(patch).length) useBoard.getState().patchItem(id, patch, false);
}
