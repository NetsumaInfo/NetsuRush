import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nr, type UpscaleProgress, type UpscaleResult } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostImport } from "@/lib/host";
import { DEFAULT_SETTINGS, RESTORE_MODELS, SHADER_MODELS, UP_MODELS, shaderRuntimeModel, isRtxShader, type UpSettings } from "./upscaleShared";
import { useSharedProcSources, jobFor, makeRenderReviews } from "./useProcSources";
import i18n from "@/i18n";
import { readPersistedObject, writePersistedObject } from "@/lib/persistedJson";
import { isUpscaleCompareCompatible, mergeUpscaleModelResult, upscaleTestConfigKey } from "./upscaleCompareState";
import { processExportPayload } from "./processExport";

const SETTINGS_KEY = "nr.netsulab.upscale.settings";

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

// `FrameCompare` vit désormais dans useProcSources (partagé) ; ré-export pour les consommateurs
// existants (UpscaleCompare importe `./useUpscale`).
export type { FrameCompare } from "./useProcSources";

export function useUpscale() {
  const base = useSharedProcSources();
  const { sources, active, activeKey, scope, range, scenes, picked, outDir, chooseOut, importBack, outputNamingProblem, outputNameFor, setSourcesErr, recordRenders } = base;

  const [settings, setSettings] = useState<UpSettings>(() => {
    const saved = readPersistedObject(SETTINGS_KEY, DEFAULT_SETTINGS);
    if (saved.shader === "anime4k") return { ...saved, shader: "anime4k_aa_hq" };
    if (saved.shader === "artcnn_quality") return { ...saved, shader: "artcnn_c4f32" };
    // RTX VSR n'existe qu'en ×2 : une échelle héritée d'un autre shader ferait échouer le job au
    // lancement, alors que le sélecteur, lui, verrouille déjà le facteur.
    if (isRtxShader(saved.shader) && saved.scale !== 2) return { ...saved, scale: 2 };
    return saved;
  });
  const patch = useCallback((p: Partial<UpSettings>) => setSettings((s) => {
    const next = { ...s, ...p };
    writePersistedObject(SETTINGS_KEY, next);
    return next;
  }), []);

  // Tests d'upscale sur une même frame, accumulés pour comparer directement les sorties de modèles.
  const [compare, setCompare] = useState<import("./useProcSources").FrameCompare | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const testSeq = useRef(0);
  const compareConfigKey = useMemo(() => upscaleTestConfigKey(settings), [settings]);

  // Une comparaison appartient strictement à une source et à une configuration d'inférence commune.
  // Le modèle est exclu de la clé : changer A → B conserve A pour permettre la comparaison finale.
  useEffect(() => {
    testSeq.current++;
    setCompare(null);
    setTestErr(null);
    setTesting(false);
  }, [activeKey, compareConfigKey]);

  const [busy, setBusy] = useState<UpscaleProgress | null>(null);
  const [batch, setBatch] = useState<{ i: number; n: number; name: string } | null>(null);
  const [result, setResult] = useState<UpscaleResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);

  // Upscale d'une seule frame (à `time` secondes) → résultat de modèle, sans encoder tout le clip.
  const testFrame = useCallback(async (time: number) => {
    if (!active || testing) return;
    const seq = ++testSeq.current;
    const sourceKey = activeKey;
    const configKey = compareConfigKey;
    const restoring = settings.mode === "restore";
    const routedShaderModel = !restoring && settings.engine === "turbo" ? shaderRuntimeModel(settings.shader) : null;
    const modelId = routedShaderModel ?? settings.model;
    const modelLabel = routedShaderModel
      ? SHADER_MODELS.find((m) => m.id === settings.shader)?.label ?? modelId
      : [...UP_MODELS, ...RESTORE_MODELS].find((m) => m.id === modelId)?.label ?? modelId;
    setCompare((prev) => isUpscaleCompareCompatible(prev, { sourceKey, configKey, time }) ? prev : null);
    setTesting(true); setTestErr(null);
    try {
      const r = await nr.upscaleTestFrame({
        input: active.path, time, model: modelId, scale: restoring ? 1 : settings.scale,
        denoise: modelId === "light" ? settings.denoise : undefined,
        tile: settings.tile, tilePad: settings.tilePad, prePad: settings.prePad, fp32: settings.fp32,
        cleanupNoise: settings.cleanupNoise, cleanupEdges: settings.cleanupEdges,
      });
      if (seq !== testSeq.current) return;
      if (r.ok && r.orig && r.out) {
        // Le nom de fichier change à chaque test (timestamp) → URL neuve, pas de cache.
        const origUrl = nr.mediaUrl(r.orig);
        const outUrl = nr.mediaUrl(r.out);
        setCompare((prev) => mergeUpscaleModelResult(prev, {
          sourceKey,
          configKey,
          time,
          origUrl,
          outUrl,
          width: r.width || 0,
          height: r.height || 0,
          variant: { id: `model:${modelId}`, label: modelLabel, url: outUrl, model: modelId },
        }));
        if (r.black) setTestErr(i18n.t("upscale:errors.frameBlack"));
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

  // Les effets nettoient l'état, mais ce garde empêche aussi un résultat périmé d'être peint pendant
  // le rendu qui précède leur exécution (changement de source/configuration ou désélection complète).
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
    // Découpes : plans de timeline (in/out portés par la source) OU portée du panneau (source unique).
    const anyRange = sources.some((s) => s.in != null);
    if (!multi && !anyRange && scope === "scenes" && !scenes.some((_, i) => picked.has(i))) { setErr(i18n.t("upscale:errors.noShotSelected")); return; }
    if (!multi && !anyRange && scope === "range" && range[1] <= range[0]) { setErr(i18n.t("upscale:errors.invalidRange")); return; }

    running.current = true;
    setResult(null); setErr(null); setSourcesErr(null);
    // Tâche lourde → propose de fermer le logiciel de montage (libérer RAM/GPU).
    useApp.getState().offerCloseForRam();
    const off = nr.onUpscaleProgress(setBusy);
    // Import : le backend importe dans Resolve. Pour Adobe, on importe côté renderer APRÈS l'encodage
    // (le core ignore l'hôte actif) → on désactive l'import backend et on route via hostImport.
    const host = useApp.getState().activeHost;
    const restoring = settings.mode === "restore";
    const parallel = !restoring && settings.engine === "turbo" && !shaderRuntimeModel(settings.shader) && settings.tParallel;
    const sourceConcurrency = parallel && sources.length > 1 ? settings.tConcurrency : 1;
    const backendImport = importBack && host === "resolve" && !parallel;
    const outputs: string[] = [];
    const reviews: import("./useProcSources").RenderReview[] = [];
    let imported = 0; let failed = 0; let lastErr: string | null = null;
    try {
      const completed = await mapConcurrent(sources, sourceConcurrency, async (src, i) => {
        const { whole, segments } = jobFor(src, { multi, scope, range, scenes, picked });
        setBatch({ i, n: sources.length, name: src.name });
        setBusy({ file: src.name, pct: 0, done: 0, total: segments?.length || 1, phase: "model" });
        // Moteur Turbo = shader GLSL (ffmpeg libplacebo, GPU) ; sinon moteur IA (Real-ESRGAN/CUGAN).
        const r = !restoring && settings.engine === "turbo"
          ? await nr.upscaleShaderRun({
              input: src.path,
              shader: settings.shader, scale: settings.scale, codec: settings.codec,
              deband: settings.tDeband, grain: settings.tGrain, sharp: settings.tSharp,
              sigmoid: settings.tSigmoid, dither: settings.tDither,
              vsrQuality: settings.rtxQuality, hdr: settings.rtxHdr,
              hdrContrast: settings.rtxHdrContrast, hdrSaturation: settings.rtxHdrSaturation,
              hdrMidGray: settings.rtxHdrMidGray, hdrNits: settings.rtxHdrNits,
              quality: settings.quality, preset: settings.preset, bitDepth: settings.bitDepth, profile: settings.profile,
              audio: settings.audio, abr: settings.abr, ...processExportPayload(settings),
              outDir: dir, whole, segments,
              importBack: backendImport, baseName: src.name.replace(/\.[^.]+$/, ""),
              outputName: outputNameFor(src),
              parallel: parallel && sources.length === 1,
              concurrency: settings.tConcurrency,
            })
          : await nr.upscaleRun({
              input: src.path,
              model: settings.model, scale: restoring ? 1 : settings.scale, codec: settings.codec,
              denoise: settings.model === "light" ? settings.denoise : undefined,
              tile: settings.tile, tilePad: settings.tilePad, prePad: settings.prePad, fp32: settings.fp32,
              cleanupNoise: settings.cleanupNoise, cleanupEdges: settings.cleanupEdges,
              quality: settings.quality, preset: settings.preset, bitDepth: settings.bitDepth, profile: settings.profile,
              audio: settings.audio, abr: settings.abr, ...processExportPayload(settings),
              outDir: dir, whole, segments,
              importBack: backendImport, baseName: src.name.replace(/\.[^.]+$/, ""),
              outputName: outputNameFor(src),
            });
        return { src, segments, r };
      });
      for (const { src, segments, r } of completed) {
        if (r.outputs) { outputs.push(...r.outputs); reviews.push(...makeRenderReviews(src, r.outputs, "upscale", segments)); }
        imported += r.imported || 0; failed += r.failed || 0;
        if (!r.ok) lastErr = r.error || i18n.t("upscale:errors.upscaleFailed");
      }
      // En parallèle, l'import est regroupé après tous les encodages (les APIs hôte restent séquentielles).
      if (importBack && (host !== "resolve" || parallel) && outputs.length) {
        const ir = await hostImport(host, outputs);
        if (ir.ok) imported += ir.count ?? 0;
        else if (!lastErr) lastErr = ir.error ?? i18n.t("upscale:errors.adobeImportFailed");
      }
      recordRenders(reviews);
      setResult({ ok: outputs.length > 0, outputs, imported, failed, error: outputs.length ? null : lastErr });
      if (!outputs.length) setErr(lastErr);
    } catch (e) {
      setErr(i18n.t("upscale:errors.upscaleUnavailable", { err: String(e) }));
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
    busy, batch, result, err, run,
  };
}
