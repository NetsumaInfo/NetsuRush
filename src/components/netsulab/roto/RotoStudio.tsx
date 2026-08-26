import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eraser, AlertTriangle, ChevronLeft, ChevronRight,
  Eye, EyeOff, Sparkles, Play, Pause, X, ArrowLeftToLine, ArrowRightToLine,
} from "lucide-react";
import { useSharedProcSources } from "@/components/upscale/useProcSources";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { fmtTime } from "@/lib/utils";
import { Accordion } from "@/components/ui/accordion";
import {
  isDefaultPost, EXPORT_FMT_KEY, EXPORT_FORMATS, REMOVE_ENGINES, REFINE_ENGINES, SAM_MODELS, VIEW_MODES,
} from "./rotoShared";
import { UpscaleCompare } from "@/components/upscale/UpscaleCompare";
import type { FrameCompare } from "@/components/upscale/useProcSources";
import { useRotoSession } from "./useRotoSession";
import { useFrameViewer } from "./useFrameViewer";
import { ObjectsPanel } from "./ObjectsPanel";
import { PointsTable } from "./PointsTable";
import { RotoViewer } from "./RotoViewer";
import { RotoTimeline } from "./RotoTimeline";
import { RotoSection, RotoStep, useRotoSections, type RotoSectionId } from "./RotoSection";
import {
  SamModelRow, TrackButtons, PostPanel, ViewPanel, EngineRow, ExportRow, RemoveParamsRows,
  MatteFinePanel,
} from "./RotoPanels";
import { useTranslation } from "react-i18next";

const BUSY_KEYS: Record<string, string> = {
  "Ouverture…": "open", "Segmentation…": "segment", "Annulation…": "undo", "Recalcul…": "recalc",
  "Suivi": "track", "Réinitialisation du suivi": "resetTrack", "Dédoublonnage": "dedupe",
  "Restauration des mattes": "restoreMattes", "Export": "export", "Matte fin": "matteFine",
  "Suppression": "remove", "Test matte (1 image)": "testMatte", "Test suppression (1 image)": "testRemove",
};

// Roto Studio : pose des points sur l'objet actif (clic gauche = inclure,
// droit = exclure, Maj+survol = preview) → masque teinté immédiat ; « Suivre » propage sur le plan
// (complet ou partiel directionnel, annulable, le playhead suit) ; puis affinage non destructif,
// matte fin, export alpha ou suppression d'objet. Logique dans useRotoSession / useFrameViewer.
export function RotoStudio() {
  const { t } = useTranslation("roto");
  const base = useSharedProcSources();
  const active = base.active;
  const s = useRotoSession(active);

  const nbFrames = s.dims?.frames || 0;
  const view = useFrameViewer(s.framesDir, s.frame, s.setFrame, nbFrames, s.fps);
  // Moteur de suppression retenu (remonté par EngineRow) : les réglages propres à la diffusion
  // n'ont aucun effet sur LaMa, qui reconstruit en une passe.
  const [removeEngine, setRemoveEngine] = useState(REMOVE_ENGINES[0].id);
  // Format d'export tenu ICI : le tiroir « Sortie » le résume quand il est fermé.
  const [exportFmt, setExportFmt] = useState(EXPORT_FORMATS[0].id);
  const sections = useRotoSections();

  // Résumés affichés sur un tiroir FERMÉ : sans eux, replier une section cacherait son état au
  // lieu de gagner de la place, et il faudrait la rouvrir juste pour savoir où on en est.
  const viewLabelKey = (VIEW_MODES.find((m) => m.id === s.view.mode) ?? VIEW_MODES[0]).labelKey;
  const postCount = useMemo(() => (isDefaultPost(s.post) ? 0 : Object.entries(s.post)
    .filter(([k, v]) => (k === "gamma" ? Math.abs(v - 1) > 1e-3 : v !== 0)).length), [s.post]);
  const selectSummary = t("summary.select", {
    model: SAM_MODELS.find((m) => m.id === s.samModel)?.label ?? s.samModel,
    count: s.objects.length,
  });
  // Le tiroir « Masque » porte deux étapes : le résumé nomme celle qui agit RÉELLEMENT sur l'alpha,
  // le matte fin en premier puisqu'il précède la retouche.
  const maskSummary = s.refined
    ? t(s.useRefined ? "summary.matteOn" : "summary.matteOff")
    : postCount ? t("summary.post", { count: postCount }) : t("summary.matteNone");
  const outputSummary = t(`exportFmt.${EXPORT_FMT_KEY[exportFmt]}Label`, {
    defaultValue: EXPORT_FORMATS.find((f) => f.id === exportFmt)?.label ?? exportFmt,
  });
  const removeSummary = t("summary.remove", { steps: s.removeParams.steps, seed: s.removeParams.seed });

  // Test sur 1 image → même charge utile qu'un test de traitement, donc même comparateur (wipe,
  // zoom molette ancré, pan). `alpha` : le damier n'a de sens que sous une image RÉELLEMENT
  // transparente, donc sous la vue « alpha » ; sous une vue opaque (édition, matte, fond couleur)
  // il ne ferait que salir le rendu qu'on juge. Sans image source, le comparateur se dégrade en
  // aperçu simple des deux côtés plutôt que de disparaître.
  const testCompare = useMemo<FrameCompare | null>(() => (s.testSrc ? {
    origUrl: s.testBefore ?? s.testSrc,
    outUrl: s.testSrc,
    width: s.dims?.w ?? 0,
    height: s.dims?.h ?? 0,
    time: s.fps > 0 ? s.frame / s.fps : 0,
    alpha: s.testMode === "alpha",
  } : null), [s.testSrc, s.testBefore, s.testMode, s.dims, s.fps, s.frame]);

  // Le matte fin n'a de sens qu'une fois le plan suivi : on déplie sa section à ce moment-là,
  // UNE seule fois — la rouvrir à chaque suivi ignorerait le fait que l'utilisateur l'a refermée.
  // Idem pour la suppression d'objet : elle exige le suivi (`disabled={!s.tracked}`), donc avant
  // lui son tiroir ne sert à rien — et après, c'est la sortie qu'on cherche.
  useEffect(() => {
    if (!s.tracked) return;
    sections.openOnce("mask");
    sections.openOnce("remove");
  }, [s.tracked, sections]);

  // Va à une frame donnée en coupant la lecture (scrub/step manuels).
  const goto = useCallback((f: number) => {
    view.stop(); s.setFrame(Math.max(0, Math.min(nbFrames - 1, f)));
  }, [view, s, nbFrames]);
  const step = useCallback((d: number) => goto(s.frame + d), [goto, s.frame]);

  // Frames annotées triées (PgUp/PgDn = saut de keyframe en keyframe).
  const annotated = useMemo(() =>
    Object.keys(s.pointsByFrame).map(Number).sort((a, b) => a - b), [s.pointsByFrame]);

  // Navigation clavier (hors saisie de texte) : ←/→ image (Maj ×10), J/K/L lecture pro, Espace,
  // I/O bornes de plage (Maj = effacer), 1-9 objet actif, PgUp/PgDn frames annotées, Ctrl+Z undo.
  useEffect(() => {
    if (!active || nbFrames < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      const big = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-big); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(big); }
      else if (e.key === " ") { e.preventDefault(); view.togglePlay(); }
      else if (e.key === "Home") { e.preventDefault(); goto(0); }
      else if (e.key === "End") { e.preventDefault(); goto(nbFrames - 1); }
      else if (k === "j") { e.preventDefault(); view.playDir(-1); }
      else if (k === "k") { e.preventDefault(); view.stop(); }
      else if (k === "l") { e.preventDefault(); view.playDir(1); }
      else if (k === "i") { e.preventDefault(); s.setInF(e.shiftKey ? null : s.frame); }
      else if (k === "o") { e.preventDefault(); s.setOutF(e.shiftKey ? null : s.frame); }
      else if (k === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void s.undoPoint(); }
      else if (k === "e") { e.preventDefault(); s.setPointLabel(s.pointLabel ? 0 : 1); }   // bascule inclure/exclure
      // Suivi pas-à-pas : , = une image en arrière ; . ou ; = une image en avant (; = AZERTY).
      else if (k === "," || k === "." || k === ";") {
        e.preventDefault();
        if (s.pointCount && !s.busy) void s.trackStep(k === "," ? -1 : 1);
      }
      else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const next = e.key === "PageUp"
          ? [...annotated].reverse().find((f) => f < s.frame)
          : annotated.find((f) => f > s.frame);
        if (next !== undefined) goto(next);
      } else if (/^[1-9]$/.test(e.key)) {
        const obj = s.objects[Number(e.key) - 1];
        if (obj) s.setActiveObj(obj.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, nbFrames, step, goto, view, s, annotated]);

  const running = !!s.busy;

  return (
    <>
      {/* Centre : viewer zoomable + timeline filmstrip + transport */}
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-4">
        {!active ? (
          <p className="text-sm text-muted-foreground">{t("studio.pickSource")}</p>
        ) : testCompare ? (
          // TEST sur une image : le comparateur PREND LA PLACE du viewer, exactement comme le
          // résultat d'un traitement. Une popup montrait le rendu au tiers de sa taille, sans zoom
          // ni loupe — donc rien de jugeable, alors que c'est là qu'on décide des réglages.
          <div className="flex w-full min-w-0 flex-col gap-2">
            {s.testLabel && <p className="text-xs text-muted-foreground">{s.testLabel}</p>}
            <UpscaleCompare data={testCompare} onClose={s.clearTest} />
          </div>
        ) : (
          <>
            <RotoViewer s={s} shown={view.shown} stopPlayback={view.stop} />
            <RotoTimeline s={s} goto={goto} />
            {nbFrames > 1 && (
              <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2">
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={view.togglePlay} aria-label={view.playing ? t("studio.pause") : t("studio.play")}>
                    {view.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </Button>} />
                  <TooltipContent>{view.playing ? t("studio.pauseTip") : t("studio.playTip")}</TooltipContent>
                </Tooltip>
                <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={s.frame <= 0} aria-label={t("studio.prevFrame")}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => step(1)} disabled={s.frame >= nbFrames - 1} aria-label={t("studio.nextFrame")}><ChevronRight className="h-4 w-4" /></Button>
                {view.speed !== 0 && Math.abs(view.speed) > 1 && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">{view.speed > 0 ? "▶" : "◀"} ×{Math.abs(view.speed)}</span>
                )}
                <span className="flex-1" />
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => s.setInF(s.frame)} aria-label={t("studio.inHere")}>
                    <ArrowLeftToLine className="h-3.5 w-3.5" />
                  </Button>} />
                  <TooltipContent>{t("studio.inTip")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => s.setOutF(s.frame)} aria-label={t("studio.outHere")}>
                    <ArrowRightToLine className="h-3.5 w-3.5" />
                  </Button>} />
                  <TooltipContent>{t("studio.outTip")}</TooltipContent>
                </Tooltip>
                {(s.inF !== null || s.outF !== null) && (
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => { s.setInF(null); s.setOutF(null); }}>
                    {t("studio.range", { from: (s.inF ?? 0) + 1, to: (s.outF ?? nbFrames - 1) + 1 })} <X className="h-3 w-3" />
                  </Button>
                )}
                <span className="ml-auto min-w-fit break-keep text-right text-xs tabular-nums text-muted-foreground">
                  {t("img")} {s.frame + 1}/{nbFrames}{s.fps > 0 && ` · ${fmtTime(s.frame / s.fps, { padMinutes: false })}`}
                </span>
              </div>
            )}
          </>
        )}
      </section>

      {/* Droite : modèle + objets + suivi + affinage + sortie */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="h-4 w-4 text-primary" /> {t("studio.title")}</h2>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => s.setShowOverlay(!s.showOverlay)} aria-label={t("studio.showMask")}>
              {s.showOverlay ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </Button>} />
            <TooltipContent>{s.showOverlay ? t("studio.hideOverlay") : t("studio.showOverlay")}</TooltipContent>
          </Tooltip>
        </div>

        {/* `scrollbar-gutter: stable` : avec `overflow-y-auto`, ouvrir une section fait apparaître
            la barre de défilement, qui reprend ~15 px de large — toute la colonne se recomposait à
            chaque clic. La gouttière est réservée en permanence. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 [scrollbar-gutter:stable]">
          {/* `multiple` : plusieurs étapes ouvertes à la fois. Un accordéon exclusif obligerait à
              refermer le suivi pour régler l'affinage, alors que les deux se répondent. */}
          <Accordion value={sections.open} onValueChange={(v) => sections.setOpen(v as RotoSectionId[])}
            multiple>
            {/* 1. Ce qu'on isole : le modèle, les objets et leurs points décrivent une seule chose. */}
            <RotoSection id="select" title={t("panels.selection")} summary={selectSummary}>
              <div className="space-y-3">
                <RotoStep label={t("panels.model")}>
                  <SamModelRow model={s.samModel} installed={s.installedSam} onChoose={s.chooseSam} disabled={running} />
                </RotoStep>
                <RotoStep label={t("objects.title")}>
                  <ObjectsPanel s={s} />
                </RotoStep>
                <RotoStep label={t("points.title")} hint={t("summary.points", { count: s.pointCount })}>
                  <PointsTable s={s} goto={goto} running={running} />
                </RotoStep>
              </div>
            </RotoSection>

            {/* 2. Propager la sélection sur le plan. */}
            <RotoSection id="track" title={t("panels.track")}
              summary={s.tracked ? t("summary.tracked") : t("summary.notTracked")}>
              <TrackButtons s={s} running={running} />
            </RotoSection>

            {/* 3. Ce qu'on regarde — un mode, pas un réglage : il change en permanence pendant le travail. */}
            <RotoSection id="view" title={t("panels.display")} summary={t(viewLabelKey)}>
              <ViewPanel view={s.view} onChange={s.updateView} disabled={running} />
            </RotoSection>

            {/* 4. Un seul alpha, façonné en deux temps : le modèle d'abord, la main ensuite. L'ordre
                   est celui du calcul — la retouche s'applique PAR-DESSUS le matte fin. */}
            <RotoSection id="mask" title={t("panels.mask")} summary={maskSummary}>
              <div className="space-y-3">
                <RotoStep label={t("panels.matteFine")} hint={t("mask.stepModel")}>
                  <MatteFinePanel s={s} engines={REFINE_ENGINES} disabled={running} />
                </RotoStep>
                <RotoStep label={t("panels.maskRefine")}
                  hint={s.refined && s.useRefined ? t("mask.stepOnRefined") : t("mask.stepManual")}>
                  <PostPanel post={s.post} onChange={s.updatePost} disabled={running || (!s.pointCount && !s.tracked)} />
                </RotoStep>
              </div>
            </RotoSection>

            {/* 5. Effacer au lieu d'extraire : le masque pilote la reconstruction du fond. Tiroir à
                   part — rangée sous « Sortie », l'opération passait pour une variante de l'export. */}
            <RotoSection id="remove" title={t("panels.removeObject")} summary={removeSummary}>
              <div className="space-y-1.5">
                <EngineRow label={t("panels.removeObject")} icon={Eraser} engines={REMOVE_ENGINES}
                  installed={s.installedModels} disabled={!s.tracked || running} onRun={s.removeSelected}
                  onTest={s.testRemove} testDisabled={!s.tracked || running} onEngineChange={setRemoveEngine} />
                <RemoveParamsRows value={s.removeParams} onChange={s.setRemoveParams} disabled={running}
                  diffusion={removeEngine === "minimax-remover"} />
              </div>
            </RotoSection>

            {/* 6. Dernier geste : écrire le fichier avec sa couche alpha. En queue de rail parce que
                   tout ce qui précède — masque, matte, effacement — décide de ce qu'il contient. */}
            <RotoSection id="output" title={t("panels.output")} summary={outputSummary}>
              <RotoStep label={t("output.exportStep")}>
                <ExportRow fmt={exportFmt} onFmtChange={setExportFmt} disabled={!s.tracked || running}
                  objects={s.objects} onExport={s.exportAs} />
              </RotoStep>
            </RotoSection>
          </Accordion>
        </div>

        <div className="space-y-2 border-t border-border p-3">
          {running && (
            <div className="space-y-1">
              <Progress value={s.prog?.pct ?? null} className="h-1.5" />
              <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5" />
                  {t(`busy.${BUSY_KEYS[s.busy || ""]}`, { defaultValue: s.busy || "" })}{s.prog?.stage ? ` — ${t(`stage.${s.prog.stage}`, { defaultValue: s.prog.stage })}` : ""}
                </p>
                {/* Le matte fin dure autant qu'un suivi : l'abandonner ne doit pas demander de
                    tuer le service. Même drapeau d'annulation, testé image par image. */}
                {(s.busy === "Suivi" || s.busy === "Matte fin") && (
                  <Button variant="ghost" size="sm" className="h-6 shrink-0 text-xs" onClick={s.cancel}>
                    <X className="h-3 w-3" /> {t("cancel")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {s.err && <Card className="block border-destructive/40 p-2.5 text-xs text-destructive"><AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" /> {s.err}</Card>}
          {s.note && !s.err && <p className="break-all text-xs text-muted-foreground">{s.note}</p>}
        </div>
      </aside>

    </>
  );
}
