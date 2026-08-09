import i18n from "@/i18n";

export type TimelineHost = "resolve" | "ppro" | "aeft";
export type TimelineInsertionMode = "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite";
export type TimelineInsertions = Record<TimelineHost, TimelineInsertionMode>;

const ALL_OPTIONS: { value: TimelineInsertionMode; labelKey: string }[] = [
  { value: "insert", labelKey: "insertionInsert" },
  { value: "overwrite", labelKey: "insertionOverwrite" },
  { value: "replace", labelKey: "insertionReplace" },
  { value: "fit", labelKey: "insertionFit" },
  { value: "above", labelKey: "insertionAbove" },
  { value: "end", labelKey: "insertionEnd" },
  { value: "ripple_overwrite", labelKey: "insertionRippleOverwrite" },
];

const HOST_MODES: Record<TimelineHost, readonly TimelineInsertionMode[]> = {
  // Resolve ne fournit pas de commande d'écrasement générique dans son API externe.
  // Le mode est volontairement absent pour éviter de promettre une action qui ne peut pas s'exécuter.
  resolve: ["replace", "fit", "above", "end"],
  ppro: ["insert", "overwrite", "replace", "above", "end", "ripple_overwrite"],
  aeft: ["insert", "replace", "fit", "above", "end"],
};

export const DEFAULT_TIMELINE_INSERTIONS: TimelineInsertions = {
  resolve: "end",
  ppro: "end",
  aeft: "end",
};

export function timelineInsertionOptions(host: TimelineHost): { value: TimelineInsertionMode; label: string }[] {
  return ALL_OPTIONS
    .filter((option) => HOST_MODES[host].includes(option.value))
    .map((option) => ({
      value: option.value,
      label: host === "aeft"
        ? i18n.t(`export:editor.aeftInsertion.${option.value}`)
        : i18n.t(`export:editor.${option.labelKey}`),
    }));
}

export function coerceTimelineInsertion(host: TimelineHost, value: unknown): TimelineInsertionMode {
  if (value === "upper") return "above";
  return HOST_MODES[host].includes(value as TimelineInsertionMode)
    ? value as TimelineInsertionMode
    : DEFAULT_TIMELINE_INSERTIONS[host];
}

export function normalizeTimelineInsertions(value: unknown): TimelineInsertions {
  const raw = value && typeof value === "object" ? value as Partial<Record<TimelineHost, unknown>> : {};
  return {
    resolve: coerceTimelineInsertion("resolve", raw.resolve),
    ppro: coerceTimelineInsertion("ppro", raw.ppro),
    aeft: coerceTimelineInsertion("aeft", raw.aeft),
  };
}
