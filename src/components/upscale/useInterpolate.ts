import { useCallback, useRef, useState } from "react";
import { nr, type ProcessProgress, type ProcessResult } from "@/lib/bridge";
import { useApp } from "@/store";
import { DEFAULT_INTERP, type InterpSettings } from "./processShared";
import { useSharedProcSources, jobFor, makeRenderReviews, type FrameCompare, type RenderReview } from "./useProcSources";
import i18n from "@/i18n";
import { readPersistedObject, writePersistedObject } from "@/lib/persistedJson";
import { processExportPayload } from "./processExport";

const SETTINGS_KEY = "nr.netsulab.interpolate.settings";

// Mode interpolation (RIFE) du hub. Même forme de retour que useUpscale → réutilise Sources/Preview.
export function useInterpolate() {
  const base = useSharedProcSources();
  const { sources, active, scope, range, scenes, picked, outDir, chooseOut, importBack, outputNamingProblem, outputNameFor, setSourcesErr, recordRenders } = base;

  const [settings, setSettings] = useState<InterpSettings>(() => readPersistedObject(SETTINGS_KEY, DEFAULT_INTERP));
  const patch = useCallback((p: Partial<InterpSettings>) => setSettings((s) => {
    const next = { ...s, ...p };
    writePersistedObject(SETTINGS_KEY, next);
    return next;
  }), []);

  const [compare, setCompare] = useState<FrameCompare | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);

  const [busy, setBusy] = useState<ProcessProgress | null>(null);
  const [batch, setBatch] = useState<{ i: number; n: number; name: string } | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);

  // Test sur une frame : orig = frame à `time`, out = frame interpolée à mi-chemin avec la suivante.
  const testFrame = useCallback(async (time: number) => {
    if (!active || testing) return;
    setTesting(true); setTestErr(null);
    try {
      const r = await nr.processTestFrame({ input: active.path, time, mode: "interpolate", model: settings.model });
      if (r.ok && r.orig && r.out) {
        setCompare({ origUrl: nr.mediaUrl(r.orig), outUrl: nr.mediaUrl(r.out), width: r.width || 0, height: r.height || 0, time });
      } else {
        setTestErr(r.error || i18n.t("upscale:errors.testFailed"));
      }
    } catch (e) {
      setTestErr(String(e));
    } finally {
      setTesting(false);
    }
  }, [active, testing, settings]);

  const clearCompare = useCallback(() => { setCompare(null); setTestErr(null); }, []);

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
        const r = await nr.processInterpolate({
          input: src.path,
          model: settings.model, factor: settings.factor,
          targetFps: settings.targetFps ?? undefined, slowmo: settings.slowmo, dedup: settings.dedup,
          codec: settings.codec, quality: settings.quality, preset: settings.preset, bitDepth: settings.bitDepth, profile: settings.profile,
          audio: settings.audio, abr: settings.abr, ...processExportPayload(settings),
          outDir: dir, whole, segments,
          importBack, baseName: src.name.replace(/\.[^.]+$/, ""), outputName: outputNameFor(src),
        });
        if (r.outputs) {
          outputs.push(...r.outputs);
          reviews.push(...makeRenderReviews(src, r.outputs, "interpolate", segments));
        }
        imported += r.imported || 0;
        failed += r.failed || 0;
        if (!r.ok) lastErr = r.error || i18n.t("upscale:errors.interpolateFailed");
      }
      recordRenders(reviews);
      setResult({ ok: outputs.length > 0, outputs, imported, failed, error: outputs.length ? null : lastErr });
      if (!outputs.length) setErr(lastErr);
    } catch (e) {
      setErr(i18n.t("upscale:errors.interpolateUnavailable", { err: String(e) }));
    } finally {
      off();
      setBusy(null); setBatch(null);
      running.current = false;
    }
  }, [sources, outDir, chooseOut, scope, range, scenes, picked, settings, importBack, outputNamingProblem, outputNameFor, setSourcesErr, recordRenders]);

  return {
    ...base,
    settings, patch,
    compare, testing, testErr, testFrame, clearCompare,
    busy, batch, result, err: err ?? base.sourcesErr, run,
  };
}
