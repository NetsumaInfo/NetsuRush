// Extraction de palette d'une sélection de médias.
//
// Moteur : quantizer Celebi + scoring de @material/material-color-utilities (Apache-2.0, sans
// dépendance) — quantification en espace HCT, perceptuellement juste, très au-dessus d'un median-cut
// RGB classique. Par-dessus, ce qui est PROPRE au board :
//   - on échantillonne ce qui est VU (rognage, miroirs et niveaux de gris appliqués), pas le fichier ;
//   - plusieurs médias sont agrégés en une seule quantification, chacun pondéré par sa surface
//     AFFICHÉE : une grande référence pèse plus qu'une vignette posée à côté ;
//   - le budget de pixels est plafonné, donc le coût ne dépend pas du poids des images.
//
// Limite connue : un média dont les pixels ne sont pas lisibles (iframe YouTube/embed, ou source
// distante qui teinte le canvas) est ignoré et compté dans `skipped`.

import { QuantizerCelebi, Score, Hct, hexFromArgb, argbFromRgb } from "@material/material-color-utilities";
import type { BoardItem } from "./referenceShared";

export const PALETTE_MIN = 3;
export const PALETTE_MAX = 12;

// Budget total d'échantillons : ~90 000 pixels suffisent à décrire une planche entière et gardent
// la quantification sous la centaine de millisecondes.
const PIXEL_BUDGET = 90_000;
// Côté max d'un média rééchantillonné (le détail fin ne change pas une palette).
const SIDE_MAX = 220;
// Kinds dont les pixels sont accessibles.
const SAMPLEABLE = new Set(["image", "video", "sequence"]);

export interface PaletteResult {
  colors: string[];
  skipped: number;   // médias ignorés (iframe, pixels illisibles)
  sampled: number;   // médias réellement échantillonnés
}

// Élément vivant de l'item à l'écran : c'est la source la plus fidèle (frame courante d'une vidéo,
// image déjà décodée) et elle évite un second téléchargement.
function liveMedia(id: string): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | null {
  const root = document.querySelector(`[data-board-item="${CSS.escape(id)}"]`);
  return root?.querySelector("video, img, canvas") ?? null;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function naturalSize(el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight };
  if (el instanceof HTMLCanvasElement) return { w: el.width, h: el.height };
  return { w: el.naturalWidth, h: el.naturalHeight };
}

// Dessine le média dans un canvas hors écran, en appliquant le rognage de l'item, puis renvoie les
// pixels ARGB. `budget` borne le nombre d'échantillons rendus (pondération par surface affichée).
function pixelsFrom(el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, item: BoardItem, budget: number): number[] | null {
  const nat = naturalSize(el);
  if (!nat.w || !nat.h) return null;

  const crop = item.crop;
  const sx = crop ? crop.x * nat.w : 0;
  const sy = crop ? crop.y * nat.h : 0;
  const sw = crop ? Math.max(1, crop.w * nat.w) : nat.w;
  const sh = crop ? Math.max(1, crop.h * nat.h) : nat.h;

  const side = Math.min(SIDE_MAX, Math.max(16, Math.floor(Math.sqrt(budget * (sw / sh)))));
  const dw = Math.max(1, Math.min(SIDE_MAX, side));
  const dh = Math.max(1, Math.min(SIDE_MAX, Math.round((dw * sh) / sw)));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Le miroir ne change pas l'ensemble des couleurs : inutile de le reproduire ici.
  if (item.grayscale) ctx.filter = "grayscale(1)";
  try {
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, dw, dh);
  } catch {
    return null; // source non dessinable
  }

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, dw, dh).data;
  } catch {
    return null; // canvas teinté (source d'une autre origine) — l'appelant compte le média comme ignoré
  }

  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    // Pixels quasi transparents ignorés : ils ne font pas partie de l'image telle qu'on la voit.
    if (data[i + 3] < 200) continue;
    out.push(argbFromRgb(data[i], data[i + 1], data[i + 2]));
  }
  return out;
}

// Récupère les pixels d'un item (élément vivant si présent, sinon chargement direct de la source).
async function samplePixels(item: BoardItem, budget: number): Promise<number[] | null> {
  if (!SAMPLEABLE.has(item.kind)) return null;
  const live = liveMedia(item.id);
  if (live) {
    const px = pixelsFrom(live, item, budget);
    if (px && px.length) return px;
  }
  if (!item.src) return null;
  const img = await loadImage(item.src);
  if (!img) return null;
  return pixelsFrom(img, item, budget);
}

// Extrait la palette d'une sélection. `count` = nombre de couleurs souhaité (borné 3–12).
export async function extractPalette(items: BoardItem[], count: number): Promise<PaletteResult> {
  const want = Math.max(PALETTE_MIN, Math.min(PALETTE_MAX, Math.round(count)));
  const usable = items.filter((it) => SAMPLEABLE.has(it.kind) && !it.missing && !it.loading);
  const skippedKinds = items.length - usable.length;
  if (!usable.length) return { colors: [], skipped: skippedKinds, sampled: 0 };

  // Pondération par surface AFFICHÉE : la planche dit ce qui compte, pas la définition des fichiers.
  const areas = usable.map((it) => Math.max(1, it.w * it.h));
  const total = areas.reduce((t, a) => t + a, 0);

  const pixels: number[] = [];
  let skipped = skippedKinds;
  let sampled = 0;
  for (let i = 0; i < usable.length; i++) {
    const budget = Math.max(2_000, Math.round((areas[i] / total) * PIXEL_BUDGET));
    const px = await samplePixels(usable[i], budget);
    if (!px || !px.length) { skipped++; continue; }
    sampled++;
    pixels.push(...px);
  }
  if (!pixels.length) return { colors: [], skipped, sampled: 0 };

  // 128 grappes : assez fin pour ne pas mélanger deux teintes proches, assez grossier pour rester rapide.
  const quantized = QuantizerCelebi.quantize(pixels, 128);
  // `filter: false` : le scoring de Material écarte par défaut les couleurs peu chromatiques, ce qui
  // conviendrait à un thème d'interface mais amputerait une palette de moodboard de ses gris et
  // de ses tons rompus — exactement ce qu'un dessinateur veut voir.
  const scored = Score.score(quantized, { desired: want, filter: false });

  // Complément par population si le scoring en rend moins que demandé (image très monochrome).
  const seen = new Set(scored);
  if (scored.length < want) {
    const byPop = [...quantized.entries()].sort((a, b) => b[1] - a[1]);
    for (const [argb] of byPop) {
      if (scored.length >= want) break;
      if (seen.has(argb)) continue;
      seen.add(argb);
      scored.push(argb);
    }
  }

  // Tri par teinte : une bande lisible, pas un classement de scores.
  const ordered = scored.slice(0, want).sort((a, b) => Hct.fromInt(a).hue - Hct.fromInt(b).hue);
  return { colors: ordered.map(hexFromArgb), skipped, sampled };
}
