import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Scissors, Check, CircleAlert, Film, Search, Pencil, Repeat, CheckSquare, Square, X } from "lucide-react";
import { nr, type DetectModel, type CutAnalysis } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PRESETS, SELECTION_BAR_CLASS } from "./cutStudioShared";
import { TimelineFolders } from "./TimelineFolders";
import { SortSelect, FoldersToggle, TIMELINE_SORT_DEFS } from "./BrowserControls";
import { CutEditor } from "./CutEditor";
import { detectionOptionsFor, detectionThreshold } from "@/lib/detection";
import { DetectionAdvancedSettings } from "./DetectionAdvancedSettings";
import { DetectionModelSelect, DetectionPresetSelect } from "./DetectionControls";
import { useAdobeTimelines } from "./useAdobeTimelines";
import { analyzeHostTimelineCut, buildHostCutTimeline } from "./hostCutTimeline";

type TimelineEntry = { name: string; current: boolean };
type Thumb = { path: string; in: number };
type BatchItem = { name: string; status: "pending" | "running" | "done" | "error"; text?: string };

// Page pleine « Découpe timeline » (dans le sous-onglet Découpage), façon Media Pool : parcours des
// timelines en VIGNETTES, sélection MULTIPLE, choix du modèle. Deux voies : « Découper » (direct, 1
// nouvelle timeline par source) ou « Éditer les coupes » (1 timeline → éditeur in-app : fusionner/
// supprimer des plans avant de construire). TOUJOURS non destructif : l'originale reste intacte, les
// coupes sont des through-edits (supprimables dans Resolve).
export function CutTimelineView() {
  const { t } = useTranslation(["derush", "common"]);
  const close = useApp((s) => s.closeCutTimeline);
  // Hôte Adobe : séquences/comps et plans montés viennent du snapshot CEP ; l'analyse et le montage
  // passent par hostCutTimeline (détection sur fichiers + job du panneau), pas par le pont Resolve.
  const adobe = useAdobeTimelines();
  const activeHost = useApp((s) => s.activeHost);
  const [timelines, setTimelines] = useState<TimelineEntry[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Map<string, Thumb>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState<DetectModel>(() => useApp.getState().cutModel);
  const [preset, setPreset] = useState(() => useApp.getState().cutPreset);
  const detectionOptions = useApp((state) => state.detectionOptions);
  // Mode de sortie : 'new' (timeline découpée à côté) ou 'replace' (UNE SEULE timeline : remplace
  // l'originale — supprime l'ancienne + renomme la nouvelle à son nom, plus de doublon). Persisté.
  const [mode, setModeState] = useState<"new" | "replace">(() => (typeof localStorage !== "undefined" && localStorage.getItem("nr.cut.mode") === "replace" ? "replace" : "new"));
  const setMode = (m: "new" | "replace") => { setModeState(m); try { localStorage.setItem("nr.cut.mode", m); } catch { /* noop */ } };
  const nameTouched = useRef(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [editing, setEditing] = useState<CutAnalysis | null>(null);
  const [batch, setBatch] = useState<{ items: BatchItem[]; running: boolean } | null>(null);
  const [prog, setProg] = useState<{ label: string; value: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const offRef = useRef<(() => void) | null>(null);

  const timelinesEpoch = useApp((s) => s.timelinesEpoch);
  const busy = analyzing || !!batch?.running;

  // Liste des timelines (re-listée sur changement Resolve sans perdre la sélection).
  // SWR : liste cachée peinte d'abord (instantané), scan Resolve la remplace ensuite.
  useEffect(() => {
    if (adobe.active) return;
    let alive = true;
    void swrRead(
      nr.snapshot?.peek("timelines"),
      () => nr.listTimelines(),
      (r) => {
        if (!alive) return;
        if (!r.ok) { setListErr(r.error || t("shared.failed")); setTimelines([]); return; }
        const sorted = [...r.timelines].sort((a: TimelineEntry, b: TimelineEntry) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
        setTimelines(sorted);
        setSel((prev) => { const keep = new Set([...prev].filter((n) => sorted.some((t: TimelineEntry) => t.name === n))); return keep.size ? keep : (r.current ? new Set([r.current]) : new Set()); });
      },
    );
    return () => { alive = false; };
  }, [adobe.active, timelinesEpoch, t]);

  // Vignettes des timelines (1er plan source) : cache peint d'abord, puis chargées + streamées
  // (remplissage progressif). Côté Adobe, la vignette est la 1re frame lue dans le snapshot.
  useEffect(() => {
    if (adobe.active) return;
    const off = nr.onTimelineThumb((t) => setThumbs((m) => { const n = new Map(m); n.set(t.name, { path: t.path, in: t.in }); return n; }));
    void swrRead(
      nr.snapshot?.peek("thumbs"),
      () => nr.timelineThumbs(),
      (r) => { if (r.ok) setThumbs((m) => { const n = new Map(m); for (const th of r.thumbs) n.set(th.name, { path: th.path, in: th.in }); return n; }); },
    );
    return off;
  }, [adobe.active, timelinesEpoch, t]);

  // Dossiers Media Pool de chaque timeline (rangement façon Media Pool) + contrôles unifiés (tri/dossiers).
  const [bins, setBins] = useState<Map<string, string>>(new Map());
  const [treeMode, setTreeMode] = useState(true);
  const [sortDir, setSortDir] = usePersistedChoice<"az" | "za">("nr.cut.sortdir", ["az", "za"], "az");
  useEffect(() => {
    if (adobe.active) return;  // pas de bins projet côté Adobe
    // SWR : bins du snapshot d'abord (instantané), timelineTree live remplace ensuite.
    void swrRead(
      nr.snapshot?.peek("tree"),
      () => nr.timelineTree(),
      (r) => { if (r.ok) setBins(new Map(r.timelines.map((t: { name: string; bin: string }) => [t.name, t.bin]))); },
    );
  }, [adobe.active, timelinesEpoch]);
  const hasBins = useMemo(() => { for (const b of bins.values()) if (b) return true; return false; }, [bins]);

  useEffect(() => () => offRef.current?.(), []);

  const selNames = useMemo(() => [...sel], [sel]);
  const single = selNames.length === 1 ? selNames[0] : null;

  // Nom par défaut « <timeline> — découpé » tant que non édité manuellement (1 seule sélection).
  useEffect(() => {
    if (!nameTouched.current) setName(single ? t("cutTimeline.defaultName", { name: single }) : "");
  }, [single, t]);

  // Source effective : snapshot CEP (Adobe) ou lecture Resolve. Le reste de la vue ne connaît que ça.
  const entries: TimelineEntry[] | null = adobe.active ? adobe.timelines : timelines;
  const shotThumbs = adobe.active ? adobe.thumbs : thumbs;
  // « Remplacer l'originale » = Resolve seul : aucune API Premiere/AE ne supprime puis renomme une
  // séquence de façon fiable. Sur Adobe on crée donc toujours une séquence/comp à côté.
  const outMode = adobe.active ? "new" : mode;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries ?? [];
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  }, [entries, query]);

  const allSelected = visible.length > 0 && visible.every((t) => sel.has(t.name));
  const selectAll = () => setSel(new Set(visible.map((t) => t.name)));
  const clearSel = () => setSel(new Set());

  const toggle = (n: string) => setSel((s) => { const next = new Set(s); next.has(n) ? next.delete(n) : next.add(n); return next; });

  const threshold = detectionThreshold(model, PRESETS[preset].thr, detectionOptions);
  const scopedOptions = detectionOptionsFor(model, detectionOptions);

  // Analyse (détection des plans de chaque rush de la timeline) — Resolve par le core, Adobe côté
  // renderer depuis le snapshot. Même retour, donc même éditeur de coupes derrière.
  function analyze(timelineName: string) {
    const cutProgress = (phase: string, file: string, pct: number | null) => setProg({
      label: phase === "analyze" ? t("cutTimeline.computingCuts") : t("cutTimeline.detecting", { file: file || "…" }),
      value: pct,
    });
    if (adobe.active) {
      return analyzeHostTimelineCut({
        cuts: adobe.cuts(timelineName), timelineName, model, threshold, detectionOptions: scopedOptions,
        onProgress: (p) => cutProgress(p.phase, p.file, p.pct),
      });
    }
    offRef.current = nr.onTimelineCutProgress((p) => cutProgress(p.phase, p.file, p.pct ?? (p.total ? Math.round((p.done / p.total) * 100) : null)));
    return nr.analyzeTimelineCut({ timelineName, model, threshold, detectionOptions: scopedOptions })
      .finally(() => { offRef.current?.(); offRef.current = null; });
  }

  async function startEdit() {
    if (!single) return;
    setErr(null); setAnalyzing(true); setProg({ label: t("cutTimeline.analyzingShots"), value: null });
    const a = await analyze(single);
    setAnalyzing(false); setProg(null);
    if (!a.ok) { setErr(a.error || t("cutTimeline.analyzeFailed")); return; }
    if (!a.clips.length) { setErr(t("cutTimeline.noShots")); return; }
    setEditing(a);
  }

  async function cutOnAdobe(timelineName: string, outName: string) {
    const a = await analyze(timelineName);
    if (!a.ok || !a.clips.length) return { ok: false as const, error: a.error || t("cutTimeline.noShots") };
    setProg({ label: t("cutTimeline.building"), value: null });
    return buildHostCutTimeline(activeHost, { name: outName, source: timelineName, clips: a.clips });
  }

  async function runBatch() {
    if (!selNames.length) return;
    setErr(null);
    const items: BatchItem[] = selNames.map((n) => ({ name: n, status: "pending" }));
    setBatch({ items, running: true });
    if (!adobe.active) {
      offRef.current = nr.onTimelineCutProgress((p) => setProg({
        label: p.phase === "build" ? t("cutTimeline.building") : t("cutTimeline.detecting", { file: p.file || "…" }),
        value: p.pct ?? (p.total ? Math.round((p.done / p.total) * 100) : null),
      }));
    }
    const patch = (i: number, u: Partial<BatchItem>) => setBatch((b) => b ? { ...b, items: b.items.map((it, k) => k === i ? { ...it, ...u } : it) } : b);
    for (let i = 0; i < selNames.length; i++) {
      patch(i, { status: "running" });
      const tlName = single ? (name.trim() || t("cutTimeline.defaultName", { name: selNames[i] })) : t("cutTimeline.defaultName", { name: selNames[i] });
      // Adobe : analyse (détection) puis montage par le job du panneau — le core n'a pas d'équivalent
      // à `cutTimeline` de ce côté. Resolve garde son chemin natif en un appel.
      const r = adobe.active
        ? await cutOnAdobe(selNames[i], tlName)
        : await nr.cutTimeline({ timelineName: selNames[i], model, threshold, detectionOptions: scopedOptions, name: tlName, mode });
      patch(i, r.ok ? { status: "done", text: t("cutTimeline.itemDone", { count: r.shots, name: r.timeline }) } : { status: "error", text: r.error || t("shared.failed") });
    }
    offRef.current?.(); offRef.current = null;
    setProg(null);
    setBatch((b) => b ? { ...b, running: false } : b);
  }

  const loading = entries == null;
  const empty = entries != null && entries.length === 0;
  const done = batch && !batch.running;

  // Éditeur de coupes : occupe toute la page.
  if (editing) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
           <button type="button" aria-label={t("common:action.back")} onClick={() => setEditing(null)} className="inline-flex h-8 items-center justify-center rounded-md px-2 text-sm transition-colors hover:bg-accent"><ArrowLeft className="h-4 w-4" /></button>
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{t("cutTimeline.editHeader", { name: single })}</div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <CutEditor
            analysis={editing}
            onBack={() => setEditing(null)}
            onClose={close}
            mode={outMode}
            onBuild={adobe.active
              ? (clips, outName) => buildHostCutTimeline(activeHost, { name: outName, source: editing.source, clips })
              : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* En-tête de page */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <button type="button" aria-label={t("common:action.back")} onClick={close} className="inline-flex h-8 items-center justify-center rounded-md px-2 text-sm transition-colors hover:bg-accent"><ArrowLeft className="h-4 w-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Scissors className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-[13px] font-medium">{t("cutTimeline.title")}</span>
        </div>
      </header>

      {/* Barre de navigation (fixe) : recherche + dossiers + tri */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} disabled={busy} placeholder={t("shared.searchTimeline")} className="h-8 pl-8" />
        </div>
        <div className="flex-1" />
        {hasBins && <FoldersToggle pressed={treeMode} onPressedChange={setTreeMode} />}
        <SortSelect value={sortDir} onChange={(v) => setSortDir(v as "az" | "za")} options={TIMELINE_SORT_DEFS.map((o) => ({ value: o.value, label: t(o.labelKey) }))} />
      </div>

      {/* Zone défilante : barre d'ACTION sticky EN HAUT (façon sélection des rush) + grille dessous */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {/* Barre d'action sticky : UNE SEULE ligne (jamais de retour à la ligne qui pousse vers le bas —
            déborde en scroll horizontal si étroit). Labels condensés en icônes + tooltips. */}
        <Card className={cn(SELECTION_BAR_CLASS, "items-center gap-1.5 overflow-x-auto")}>
          {/* Sélection : icône bascule + compteur court + vider */}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={allSelected ? clearSel : selectAll} disabled={busy || !visible.length} className="shrink-0" />}>
              {allSelected ? <CheckSquare className="size-4 text-primary" /> : <Square className="size-4" />}
            </TooltipTrigger>
            <TooltipContent>{allSelected ? t("shared.deselectAll") : t("shared.selectAll")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 px-0.5 text-xs tabular-nums text-muted-foreground" />}>
              {sel.size}/{visible.length}
            </TooltipTrigger>
            <TooltipContent>{t("cutTimeline.selectedOf", { count: sel.size, total: visible.length })}</TooltipContent>
          </Tooltip>
          {sel.size > 0 && !allSelected && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={clearSel} disabled={busy} className="shrink-0" />}>
                <X className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("shared.deselectAll")}</TooltipContent>
            </Tooltip>
          )}

          {single && (
            <Input value={name} onChange={(e) => { nameTouched.current = true; setName(e.target.value); }} disabled={busy} placeholder={t("cutTimeline.defaultName", { name: single })} className="h-8 w-44 shrink-0" aria-label={t("cutEditor.nameLabel")} />
          )}

          <div className="flex-1" />

          {/* Modèle de détection */}
          <DetectionModelSelect model={model} onChange={setModel} disabled={busy} />
          <DetectionPresetSelect model={model} preset={preset} onChange={setPreset} disabled={busy} />
          <DetectionAdvancedSettings model={model} disabled={busy} compact />

          {/* Sortie : icônes seules (Nouvelle / Remplacer) — « Remplacer » est Resolve seul. */}
          {!adobe.active && (
          <ToggleGroup value={[mode]} onValueChange={(v) => { const m = v[0] as "new" | "replace" | undefined; if (m) setMode(m); }} disabled={busy} spacing={0} variant="outline" size="sm" className="shrink-0">
            <Tooltip>
              <TooltipTrigger render={<ToggleGroupItem value="new" className="px-2 text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary" />}>
                <Film className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("cutTimeline.modeNewTip")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<ToggleGroupItem value="replace" className="px-2 text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary" />}>
                <Repeat className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("cutTimeline.modeReplaceTip")}</TooltipContent>
            </Tooltip>
          </ToggleGroup>
          )}

          {/* Actions : Éditer (icône, une seule sélection) puis Découper (primaire) */}
          {done ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setBatch(null); setErr(null); }} disabled={busy} className="shrink-0">{t("cutTimeline.again")}</Button>
              <Button size="sm" onClick={close} className="shrink-0">{t("common:action.close")}</Button>
            </>
          ) : (
            <>
              {single && (
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={startEdit} disabled={busy} className="shrink-0" />}>
                    {analyzing ? <Spinner className="size-4" /> : <Pencil className="size-4" />}
                  </TooltipTrigger>
                  <TooltipContent>{t("cutTimeline.editTip")}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger render={<Button size="sm" onClick={runBatch} disabled={busy || sel.size === 0} className="shrink-0" />}>
                  <Scissors className="size-4" /> {t("cutTimeline.cut")}{sel.size > 1 ? ` ${sel.size}` : ""}
                </TooltipTrigger>
                <TooltipContent>{sel.size > 1 ? t("cutTimeline.cutTipMany", { count: sel.size }) : t("cutTimeline.cutTipOne")}</TooltipContent>
              </Tooltip>
            </>
          )}
        </Card>

        {/* Progression + résultats en lot */}
        {busy && prog && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> {prog.label}</div>
            <Progress value={prog.value} />
          </div>
        )}
        {batch && (
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border p-2 text-xs">
            {batch.items.map((it) => (
              <div key={it.name} className="flex items-center gap-2">
                {it.status === "done" ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
                  : it.status === "error" ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  : it.status === "running" ? <Spinner className="size-3.5 text-primary" />
                  : <Film className="h-3.5 w-3.5 shrink-0 opacity-40" />}
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className="shrink-0 text-muted-foreground">{it.text || ""}</span>
              </div>
            ))}
          </div>
        )}
        {err && <p className="text-xs text-destructive">{err}</p>}

        {/* Navigateur de timelines façon Media Pool (dossiers + vignettes) */}
        {loading ? (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-video rounded-lg" />)}
          </div>
        ) : empty ? (
          <p className="py-10 text-center text-xs text-amber-500">{listErr || t("cutTimeline.noneInProject")}</p>
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{t("shared.noTimelineFor", { q: query })}</p>
        ) : (
          <TimelineFolders timelines={visible} bins={treeMode ? bins : new Map()} thumbs={shotThumbs} sortDir={sortDir} selected={sel} onToggle={toggle} busy={busy} />
        )}
      </div>
    </div>
  );
}
