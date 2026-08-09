import type { FrameCompare, FrameCompareVariant } from "./useProcSources";
import type { UpSettings } from "./upscaleShared";

export interface UpscaleModelResult {
  sourceKey: string;
  configKey: string;
  time: number;
  origUrl: string;
  outUrl: string;
  width: number;
  height: number;
  variant: FrameCompareVariant;
}

// Le modèle est volontairement exclu : deux sorties ne sont comparables que si tous les autres
// paramètres d'inférence sont identiques. Les réglages d'encodage/audio ne touchent pas le test PNG.
export function upscaleTestConfigKey(settings: UpSettings): string {
  return JSON.stringify([
    settings.engine,
    settings.scale,
    settings.denoise,
    settings.tile,
    settings.tilePad,
    settings.prePad,
    settings.fp32,
    settings.cleanupNoise,
    settings.cleanupEdges,
  ]);
}

export function isUpscaleCompareCompatible(
  previous: FrameCompare | null,
  identity: Pick<UpscaleModelResult, "sourceKey" | "configKey" | "time">,
): previous is FrameCompare {
  return previous?.sourceKey === identity.sourceKey
    && previous.configKey === identity.configKey
    && Math.abs(previous.time - identity.time) < 0.001;
}

export function mergeUpscaleModelResult(previous: FrameCompare | null, result: UpscaleModelResult): FrameCompare {
  const compatible = isUpscaleCompareCompatible(previous, result);
  const oldVariants = compatible ? previous.variants ?? [] : [];
  const variants = [...oldVariants.filter((variant) => variant.id !== result.variant.id), result.variant];
  const previousRight = compatible && previous?.rightId !== result.variant.id ? previous?.rightId : previous?.leftId;
  const leftId = previousRight && variants.some((variant) => variant.id === previousRight)
    ? previousRight
    : variants[0].id;

  return {
    origUrl: result.origUrl,
    outUrl: result.outUrl,
    width: result.width,
    height: result.height,
    time: result.time,
    sourceKey: result.sourceKey,
    configKey: result.configKey,
    variants,
    leftId,
    rightId: result.variant.id,
    revision: (compatible ? previous?.revision ?? 0 : 0) + 1,
  };
}
