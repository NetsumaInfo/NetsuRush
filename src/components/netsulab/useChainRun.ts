import { useCallback, useEffect, useRef, useState } from "react";
import { nr, type PipelineProgress, type ProcessResult } from "@/lib/bridge";
import { useApp } from "@/store";
import { makeRenderReviews, useSharedProcSources, type RenderReview } from "@/components/upscale/useProcSources";
import { isStillSource } from "@/components/upscale/imageOutput";
import { useTranslation } from "react-i18next";

// Exécute la CHAÎNE ordonnée (nlChain) sur chaque source du bac via le pipeline core (fichier→fichier,
// 1 sortie par source). Réutilise le dossier de sortie / import du contexte de sources partagé.
export function useChainRun() {
  const { t } = useTranslation("upscale");
  const base = useSharedProcSources();
  const { sources, outDir, chooseOut, importBack, outputNamingProblem, outputNameFor, recordRenders, setNamingTokens } = base;
  const chain = useApp((s) => s.nlChain);
  // Une chaîne enchaîne des transforms vidéo → vidéo : {op} vaut « chain » pour le motif de nommage.
  useEffect(() => { setNamingTokens({ op: "chain", scale: "", model: "" }); }, [setNamingTokens]);

  const [busy, setBusy] = useState<PipelineProgress | null>(null);
  const [batch, setBatch] = useState<{ i: number; n: number; name: string } | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (!sources.length || !chain.length || running.current) return;
    let dir = outDir;
    if (!dir) dir = await chooseOut();
    if (!dir) return;
    if (outputNamingProblem) { setErr(t(`errors.${outputNamingProblem}`)); return; }
    // Le pipeline core est fichier vidéo → fichier vidéo : une image fixe n'y entre pas.
    const targets = sources.filter((s) => !isStillSource(s));
    const skipped = sources.length - targets.length;
    if (!targets.length) { setErr(t("errors.chainNeedsVideo")); return; }

    running.current = true;
    setResult(null); setErr(null);
    useApp.getState().offerCloseForRam();
    const off = nr.onPipelineProgress(setBusy);
    const outputs: string[] = [];
    const reviews: RenderReview[] = [];
    let imported = 0; let failed = 0; let lastErr: string | null = null;
    try {
      for (let i = 0; i < targets.length; i++) {
        const src = targets[i];
        setBatch({ i, n: targets.length, name: src.name });
        setBusy({ file: src.name, pct: 0, done: 0, total: chain.length, phase: chain[0].kind, opIndex: 0, opCount: chain.length });
        const r = await nr.pipelineRun({
          input: src.path,
          ops: chain.map((s) => ({ kind: s.kind, settings: s.settings })),
          outDir: dir,
          importBack,
          baseName: src.name.replace(/\.[^.]+$/, ""),
          outputName: outputNameFor(src),
        });
        if (r.outputs) {
          outputs.push(...r.outputs);
          reviews.push(...makeRenderReviews(src, r.outputs, "chain"));
        }
        imported += r.imported || 0;
        failed += r.failed || 0;
        if (!r.ok) lastErr = r.error || t("errors.chainFailed");
      }
      recordRenders(reviews);
      failed += skipped;
      setResult({ ok: outputs.length > 0, outputs, imported, failed, error: outputs.length ? null : lastErr });
      if (!outputs.length) setErr(lastErr);
      else if (skipped) setErr(t("errors.chainSkippedStills", { count: skipped }));
    } catch (e) {
      setErr(t("errors.chainUnavailable", { err: String(e) }));
    } finally {
      off();
      setBusy(null); setBatch(null);
      running.current = false;
    }
  }, [sources, chain, outDir, chooseOut, importBack, outputNamingProblem, outputNameFor, recordRenders, t]);

  return { busy, batch, result, err, run };
}
