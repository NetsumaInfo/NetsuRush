import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { nr, type AudioTrack, type ProcMode, type Scene } from "@/lib/bridge";
import { useApp } from "@/store";
import { type UpScope, type UpSource } from "./upscaleShared";
import { readPersistedValue, writePersistedValue } from "@/lib/persistedJson";

const SCOPE_KEY = "nr.netsulab.scope";
const OUT_DIR_KEY = "nr.netsulab.outDir";
const IMPORT_BACK_KEY = "nr.netsulab.importBack";
const OUTPUT_NAMING_KEY = "nr.netsulab.outputNaming";
const RENDER_HISTORY_KEY = "nr.netsulab.renders.v1";
const REVIEWABLE_VIDEO = /\.(?:avi|m2ts|m4v|mkv|mov|mp4|mts|mxf|ts|webm)$/i;

export type OutputNamingMode = "original" | "prefix" | "suffix" | "custom";
export interface OutputNaming {
  mode: OutputNamingMode;
  value: string;
}

const DEFAULT_OUTPUT_NAMING: OutputNaming = { mode: "original", value: "" };

export interface FrameCompare {
  origUrl: string;
  outUrl: string;
  width: number;
  height: number;
  time: number;
  alpha?: boolean;   // sortie détourée (removeBG) → fond damier sous les images pour lire l'alpha.
  sourceKey?: string;
  configKey?: string;
  revision?: number;
  variants?: FrameCompareVariant[];
  leftId?: string;
  rightId?: string;
}

export interface FrameCompareVariant {
  id: string;
  label: string;
  url: string;
  model?: string;
}

export interface RenderReview {
  id: string;
  mode: ProcMode | "chain";
  sourcePath: string;
  sourceName: string;
  outputPath: string;
  outputName: string;
  sourceStart: number;
  sourceEnd?: number;
  createdAt: number;
  alpha?: boolean;
}

function nameOf(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || p;
}

function outputBaseName(sourceName: string, naming: OutputNaming): string {
  const original = sourceName.replace(/\.[^.]+$/, "");
  const value = naming.value.trim();
  if (naming.mode === "prefix") return `${value}${original}`;
  if (naming.mode === "suffix") return `${original}${value}`;
  if (naming.mode === "custom" && value) return value.replace(/\.[^.]+$/, "");
  return original;
}

// Associe chaque fichier final à sa source et, si l'op a produit plusieurs plans, à sa plage exacte.
// Les séquences PNG sont volontairement exclues : le viewer vidéo ne doit jamais tenter de lire un
// dossier comme un média. Elles restent bien présentes dans le résultat d'export classique.
export function makeRenderReviews(
  source: UpSource,
  outputs: string[],
  mode: ProcMode | "chain",
  segments?: { in: number; out: number }[],
): RenderReview[] {
  const ranges = segments?.length
    ? segments
    : source.in != null && source.out != null ? [{ in: source.in, out: source.out }] : [];
  const now = Date.now();
  return outputs.filter((outputPath) => REVIEWABLE_VIDEO.test(outputPath)).map((outputPath, i) => {
    const range = ranges[Math.min(i, Math.max(0, ranges.length - 1))];
    return {
      id: outputPath,
      mode,
      sourcePath: source.path,
      sourceName: source.name,
      outputPath,
      outputName: nameOf(outputPath),
      sourceStart: range?.in ?? 0,
      sourceEnd: range?.out,
      createdAt: now + i,
      alpha: mode === "removebg" || undefined,
    };
  });
}

// Clé d'identité d'une source : chemin seul pour un fichier entier, chemin + portion pour un plan de
// timeline (plusieurs plans du même fichier = sources DISTINCTES, sélectionnables indépendamment).
export const srcKey = (s: { path: string; in?: number; out?: number }): string =>
  (s.in != null && s.out != null) ? `${s.path}#${s.in.toFixed(3)}-${s.out.toFixed(3)}` : s.path;
const outputNamingKey = (source: UpSource): string => source.uid ?? srcKey(source);

// Résout le découpage d'UNE source pour un run : un plan de timeline (in/out portés) → segment exact ;
// sinon on applique la portée du panneau (entier / plage / plans) — seulement en source unique.
export function jobFor(
  src: UpSource,
  ctx: { multi: boolean; scope: UpScope; range: [number, number]; scenes: Scene[]; picked: Set<number> },
): { whole: boolean; segments?: { in: number; out: number }[] } {
  if (src.in != null && src.out != null) return { whole: false, segments: [{ in: src.in, out: src.out }] };
  const { multi, scope, range, scenes, picked } = ctx;
  if (multi || scope === "whole") return { whole: true };
  if (scope === "range") return { whole: false, segments: [{ in: range[0], out: range[1] }] };
  const segs = scenes.filter((_, i) => picked.has(i)).map((s) => ({ in: s.start, out: s.end }));
  return segs.length ? { whole: false, segments: segs } : { whole: true };
}

// État PARTAGÉ par tous les modes du hub (upscale / interpolation / depth / removeBG) :
// sélection des sources, source aperçue, métadonnées (durée/fps/pistes), portée + plage + plans,
// dossier de sortie, import au Media Pool. Chaque mode greffe ses propres réglages + run par-dessus.
export function useProcSources() {
  // Le BAC de sélection vit dans le store (slice netsulab) : persistant, partagé navigateur ↔ bac ↔ ops.
  const sources = useApp((s) => s.nlSources);
  const activeIdx = useApp((s) => s.nlActiveIdx);
  const setActiveIdx = useApp((s) => s.nlSetActiveIdx);
  const nlToggle = useApp((s) => s.nlToggleSource);
  const nlAdd = useApp((s) => s.nlAddSources);
  const nlClear = useApp((s) => s.nlClearSources);
  const nlRemoveMany = useApp((s) => s.nlRemoveSources);
  const nlSetSourceRange = useApp((s) => s.nlSetSourceRange);
  const [scope, setScopeState] = useState<UpScope>(() => {
    const value = readPersistedValue<unknown>(SCOPE_KEY, "whole");
    return value === "range" || value === "scenes" ? value : "whole";
  });
  const setScope = useCallback((value: UpScope) => {
    writePersistedValue(SCOPE_KEY, value);
    setScopeState(value);
  }, []);

  // Source unique (les options plage/plans n'ont de sens que pour 1 clip).
  const single = sources.length === 1 ? sources[0] : null;
  // Source aperçue (en multi-sélection on peut basculer d'un clip à l'autre pour le preview/test).
  const active = sources.length ? sources[Math.min(activeIdx, sources.length - 1)] : null;
  // Identité STABLE de la source aperçue : uid posé à l'ajout au bac (deux plans du même fichier =
  // clés distinctes, contrairement au path). Tous les effets d'aperçu sont keyés là-dessus.
  const activeKey = active ? (active.uid ?? active.path) : "";
  const [native, setNative] = useState(false);
  const [fps, setFps] = useState(0);
  const [duration, setDuration] = useState(0);
  // Plage : DÉRIVÉE de la source de manière SYNCHRONE (in/out du plan connus dès la sélection →
  // le lecteur reçoit la bonne plage au premier rendu, plus de fenêtre [0,0] où il démarrait à 0).
  // Une édition (poignées/champs) prend le dessus, invalidée au changement de source.
  const [rangeEdit, setRangeEdit] = useState<{ key: string; r: [number, number] } | null>(null);
  const range: [number, number] = rangeEdit?.key === activeKey
    ? rangeEdit.r
    : [active?.in ?? 0, active?.out ?? duration];
  const setRange = useCallback((r: [number, number]) => setRangeEdit({ key: activeKey, r }), [activeKey]);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [detecting, setDetecting] = useState(false);

  const [outDir, setOutDir] = useState<string | null>(() => readPersistedValue<string | null>(OUT_DIR_KEY, null));
  const [outputNaming, setOutputNamingState] = useState<OutputNaming>(() => {
    const saved = readPersistedValue<Partial<OutputNaming> | null>(OUTPUT_NAMING_KEY, null);
    const mode = saved?.mode;
    return mode === "prefix" || mode === "suffix" || mode === "custom" || mode === "original"
      ? { mode, value: typeof saved?.value === "string" ? saved.value : "" }
      : DEFAULT_OUTPUT_NAMING;
  });
  const setOutputNaming = useCallback((next: OutputNaming) => {
    writePersistedValue(OUTPUT_NAMING_KEY, next);
    setOutputNamingState(next);
  }, []);
  const [outputNamingOverrides, setOutputNamingOverrides] = useState<Record<string, OutputNaming>>({});
  const setOutputNamingOverride = useCallback((source: UpSource, next: OutputNaming | null) => {
    const key = outputNamingKey(source);
    setOutputNamingOverrides((current) => {
      if (next) return { ...current, [key]: next };
      if (!(key in current)) return current;
      const copy = { ...current };
      delete copy[key];
      return copy;
    });
  }, []);
  const outputNamingOverrideFor = useCallback((source: UpSource): OutputNaming | null =>
    outputNamingOverrides[outputNamingKey(source)] ?? null, [outputNamingOverrides]);
  const outputNamingFor = useCallback((source: UpSource): OutputNaming =>
    outputNamingOverrideFor(source) ?? outputNaming, [outputNaming, outputNamingOverrideFor]);
  const outputNameFor = useCallback((source: UpSource) =>
    outputBaseName(source.name, outputNamingFor(source)), [outputNamingFor]);
  const outputBases = sources.map((source) => outputNameFor(source).toLocaleLowerCase());
  const outputNamingProblem: "duplicateOutputNames" | null =
    new Set(outputBases).size !== outputBases.length ? "duplicateOutputNames" : null;
  const [importBack, setImportBackState] = useState(() => readPersistedValue(IMPORT_BACK_KEY, true));
  const setImportBack = useCallback((value: boolean) => {
    writePersistedValue(IMPORT_BACK_KEY, value);
    setImportBackState(value);
  }, []);
  const [sourcesErr, setSourcesErr] = useState<string | null>(null);
  const [renderHistory, setRenderHistory] = useState<RenderReview[]>(() => {
    const saved = readPersistedValue<unknown>(RENDER_HISTORY_KEY, []);
    return Array.isArray(saved)
      ? saved.filter((r): r is RenderReview => {
          if (!r || typeof r !== "object") return false;
          const item = r as Partial<RenderReview>;
          return !!item.sourcePath && !!item.outputPath;
        })
      : [];
  });
  const [activeRenderId, setActiveRenderId] = useState<string | null>(null);
  const [renderReviewOpen, setRenderReviewOpen] = useState(false);

  const recordRenders = useCallback((items: RenderReview[]) => {
    if (!items.length) return;
    setRenderHistory((old) => {
      const replaced = new Map(old.map((r) => [r.outputPath, r]));
      for (const item of items) replaced.set(item.outputPath, item);
      const next = [...replaced.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
      writePersistedValue(RENDER_HISTORY_KEY, next);
      return next;
    });
    setActiveRenderId(items[items.length - 1].id);
    setRenderReviewOpen(true);
  }, []);

  const renderedForActive = active
    ? renderHistory.filter((r) => r.sourcePath === active.path).sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const activeRender = renderedForActive.find((r) => r.id === activeRenderId) ?? renderedForActive[0] ?? null;
  const selectRender = useCallback((id: string) => { setActiveRenderId(id); setRenderReviewOpen(true); }, []);
  const openRenderReview = useCallback(() => setRenderReviewOpen(true), []);
  const closeRenderReview = useCallback(() => setRenderReviewOpen(false), []);

  const toggleSource = useCallback((c: UpSource) => { setSourcesErr(null); nlToggle(c); }, [nlToggle]);
  const clearSources = useCallback(() => { setSourcesErr(null); nlClear(); }, [nlClear]);
  const removeSources = useCallback((keys: string[]) => { setSourcesErr(null); nlRemoveMany(keys); }, [nlRemoveMany]);
  // Rogne/dérogne la source aperçue (persiste in/out sur la source du bac → marche même en multi).
  const setSourceRange = useCallback((idx: number, inS: number | null, outS: number | null) => nlSetSourceRange(idx, inS, outS), [nlSetSourceRange]);

  // Ajout en LOT dédupliqué par CLÉ (fichier entier = chemin ; plan de timeline = chemin + in/out).
  const addSources = useCallback((items: UpSource[]) => { setSourcesErr(null); nlAdd(items); }, [nlAdd]);

  const pickFiles = useCallback(async () => {
    const files = await nr.chooseFiles();
    if (files && files.length) nlAdd(files.map((p) => ({ name: nameOf(p), path: p })));
  }, [nlAdd]);

  // Charge métadonnées (durée, stratégie de lecture, pistes audio) quand la source aperçue change —
  // keyé sur l'uid (pas le path) : cliquer un AUTRE plan du même fichier recharge bien l'aperçu.
  useEffect(() => {
    setScenes([]); setPicked(new Set()); setAudioTracks([]);
    setDuration(0); setRangeEdit(null); setNative(false); setFps(0);
    if (!active) return;
    let on = true;
    const path = active.path;
    nr.playInfo(path).then((info) => {
      if (!on) return;
      setDuration(info?.duration || 0); setNative(!!info?.native); setFps(info?.fps || 0);
    }).catch(() => {});
    nr.audioTracks(path).then((r) => { if (on) setAudioTracks(r.tracks || []); }).catch(() => {});
    return () => { on = false; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [activeKey]);

  const detectScenes = useCallback(async () => {
    if (!single) return;
    setDetecting(true); setSourcesErr(null);
    try {
      const cached = await nr.cachedScenes(single.path);
      const r = cached.cached && cached.scenes.length ? cached : await nr.detectScenes(single.path);
      setScenes(r.scenes || []);
      setPicked(new Set((r.scenes || []).map((_, i) => i)));
      if (r.error) setSourcesErr(r.error);
    } catch (e) { setSourcesErr(String(e)); } finally { setDetecting(false); }
  }, [single]);

  const toggleScene = useCallback((i: number) => {
    setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }, []);
  const setAllScenes = useCallback((on: boolean) => {
    setPicked(on ? new Set(scenes.map((_, i) => i)) : new Set());
  }, [scenes]);

  const chooseOut = useCallback(async () => {
    const d = await nr.chooseDir();
    if (d) {
      setOutDir(d);
      writePersistedValue(OUT_DIR_KEY, d);
    }
    return d;
  }, []);

  return {
    sources, single, active, activeKey, activeIdx, setActiveIdx, native, fps, toggleSource, clearSources, removeSources, addSources, pickFiles,
    scope, setScope, audioTracks,
    duration, range, setRange, setSourceRange,
    scenes, picked, detecting, detectScenes, toggleScene, setAllScenes,
    outDir, chooseOut, importBack, setImportBack,
    outputNaming, setOutputNaming, outputNamingOverrides, setOutputNamingOverride, outputNamingOverrideFor, outputNamingFor, outputNameFor, outputNamingProblem,
    sourcesErr, setSourcesErr,
    renderedForActive, activeRender, renderReviewOpen,
    recordRenders, selectRender, openRenderReview, closeRenderReview,
  };
}

export type ProcSources = ReturnType<typeof useProcSources>;

// Contexte partagé : UNE instance de useProcSources pour TOUS les modes du hub. Le provider est monté
// dans ProcessPanel (jamais démonté en changeant de mode) → source + scope + plage + plans sélectionnés
// survivent au changement de mode. Avant, chaque mode appelait son propre useProcSources → tout était
// réinitialisé au démontage du mode.
export const ProcSourcesContext = createContext<ProcSources | null>(null);

export function useSharedProcSources(): ProcSources {
  const ctx = useContext(ProcSourcesContext);
  if (!ctx) throw new Error("useSharedProcSources doit être utilisé dans ProcSourcesContext.Provider");
  return ctx;
}

// Sous-ensemble de champs réellement consommés par UpscaleSources / UpscalePreview (les deux panneaux
// partagés du hub). Les 4 hooks de mode renvoient une forme assignable à ce type → on peut typer
// la prop `up` des panneaux partagés là-dessus, sans coupler à un mode précis.
export interface ProcController extends ProcSources {
  compare: FrameCompare | null;
  testing: boolean;
  testErr: string | null;
  testFrame: (time: number) => Promise<void>;
  clearCompare: () => void;
}
