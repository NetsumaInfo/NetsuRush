import type {
  DetectModel,
  DetectOptions,
  OmniInterLabel,
  OmniIntraLabel,
} from "@/lib/bridge";

export const OMNI_INTRA_LABELS: OmniIntraLabel[] = [
  "General", "Dissolve", "Wipes", "Push", "Slide", "Zoom", "Fade", "Doorway",
];

export const OMNI_INTER_LABELS: OmniInterLabel[] = [
  "New_Start", "Hard_Cut", "Transition_Source", "Transition", "Sudden_Jump",
];

export interface NormalizedDetectOptions {
  minSceneFrames: number;
  omnishotcut: {
    mode: "clean_shot" | "default";
    overlapWindowLength: number;
    intraLabels: OmniIntraLabel[];
    interLabels: OmniInterLabel[];
  };
  autoshot: { threshold: number };
}

export const DEFAULT_DETECT_OPTIONS: NormalizedDetectOptions = {
  minSceneFrames: 2,
  omnishotcut: {
    mode: "clean_shot",
    overlapWindowLength: 20,
    intraLabels: [...OMNI_INTRA_LABELS],
    interLabels: [...OMNI_INTER_LABELS],
  },
  autoshot: {
    threshold: 0.296,
  },
};

const finite = (value: unknown, fallback: number, min: number, max: number) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const subset = <T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] => {
  if (!Array.isArray(value)) return [...fallback];
  const clean = [...new Set(value.filter((item): item is T => allowed.includes(item as T)))];
  return clean.length ? clean : [...fallback];
};

export function normalizeDetectOptions(value?: DetectOptions | null): NormalizedDetectOptions {
  const omni = value?.omnishotcut;
  const auto = value?.autoshot;
  return {
    minSceneFrames: Math.round(finite(value?.minSceneFrames, 2, 1, 300)),
    omnishotcut: {
      mode: omni?.mode === "default" ? "default" : "clean_shot",
      overlapWindowLength: Math.round(finite(omni?.overlapWindowLength, 20, 0, 239)),
      intraLabels: subset(omni?.intraLabels, OMNI_INTRA_LABELS, OMNI_INTRA_LABELS),
      interLabels: subset(omni?.interLabels, OMNI_INTER_LABELS, OMNI_INTER_LABELS),
    },
    autoshot: {
      threshold: finite(auto?.threshold, 0.296, 0.01, 0.99),
    },
  };
}

export function detectionOptionsFor(model: DetectModel, value?: DetectOptions | null): DetectOptions {
  const normalized = normalizeDetectOptions(value);
  if (model === "omnishotcut") return { minSceneFrames: normalized.minSceneFrames, omnishotcut: normalized.omnishotcut };
  if (model === "autoshot") return { minSceneFrames: normalized.minSceneFrames, autoshot: normalized.autoshot };
  return { minSceneFrames: normalized.minSceneFrames };
}

export function modelUsesPreset(model: DetectModel): boolean {
  return model === "transnetv2";
}

export function detectionThreshold(model: DetectModel, presetThreshold: number, value?: DetectOptions | null): number {
  if (model === "transnetv2") return presetThreshold;
  if (model === "autoshot") return normalizeDetectOptions(value).autoshot.threshold;
  return 0;
}

export function detectionOptionsKey(model: DetectModel, value?: DetectOptions | null): string {
  return JSON.stringify(detectionOptionsFor(model, value));
}
