// Constantes/enums partagés du module voix (modèles ASR/VAD, formats sous-titres, helpers).
import type { AsrModel, VadModel, SubtitleFormat } from "@/lib/bridge";

// Sélecteur de moteur ASR (ToggleGroup Rapide/Précis), comme TransNetV2/OmniShotCut pour la détection.
// label/hint = clés i18n (namespace "voice"), résolues au rendu via t() dans les composants.
export const ASR_MODELS: { id: AsrModel; labelKey: string; hintKey: string }[] = [
  { id: "whisper-turbo", labelKey: "shared.asr.whisperTurbo.label", hintKey: "shared.asr.whisperTurbo.hint" },
  { id: "parakeet-v3", labelKey: "shared.asr.parakeetV3.label", hintKey: "shared.asr.parakeetV3.hint" },
  { id: "whisperx", labelKey: "shared.asr.whisperx.label", hintKey: "shared.asr.whisperx.hint" },
  { id: "canary-1b-v2", labelKey: "shared.asr.canary.label", hintKey: "shared.asr.canary.hint" },
];

// Moteur de segmentation VAD : Silero v5 pose les frontières parole/silence. NOVA-VAD n'est PAS
// un moteur alternatif (classifieur bloc-1s, pas de frontières) → il vit en couche de CONFIRMATION
// anti-bruit par-dessus Silero (toggle des réglages Silences), pas dans ce sélecteur.
export const VAD_MODELS: { id: VadModel; labelKey: string; hintKey: string; disabled?: boolean }[] = [
  { id: "silero", labelKey: "shared.vad.silero.label", hintKey: "shared.vad.silero.hint" },
];

export const SUBTITLE_FORMATS: { id: SubtitleFormat; label: string }[] = [
  { id: "srt", label: "SRT" },
  { id: "vtt", label: "VTT" },
];

// Horodatage compact mm:ss.cs (sans heure si < 1 h) pour les listes de mots/segments.
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const cs = Math.floor((s % 1) * 100);
  const total = Math.floor(s);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  const mm = String(min).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return hr > 0 ? `${hr}:${mm}:${ss}` : `${mm}:${ss}.${String(cs).padStart(2, "0")}`;
}
