import { useEffect, useState } from "react";
import { ScanSearch, ImagePlay, AlertTriangle, FileVideo, FileOutput, ChevronLeft, ChevronRight, Check, Image as ImageIcon } from "lucide-react";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, fmtTime, thumbTime } from "@/lib/utils";
import { nativePlayer } from "@/lib/nativePlayer";
import { LazyThumb } from "@/components/rushes/LazyThumb";
import { warmGenerateThumbs, warmResolveThumbs } from "@/lib/thumbCache";
import { UpscalePlayer } from "./UpscalePlayer";
import { isStillSource } from "./imageOutput";
import { UpscaleCompare } from "./UpscaleCompare";
import { RenderedReview } from "./RenderedReview";
import type { FrameCompare, ProcController } from "./useProcSources";
import type { UpScope } from "./upscaleShared";
import { useTranslation } from "react-i18next";

const fmt = (s: number) => fmtTime(s, { padMinutes: false });

const SCOPES: UpScope[] = ["whole", "range", "scenes"];

export function UpscalePreview({ up }: { up: ProcController }) {
  const { t } = useTranslation("upscale");
  const { sources, single, active, activeKey, activeIdx, setActiveIdx, native, fps,
    scope, setScope, duration, range, setRange, setSourceRange,
    scenes, picked, detecting, detectScenes, toggleScene, setAllScenes,
    compare, testing, testErr, testFrame, clearCompare,
    renderedForActive, activeRender, renderReviewOpen, selectRender, openRenderReview, closeRenderReview } = up;

  // Intention de lecture (clic bac / chevrons) → le lecteur démarre en boucle sur le plan.
  const playNonce = useApp((s) => s.nlPlayNonce);
  const [cur, setCur] = useState(0);
  const [goto, setGoto] = useState<{ t: number; n: number } | null>(null);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [renderCompare, setRenderCompare] = useState<FrameCompare | null>(null);
  // La source aperçue porte-t-elle déjà un rognage ? → afficher les poignées de plage sur ces bornes.
  const trimmed = !!active && active.in != null && active.out != null;
  const singlePath = single?.path;
  // Keyé sur l'identité de la SOURCE (uid), pas le fichier : un autre plan du même fichier recharge.
  useEffect(() => { setCur(active?.in ?? 0); setPreviewIdx(null); setRenderCompare(null); }, [activeKey, active?.in]);

  // Même amorçage que NetsuCut/Timeline : un seul RPC résout le cache existant, puis seules les
  // absentes sont générées en basse priorité. Les cartes visibles gardent la priorité haute.
  useEffect(() => {
    if (!singlePath || !scenes.length) return;
    const items = scenes.map((s) => ({ path: singlePath, time: thumbTime(s.start, s.end) }));
    void warmResolveThumbs(items);
    warmGenerateThumbs(items);
  }, [singlePath, scenes]);

  // Le lecteur mpv vit dans une surface Windows distincte, au-dessus du WebView.
  // Quand la dernière source est désélectionnée, l'état vide React ne suffit donc
  // pas : on libère explicitement le média et on masque aussi cette surface native.
  useEffect(() => {
    if (active && !isStillSource(active)) return;
    void nativePlayer.stop().catch(() => {});
    void nativePlayer.hide().catch(() => {});
  }, [active]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
        <FileVideo className="h-10 w-10 opacity-40" />
        <p>{t("preview.selectRushLeft")}</p>
      </div>
    );
  }

  const multi = sources.length > 1;
  const idx = Math.min(activeIdx, sources.length - 1);
  const reviewActive = renderReviewOpen && !!activeRender;
  // Image fixe : ni durée, ni plage, ni plans — l'aperçu est l'image elle-même et le test porte
  // forcément sur elle (t = 0).
  const still = isStillSource(active);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* En-tête : clip aperçu (+ navigation entre clips en multi) + portée (si 1 seul) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {multi && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setActiveIdx((idx - 1 + sources.length) % sources.length)} aria-label={t("preview.prevClip")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>} />
              <TooltipContent>{t("preview.prevClip")}</TooltipContent>
            </Tooltip>
          )}
          {still
            ? <Tooltip>
                <TooltipTrigger render={<ImageIcon className="h-4 w-4 shrink-0 text-primary" />} />
                <TooltipContent>{t("preview.stillSource")}</TooltipContent>
              </Tooltip>
            : <FileVideo className="h-4 w-4 shrink-0 text-primary" />}
          <Tooltip>
            <TooltipTrigger render={<span className="truncate font-medium">{active.name}</span>} />
            <TooltipContent>{active.path}</TooltipContent>
          </Tooltip>
          {multi && <span className="shrink-0 text-xs text-muted-foreground">{idx + 1}/{sources.length}</span>}
          {duration > 0 && <span className="shrink-0 text-xs text-muted-foreground">· {fmt(duration)}</span>}
          {multi && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setActiveIdx((idx + 1) % sources.length)} aria-label={t("preview.nextClip")}>
                <ChevronRight className="h-4 w-4" />
              </Button>} />
              <TooltipContent>{t("preview.nextClip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {/* Portée de la source APERÇUE (marche en multi : chaque source se rogne indépendamment).
            Entier = clip complet · Plage = rogner in/out (persisté sur la source) · Plans = par plan (source unique). */}
        {!still && <ToggleGroup value={[trimmed && scope === "whole" ? "range" : scope]} onValueChange={(v) => {
          const s = v[0] as UpScope; if (!s) return;
          setScope(s);
          if (s === "range") setSourceRange(idx, range[0], range[1]);     // fige le rognage courant
          else setSourceRange(idx, null, null);                          // Entier/Plans → dérogne la source
        }}>
          {SCOPES.filter((s) => s !== "scenes" || single).map((s) => <ToggleGroupItem key={s} value={s}>{t(`scope.${s}`)}</ToggleGroupItem>)}
        </ToggleGroup>}
        {!reviewActive && renderedForActive.length > 0 && (
          <Button variant="outline" size="sm" onClick={openRenderReview}>
            <FileOutput className="size-4 text-[var(--color-ok)]" /> {t("review.open", { count: renderedForActive.length })}
          </Button>
        )}
      </div>

      {multi && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("preview.multiHint", { count: sources.length })}
        </p>
      )}

      {/* Après export : le résultat prend automatiquement la place du viewer. Un seul lecteur reste
          monté (source OU rendu) pour respecter l'unique surface mpv ; le bouton A/B garde la même
          progression. La comparaison détaillée extrait deux PNG lossless à cet instant. */}
      {(() => {
        const shownCompare = renderCompare ?? (!reviewActive ? compare : null);
        if (shownCompare) return (
          <UpscaleCompare key={`${shownCompare.sourceKey || "compare"}:${shownCompare.revision || 0}`}
            data={shownCompare} onClose={() => renderCompare ? setRenderCompare(null) : clearCompare()} />
        );
        if (reviewActive && activeRender) return (
          <RenderedReview
            review={activeRender} reviews={renderedForActive}
            sourceDuration={duration} sourceNative={native} sourceFps={fps}
            onSelect={selectRender} onClose={closeRenderReview} onCompare={setRenderCompare}
          />
        );
        if (still) return (
          <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-black/40 p-2">
            <img src={nr.mediaUrl(active.path)} alt={active.name} className="max-h-[52vh] max-w-full object-contain" />
          </div>
        );
        return (
          <UpscalePlayer
            key={activeKey}
            path={active.path} mediaKey={activeKey} duration={duration} native={native} fps={fps}
            rangeMode={scope === "range" || trimmed}
            rangeIn={range[0]} rangeOut={range[1]}
            onRange={(i, o) => { setRange([i, o]); setSourceRange(idx, i, o); }} onTime={setCur} goto={goto}
            playSignal={playNonce}
          />
        );
      })()}

      {/* Test d'upscale sur la frame courante */}
      {!reviewActive && <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => testFrame(still ? 0 : cur)} disabled={testing}>
          {testing ? <Spinner className="h-4 w-4" /> : <ImagePlay className="h-4 w-4" />}
          {testing ? t("preview.testing") : compare
            ? t("preview.testAnotherModel")
            : still ? t("preview.testStill")
            : t("preview.testOnImage", { time: fmt(cur) })}
        </Button>
        {compare && <span className="text-xs text-muted-foreground">{t("preview.wheelZoom")}</span>}
        {testErr && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> {testErr}
          </span>
        )}
      </div>}

      {/* Sélection des plans détectés (scope = scenes) — grille avec vignettes. Masqué pour un plan de
          timeline (sa portée est déjà fixée par le cut). */}
      {single && !still && scope === "scenes" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={detectScenes} disabled={detecting}>
              {detecting ? <Spinner className="h-4 w-4" /> : <ScanSearch className="h-4 w-4" />} {t("preview.detectShots")}
            </Button>
            {scenes.length > 0 && (
              <>
                <span className="text-xs text-muted-foreground">{t("preview.selectedCount", { picked: picked.size, total: scenes.length })}</span>
                <Button variant="ghost" size="sm" onClick={() => setAllScenes(picked.size < scenes.length)}>
                  {picked.size < scenes.length ? t("preview.all") : t("preview.none")}
                </Button>
              </>
            )}
          </div>
          {scenes.length > 0 ? (
            <>
              <p className="text-[11px] text-muted-foreground">{t("preview.shotHint")}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {scenes.map((s, i) => {
                  const sel = picked.has(i);
                  const previewing = previewIdx === i;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "group relative overflow-hidden rounded-lg border transition-all",
                        previewing ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/60",
                      )}
                    >
                      <Tooltip>
                        <TooltipTrigger render={<button type="button" className="block w-full text-left"
                          onClick={() => { setPreviewIdx(i); setGoto({ t: s.start, n: (goto?.n || 0) + 1 }); }}>
                          <LazyThumb path={single.path} at={s.start} out={s.end} rootMargin={600} className="aspect-video w-full rounded" />
                          <div className="flex items-center justify-between px-1.5 py-1 text-[10px]">
                            <span className="font-medium">{t("preview.shot", { n: i + 1 })}</span>
                            <span className="tabular-nums text-muted-foreground">{fmt(s.start)}→{fmt(s.end)}</span>
                          </div>
                        </button>} />
                        <TooltipContent>{t("preview.shotPreview")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<button type="button" onClick={() => toggleScene(i)}
                          aria-label={sel ? t("preview.deselect") : t("preview.select")}
                          className={cn(
                            "absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                            sel ? "border-primary bg-primary text-primary-foreground"
                                : "border-white/40 bg-black/40 text-transparent hover:border-primary hover:text-primary/70",
                          )}>
                          <Check className="h-3 w-3" />
                        </button>} />
                        <TooltipContent>{sel ? t("preview.deselect") : t("preview.select")}</TooltipContent>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            !detecting && <p className="text-xs text-muted-foreground">{t("preview.detectPrompt")}</p>
          )}
        </div>
      )}
    </div>
  );
}
