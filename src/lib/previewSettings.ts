import type { PreviewGenerationSettings, ThumbPreset } from "@/lib/bridge";

const PREVIEW_SETTINGS_KEY = "nr.preview-generation.v2";
export const PREVIEW_SETTINGS_EVENT = "nr:preview-settings";

export const DEFAULT_PREVIEW_SETTINGS: PreviewGenerationSettings = {
  proxy: {
    format: "h264",
    engine: "auto",
    preset: "level1",
    height: 360,
    audio: true,
  },
  thumbnail: {
    // WebP par défaut : ~25-30 % de moins que JPEG à qualité perçue égale, décodé nativement par la
    // WebView. JPEG reste offert (fichiers relisibles par n'importe quel outil externe).
    format: "webp",
    preset: "balanced",
  },
};

const HEIGHTS = new Set([360, 480, 520, 720]);
const THUMB_PRESETS: ThumbPreset[] = ["light", "balanced", "sharp"];
const THUMB_PRESET_SET = new Set<string>(THUMB_PRESETS);

// Les miniatures se réglaient par {hauteur, qualité} ; elles se règlent par CRAN. Un réglage déjà
// écrit en localStorage se replie sur le cran de sa hauteur — même règle que `presetFromLegacyHeight`
// côté core, sinon les deux normalisations calculent des clés de cache différentes.
function thumbPresetFrom(thumbnail: { preset?: unknown; height?: unknown }): ThumbPreset {
  if (typeof thumbnail.preset === "string" && THUMB_PRESET_SET.has(thumbnail.preset)) return thumbnail.preset as ThumbPreset;
  const height = Number(thumbnail.height);
  if (height === 360) return "light";
  if (height === 720) return "sharp";
  return "balanced";
}

type PartialPreviewSettings = {
  proxy?: Omit<Partial<PreviewGenerationSettings["proxy"]>, "format"> & { format?: string };
  thumbnail?: Partial<PreviewGenerationSettings["thumbnail"]> & { height?: unknown; quality?: unknown };
};

function normalizePreviewSettings(value: unknown): PreviewGenerationSettings {
  const raw: PartialPreviewSettings = value && typeof value === "object" ? value as PartialPreviewSettings : {};
  const proxy = raw.proxy ?? {};
  const thumbnail = raw.thumbnail ?? {};
  return {
    proxy: {
      format: proxy.format === "webm" || proxy.format === "webp" ? "webm" : proxy.format === "hevc" ? "hevc" : "h264",
      engine: proxy.engine === "nvenc" || proxy.engine === "amf" || proxy.engine === "qsv" || proxy.engine === "cpu" ? proxy.engine : "auto",
      preset: proxy.preset === "level2" || proxy.preset === "level3" ? proxy.preset : "level1",
      height: HEIGHTS.has(Number(proxy.height)) ? Number(proxy.height) as 360 | 480 | 520 | 720 : 480,
      audio: proxy.audio !== false,
    },
    thumbnail: {
      format: thumbnail.format === "jpeg" ? "jpeg" : "webp",
      preset: thumbPresetFrom(thumbnail),
    },
  };
}

export function readPreviewSettings(): PreviewGenerationSettings {
  if (typeof localStorage === "undefined") return DEFAULT_PREVIEW_SETTINGS;
  try {
    return normalizePreviewSettings(JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY) ?? "null"));
  } catch {
    return DEFAULT_PREVIEW_SETTINGS;
  }
}

export function writePreviewSettings(settings: PreviewGenerationSettings): PreviewGenerationSettings {
  const next = normalizePreviewSettings(settings);
  if (typeof localStorage !== "undefined") localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PREVIEW_SETTINGS_EVENT));
  return next;
}

export function previewSettingsFingerprint(settings = readPreviewSettings()): string {
  const p = settings.proxy;
  const t = settings.thumbnail;
  return `${p.format}-${p.engine}-${p.preset}-${p.height}-${p.audio ? 1 : 0}|${t.format}-${t.preset}`;
}
