// Rendu du board HORS DOM : on repart du MODÈLE (liste d'items + tracés) et on peint, soit dans un
// <canvas> (PNG/JPG, presse-papiers), soit en SVG. Rasteriser le DOM ne marcherait pas : une balise
// <video> et une iframe ne se capturent pas, et les transformations CSS du board fausseraient
// l'échelle. Ici, chaque type d'item sait se peindre, dans l'ordre des z, exactement comme à l'écran.
//
// Les tracés liés à un média sont résolus AVANT rendu (cf. drawAnchor) : l'export montre ce que
// l'utilisateur voit, pas les coordonnées stockées.

import type { BoardItem, DrawShape } from "./referenceShared";
import { rotatedBBox } from "./boardArrange";
import { resolveShapes } from "./drawAnchor";
import { connectorPath, penPath, shapeBBox } from "./drawGeometry";

export interface RenderOptions {
  // Largeur de sortie en pixels ; à défaut, la taille naturelle du contenu (+ marge).
  width?: number;
  // Marge autour du contenu, en fraction du plus grand côté (0,03 = 3 %, comme les visionneuses).
  marginRatio?: number;
  // Fond ; `null` = transparent (PNG uniquement).
  background?: string | null;
  // Rendre uniquement ces items (export de la sélection).
  only?: Set<string>;
}

const DEFAULT_MARGIN = 0.03;
const TEXT_PAD = 12;          // p-3 de la note à l'écran
const INDENT_STEP = 24;
const UI_FONT = "Inter, system-ui, sans-serif";

// Kinds sans pixels propres (iframe) : rendus en cartouche titré.
const CARD_KINDS = new Set(["youtube", "embed"]);

function visibleItems(items: BoardItem[], only?: Set<string>): BoardItem[] {
  return items
    .filter((it) => it.kind !== "draw" && (!only || only.has(it.id)))
    .sort((a, b) => a.z - b.z);
}

function shapesOf(items: BoardItem[]): DrawShape[] {
  const layer = items.find((it) => it.kind === "draw");
  if (!layer?.shapes?.length) return [];
  return resolveShapes(layer.shapes, items);
}

// Emprise du contenu : items (rotation comprise) + tracés.
export function contentBounds(items: BoardItem[], only?: Set<string>): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of visibleItems(items, only)) {
    const b = rotatedBBox(it);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!only) {
    for (const s of shapesOf(items)) {
      const [a, b, c, d] = shapeBBox(s);
      minX = Math.min(minX, a); minY = Math.min(minY, b);
      maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Taille de sortie par défaut (contenu + marge), utilisée pour pré-remplir le dialogue d'export.
export function defaultExportSize(items: BoardItem[], only?: Set<string>, marginRatio = DEFAULT_MARGIN): { w: number; h: number } {
  const b = contentBounds(items, only);
  const m = Math.max(b.w, b.h) * marginRatio;
  return { w: Math.max(1, Math.round(b.w + 2 * m)), h: Math.max(1, Math.round(b.h + 2 * m)) };
}

// ── Sources de pixels ────────────────────────────────────────────────────────

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

function naturalSize(el: CanvasImageSource): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight };
  if (el instanceof HTMLCanvasElement) return { w: el.width, h: el.height };
  if (el instanceof HTMLImageElement) return { w: el.naturalWidth, h: el.naturalHeight };
  return { w: 0, h: 0 };
}

// Élément peignable d'un média : l'élément vivant si l'item est monté (frame courante d'une vidéo),
// sinon un chargement direct de la source.
async function mediaSource(item: BoardItem): Promise<CanvasImageSource | null> {
  const live = liveMedia(item.id);
  if (live && naturalSize(live).w) return live;
  if (!item.src) return null;
  return await loadImage(item.src);
}

// ── Rendu canvas ─────────────────────────────────────────────────────────────

function applyItemTransform(ctx: CanvasRenderingContext2D, item: BoardItem): void {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  ctx.translate(cx, cy);
  if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);
  if (item.flipH || item.flipV) ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
  ctx.translate(-item.w / 2, -item.h / 2);
}

function drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Découpe un texte en lignes tenant dans `maxWidth` (respecte les retours à la ligne saisis).
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { lines.push(""); continue; }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const candidate = line + word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function paintText(ctx: CanvasRenderingContext2D, item: BoardItem): void {
  const size = item.fontSize ?? 18;
  const font = item.fontFamily ?? UI_FONT;
  const lh = (item.lineHeight ?? 1.2) * size;
  const padLeft = TEXT_PAD + (item.indent ? item.indent * INDENT_STEP : 0);

  if (item.bg && item.bg !== "transparent") {
    ctx.fillStyle = item.bg;
    drawRoundRect(ctx, 0, 0, item.w, item.h, 4);
    ctx.fill();
  }

  const weight = item.bold ? "700" : "400";
  const style = item.italic ? "italic " : "";
  ctx.font = `${style}${weight} ${size}px ${font}`;
  ctx.textBaseline = "top";
  const maxW = Math.max(1, item.w - padLeft - TEXT_PAD);
  const lines = wrapText(ctx, item.text ?? "", maxW);
  const align = item.align ?? "left";
  ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  const anchorX = align === "center" ? item.w / 2 : align === "right" ? item.w - TEXT_PAD : padLeft;

  lines.forEach((line, i) => {
    const y = TEXT_PAD + i * lh;
    if (item.highlight && item.highlight !== "transparent" && line) {
      const w = ctx.measureText(line).width;
      const x = align === "center" ? anchorX - w / 2 : align === "right" ? anchorX - w : anchorX;
      ctx.fillStyle = item.highlight;
      ctx.fillRect(x - 2, y - 1, w + 4, lh);
    }
    ctx.fillStyle = item.color ?? "#ffffff";
    ctx.fillText(line, anchorX, y);
    if (item.strike || item.underline) {
      const w = ctx.measureText(line).width;
      const x = align === "center" ? anchorX - w / 2 : align === "right" ? anchorX - w : anchorX;
      ctx.fillRect(x, y + (item.strike ? size * 0.55 : size * 1.02), w, Math.max(1, size * 0.06));
    }
  });
  ctx.textAlign = "left";
}

function paintFrame(ctx: CanvasRenderingContext2D, item: BoardItem): void {
  const color = item.color ?? "#8b8b94";
  const fillMode = item.fillMode ?? (item.filled ? "solid" : "tint");
  if (fillMode !== "none") {
    ctx.save();
    ctx.globalAlpha = fillMode === "solid" ? 1 : 0.09;
    ctx.fillStyle = fillMode === "solid" ? item.fillColor ?? color : color;
    drawRoundRect(ctx, 0, 0, item.w, item.h, 8);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  drawRoundRect(ctx, 0.75, 0.75, item.w - 1.5, item.h - 1.5, 8);
  ctx.stroke();
  ctx.restore();

  if (item.text) {
    const size = item.fontSize ?? 14;
    ctx.font = `500 ${size}px ${item.fontFamily ?? UI_FONT}`;
    ctx.textBaseline = "middle";
    const w = ctx.measureText(item.text).width;
    const h = size * 1.6;
    ctx.fillStyle = item.titleBg && item.titleBg !== "transparent" ? item.titleBg : "#17171b";
    drawRoundRect(ctx, 12, -h / 2, w + 16, h, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(item.text, 20, 0);
  }
}

function paintPalette(ctx: CanvasRenderingContext2D, item: BoardItem): void {
  const colors = item.colors ?? [];
  ctx.fillStyle = "#17171b";
  drawRoundRect(ctx, 0, 0, item.w, item.h, 8);
  ctx.fill();
  if (!colors.length) return;
  const top = item.title ? 20 : 6;
  const pad = 6;
  const gap = 4;
  const cw = (item.w - pad * 2 - gap * (colors.length - 1)) / colors.length;
  const ch = item.h - top - pad;
  if (item.title) {
    ctx.font = `500 11px ${UI_FONT}`;
    ctx.fillStyle = "#9b9ba4";
    ctx.textBaseline = "top";
    ctx.fillText(item.title, pad + 4, 6);
  }
  colors.forEach((hex, i) => {
    ctx.fillStyle = hex;
    drawRoundRect(ctx, pad + i * (cw + gap), top, cw, ch, 6);
    ctx.fill();
    if (item.showHex !== false) {
      ctx.font = `500 10px ${UI_FONT}`;
      ctx.fillStyle = readableOn(hex);
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(hex.toUpperCase(), pad + i * (cw + gap) + cw / 2, top + ch - 4, cw - 4);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }
  });
}

function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#0b0b0e" : "#ffffff";
}

function paintCard(ctx: CanvasRenderingContext2D, item: BoardItem): void {
  ctx.fillStyle = "#1c1c21";
  drawRoundRect(ctx, 0, 0, item.w, item.h, 6);
  ctx.fill();
  ctx.font = `500 13px ${UI_FONT}`;
  ctx.fillStyle = "#c9c9d1";
  ctx.textBaseline = "middle";
  const label = item.title || item.ref || "";
  ctx.fillText(label.slice(0, 60), 12, item.h / 2, Math.max(10, item.w - 24));
}

async function paintItem(ctx: CanvasRenderingContext2D, item: BoardItem): Promise<void> {
  ctx.save();
  ctx.globalAlpha = item.opacity ?? 1;
  applyItemTransform(ctx, item);

  if (item.kind === "text") paintText(ctx, item);
  else if (item.kind === "frame") paintFrame(ctx, item);
  else if (item.kind === "palette") paintPalette(ctx, item);
  else if (CARD_KINDS.has(item.kind)) paintCard(ctx, item);
  else {
    const src = await mediaSource(item);
    if (!src) {
      paintCard(ctx, item);
    } else {
      const nat = naturalSize(src);
      const crop = item.crop;
      const sx = crop ? crop.x * nat.w : 0;
      const sy = crop ? crop.y * nat.h : 0;
      const sw = crop ? Math.max(1, crop.w * nat.w) : nat.w;
      const sh = crop ? Math.max(1, crop.h * nat.h) : nat.h;
      if (item.grayscale) ctx.filter = "grayscale(1)";
      try {
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, item.w, item.h);
      } catch {
        paintCard(ctx, item);
      }
      ctx.filter = "none";
    }
  }
  ctx.restore();
}

function paintHead(ctx: CanvasRenderingContext2D, type: string, tx: number, ty: number, ang: number, len: number, color: string, w: number): void {
  if (!type || type === "none") return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (type === "dot") {
    ctx.beginPath();
    ctx.arc(tx, ty, w * 1.6, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "bar") {
    const a = ang + Math.PI / 2;
    const hx = Math.cos(a) * w * 2.2;
    const hy = Math.sin(a) * w * 2.2;
    ctx.beginPath();
    ctx.moveTo(tx - hx, ty - hy);
    ctx.lineTo(tx + hx, ty + hy);
    ctx.stroke();
  } else {
    const a1 = ang + Math.PI * 0.82;
    const a2 = ang - Math.PI * 0.82;
    const p1x = tx + Math.cos(a1) * len, p1y = ty + Math.sin(a1) * len;
    const p2x = tx + Math.cos(a2) * len, p2y = ty + Math.sin(a2) * len;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(p1x, p1y);
    if (type === "triangle") {
      ctx.lineTo(p2x, p2y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.moveTo(tx, ty);
      ctx.lineTo(p2x, p2y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function dashFor(shape: DrawShape): number[] {
  if (shape.dash === "dashed") return [shape.w * 3, shape.w * 2];
  if (shape.dash === "dotted") return [0.1, shape.w * 2];
  return [];
}

function paintShape(ctx: CanvasRenderingContext2D, s: DrawShape): void {
  ctx.save();
  ctx.globalAlpha = s.op != null && s.op < 1 ? s.op : 1;
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashFor(s));

  if (s.t === "pen") {
    ctx.stroke(new Path2D(penPath(s.p)));
  } else if (s.t === "line" || s.t === "arrow") {
    const { d, startAng, endAng } = connectorPath(s);
    ctx.stroke(new Path2D(d));
    ctx.setLineDash([]);
    const [x1, y1, x2, y2] = s.p;
    const len = Math.max(s.w * 3.5, Math.hypot(x2 - x1, y2 - y1) * 0.18);
    paintHead(ctx, s.h1 ?? "none", x1, y1, startAng, len, s.c, s.w);
    paintHead(ctx, s.h2 ?? (s.t === "arrow" ? "arrow" : "none"), x2, y2, endAng, len, s.c, s.w);
  } else if (s.t === "rect") {
    const x = Math.min(s.p[0], s.p[2]), y = Math.min(s.p[1], s.p[3]);
    const w = Math.abs(s.p[2] - s.p[0]), h = Math.abs(s.p[3] - s.p[1]);
    const r = s.r ? Math.min(w, h) * 0.12 : 0;
    drawRoundRect(ctx, x, y, w, h, r);
    if (s.fill && s.fill !== "none") { ctx.fillStyle = s.fill; ctx.fill(); }
    ctx.stroke();
  } else if (s.t === "ellipse") {
    const cx = (s.p[0] + s.p[2]) / 2, cy = (s.p[1] + s.p[3]) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(s.p[2] - s.p[0]) / 2, Math.abs(s.p[3] - s.p[1]) / 2, 0, 0, Math.PI * 2);
    if (s.fill && s.fill !== "none") { ctx.fillStyle = s.fill; ctx.fill(); }
    ctx.stroke();
  } else if (s.t === "diamond") {
    const x0 = Math.min(s.p[0], s.p[2]), y0 = Math.min(s.p[1], s.p[3]);
    const x1 = Math.max(s.p[0], s.p[2]), y1 = Math.max(s.p[1], s.p[3]);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, y0);
    ctx.lineTo(x1, cy);
    ctx.lineTo(cx, y1);
    ctx.lineTo(x0, cy);
    ctx.closePath();
    if (s.fill && s.fill !== "none") { ctx.fillStyle = s.fill; ctx.fill(); }
    ctx.stroke();
  } else if (s.t === "text" && s.text) {
    ctx.fillStyle = s.c;
    ctx.font = `${s.w}px ${UI_FONT}`;
    ctx.textBaseline = "top";
    ctx.fillText(s.text, s.p[0], s.p[1]);
  }
  ctx.restore();
}

// Peint tout le board dans un canvas. `width` fixe la largeur de sortie (la hauteur suit le ratio).
export async function renderBoardCanvas(items: BoardItem[], opts: RenderOptions = {}): Promise<HTMLCanvasElement> {
  const marginRatio = opts.marginRatio ?? DEFAULT_MARGIN;
  const bounds = contentBounds(items, opts.only);
  const margin = Math.max(bounds.w, bounds.h) * marginRatio;
  const natW = Math.max(1, bounds.w + 2 * margin);
  const natH = Math.max(1, bounds.h + 2 * margin);
  const outW = Math.max(1, Math.round(opts.width ?? natW));
  const scale = outW / natW;
  const outH = Math.max(1, Math.round(natH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.scale(scale, scale);
  ctx.translate(margin - bounds.x, margin - bounds.y);

  const layer = items.find((it) => it.kind === "draw");
  const shapes = shapesOf(items);
  const drawBehind = false; // le calque de dessin d'un export suit l'ordre visible : au-dessus.

  if (drawBehind) shapes.forEach((s) => paintShape(ctx, s));
  for (const item of visibleItems(items, opts.only)) await paintItem(ctx, item);
  if (!drawBehind && layer && !opts.only) shapes.forEach((s) => paintShape(ctx, s));

  return canvas;
}

// PNG d'un seul item, à sa taille affichée — utilisé par « Copier » (presse-papiers système).
export async function itemToPngBlob(item: BoardItem): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(item.w));
  canvas.height = Math.max(1, Math.round(item.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // L'item est peint à l'origine : on annule sa position monde.
  const shifted: BoardItem = { ...item, x: 0, y: 0, rotation: 0 };
  await paintItem(ctx, shifted);
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

// ── Rendu SVG ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function itemTransform(item: BoardItem): string {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const parts = [`translate(${cx} ${cy})`];
  if (item.rotation) parts.push(`rotate(${item.rotation})`);
  if (item.flipH || item.flipV) parts.push(`scale(${item.flipH ? -1 : 1} ${item.flipV ? -1 : 1})`);
  parts.push(`translate(${-item.w / 2} ${-item.h / 2})`);
  return parts.join(" ");
}

// Média → data: URL (le SVG doit être autonome, un chemin local ne s'ouvrirait nulle part ailleurs).
async function mediaDataUrl(item: BoardItem): Promise<string | null> {
  const src = await mediaSource(item);
  if (!src) return null;
  const nat = naturalSize(src);
  if (!nat.w || !nat.h) return null;
  const crop = item.crop;
  const sx = crop ? crop.x * nat.w : 0;
  const sy = crop ? crop.y * nat.h : 0;
  const sw = crop ? Math.max(1, crop.w * nat.w) : nat.w;
  const sh = crop ? Math.max(1, crop.h * nat.h) : nat.h;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (item.grayscale) ctx.filter = "grayscale(1)";
  try {
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null; // source non lisible (canvas teinté) → cartouche à la place
  }
}

function svgShape(s: DrawShape): string {
  const dash = s.dash === "dashed" ? ` stroke-dasharray="${s.w * 3} ${s.w * 2}"`
    : s.dash === "dotted" ? ` stroke-dasharray="0.1 ${s.w * 2}"` : "";
  const op = s.op != null && s.op < 1 ? ` opacity="${s.op}"` : "";
  const common = `fill="${s.fill && s.fill !== "none" ? s.fill : "none"}" stroke="${s.c}" stroke-width="${s.w}" stroke-linecap="round" stroke-linejoin="round"${dash}${op}`;
  if (s.t === "pen") return `<path d="${penPath(s.p)}" ${common} fill="none"/>`;
  if (s.t === "line" || s.t === "arrow") return `<path d="${connectorPath(s).d}" ${common} fill="none"/>`;
  if (s.t === "rect") {
    const x = Math.min(s.p[0], s.p[2]), y = Math.min(s.p[1], s.p[3]);
    const w = Math.abs(s.p[2] - s.p[0]), h = Math.abs(s.p[3] - s.p[1]);
    const r = s.r ? ` rx="${Math.min(w, h) * 0.12}"` : "";
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${r} ${common}/>`;
  }
  if (s.t === "ellipse") {
    const cx = (s.p[0] + s.p[2]) / 2, cy = (s.p[1] + s.p[3]) / 2;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${Math.abs(s.p[2] - s.p[0]) / 2}" ry="${Math.abs(s.p[3] - s.p[1]) / 2}" ${common}/>`;
  }
  if (s.t === "diamond") {
    const x0 = Math.min(s.p[0], s.p[2]), y0 = Math.min(s.p[1], s.p[3]);
    const x1 = Math.max(s.p[0], s.p[2]), y1 = Math.max(s.p[1], s.p[3]);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return `<polygon points="${cx},${y0} ${x1},${cy} ${cx},${y1} ${x0},${cy}" ${common}/>`;
  }
  return `<text x="${s.p[0]}" y="${s.p[1]}" fill="${s.c}" font-size="${s.w}" dominant-baseline="hanging">${esc(s.text ?? "")}</text>`;
}

async function svgItem(item: BoardItem): Promise<string> {
  const t = ` transform="${itemTransform(item)}"`;
  const op = item.opacity != null && item.opacity < 1 ? ` opacity="${item.opacity}"` : "";

  if (item.kind === "text") {
    const size = item.fontSize ?? 18;
    const lh = (item.lineHeight ?? 1.2) * size;
    const lines = (item.text ?? "").split("\n");
    const bg = item.bg && item.bg !== "transparent"
      ? `<rect width="${item.w}" height="${item.h}" rx="4" fill="${item.bg}"/>` : "";
    const style = `font-family:${item.fontFamily ?? UI_FONT};font-size:${size}px;font-weight:${item.bold ? 700 : 400};${item.italic ? "font-style:italic;" : ""}`;
    const spans = lines
      .map((l, i) => `<tspan x="${TEXT_PAD}" y="${TEXT_PAD + i * lh}">${esc(l)}</tspan>`)
      .join("");
    return `<g${t}${op}>${bg}<text fill="${item.color ?? "#ffffff"}" style="${style}" dominant-baseline="hanging">${spans}</text></g>`;
  }

  if (item.kind === "frame") {
    const color = item.color ?? "#8b8b94";
    const fillMode = item.fillMode ?? (item.filled ? "solid" : "tint");
    const fill = fillMode === "solid" ? `fill="${item.fillColor ?? color}"`
      : fillMode === "none" ? `fill="none"` : `fill="${color}" fill-opacity="0.09"`;
    const label = item.text
      ? `<text x="20" y="0" fill="${color}" font-family="${UI_FONT}" font-size="${item.fontSize ?? 14}" dominant-baseline="middle">${esc(item.text)}</text>`
      : "";
    return `<g${t}${op}><rect width="${item.w}" height="${item.h}" rx="8" ${fill} stroke="${color}" stroke-opacity="0.7" stroke-width="1.5"/>${label}</g>`;
  }

  if (item.kind === "palette") {
    const colors = item.colors ?? [];
    const top = item.title ? 20 : 6;
    const pad = 6, gap = 4;
    const cw = colors.length ? (item.w - pad * 2 - gap * (colors.length - 1)) / colors.length : 0;
    const ch = item.h - top - pad;
    const swatches = colors
      .map((hex, i) => `<rect x="${pad + i * (cw + gap)}" y="${top}" width="${cw}" height="${ch}" rx="6" fill="${hex}"/>`)
      .join("");
    const title = item.title
      ? `<text x="10" y="6" fill="#9b9ba4" font-family="${UI_FONT}" font-size="11" dominant-baseline="hanging">${esc(item.title)}</text>` : "";
    return `<g${t}${op}><rect width="${item.w}" height="${item.h}" rx="8" fill="#17171b"/>${title}${swatches}</g>`;
  }

  const href = CARD_KINDS.has(item.kind) ? null : await mediaDataUrl(item);
  if (!href) {
    const label = esc((item.title || item.ref || "").slice(0, 60));
    return `<g${t}${op}><rect width="${item.w}" height="${item.h}" rx="6" fill="#1c1c21"/><text x="12" y="${item.h / 2}" fill="#c9c9d1" font-family="${UI_FONT}" font-size="13" dominant-baseline="middle">${label}</text></g>`;
  }
  return `<g${t}${op}><image href="${href}" width="${item.w}" height="${item.h}" preserveAspectRatio="none"/></g>`;
}

// Board → SVG autonome. Les tracés restent VECTORIELS ; les médias sont embarqués en base64.
export async function renderBoardSvg(items: BoardItem[], opts: RenderOptions = {}): Promise<string> {
  const marginRatio = opts.marginRatio ?? DEFAULT_MARGIN;
  const bounds = contentBounds(items, opts.only);
  const margin = Math.max(bounds.w, bounds.h) * marginRatio;
  const w = Math.max(1, Math.round(bounds.w + 2 * margin));
  const h = Math.max(1, Math.round(bounds.h + 2 * margin));

  const parts: string[] = [];
  for (const item of visibleItems(items, opts.only)) parts.push(await svgItem(item));
  if (!opts.only) for (const s of shapesOf(items)) parts.push(svgShape(s));

  const bg = opts.background ? `<rect width="${w}" height="${h}" fill="${opts.background}"/>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    bg,
    `<g transform="translate(${margin - bounds.x} ${margin - bounds.y})">`,
    ...parts,
    "</g></svg>",
  ].join("");
}
