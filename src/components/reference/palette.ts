// Extraction de palette d'une sélection de médias.
//
// Moteur : quantizer Celebi + scoring de @material/material-color-utilities (Apache-2.0, sans
// dépendance) — quantification en espace HCT, perceptuellement juste, très au-dessus d'un median-cut
// RGB classique. Par-dessus, ce qui est PROPRE au board :
//   - on échantillonne ce qui est VU (rognage appliqué, frame courante d'une vidéo), pas le fichier ;
//   - plusieurs médias sont agrégés en une seule quantification, chacun pondéré par sa surface
//     AFFICHÉE : une grande référence pèse plus qu'une vignette posée à côté ;
//   - le budget de pixels est plafonné, donc le coût ne dépend pas du poids des images.
//
// Le point dur est la LECTURE des pixels. La coquille affiche les médias via son protocole d'asset,
// qui teinte le canvas et fait lever `getImageData` ; la voie HTTP du core, elle, dépend d'en-têtes
// CORS que la WebView n'honore pas toujours au chargement d'une <img>. D'où l'ordre :
//   1. le CORE lit le fichier SUR LE DISQUE (ffmpeg) et rend un PNG minuscule → chargé en `data:`
//      URL, donc lisible sans aucune restriction d'origine. Marche pour image, GIF et vidéo, et même
//      pour une source qu'aucun élément de la page n'a encore décodée ;
//   2. repli serveur HTTP du core en `crossOrigin="anonymous"` (source distante, asset temporaire) ;
//   3. repli élément vivant à l'écran (déjà décodé, sans restriction : blob:, data:).
// Reste ignoré ce dont les pixels sont vraiment hors d'atteinte : une iframe YouTube ou une carte embed.

import { QuantizerCelebi, Score, Hct, hexFromArgb, argbFromRgb } from "@material/material-color-utilities";
import { nr } from "@/lib/bridge";
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
  // Le core n'a jamais répondu sur la lecture de fichier. Presque toujours : la fenêtre n'a pas été
  // relancée depuis la mise à jour, donc le core en cours ne connaît pas encore ce canal. Le dire
  // vaut mieux qu'un « aucune couleur exploitable » qui n'indique rien à faire.
  coreDown: boolean;
}

// Compteurs de la voie « fichier lu par le core », pour distinguer un core muet d'une vraie image
// illisible.
interface SampleStats { coreTried: number; coreOk: number }

// Élément vivant de l'item à l'écran. Fidèle (frame courante d'une vidéo, image déjà décodée) mais
// chargé sans `crossOrigin` : le TEINDRAIT le canvas et `getImageData` lèverait. On ne s'en sert
// donc qu'en dernier recours, et l'échec de lecture est rattrapé plus bas.
function liveMedia(id: string): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | null {
  const root = document.querySelector(`[data-board-item="${CSS.escape(id)}"]`);
  return root?.querySelector("video, img, canvas") ?? null;
}

// Source LISIBLE par un canvas : le serveur HTTP du core répond avec `Access-Control-Allow-Origin: *`,
// donc une image chargée là en `crossOrigin="anonymous"` ne teinte pas le canvas — contrairement au
// protocole d'asset de la coquille, qui sert l'affichage mais interdit la relecture des pixels.
function readableSrc(ref: string): string {
  if (!ref) return "";
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref;
  try {
    return nr.mediaUrl(ref);
  } catch {
    return "";
  }
}

function loadImage(src: string, anonymous: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (anonymous) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Vidéo décodée hors écran, positionnée sur la frame voulue, en `crossOrigin="anonymous"` pour que
// ses pixels restent lisibles. Bornée dans le temps : une source lente ne bloque pas l'extraction.
function loadVideoFrame(src: string, at: number): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.muted = true;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok ? v : null);
    };
    const timer = setTimeout(() => finish(false), 8000);
    v.onerror = () => finish(false);
    v.onseeked = () => finish(true);
    v.onloadeddata = () => {
      if (at > 0 && at < (v.duration || Infinity)) v.currentTime = at;
      else finish(true);
    };
    v.src = src;
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

// Pixels d'un item, par ordre de fiabilité décroissante : fichier lu par le core → serveur HTTP du
// core en anonyme → élément vivant à l'écran. Chaque voie peut rendre un canvas teinté ou une source
// non dessinable ; tant qu'il en reste une, le média n'est pas perdu.
async function samplePixels(item: BoardItem, budget: number, stats: SampleStats): Promise<number[] | null> {
  if (!SAMPLEABLE.has(item.kind)) return null;

  const ref = item.kind === "sequence" ? item.frames?.[item.frame ?? 0] ?? item.ref : item.ref;

  // 1. Lecture par le CORE, directement sur le fichier. Le PNG rendu arrive en `data:` URL : aucune
  //    origine, donc aucun canvas teinté, quelle que soit la nature du média.
  if (ref && !/^(https?:|data:|blob:)/i.test(ref) && nr.reference?.sampleFrame) {
    stats.coreTried++;
    const shot = await nr.reference.sampleFrame(ref, {
      at: item.kind === "video" ? item.trimIn ?? 0 : 0,
      side: SIDE_MAX,
    }).catch(() => null);
    if (shot?.ok && shot.png) {
      stats.coreOk++;
      const el = await loadImage(`data:image/png;base64,${shot.png}`, false);
      if (el) {
        const px = pixelsFrom(el, item, budget);
        if (px && px.length) return px;
      }
    }
  }

  const src = readableSrc(ref);
  if (src) {
    const el = item.kind === "video"
      ? await loadVideoFrame(src, item.trimIn ?? 0)
      : await loadImage(src, true);
    if (el) {
      const px = pixelsFrom(el, item, budget);
      if (px && px.length) return px;
    }
  }

  const live = liveMedia(item.id);
  if (live) {
    const px = pixelsFrom(live, item, budget);
    if (px && px.length) return px;
  }
  return null;
}

// Extrait la palette d'une sélection. `count` = nombre de couleurs souhaité (borné 3–12).
export async function extractPalette(items: BoardItem[], count: number): Promise<PaletteResult> {
  const want = Math.max(PALETTE_MIN, Math.min(PALETTE_MAX, Math.round(count)));
  const usable = items.filter((it) => SAMPLEABLE.has(it.kind) && !it.missing && !it.loading);
  const skippedKinds = items.length - usable.length;
  const stats: SampleStats = { coreTried: 0, coreOk: 0 };
  if (!usable.length) return { colors: [], skipped: skippedKinds, sampled: 0, coreDown: false };

  // Pondération par surface AFFICHÉE : la planche dit ce qui compte, pas la définition des fichiers.
  const areas = usable.map((it) => Math.max(1, it.w * it.h));
  const total = areas.reduce((t, a) => t + a, 0);

  const pixels: number[] = [];
  let skipped = skippedKinds;
  let sampled = 0;
  for (let i = 0; i < usable.length; i++) {
    const budget = Math.max(2_000, Math.round((areas[i] / total) * PIXEL_BUDGET));
    const px = await samplePixels(usable[i], budget, stats);
    if (!px || !px.length) { skipped++; continue; }
    sampled++;
    // Concaténation par boucle : `push(...px)` passerait des dizaines de milliers d'arguments d'un
    // coup (un média échantillonné en fait jusqu'à ~48 000), ce qui heurte la limite d'arguments
    // d'un appel de fonction — la palette planterait sur les grandes sélections, pas les petites.
    for (let k = 0; k < px.length; k++) pixels.push(px[k]);
  }
  // Core muet sur TOUTES les tentatives : c'est lui le coupable, pas les images.
  const coreDown = stats.coreTried > 0 && stats.coreOk === 0;
  if (!pixels.length) return { colors: [], skipped, sampled: 0, coreDown };

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
  return { colors: ordered.map(hexFromArgb), skipped, sampled, coreDown };
}
