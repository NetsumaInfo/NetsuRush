import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nr, type ProcessProgress, type ProcessResult } from "@/lib/bridge";
import { useApp } from "@/store";
import { DEFAULT_SEG, SEG_MODELS, segTokens, type SegSettings } from "./processShared";
import { useSharedProcSources, jobFor, makeRenderReviews, type FrameCompare, type RenderReview } from "./useProcSources";
import i18n from "@/i18n";
import { readPersistedObject, writePersistedObject } from "@/lib/persistedJson";
import { isUpscaleCompareCompatible, mergeUpscaleModelResult } from "./upscaleCompareState";
import { processExportPayload } from "./processExport";
import { imageOutputPayload, outputKindFor } from "./imageOutput";

const SETTINGS_KEY = "nr.netsulab.removebg.settings";

// Mode removeBG (détourage / alpha) du hub. Pas de codec/audio (sortie alpha dédiée). Même forme de retour.
export function useRemoveBg() {
  const base = useSharedProcSources();
  const { sources, active, activeKey, scope, range, scenes, picked, outDir, chooseOut, importBack, outputNamingProblem, outputNameFor, setSourcesErr, recordRenders, setNamingTokens } = base;

  const [settings, setSettings] = useState<SegSettings>(() => readPersistedObject(SETTINGS_KEY, DEFAULT_SEG));
  const patch = useCallback((p: Partial<SegSettings>) => setSettings((s) => {
    const next = { ...s, ...p };
    writePersistedObject(SETTINGS_KEY, next);
    return next;
  }), []);

  useEffect(() => { setNamingTokens(segTokens(settings)); }, [settings, setNamingTokens]);

  const [compare, setCompare] = useState<FrameCompare | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const testSeq = useRef(0);
  const compareConfigKey = useMemo(() => JSON.stringify([
    settings.despeckle, settings.edgeSmoothing, settings.edgeOffset,
  ]), [settings.despeckle, settings.edgeSmoothing, settings.edgeOffset]);

  useEffect(() => {
    testSeq.current++;
    setCompare(null);
    setTestErr(null);
    setTesting(false);
  }, [activeKey, compareConfigKey]);

  const [busy, setBusy] = useState<ProcessProgress | null>(null);
  const [batch, setBatch] = useState<{ i: number; n: number; name: string } | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);

  // Test sur une frame : orig = frame source, out = frame détourée (alpha aplati sur damier côté affichage).
  const testFrame = useCallback(async (time: number) => {
    if (!active || testing) return;
    const seq = ++testSeq.current;
    const sourceKey = activeKey;
    const configKey = compareConfigKey;
    const modelId = settings.model;
    const modelLabel = SEG_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
    setCompare((prev) => isUpscaleCompareCompatible(prev, { sourceKey, configKey, time }) ? prev : null);
    setTesting(true); setTestErr(null);
    try {
      const r = await nr.processTestFrame({
        input: active.path, time, mode: "removebg", model: modelId,
        despeckle: settings.despeckle,
        edgeSmoothing: settings.edgeSmoothing,
        edgeOffset: settings.edgeOffset,
      });
      if (seq !== testSeq.current) return;
      if (r.ok && r.orig && r.out) {
        const origUrl = nr.mediaUrl(r.orig);
        const outUrl = nr.mediaUrl(r.out);
        setCompare((prev) => ({
          ...mergeUpscaleModelResult(prev, {
            sourceKey, configKey, time, origUrl, outUrl,
            width: r.width || 0, height: r.height || 0,
            variant: { id: `model:${modelId}`, label: modelLabel, url: outUrl, model: modelId },
          }),
          alpha: true,
        }));
      } else {
        setTestErr(r.error || i18n.t("upscale:errors.testFailed"));
      }
    } catch (e) {
      setTestErr(String(e));
    } finally {
      if (seq === testSeq.current) setTesting(false);
    }
  }, [active, activeKey, compareConfigKey, testing, settings]);

  const clearCompare = useCallback(() => {
    testSeq.current++;
    setTesting(false);
    setCompare(null);
    setTestErr(null);
  }, []);

  const currentCompare = activeKey && compare?.sourceKey === activeKey && compare.configKey === compareConfigKey
    ? compare
    : null;

  const run = useCallback(async () => {
    if (!sources.length || running.current) return;
    let dir = outDir;
    if (!dir) dir = await chooseOut();
    if (!dir) return;
    if (outputNamingProblem) { setErr(i18n.t(`upscale:errors.${outputNamingProblem}`)); return; }

    const multi = sources.length > 1;
    const anyRange = sources.some((s) => s.in != null);
    if (!multi && !anyRange && scope === "scenes" && !scenes.some((_, i) => picked.has(i))) { setErr(i18n.t("upscale:errors.noShotSelected")); return; }
    if (!multi && !anyRange && scope === "range" && range[1] <= range[0]) { setErr(i18n.t("upscale:errors.invalidRange")); return; }

    running.current = true;
    setResult(null); setErr(null); setSourcesErr(null);
    // Tâche lourde → propose de fermer le logiciel de montage (libérer RAM/GPU).
    useApp.getState().offerCloseForRam();
    const off = nr.onProcessProgress(setBusy);
    const outputs: string[] = [];
    const reviews: RenderReview[] = [];
    let imported = 0; let failed = 0; let lastErr: string | null = null;
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const { whole, segments } = jobFor(src, { multi, scope, range, scenes, picked });
        setBatch({ i, n: sources.length, name: src.name });
        setBusy({ file: src.name, pct: 0, done: 0, total: segments?.length || 1, phase: "model" });
        const r = await nr.processRemoveBg({
          input: src.path,
          model: settings.model, dedup: settings.dedup,
          // Le format alpha suit la SORTIE choisie : une séquence n'a qu'une forme (PNG RGBA), une
          // vidéo alpha laisse le core arbitrer ProRes 4444 / WebM VP9 selon le codec demandé.
          format: outputKindFor(settings, src) === "video" ? "prores_4444" : "png_seq",
          ...processExportPayload(settings),
          ...imageOutputPayload(settings, outputKindFor(settings, src)),
          despeckle: settings.despeckle,
          edgeSmoothing: settings.edgeSmoothing,
          edgeOffset: settings.edgeOffset,
          outDir: dir, whole, segments,
          importBack, baseName: src.name.replace(/\.[^.]+$/, ""), outputName: outputNameFor(src),
        });
        if (r.outputs) {
          outputs.push(...r.outputs);
          reviews.push(...makeRenderReviews(src, r.outputs, "removebg", segments));
        }
        imported += r.imported || 0;
        failed += r.failed || 0;
        if (!r.ok) lastErr = r.error || i18n.t("upscale:errors.removebgFailed");
      }
      recordRenders(reviews);
      setResult({ ok: outputs.length > 0, outputs, imported, failed, error: outputs.length ? null : lastErr });
      if (!outputs.length) setErr(lastErr);
    } catch (e) {
      setErr(i18n.t("upscale:errors.removebgUnavailable", { err: String(e) }));
    } finally {
      off();
      setBusy(null); setBatch(null);
      running.current = false;
    }
  }, [sources, outDir, chooseOut, scope, range, scenes, picked, settings, importBack, outputNamingProblem, outputNameFor, setSourcesErr, recordRenders]);

  return {
    ...base,
    settings, patch,
    compare: currentCompare, testing, testErr, testFrame, clearCompare,
    busy, batch, result, err: err ?? base.sourcesErr, run,
  };
}
