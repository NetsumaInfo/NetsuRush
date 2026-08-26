import type { UpSource } from "./upscaleShared";

// Still-image and image-sequence output for the process hub. Every op writes either a video, one
// image (still source) or a numbered sequence (video source), so the contract lives in one place:
// renderer settings, the payload sent to core, and the file names shown before the run.

export type ProcOutputKind = "video" | "sequence" | "image";
export type ProcImageFormat = "png" | "jpeg";

// PNG compression is lossless whatever the level: only encode time and file size change.
export const PNG_LEVELS = [1, 6, 9] as const;
export const PNG_BITS = [8, 16] as const;
export const SEQ_PADDINGS = [4, 5, 6, 8] as const;

export interface ImageOutputSettings {
  // What the user asked for. A still source always writes one image, whatever this holds.
  outputKind: "video" | "sequence";
  imageFormat: ProcImageFormat;
  pngBits: 8 | 16;
  pngCompression: number;   // 0..9, ffmpeg -compression_level
  jpegQuality: number;      // 1..100, mapped to mjpeg -q:v by the sidecar
  seqPadding: number;       // digits in the frame counter
  seqStart: number;         // first frame number
}

export const DEFAULT_IMAGE_OUTPUT: ImageOutputSettings = {
  outputKind: "video",
  imageFormat: "png",
  pngBits: 8,
  pngCompression: 6,
  jpegQuality: 92,
  seqPadding: 6,
  seqStart: 1,
};

// Still sources the hub accepts. GIF stays out on purpose: it is decoded as a video so an animated
// GIF keeps its frames instead of collapsing to its first one.
const STILL_RE = /\.(?:png|jpe?g|webp|bmp|tiff?|tga|dpx|exr|jfif)$/i;

export const isStillSource = (source: { path: string }): boolean => STILL_RE.test(source.path);

export const imageExt = (format: ProcImageFormat): string => (format === "jpeg" ? "jpg" : "png");

/** What this source will actually produce: a still source can only write one image. */
export function outputKindFor(settings: ImageOutputSettings, source?: UpSource | null): ProcOutputKind {
  if (source && isStillSource(source)) return "image";
  return settings.outputKind === "sequence" ? "sequence" : "video";
}

/** True when at least one source of the batch is a still image. */
export const hasStillSource = (sources: UpSource[]): boolean => sources.some(isStillSource);

/** Frame pattern of a sequence, as the sidecar will number it ("clip_000001.png"). */
export function sequenceSample(base: string, settings: ImageOutputSettings): string {
  const n = String(Math.max(0, settings.seqStart | 0)).padStart(settings.seqPadding, "0");
  return `${base}_${n}.${imageExt(settings.imageFormat)}`;
}

/**
 * File the run will write for this source, as shown in the naming preview. A sequence lands in its
 * OWN folder (hundreds of files next to the videos would be unusable), hence the "folder/frame" form.
 */
export function outputSample(base: string, kind: ProcOutputKind, settings: ImageOutputSettings, videoExt: string): string {
  if (kind === "image") return `${base}.${imageExt(settings.imageFormat)}`;
  if (kind === "sequence") return `${base}/${sequenceSample(base, settings)}`;
  return `${base}.${videoExt}`;
}

/** Settings block sent to core (same field names all the way down to the Python sidecars). */
export function imageOutputPayload(settings: ImageOutputSettings, kind: ProcOutputKind) {
  return {
    outputKind: kind,
    imageFormat: settings.imageFormat,
    pngBits: settings.pngBits,
    pngCompression: settings.pngCompression,
    jpegQuality: settings.jpegQuality,
    seqPadding: settings.seqPadding,
    seqStart: settings.seqStart,
  };
}

/** Coerces a persisted block (older builds had no image output at all). */
export function coerceImageOutput(saved: Partial<ImageOutputSettings> | null | undefined): ImageOutputSettings {
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };
  return {
    outputKind: saved?.outputKind === "sequence" ? "sequence" : "video",
    imageFormat: saved?.imageFormat === "jpeg" ? "jpeg" : "png",
    pngBits: saved?.pngBits === 16 ? 16 : 8,
    pngCompression: clamp(saved?.pngCompression, 0, 9, DEFAULT_IMAGE_OUTPUT.pngCompression),
    jpegQuality: clamp(saved?.jpegQuality, 1, 100, DEFAULT_IMAGE_OUTPUT.jpegQuality),
    seqPadding: clamp(saved?.seqPadding, 3, 8, DEFAULT_IMAGE_OUTPUT.seqPadding),
    seqStart: clamp(saved?.seqStart, 0, 999999, DEFAULT_IMAGE_OUTPUT.seqStart),
  };
}
