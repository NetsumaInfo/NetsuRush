// Slice « voix » : clip sélectionné, transcription (mots horodatés), silences, et état d'édition
// du montage par texte (mots retirés). Les 4 features (silences / sous-titres / montage texte /
// fillers) lisent ce même modèle. L'orchestration des sidecars passe par nr.transcribe ; la
// progression SSE est poussée par le panneau (onVoiceProgress → setVoiceProgress).
import type { StateCreator } from "zustand";
import i18n from "@/i18n";
import { nr, type AsrModel, type VadModel, type VoiceWord, type VoiceSpan, type FillerSpan, type SilenceParams, type HesitationParams, type PreviewMode } from "@/lib/bridge";
import { loadCustomPresets, storeCustomPresets, snapshotPreset, type CustomVoicePreset } from "@/components/voice/voicePresets";
import { analysisCutList } from "@/components/voice/voiceCut";
import { getActiveExportProfile, isTimelineImport, getExportProfileIssues } from "@/features/export/profiles";
import { hostBuildTimeline } from "@/lib/host";
import { basename } from "@/lib/utils";
import type { AppState } from "./index";

interface VoiceClipRef {
  path: string;
  name: string;
  source: "mediapool" | "local";
  fps?: number;
  srcFrames?: number;
}

const lsGet = (k: string, def: string) => {
  try { return localStorage.getItem(k) || def; } catch { return def; }
};

// Sensibilité UI → paramètres acoustiques (Goto allégé) : + sensible = seuil de score plus bas,
// F0 toléré plus large (monotone), durée mini plus courte, scan des trous plus fin. Partagé entre
// runDetectFillers (relance ciblée) et runAnalyzeAll (pipeline).
function fillerParams(hp: HesitationParams) {
  const sens = hp.sensitivity ?? 0.5;
  const mono = hp.monotone ?? 0.5;
  return {
    min_score: Math.max(0.2, 0.7 - sens * 0.45),
    min_dur: (hp.min_ms ?? 400) / 1000,
    max_dur: (hp.max_ms ?? 1500) / 1000,
    f0_std: 8 + mono * 22,                 // tolérance monotone (curseur dédié) : 8..30 Hz
    flux_ratio: 0.55 + sens * 0.3,
    gap_min: Math.max(0.05, 0.12 - sens * 0.06),
  };
}

// Analyse groupée (accueil) : état par clip. Les résultats restent dans l'entrée (pas dans l'état
// éditeur) → ouvrir un clip analysé hydrate l'éditeur INSTANTANÉMENT, sans relancer les sidecars.
export interface VoiceBatchEntry {
  clip: VoiceClipRef;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  words?: VoiceWord[];
  speech?: VoiceSpan[];
  silence?: VoiceSpan[];
  fillers?: FillerSpan[];
  duration?: number;
}

// Rendu en lot (accueil) : état par clip. `pct` vient du SSE export:progress filtré sur le jobId
// (= chemin du rush) → plusieurs rendus en vol ne se volent plus la barre.
export interface VoiceRenderEntry {
  clip: VoiceClipRef;
  status: "queued" | "running" | "done" | "error";
  pct: number;
  file?: string;
  error?: string;
}

// Jeton d'annulation du lot en cours : « Arrêter » vide la file, les clips déjà lancés finissent.
let batchToken = { cancelled: false };
let renderToken = { cancelled: false };

// Rushs rendus DE FRONT. Le portail d'encodage du core (core/export/gate.js) borne déjà le nombre
// réel de ffmpeg simultanés : ce chiffre ne sert qu'à garder assez de jobs en vol pour le saturer.
const RENDER_CONCURRENCY = 3;

const nameStem = (p: string) => basename(p).replace(/\.[^.]+$/, "");

export interface VoiceSlice {
  voiceClip: VoiceClipRef | null;
  setVoiceClip: (c: VoiceClipRef | null) => void;
  // Ouverture d'un clip depuis l'accueil : reset + hydratation depuis le lot si déjà analysé.
  openVoiceClip: (c: VoiceClipRef) => void;

  // Analyse groupée (multi-rushs en parallèle depuis l'accueil).
  voiceBatch: Record<string, VoiceBatchEntry>;
  voiceBatchRunning: boolean;
  runVoiceBatch: (clips: VoiceClipRef[]) => Promise<void>;
  stopVoiceBatch: () => void;
  clearVoiceBatch: () => void;

  // Rendu groupé (accueil) : applique le PROFIL D'EXPORT actif à plusieurs rushs à la fois. Analyse
  // à la volée les clips pas encore analysés → un seul geste « sélectionner → rendre ».
  voiceRender: Record<string, VoiceRenderEntry>;
  voiceRenderRunning: boolean;
  runVoiceRender: (clips: VoiceClipRef[], profileId?: string) => Promise<void>;
  stopVoiceRender: () => void;

  // Presets enregistrés par l'utilisateur (localStorage), en plus des intégrés.
  customPresets: CustomVoicePreset[];
  saveCurrentAsPreset: (label: string) => void;
  deleteCustomPreset: (id: string) => void;

  asrModel: AsrModel;
  setAsrModel: (m: AsrModel) => void;
  vadModel: VadModel;
  setVadModel: (m: VadModel) => void;
  // Verbatim : Whisper amorcé pour TRANSCRIRE les hésitations (euh/hum) au lieu de les gommer →
  // la détection lexicale les voit. ON par défaut (le module sert à les couper). Persisté.
  verbatim: boolean;
  setVerbatim: (b: boolean) => void;

  words: VoiceWord[];
  speech: VoiceSpan[];
  silence: VoiceSpan[];
  voiceDuration: number;
  voiceLang: string;

  silenceParams: SilenceParams;
  setSilenceParams: (p: Partial<SilenceParams>) => void;
  runDetectSilences: () => Promise<void>;

  // Pics d'amplitude du clip (waveform) → sert l'aperçu LIVE des seuils (classification pure JS).
  voicePeaks: number[];
  setVoicePeaks: (p: number[]) => void;

  // Réglages de détection d'hésitations (sensibilité + durée mini), partagés lexical/prolongation/audio.
  hesitationParams: HesitationParams;
  setHesitationParams: (p: Partial<HesitationParams>) => void;

  // Hésitations détectées ACOUSTIQUEMENT (spans temporels dans les trous) — soustraites de la cut list.
  voiceFillerSpans: FillerSpan[];
  runDetectFillers: () => Promise<void>;
  clearFillerSpans: () => void;

  // Sélection (panneau CUTS) : spans hésitations/répétitions DÉSÉLECTIONNÉS (= NON coupés).
  // Les répétitions sont recalculées des mots côté composant (indices déterministes).
  offFillers: Set<number>;
  offRepeats: Set<number>;
  toggleFillerSpan: (i: number) => void;
  toggleRepeatSpan: (i: number) => void;

  // Nom de la timeline de sortie (vide → nom auto dérivé du clip).
  timelineName: string;
  setTimelineName: (n: string) => void;

  // Intervalles de parole DÉSACTIVÉS (exclus du montage final) — panneau CUTS.
  offIntervals: Set<number>;
  toggleInterval: (i: number) => void;
  enableAllIntervals: () => void;

  // Mode d'écoute : quel type de coupe la lecture saute (un seul à la fois, ou brut/tout).
  previewMode: PreviewMode;
  setPreviewMode: (m: PreviewMode) => void;
  // Détection/aperçu limités à une sous-plage (façon « preview range only »).
  previewRangeOnly: boolean;
  setPreviewRangeOnly: (b: boolean) => void;

  // Métadonnées du clip pour l'en-tête (résolution, fps, timecode source).
  clipMeta: { fps?: number; width?: number; height?: number; tc?: string | null } | null;
  setClipMeta: (m: { fps?: number; width?: number; height?: number; tc?: string | null } | null) => void;

  // Montage par texte : indices (dans `words`) des mots RETIRÉS du montage final, avec historique.
  removedWords: Set<number>;
  removedPast: Set<number>[];
  removedFuture: Set<number>[];
  toggleWord: (i: number) => void;
  removeRange: (from: number, to: number) => void;
  restoreRange: (from: number, to: number) => void;
  setRemoved: (s: Set<number>, record?: boolean) => void;
  clearRemoved: () => void;
  undoRemoved: () => void;
  redoRemoved: () => void;

  voiceBusy: string | null;
  voiceProgress: number;
  voiceError: string | null;
  voiceNotice: string | null;
  setVoiceProgress: (phase: string, pct: number) => void;
  setVoiceNotice: (m: string | null) => void;
  setVoiceError: (m: string | null) => void;

  runTranscribe: () => Promise<void>;
  // Pipeline complet : transcription ∥ silences (GPU ∥ CPU, audio extrait UNE fois), puis hésitations
  // (dépend des mots + silences). À la fin, lecture basculée sur « Tout » (montage final).
  runAnalyzeAll: () => Promise<void>;
  resetVoice: () => void;
}

// Pipeline d'analyse d'UN clip, sans toucher l'état éditeur (utilisé par le lot). Même logique que
// runAnalyzeAll : transcription (daemon GPU, jobs enchaînés) ∥ silences (Silero CPU one-shot), puis
// hésitations acoustiques. Lève en cas d'échec transcription/silences ; hésitations best-effort.
async function analyzeClipData(
  clip: VoiceClipRef,
  opts: { asrModel: AsrModel; verbatim: boolean; silenceParams: SilenceParams; hesitationParams: HesitationParams },
): Promise<Omit<VoiceBatchEntry, "clip" | "status">> {
  const [tr, sil] = await Promise.all([
    nr.transcribe({ input: clip.path, model: opts.asrModel, lang: "fr", verbatim: opts.verbatim }),
    nr.detectSilences({ input: clip.path, params: opts.silenceParams }),
  ]);
  if (!tr.ok) throw new Error(tr.error || i18n.t("voice:store.errTranscribe"));
  if (!sil.ok) throw new Error(sil.error || i18n.t("voice:store.errDetectSilences"));
  const fil = await nr.detectFillers({
    input: clip.path, words: tr.words, silences: sil.silence, params: fillerParams(opts.hesitationParams),
  });
  return {
    words: tr.words, speech: sil.speech, silence: sil.silence,
    fillers: fil.ok ? fil.fillers : [],
    duration: sil.duration || tr.duration || 0,
  };
}

// Nb de clips analysés DE FRONT : Whisper sérialise de toute façon sur son daemon (1 GPU), donc 3
// suffit à saturer — silences + hésitations (spawns CPU) tournent pendant que le suivant transcrit.
const BATCH_CONCURRENCY = 3;

export const createVoiceSlice: StateCreator<AppState, [], [], VoiceSlice> = (set, get) => ({
  voiceClip: null,
  setVoiceClip: (voiceClip) => set({ voiceClip }),
  openVoiceClip: (clip) => {
    get().resetVoice();
    const entry = get().voiceBatch[clip.path];
    if (entry?.status === "done") {
      set({
        voiceClip: clip,
        words: entry.words || [], speech: entry.speech || [], silence: entry.silence || [],
        voiceFillerSpans: entry.fillers || [], voiceDuration: entry.duration || 0,
        voiceNotice: i18n.t("voice:store.batchLoaded"),
      });
      get().setPreviewMode("all"); // la lecture EST le montage final
    } else {
      set({ voiceClip: clip });
    }
  },

  voiceBatch: {},
  voiceBatchRunning: false,
  stopVoiceBatch: () => {
    batchToken.cancelled = true;
    // Les clips encore en file repassent à l'état neutre ; ceux en cours finissent proprement.
    set((s) => ({
      voiceBatch: Object.fromEntries(Object.entries(s.voiceBatch)
        .filter(([, e]) => e.status !== "queued")),
    }));
  },
  clearVoiceBatch: () => set({ voiceBatch: {} }),
  runVoiceBatch: async (clips) => {
    if (!clips.length || get().voiceBatchRunning) return;
    get().offerCloseForRam();
    const token = { cancelled: false };
    batchToken = token;
    const { asrModel, verbatim, silenceParams, hesitationParams } = get();
    const opts = { asrModel, verbatim, silenceParams, hesitationParams };
    set((s) => ({
      voiceBatchRunning: true, voiceError: null,
      voiceBatch: {
        ...s.voiceBatch,
        ...Object.fromEntries(clips.map((c) => [c.path, { clip: c, status: "queued" as const }])),
      },
    }));
    const queue = [...clips];
    const patch = (path: string, e: Partial<VoiceBatchEntry>) => set((s) => {
      const cur = s.voiceBatch[path];
      return cur ? { voiceBatch: { ...s.voiceBatch, [path]: { ...cur, ...e } } } : {};
    });
    // 3 ouvriers tirent la file : transcriptions enchaînées côté daemon, silences/hésitations des
    // autres clips en parallèle pendant ce temps (extraction WAV dédupliquée côté core).
    const worker = async () => {
      for (;;) {
        const clip = queue.shift();
        if (!clip || token.cancelled) return;
        if (!get().voiceBatch[clip.path]) continue; // retiré par « Arrêter »
        patch(clip.path, { status: "running" });
        try {
          const data = await analyzeClipData(clip, opts);
          patch(clip.path, { status: "done", ...data });
        } catch (e) {
          patch(clip.path, { status: "error", error: String((e as Error)?.message || e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, clips.length) }, worker));
    set({ voiceBatchRunning: false });
    const entries = Object.values(get().voiceBatch).filter((e) => clips.some((c) => c.path === e.clip.path));
    const done = entries.filter((e) => e.status === "done").length;
    const errs = entries.filter((e) => e.status === "error").length;
    set({ voiceNotice: token.cancelled
      ? i18n.t("voice:store.batchStopped", { count: done })
      : i18n.t("voice:store.batchDone", { count: done }) + (errs ? i18n.t("voice:store.batchErrorsSuffix", { count: errs }) : "") });
  },

  voiceRender: {},
  voiceRenderRunning: false,
  stopVoiceRender: () => {
    renderToken.cancelled = true;
    set((s) => ({
      voiceRender: Object.fromEntries(Object.entries(s.voiceRender).filter(([, e]) => e.status !== "queued")),
    }));
  },
  runVoiceRender: async (clips, profileId) => {
    if (!clips.length || get().voiceRenderRunning) return;
    const { exportProfiles, activeExportProfileId, asrModel, verbatim, silenceParams, hesitationParams } = get();
    const profile = getActiveExportProfile(exportProfiles, profileId ?? activeExportProfileId);
    const issue = getExportProfileIssues(profile)[0];
    if (issue) { set({ voiceError: i18n.t("voice:render.errProfile", { issue: issue.message }) }); return; }

    // Profil « vers la timeline » = un montage par rush dans l'hôte ; sinon un fichier par rush dans
    // un dossier demandé UNE fois (pas un sélecteur par clip).
    const toFile = !isTimelineImport(profile.workflow);
    const dir = toFile ? await nr.chooseDir() : null;
    if (toFile && !dir) { set({ voiceError: i18n.t("voice:render.errNoDir") }); return; }

    get().offerCloseForRam();
    const token = { cancelled: false };
    renderToken = token;
    const analyzeOpts = { asrModel, verbatim, silenceParams, hesitationParams };
    set({
      voiceRenderRunning: true, voiceError: null, voiceNotice: null,
      voiceRender: Object.fromEntries(clips.map((c) => [c.path, { clip: c, status: "queued" as const, pct: 0 }])),
    });
    const patch = (path: string, e: Partial<VoiceRenderEntry>) => set((s) => {
      const cur = s.voiceRender[path];
      return cur ? { voiceRender: { ...s.voiceRender, [path]: { ...cur, ...e } } } : {};
    });
    // La progression d'encodage porte le chemin du rush (jobId) → chaque rangée suit SON rendu.
    const offProgress = nr.onExportProgress((p) => { if (p.jobId) patch(p.jobId, { pct: p.pct }); });

    const renderOne = async (clip: VoiceClipRef): Promise<string | undefined> => {
      let entry = get().voiceBatch[clip.path];
      if (entry?.status !== "done") { // pas encore analysé → on l'analyse ici (un seul geste côté UI)
        const data = await analyzeClipData(clip, analyzeOpts);
        entry = { clip, status: "done", ...data };
        set((s) => ({ voiceBatch: { ...s.voiceBatch, [clip.path]: entry as VoiceBatchEntry } }));
      }
      const segments = analysisCutList(entry, get().hesitationParams);
      if (!segments.length) throw new Error(i18n.t("voice:render.errNoSegments"));
      if (!toFile) {
        const name = `${nameStem(clip.path)} — ${i18n.t("voice:export.timelineSuffixNoSilences")}`;
        const r = await hostBuildTimeline(get().activeHost, {
          name, input: clip.path, srcFrames: clip.srcFrames, mode: "new", fps: clip.fps, segments,
        });
        if (!r.ok) throw new Error(r.error || i18n.t("voice:export.errTimeline"));
        return r.timeline;
      }
      const r = await nr.exportClips({
        clips: segments.map((s) => ({ input: clip.path, start: s.in, end: s.out })),
        dir: dir ?? undefined, baseName: nameStem(clip.path), profile, merge: true, jobId: clip.path,
      });
      if (!r.ok) throw new Error(r.error || i18n.t("voice:render.errExport"));
      return r.files?.[0];
    };

    const queue = [...clips];
    const worker = async () => {
      for (;;) {
        const clip = queue.shift();
        if (!clip || token.cancelled) return;
        if (!get().voiceRender[clip.path]) continue; // retiré par « Arrêter »
        patch(clip.path, { status: "running", pct: 0 });
        try {
          const file = await renderOne(clip);
          patch(clip.path, { status: "done", pct: 100, file });
        } catch (e) {
          patch(clip.path, { status: "error", error: String((e as Error)?.message || e) });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(RENDER_CONCURRENCY, clips.length) }, worker));
    } finally {
      offProgress();
      set({ voiceRenderRunning: false });
    }
    const entries = Object.values(get().voiceRender);
    const done = entries.filter((e) => e.status === "done").length;
    const errs = entries.filter((e) => e.status === "error").length;
    set({ voiceNotice: token.cancelled
      ? i18n.t("voice:render.stopped", { count: done })
      : i18n.t("voice:render.done", { count: done, profile: profile.name })
        + (errs ? i18n.t("voice:store.batchErrorsSuffix", { count: errs }) : "") });
  },

  customPresets: loadCustomPresets(),
  saveCurrentAsPreset: (label) => {
    const name = label.trim();
    if (!name) return;
    const { silenceParams, hesitationParams, customPresets } = get();
    const next = [...customPresets, snapshotPreset(`c-${Date.now()}`, name, silenceParams, hesitationParams)];
    storeCustomPresets(next);
    set({ customPresets: next });
  },
  deleteCustomPreset: (id) => {
    const next = get().customPresets.filter((p) => p.id !== id);
    storeCustomPresets(next);
    set({ customPresets: next });
  },

  asrModel: (lsGet("nr.voice.asr", "whisper-turbo") as AsrModel),
  setAsrModel: (asrModel) => { try { localStorage.setItem("nr.voice.asr", asrModel); } catch { /* noop */ } set({ asrModel }); },
  vadModel: (lsGet("nr.voice.vad", "silero") as VadModel),
  setVadModel: (vadModel) => { try { localStorage.setItem("nr.voice.vad", vadModel); } catch { /* noop */ } set({ vadModel }); },
  verbatim: lsGet("nr.voice.verbatim", "1") === "1",
  setVerbatim: (verbatim) => { try { localStorage.setItem("nr.voice.verbatim", verbatim ? "1" : "0"); } catch { /* noop */ } set({ verbatim }); },

  words: [],
  speech: [],
  silence: [],
  voiceDuration: 0,
  voiceLang: "fr",

  // snap_ms / noise_gate = affinage énergétique par défaut (cf. python/nrvoice/vad_silero.py) : la
  // coupe tombe dans le vrai creux et les blips (clavier, clic de bouche) ne comptent plus pour de la
  // parole. pad_end_ms absent = marge symétrique (le curseur ne s'écarte du pad qu'à la demande).
  silenceParams: { threshold: 0.5, min_silence_ms: 500, min_speech_ms: 100, pad_ms: 100, snap_ms: 40, noise_gate: 0.25 },
  setSilenceParams: (p) => set((s) => ({ silenceParams: { ...s.silenceParams, ...p } })),

  voicePeaks: [],
  setVoicePeaks: (voicePeaks) => set({ voicePeaks }),

  hesitationParams: { sensitivity: 0.5, min_ms: 400, max_ms: 1500, monotone: 0.5, lexical: true, prolongation: true, acoustic: true, markers: false, extraWords: "", wordTypes: { euh: true, nasal: true, interj: true, tics: true, en: true } },
  setHesitationParams: (p) => set((s) => ({ hesitationParams: { ...s.hesitationParams, ...p } })),

  timelineName: "",
  setTimelineName: (timelineName) => set({ timelineName }),

  offIntervals: new Set<number>(),
  toggleInterval: (i) => set((s) => {
    const next = new Set(s.offIntervals);
    if (next.has(i)) next.delete(i); else next.add(i);
    return { offIntervals: next };
  }),
  enableAllIntervals: () => set({ offIntervals: new Set<number>() }),

  // Défaut « Tout » : sans détection ça lit brut à l'identique, et dès qu'une analyse existe la
  // lecture EST le montage final (sans silences/hésitations) — pas de clic en plus. Persisté.
  previewMode: (lsGet("nr.voice.preview", "all") as PreviewMode),
  setPreviewMode: (previewMode) => { try { localStorage.setItem("nr.voice.preview", previewMode); } catch { /* noop */ } set({ previewMode }); },
  previewRangeOnly: false,
  setPreviewRangeOnly: (previewRangeOnly) => set({ previewRangeOnly }),

  clipMeta: null,
  setClipMeta: (clipMeta) => set({ clipMeta }),
  runDetectSilences: async () => {
    const { voiceClip, silenceParams } = get();
    if (!voiceClip) return;
    get().offerCloseForRam();
    set({ voiceBusy: i18n.t("voice:store.busyDetectSilences"), voiceError: null, voiceNotice: null, voiceProgress: 0 });
    const r = await nr.detectSilences({ input: voiceClip.path, params: silenceParams });
    if (r.ok) {
      set({
        speech: r.speech, silence: r.silence, offIntervals: new Set<number>(), voiceFillerSpans: [],
        voiceDuration: r.duration || get().voiceDuration,
        voiceBusy: null, voiceProgress: 100,
        voiceNotice: i18n.t("voice:store.silencesDetected", { silences: r.silence.length, speech: r.speech.length }),
      });
    } else {
      set({ voiceBusy: null, voiceError: r.error || i18n.t("voice:store.errDetectSilences") });
    }
  },

  voiceFillerSpans: [],
  clearFillerSpans: () => set({ voiceFillerSpans: [], offFillers: new Set<number>() }),
  offFillers: new Set<number>(),
  offRepeats: new Set<number>(),
  toggleFillerSpan: (i) => set((s) => {
    const next = new Set(s.offFillers);
    if (next.has(i)) next.delete(i); else next.add(i);
    return { offFillers: next };
  }),
  toggleRepeatSpan: (i) => set((s) => {
    const next = new Set(s.offRepeats);
    if (next.has(i)) next.delete(i); else next.add(i);
    return { offRepeats: next };
  }),
  runDetectFillers: async () => {
    const { voiceClip, words, silence, hesitationParams: hp } = get();
    if (!voiceClip) return;
    get().offerCloseForRam();
    set({ voiceBusy: i18n.t("voice:store.busyDetectFillers"), voiceError: null, voiceNotice: null, voiceProgress: 0 });
    const r = await nr.detectFillers({ input: voiceClip.path, words, silences: silence, params: fillerParams(hp) });
    if (r.ok) {
      set({
        voiceFillerSpans: r.fillers, offFillers: new Set<number>(), voiceBusy: null, voiceProgress: 100,
        voiceNotice: r.fillers.length ? i18n.t("voice:store.fillersDetected", { count: r.fillers.length }) : i18n.t("voice:store.noFillersDetected"),
      });
    } else {
      set({ voiceBusy: null, voiceError: r.error || i18n.t("voice:store.errDetectFillers") });
    }
  },

  removedWords: new Set<number>(),
  removedPast: [],
  removedFuture: [],
  // Toute mutation passe par setRemoved(record) → empile l'état précédent (undo) et purge le redo.
  setRemoved: (removedWords, record = true) => set((s) =>
    record
      ? { removedWords, removedPast: [...s.removedPast, s.removedWords].slice(-100), removedFuture: [] }
      : { removedWords }),
  toggleWord: (i) => {
    const cur = get().removedWords;
    const next = new Set(cur);
    if (next.has(i)) next.delete(i); else next.add(i);
    get().setRemoved(next);
  },
  removeRange: (from, to) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const next = new Set(get().removedWords);
    for (let i = a; i <= b; i++) next.add(i);
    get().setRemoved(next);
  },
  restoreRange: (from, to) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const next = new Set(get().removedWords);
    for (let i = a; i <= b; i++) next.delete(i);
    get().setRemoved(next);
  },
  clearRemoved: () => get().setRemoved(new Set<number>()),
  undoRemoved: () => set((s) => {
    if (!s.removedPast.length) return {};
    const prev = s.removedPast[s.removedPast.length - 1];
    return { removedWords: prev, removedPast: s.removedPast.slice(0, -1), removedFuture: [s.removedWords, ...s.removedFuture].slice(0, 100) };
  }),
  redoRemoved: () => set((s) => {
    if (!s.removedFuture.length) return {};
    const next = s.removedFuture[0];
    return { removedWords: next, removedFuture: s.removedFuture.slice(1), removedPast: [...s.removedPast, s.removedWords].slice(-100) };
  }),

  voiceBusy: null,
  voiceProgress: 0,
  voiceError: null,
  voiceNotice: null,
  setVoiceProgress: (_phase, pct) => set({ voiceProgress: pct }),
  setVoiceNotice: (voiceNotice) => set({ voiceNotice }),
  setVoiceError: (voiceError) => set({ voiceError }),

  runTranscribe: async () => {
    const { voiceClip, asrModel, verbatim } = get();
    if (!voiceClip) return;
    get().offerCloseForRam();
    set({ voiceBusy: i18n.t("voice:store.busyTranscribe"), voiceError: null, voiceNotice: null, voiceProgress: 0 });
    const r = await nr.transcribe({ input: voiceClip.path, model: asrModel, lang: "fr", verbatim });
    if (r.ok) {
      set({
        words: r.words, voiceDuration: r.duration ?? 0, voiceLang: r.lang ?? "fr",
        removedWords: new Set<number>(), removedPast: [], removedFuture: [], voiceFillerSpans: [],
        offFillers: new Set<number>(), offRepeats: new Set<number>(), voiceBusy: null, voiceProgress: 100,
        voiceNotice: r.cached ? i18n.t("voice:store.transcriptCached") : i18n.t("voice:store.transcriptDone", { count: r.words.length }),
      });
    } else {
      set({ voiceBusy: null, voiceError: r.error || i18n.t("voice:store.errTranscribe") });
    }
  },

  runAnalyzeAll: async () => {
    const { voiceClip, asrModel, verbatim, silenceParams, words } = get();
    if (!voiceClip) return;
    get().offerCloseForRam();
    const needWords = words.length === 0;
    set({
      voiceBusy: needWords ? i18n.t("voice:store.busyAnalyzeAllWithTranscribe") : i18n.t("voice:store.busyAnalyzeAllSilencesOnly"),
      voiceError: null, voiceNotice: null, voiceProgress: 0,
    });
    // Étape 1 — transcription (daemon GPU) et silences (Silero CPU) en PARALLÈLE : indépendants,
    // même WAV (extraction dédupliquée côté core). Un seul set d'état à la fin (pas de courses busy).
    const [tr, sil] = await Promise.all([
      needWords ? nr.transcribe({ input: voiceClip.path, model: asrModel, lang: "fr", verbatim }) : Promise.resolve(null),
      nr.detectSilences({ input: voiceClip.path, params: silenceParams }),
    ]);
    if (tr && !tr.ok) { set({ voiceBusy: null, voiceError: tr.error || i18n.t("voice:store.errTranscribe") }); return; }
    if (!sil.ok) { set({ voiceBusy: null, voiceError: sil.error || i18n.t("voice:store.errDetectSilences") }); return; }
    set({
      ...(tr ? {
        words: tr.words, voiceLang: tr.lang ?? "fr",
        removedWords: new Set<number>(), removedPast: [], removedFuture: [],
      } : {}),
      speech: sil.speech, silence: sil.silence, offIntervals: new Set<number>(),
      offFillers: new Set<number>(), offRepeats: new Set<number>(),
      voiceDuration: sil.duration || (tr?.duration ?? 0) || get().voiceDuration,
      voiceBusy: i18n.t("voice:store.busyAnalyzeAllFillers"), voiceProgress: 0,
    });
    // Étape 2 — hésitations acoustiques (dépend des mots + silences frais).
    const st = get();
    const r = await nr.detectFillers({
      input: voiceClip.path, words: st.words, silences: st.silence, params: fillerParams(st.hesitationParams),
    });
    if (!r.ok) { set({ voiceBusy: null, voiceError: r.error || i18n.t("voice:store.errDetectFillers") }); return; }
    set({
      voiceFillerSpans: r.fillers, voiceBusy: null, voiceProgress: 100,
      voiceNotice: i18n.t("voice:store.analyzeAllDone", { words: get().words.length, silences: sil.silence.length, fillers: r.fillers.length }),
    });
    get().setPreviewMode("all"); // la lecture EST le montage final
  },

  resetVoice: () => set({
    words: [], speech: [], silence: [], voiceDuration: 0, removedWords: new Set<number>(),
    removedPast: [], removedFuture: [], offIntervals: new Set<number>(), voiceFillerSpans: [],
    offFillers: new Set<number>(), offRepeats: new Set<number>(), clipMeta: null,
    voiceBusy: null, voiceProgress: 0, voiceError: null, voiceNotice: null,
  }),
});
