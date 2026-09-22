// Translated text for a catalog model: its one-line description and its task group name. The
// Models page, the dictation model list and the first-run setup all read them from here, so a
// model is described the same way on every screen and in every language.
import type { TFunction } from "i18next";
import { TASK_LABELS, type ModelEntry, type ModelTask } from "@/lib/modelRegistry";

// Models whose description already lives in the namespace of the screen that owns them.
const MODEL_HINT_KEYS: Partial<Record<string, string>> = {
  transnetv2: "derush:shared.modelHintTransnet",
  omnishotcut: "derush:shared.modelHintOmni",
  autoshot: "derush:shared.modelHintAutoShot",
  "whisper-turbo": "voice:shared.asr.whisperTurbo.hint",
  "parakeet-v3": "voice:shared.asr.parakeetV3.hint",
  whisperx: "voice:shared.asr.whisperx.hint",
  "canary-1b-v2": "voice:shared.asr.canary.hint",
  "sam3.1": "roto:sam.sam31",
  "sam2.1-large": "roto:sam.large",
  "sam2.1": "roto:sam.base",
  "sam2.1-small": "roto:sam.small",
  "sam2.1-tiny": "roto:sam.tiny",
  samurai: "roto:sam.samurai",
  sam2long: "roto:sam.sam2long",
  edgetam: "roto:sam.edgetam",
};

/** Namespaces the keys below live in: a component must load them before calling `modelHint`. */
export const MODEL_TEXT_NS = ["models", "derush", "voice", "upscale", "roto"] as const;

export function modelHintKeys(m: ModelEntry): string[] {
  const keys = [`models:catalogHint.${m.id}`];
  const exact = MODEL_HINT_KEYS[m.id];
  if (exact) keys.push(exact);
  if (m.task === "upscale" || m.task === "restore" || m.task === "interpolate") keys.push(`upscale:modelHint.${m.id}`);
  if (m.task === "depth") keys.push(`upscale:depthModelHint.${m.id}`);
  if (m.task === "matte-image" || m.task === "matte-video") keys.push(`upscale:segModelHint.${m.id}`);
  if (m.task === "object-removal" || m.task === "matte-video") keys.push(`roto:engineHint.${m.id}`);
  // Never end on the generic description of the task: i18next would take it as a valid
  // translation and hide the model's own `hint` passed as defaultValue.
  return keys;
}

export const modelHint = (t: TFunction, m: ModelEntry): string =>
  m.hint ? t(modelHintKeys(m), { defaultValue: m.hint }) : "";

export const taskLabel = (t: TFunction, task: ModelTask): string =>
  t(`models:task.${task}`, { defaultValue: TASK_LABELS[task] });
