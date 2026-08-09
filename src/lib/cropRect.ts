// Géométrie d'un rectangle de rognage NORMALISÉ (0..1 sur l'image source). Module PUR : aucune
// dépendance au DOM ni au store, donc vérifiable sans runtime.
//
// Le rectangle ne sort jamais de l'image : une poignée tirée trop loin s'arrête au bord plutôt que
// de produire une plage vide, qui donnerait un fond noir sans rien dire à l'utilisateur.

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropHandle = "nw" | "ne" | "sw" | "se";

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** Sous cette taille, le rectangle n'est plus saisissable et l'agrandissement devient absurde. */
const MIN_SIZE = 0.05;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function cropIsFull(rect: CropRect): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;
}

/** Déplace le rectangle sans changer sa taille ; il bute sur les bords de l'image. */
export function moveCrop(rect: CropRect, dx: number, dy: number): CropRect {
  return {
    ...rect,
    x: Math.min(Math.max(0, rect.x + dx), 1 - rect.w),
    y: Math.min(Math.max(0, rect.y + dy), 1 - rect.h),
  };
}

/**
 * Redimensionne par un coin. `ratio` verrouille la forme (largeur/hauteur en unités d'IMAGE, donc
 * déjà corrigé du format de la source par l'appelant) ; `null` laisse la forme libre.
 */
export function resizeCrop(rect: CropRect, handle: CropHandle, dx: number, dy: number, ratio: number | null): CropRect {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const west = handle === "nw" || handle === "sw";
  const north = handle === "nw" || handle === "ne";

  let x = west ? clamp01(rect.x + dx) : rect.x;
  let y = north ? clamp01(rect.y + dy) : rect.y;
  let w = west ? right - x : clamp01(right + dx) - x;
  let h = north ? bottom - y : clamp01(bottom + dy) - y;

  if (ratio) {
    // La dimension la plus contrainte gagne : sinon le rectangle « glisse » hors de l'image dès que
    // le pointeur dépasse un bord.
    h = w / ratio;
    if (north) y = bottom - h;
    if (y < 0 || y + h > 1) {
      h = north ? bottom : 1 - y;
      w = h * ratio;
      if (west) x = right - w;
      if (north) y = bottom - h;
    }
  }

  if (w < MIN_SIZE) {
    w = MIN_SIZE;
    if (west) x = right - w;
    if (ratio) h = w / ratio;
  }
  if (h < MIN_SIZE) {
    h = MIN_SIZE;
    if (north) y = bottom - h;
    if (ratio) w = h * ratio;
  }

  return {
    x: clamp01(Math.min(x, 1 - w)),
    y: clamp01(Math.min(y, 1 - h)),
    w: Math.min(w, 1),
    h: Math.min(h, 1),
  };
}

/** Le plus grand rectangle du ratio demandé, centré dans l'image. */
export function centeredCrop(ratio: number | null): CropRect {
  if (!ratio) return FULL_CROP;
  const w = ratio >= 1 ? 1 : ratio;
  const h = ratio >= 1 ? 1 / ratio : 1;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
