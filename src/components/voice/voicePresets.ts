// Préréglages du nettoyage voix : UN choix règle TOUS les curseurs (silences + hésitations) de façon
// cohérente. « Doux » ne coupe que l'évident, « Équilibré » = le réglage juste, « Agressif » resserre
// tout (silences dès 0,3 s, tics inclus, sensibilité haute). L'état « Perso » est DÉDUIT (aucun preset
// ne matche les curseurs) — jamais stocké. Les mots perso (`extraWords`) survivent au changement de
// preset : ils composent avec, ils n'en font pas partie.
import type { SilenceParams, HesitationParams } from "@/lib/bridge";

type VoicePresetId = "doux" | "equilibre" | "agressif";

// Un preset règle les curseurs de SEGMENTATION. Les couches d'affinage indépendantes (confirmation
// anti-bruit NOVA, marge de fin, recalage sur les creux, porte de bruit) restent des réglages
// globaux : elles composent avec n'importe quel preset au lieu d'être réécrites par chacun.
type PresetSilence = Omit<
  Required<SilenceParams>,
  "nova_confirm" | "nova_min_conf" | "pad_end_ms" | "snap_ms" | "noise_gate"
>;

export interface VoicePreset {
  id: VoicePresetId;
  // label/hint = clés i18n (namespace "voice"), résolues au rendu via t().
  labelKey: string;
  hintKey: string;
  silence: PresetSilence;
  hesitation: Omit<Required<HesitationParams>, "extraWords">;
}

const ALL_WORDS = { euh: true, nasal: true, interj: true, tics: true, en: true };

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "doux",
    labelKey: "presets.doux.label",
    hintKey: "presets.doux.hint",
    silence: { threshold: 0.45, min_silence_ms: 900, min_speech_ms: 150, pad_ms: 180 },
    hesitation: {
      sensitivity: 0.3, min_ms: 500, max_ms: 1400, monotone: 0.35,
      lexical: true, prolongation: false, acoustic: true, markers: false,
      wordTypes: { ...ALL_WORDS, interj: false },
    },
  },
  {
    id: "equilibre",
    labelKey: "presets.equilibre.label",
    hintKey: "presets.equilibre.hint",
    silence: { threshold: 0.5, min_silence_ms: 500, min_speech_ms: 100, pad_ms: 100 },
    hesitation: {
      sensitivity: 0.5, min_ms: 400, max_ms: 1500, monotone: 0.5,
      lexical: true, prolongation: true, acoustic: true, markers: false,
      wordTypes: { ...ALL_WORDS },
    },
  },
  {
    id: "agressif",
    labelKey: "presets.agressif.label",
    hintKey: "presets.agressif.hint",
    silence: { threshold: 0.6, min_silence_ms: 300, min_speech_ms: 75, pad_ms: 40 },
    hesitation: {
      sensitivity: 0.85, min_ms: 300, max_ms: 2000, monotone: 0.75,
      lexical: true, prolongation: true, acoustic: true, markers: true,
      wordTypes: { ...ALL_WORDS },
    },
  },
];

// Presets ENREGISTRÉS par l'utilisateur : mêmes champs que les intégrés (silences + hésitations),
// id préfixé "c-" (jamais en collision avec doux/equilibre/agressif). Persistés localStorage —
// réglage d'app, pas une donnée projet (comme asrModel/verbatim).
export interface CustomVoicePreset {
  id: string;
  label: string;
  silence: PresetSilence;
  hesitation: Omit<Required<HesitationParams>, "extraWords">;
}

const LS_PRESETS = "nr.voice.presets:v1";

export function loadCustomPresets(): CustomVoicePreset[] {
  try {
    const raw = localStorage.getItem(LS_PRESETS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && p.id && p.label && p.silence && p.hesitation) : [];
  } catch { return []; }
}

export function storeCustomPresets(list: CustomVoicePreset[]) {
  try { localStorage.setItem(LS_PRESETS, JSON.stringify(list)); } catch { /* noop */ }
}

// Capture les curseurs courants en preset nommé (défauts appliqués → snapshot complet comparable).
export function snapshotPreset(id: string, label: string, sp: SilenceParams, hp: HesitationParams): CustomVoicePreset {
  return {
    id, label,
    silence: {
      threshold: sp.threshold ?? 0.5, min_silence_ms: sp.min_silence_ms ?? 500,
      min_speech_ms: sp.min_speech_ms ?? 100, pad_ms: sp.pad_ms ?? 100,
    },
    hesitation: {
      sensitivity: hp.sensitivity ?? 0.5, min_ms: hp.min_ms ?? 400, max_ms: hp.max_ms ?? 1500,
      monotone: hp.monotone ?? 0.5, lexical: hp.lexical !== false, prolongation: hp.prolongation !== false,
      acoustic: hp.acoustic !== false, markers: hp.markers === true,
      wordTypes: Object.fromEntries(WORD_KEYS.map((k) => [k, hp.wordTypes?.[k] !== false])) as typeof ALL_WORDS,
    },
  };
}

const WORD_KEYS = Object.keys(ALL_WORDS) as (keyof typeof ALL_WORDS)[];

// Un preset (intégré ou enregistré) matche-t-il les curseurs courants ? Défauts appliqués comme
// dans la détection : booléens « !== false », max_ms 1500, monotone 0.5.
function presetMatches(p: Pick<VoicePreset, "silence" | "hesitation">, sp: SilenceParams, hp: HesitationParams): boolean {
  const s = p.silence;
  if ((sp.threshold ?? 0.5) !== s.threshold) return false;
  if ((sp.min_silence_ms ?? 500) !== s.min_silence_ms) return false;
  if ((sp.min_speech_ms ?? 100) !== s.min_speech_ms) return false;
  if ((sp.pad_ms ?? 100) !== s.pad_ms) return false;
  const h = p.hesitation;
  if ((hp.sensitivity ?? 0.5) !== h.sensitivity) return false;
  if ((hp.min_ms ?? 400) !== h.min_ms) return false;
  if ((hp.max_ms ?? 1500) !== h.max_ms) return false;
  if ((hp.monotone ?? 0.5) !== h.monotone) return false;
  if ((hp.lexical !== false) !== h.lexical) return false;
  if ((hp.prolongation !== false) !== h.prolongation) return false;
  if ((hp.acoustic !== false) !== h.acoustic) return false;
  if ((hp.markers === true) !== h.markers) return false;
  return WORD_KEYS.every((k) => (hp.wordTypes?.[k] !== false) === h.wordTypes[k]);
}

// Preset actif déduit des curseurs courants — intégrés d'abord, puis enregistrés. Retourne l'id
// (builtin ou custom) ; null = réglages Perso.
export function matchVoicePreset(sp: SilenceParams, hp: HesitationParams, customs: CustomVoicePreset[] = []): string | null {
  for (const p of VOICE_PRESETS) if (presetMatches(p, sp, hp)) return p.id;
  for (const p of customs) if (presetMatches(p, sp, hp)) return p.id;
  return null;
}
