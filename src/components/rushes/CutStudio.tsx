import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, Scissors, FolderInput, CheckSquare, Square,
  Combine, Film, Play, Clapperboard, Minus, Plus, LayoutGrid, GripVertical, Image as ImageIcon, Zap,
  PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { nr, nextProxyToken } from "@/lib/bridge";
import { thumbTime } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { ScenePlayer, type ScenePlayerApi } from "@/components/player/ScenePlayer";
import { autoplayCeiling, fmt, gridMetrics, setMaxPlaying, onGridScroll, type Segment } from "./cutStudioShared";
import { RATE_LADDER } from "./cutShortcuts";
import { useCutActions } from "./useCutActions";
import { useCutShortcuts } from "./useCutShortcuts";
import { getActiveExportProfile, isTimelineImport } from "@/features/export/profiles";
import { SceneCard } from "./SceneCard";
import { CutContextMenu } from "./CutContextMenu";
import { useShotDetection } from "./useShotDetection";
import { usePanelLayout } from "./usePanelLayout";
import { useCutExport } from "./useCutExport";
import { ExportButton } from "@/components/export/ExportButton";
import { ExportAudioSelect } from "@/components/export/ExportAudioSelect";
import { ExportTimelineTarget } from "@/components/export/ExportTimelineTarget";
import { useExport } from "@/components/export/useExport";
import { TimelineInsertionSelect } from "./TimelineInsertionSelect";
import { modelUsesPreset } from "@/lib/detection";
import { DetectionAdvancedSettings } from "./DetectionAdvancedSettings";
import { DetectionModelSelect, DetectionPresetSelect } from "./DetectionControls";

// Seuils de mise en page (px) : sous NARROW_W la vue passe en colonne, et la grille garde toujours
// au moins MIN_GRID_W — sinon la barre d'outils n'a plus de place et ses boutons s'empilent.
const NARROW_W = 640;
const MIN_GRID_W = 260;

export function CutStudio() {
  const { t } = useTranslation(["derush", "common"]);
  const { selected, close, connected, pinned } = useApp(
    useShallow((s) => ({ selected: s.selected, close: s.close, connected: s.connected, pinned: s.pinned })),
  );
  const clip = selected!;
  const isLocal = clip.source === "local";
  // Fenêtre épinglée → mode compact : vignettes seules (lecteur masqué, barre d'outils allégée) pour
  // tenir dans un coin de l'écran. L'import se fait via le bouton télécharger de chaque vignette.
  const compact = pinned;

  const det = useShotDetection(clip.path);
  const {
    info, duration, segments, srcFrames, detecting, cacheLoading, progress,
    active, activeUrl,
    msg, setMsg, err, setErr, preset, setPreset, model, setModel,
    proxyCache, getProxy, playScene, detect,
    hasEdits, clearEdits, undoEdit, redoEdit,
  } = det;

  const { cols, setCols, panelW, setPanelW, panelRef, resizingRef, startPanelDrag, playerOpen, setPlayerOpen } = usePanelLayout();
  // Lecteur visible seulement si demandé ET hors mode compact (épinglé = vignettes seules).
  const showPanel = playerOpen && !compact;

  // Largeur RÉELLE de la vue (≠ largeur de fenêtre) : NetsuCut vit aussi dans le panneau CEP Adobe
  // (~400 px) et dans la fenêtre épinglée. Le lecteur latéral était un `shrink-0` de 360 px : sous
  // ~600 px il ne laissait qu'une dizaine de pixels à la grille, dont la barre d'outils se repliait
  // en pile illisible (« les icônes disparaissent »). En dessous de NARROW_W on EMPILE (lecteur en
  // tête, grille dessous) et on borne la largeur du lecteur pour garder une grille utilisable.
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootW, setRootW] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootW(el.clientWidth));
    setRootW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = rootW > 0 && rootW < NARROW_W;
  const asideW = rootW ? Math.min(panelW, Math.max(MIN_GRID_W, rootW - MIN_GRID_W)) : panelW;

  const { sel, setSel, toggleSel, selectAll, deselect, mergeSelected, removeSelected } = useCutActions(det, clip.path);
  const [gridPlay, setGridPlay] = useState(() => useApp.getState().cutGridPlay);
  const [proxyGen, setProxyGen] = useState<{ done: number; total: number } | null>(null);
  const [thumbsGen, setThumbsGen] = useState<{ done: number; total: number } | null>(null);
  const thumbsAbortRef = useRef(false);
  const playerApi = useRef<ScenePlayerApi | null>(null);

  // « Tout lire » concentre la lecture sur la grille : le lecteur latéral s'arrête immédiatement
  // pour libérer son décodeur. Il reste ensuite volontairement pilotable manuellement.
  function setGridPlayback(enabled: boolean) {
    if (enabled) playerApi.current?.pause();
    setGridPlay(enabled);
  }

  // Pas de pré-génération en masse des proxys : ça inondait le CPU (décode source de chaque proxy)
  // et affamait les vignettes → grille noire. Les proxys se génèrent à la demande pour les rangées
  // proches (nearVideo, visible ± 1 rangée), ce qui suffit à la lecture ; les vignettes (légères,
  // seeks rapides) priment et remplissent la grille.

  // Plafond de lecture = nombre de miniatures VISIBLES (+1 rangée tampon) → toutes les visibles
  // jouent, la rangée suivante est préchargée. Recalculé à chaque resize de la zone défilante et
  // à chaque changement de colonnes. Carte = aspect-video (h = largeur × 9/16), grille gap-3 (12px).
  // Grille RESPONSIVE : `cols` n'est plus un nombre FIXE de colonnes (qui rendait les cartes géantes
  // sur grand écran et débordantes sur petit) mais une CIBLE de densité. On dérive une largeur de
  // cellule bornée (140–320px) = largeur/cols, et la grille fait `auto-fill` → le nombre réel de
  // colonnes s'adapte à la largeur de la fenêtre. Le +/- ajuste le zoom des vignettes.
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  const { cell, actualCols, cellH } = gridMetrics(gridW, cols, narrow);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const recompute = () => {
      // Pendant le drag, le navigateur relayout la grille CSS tout seul. Mettre `gridW` à jour ici
      // rerendrait les centaines de SceneCard à chaque pixel et recréerait le lag initial.
      if (resizingRef.current) return;
      const cw = el.clientWidth, ch = el.clientHeight;
      if (!cw || !ch) return;
      setGridW(cw);
      const ceiling = autoplayCeiling(cw, ch, cols, narrow);
      if (ceiling) setMaxPlaying(ceiling);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, narrow, panelW, resizingRef]);

  const selectedList = () => segments.filter((s) => sel.has(s.id));
  // Les aperçus peuvent cibler tout le rush, mais les actions d'export exigent une sélection.
  const targetList = () => {
    const list = selectedList();
    return list.length ? list : segments;
  };

  // Vide la sélection (héritée des plans précédents) avant de relancer la détection.
  function runDetect() { setSel(new Set()); detect(); }

  const exp = useCutExport({
    clipPath: clip.path,
    clipName: clip.name,
    srcFrames,
    targetList,
    hasSelection: () => selectedList().length > 0,
    setMsg,
    setErr,
  });
  const { busy, exported, createTimeline, appendSelection, addToTimeline, importBack } = exp;
  const { download, busy: dlBusy } = useExport();
  const exportProgress = useApp((s) => s.exportProgress);
  const exportNotice = useApp((s) => s.exportNotice);
  const exportError = useApp((s) => s.exportError);
  const exportProfiles = useApp((s) => s.exportProfiles);
  const cardActionProfileId = useApp((s) => s.cardActionProfileId);
  const activeExportProfileId = useApp((s) => s.activeExportProfileId);
  const exportBaseName = clip.name.replace(/\.[^.]+$/, "");
  // Le choix de piste audio vit dans le profil actif (résolu côté core par resolveClipAudio) — pas
  // d'état local qui divergerait de ce que montrent les Réglages d'export.
  const activeProfile = getActiveExportProfile(exportProfiles, activeExportProfileId);
  const exportInputs = () => selectedList().map((s) => ({ input: clip.path, start: s.in, end: s.out }));

  // Petit bouton de chaque vignette : applique le profil configuré (import timeline OU fichier).
  const cardProfile = getActiveExportProfile(exportProfiles, cardActionProfileId);
  const cardIsTimeline = isTimelineImport(cardProfile.workflow);
  const showCardBtn = cardIsTimeline ? connected && !isLocal : true;
  const runCardAction = (s: Segment) =>
    cardIsTimeline
      ? addToTimeline(s)
      : download({ clips: [{ input: clip.path, start: s.in, end: s.out }], baseName: exportBaseName, profileId: cardActionProfileId });
  useEffect(() => { if (exportNotice) setMsg(exportNotice); }, [exportNotice, setMsg]);
  useEffect(() => { if (exportError) setErr(exportError); }, [exportError, setErr]);

  // Navigation de plan en plan depuis le lecteur (flèches) : part du plan actif, sinon du premier.
  function stepShot(d: number) {
    if (!segments.length) return;
    const i = active ? segments.findIndex((s) => s.id === active.id) : -1;
    const next = segments[Math.min(segments.length - 1, Math.max(0, i < 0 ? 0 : i + d))];
    if (next) playScene(next);
  }
  // J/K/L : vitesse CUMULÉE le long des paliers (valeurs négatives = lecture arrière).
  const rateIdx = useRef(RATE_LADDER.indexOf(1));
  function bumpRate(d: number) {
    rateIdx.current = Math.min(RATE_LADDER.length - 1, Math.max(0, rateIdx.current + d));
    playerApi.current?.setRate(RATE_LADDER[rateIdx.current]);
  }

  useCutShortcuts({
    playPause: () => { const a = playerApi.current; if (a) (a.paused() ? a.play() : a.pause()); },
    prevShot: () => stepShot(-1),
    nextShot: () => stepShot(1),
    firstShot: () => segments[0] && playScene(segments[0]),
    lastShot: () => { const l = segments[segments.length - 1]; if (l) playScene(l); },
    speedDown: () => bumpRate(-1),
    speedUp: () => bumpRate(1),
    speedPlay: () => { rateIdx.current = RATE_LADDER.indexOf(1); playerApi.current?.setRate(1); },
    merge: mergeSelected,
    removeShot: removeSelected,
    selectAll,
    deselect,
    undo: undoEdit,
    redo: redoEdit,
    detect: runDetect,
    export: () => void download({ clips: exportInputs(), baseName: exportBaseName }),
    togglePlayer: () => setPlayerOpen((v) => !v),
    // Actions indisponibles = absentes de la map (donc inertes) : pas de timeline hors connexion,
    // pas de raccourci de préréglage pour les modèles pilotés par leurs paramètres avancés.
    ...(connected && !isLocal ? { sendTimeline: appendSelection } : {}),
    ...(modelUsesPreset(model)
      ? { preset1: () => setPreset(0), preset2: () => setPreset(1), preset3: () => setPreset(2), preset4: () => setPreset(3) }
      : {}),
  }, { frameStep: (d) => { const a = playerApi.current; if (a) a.seek(a.time() + d); } });

  // Tokens des jobs proxy en cours (un par plan) → permettent d'ANNULER : proxyCancel(token) jette
  // les jobs encore en file et SIGKILL le ffmpeg en vol. genAbort = drapeau pour le message final.
  const genTokensRef = useRef<number[]>([]);
  const genAbortRef = useRef(false);

  // Pré-génère les proxys d'aperçu de TOUS les plans (ou de la sélection) à la MÊME hauteur que la
  // grille (palier de cache identique → la lecture auto réutilise les fichiers, instantanée). En
  // priorité 'low' : la file core cède toujours au survol/au plan actif, donc l'UI reste réactive.
  //
  // Pool BORNÉ (pas de Promise.all sur 1400 plans) : sinon le navigateur étale les fetch par vagues
  // et des requêtes partent APRÈS l'« Arrêter » → elles encodaient quand même (« ça continue »). Ici
  // un nombre fixe d'ouvriers tire les plans un par un ; l'arrêt lève genAbort → aucun nouveau fetch,
  // et proxyCancelMany tue les rares encodes déjà en vol (kill ffmpeg + tokens marqués annulés).
  async function generateProxies() {
    if (proxyGen) {   // déjà en cours → le bouton sert d'ARRÊT
      genAbortRef.current = true;
      nr.proxyCancelMany(genTokensRef.current);
      return;
    }
    const list = targetList();
    if (!list.length) return;
    // hauteur de cellule = largeur carte × 9/16 × DPR (cf. SceneCard) → même palier que la grille.
    const el = gridScrollRef.current;
    let height: number | undefined;
    if (el?.clientWidth) {
      const cardW = gridMetrics(el.clientWidth, cols, narrow).cell;
      height = Math.round(((cardW * 9) / 16) * (window.devicePixelRatio || 1));
    }
    setMsg(null); setErr(null);
    genAbortRef.current = false;
    genTokensRef.current = [];
    let done = 0, idx = 0;
    setProxyGen({ done, total: list.length });
    // 6 ouvriers = encodes en vol bornés → « Arrêter » ne laisse que ≤6 ffmpeg à tuer, instantané.
    const worker = async () => {
      while (idx < list.length && !genAbortRef.current) {
        const s = list[idx++];
        const token = nextProxyToken();
        genTokensRef.current.push(token);
        try { await getProxy(s, "low", height, token); } catch { /* plan suivant */ }
        done++; setProxyGen({ done, total: list.length });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    setProxyGen(null);
    if (genAbortRef.current) { setMsg(t("cutStudio.genStopped", { done, total: list.length })); genAbortRef.current = false; }
    else setMsg(t("cutStudio.proxiesReady", { count: list.length }));
  }

  // Pré-génère les vignettes de la grille. Pool BORNÉ (8 ouvriers) + ARRÊT, comme les proxys : un
  // nr.thumbnail par plan (caché disque/RAM), CPU (thumbGate) → tourne EN MÊME TEMPS que l'encode
  // proxy (GPU). Re-clic pendant = ARRÊT (thumbsAbort → plus aucun fetch lancé).
  async function generateThumbs() {
    if (thumbsGen) { thumbsAbortRef.current = true; return; }
    const list = targetList();
    if (!list.length) return;
    setMsg(null); setErr(null);
    thumbsAbortRef.current = false;
    let done = 0, idx = 0;
    setThumbsGen({ done, total: list.length });
    const worker = async () => {
      while (idx < list.length && !thumbsAbortRef.current) {
        const s = list[idx++];
        try { await nr.thumbnail(clip.path, thumbTime(s.in, s.out)); } catch { /* plan suivant */ }
        done++; setThumbsGen({ done, total: list.length });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    setThumbsGen(null);
    if (thumbsAbortRef.current) { setMsg(t("cutStudio.thumbsStopped", { done, total: list.length })); thumbsAbortRef.current = false; }
    else setMsg(t("cutStudio.thumbsReady", { count: list.length }));
  }

  const selCount = selectedList().length;
  const verb = selCount ? `(${selCount})` : t("shared.all");

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {/* header de détection : masqué en mode compact (épinglé) → tout passe par le clic droit */}
      {!compact && (
      <div className="relative shrink-0 border-b border-border px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
           <button type="button" aria-label={t("common:action.back")} onClick={close} className="inline-flex items-center justify-center rounded-md transition-colors hover:bg-accent h-8 px-2 text-sm"><ArrowLeft className="h-4 w-4" /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-tight">{clip.name}</div>
            {info && <div className="text-[11px] leading-tight text-muted-foreground">{info.width}×{info.height} · {fmt(duration)}</div>}
          </div>
          {/* Vue étroite : sélecteurs RÉTRÉCIS, jamais masqués — le choix du modèle de détection est
              le réglage le plus utilisé de la vue, le cacher dans le panneau Adobe le rendait
              introuvable. L'entête se replie sur deux lignes (flex-wrap) plutôt que d'amputer. */}
          <DetectionModelSelect model={model} onChange={setModel} disabled={detecting} className={narrow ? "w-28" : "w-36"} />
          <DetectionPresetSelect model={model} preset={preset} onChange={setPreset} disabled={detecting} className={narrow ? "w-24" : "w-28"} />
          <DetectionAdvancedSettings model={model} disabled={detecting} compact />
          <Tooltip>
            <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" onClick={runDetect} disabled={detecting} aria-label={t("shared.detectShots")} />}>
              {detecting ? <Spinner className="size-4" /> : <Scissors className="size-4" />}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {detecting && progress ? `${t("shared.analyzing")} ${progress}%` : t("shared.detectShots")}
            </TooltipContent>
          </Tooltip>
        </div>
        {/* progression : fine ligne sur la bordure du bas (n'agrandit pas l'entête → zéro saut) */}
        {detecting && (
          <Progress value={progress} className="absolute inset-x-0 bottom-0 [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none" />
        )}
      </div>
      )}
      {/* progression de détection en compact (pas de header) : fine ligne en haut de la grille */}
      {compact && detecting && (
        <Progress value={progress} className="shrink-0 [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none" />
      )}

      {/* Grille à gauche (défile seule), lecteur + actions à droite (fixe, redimensionnable).
          Vue étroite → colonne : lecteur en tête, grille dessous. */}
      <div className={"flex min-h-0 flex-1 px-4 " + (narrow ? "flex-col" : "")}>
        {/* gauche : barre d'outils fixe en tête + grille défilante. Enveloppée dans le clic droit
            (CutContextMenu) qui expose TOUTES les actions — seule surface d'action en mode compact. */}
        <CutContextMenu
          segmentsCount={segments.length} selCount={selCount} allSelected={selCount === segments.length}
          detecting={detecting} busy={!!busy || !!dlBusy}
          model={model} setModel={setModel} preset={preset} setPreset={setPreset} onDetect={runDetect}
          onSelectAll={selectAll} onDeselect={deselect} onMerge={mergeSelected}
          hasEdits={hasEdits} onClearEdits={clearEdits}
          gridPlay={gridPlay} setGridPlay={setGridPlayback} cols={cols} setCols={setCols}
          onThumbs={generateThumbs} thumbsBusy={!!thumbsGen} onProxies={generateProxies} proxyBusy={!!proxyGen}
          connected={connected} isLocal={isLocal}
          onExtract={() => void download({ clips: exportInputs(), baseName: exportBaseName })} onCreateTimeline={createTimeline} onAppendSelection={appendSelection}
          exportedCount={exported.length} onImportBack={importBack}
          compact={compact} playerOpen={playerOpen} setPlayerOpen={setPlayerOpen}
          onClose={close}
        >
          {segments.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 py-1">
              <button type="button" onClick={selectAll} className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                {selCount === segments.length ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4" />}
                <span className="tabular-nums">{narrow ? `${segments.length}${selCount ? `/${selCount}` : ""}` : `${t("cutStudio.shotCount", { count: segments.length })}${selCount ? t("cutStudio.selSuffix", { count: selCount }) : ""}`}</span>
              </button>
              {selCount > 0 && (
                <button type="button" onClick={() => setSel(new Set())} className="flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground">{t("shared.deselect")}</button>
              )}
              {selCount >= 2 && (
                <Tooltip>
                  <TooltipTrigger render={<Button size="sm" variant="outline" onClick={mergeSelected} className="h-8 gap-1 px-2 text-xs text-muted-foreground" />}>
                    <Combine className="size-3.5" /> {selCount}
                  </TooltipTrigger>
                  <TooltipContent>{t("cutStudio.mergeTip", { count: selCount })}</TooltipContent>
                </Tooltip>
              )}
              <div className="flex-1" />
              {connected && !isLocal && (
                <Tooltip>
                  <TooltipTrigger render={<Button size="sm" onClick={appendSelection} disabled={!!busy || selCount === 0} className="h-8 w-8 p-0 text-xs" />}>
                    <Clapperboard className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>{selCount ? t("cutStudio.sendSelectionToOpen") : t("cutStudio.sendAllToOpen")}</TooltipContent>
                </Tooltip>
              )}
              {!compact && (<>
              <Tooltip>
                <TooltipTrigger render={
                  <Button size="sm" variant="outline" onClick={generateThumbs}
                    className={"h-8 text-xs " + (thumbsGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
                }>
                  {thumbsGen
                    ? <><Square className="size-3.5 fill-current" /> {thumbsGen.done}/{thumbsGen.total}</>
                    : <ImageIcon className="size-3.5" />}
                </TooltipTrigger>
                <TooltipContent>{thumbsGen ? t("shared.stop") : t("shared.genThumbs", { verb })}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={
                  <Button size="sm" variant="outline" onClick={generateProxies}
                    className={"h-8 text-xs " + (proxyGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
                }>
                  {proxyGen
                    ? <><Square className="size-3.5 fill-current" /> {proxyGen.done}/{proxyGen.total}</>
                    : <Zap className="size-3.5" />}
                </TooltipTrigger>
                <TooltipContent>{proxyGen ? t("shared.stop") : t("shared.genProxies", { verb })}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={gridPlay}
                    onPressedChange={setGridPlayback}
                    className="text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15"
                  />
                }>
                  <Play className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>{t("shared.autoplayPreviews")}</TooltipContent>
              </Tooltip>
              </>)}
              <Tooltip>
                <TooltipTrigger render={<div className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-card px-1 text-xs" />}>
                  <LayoutGrid className="mr-0.5 h-3.5 w-3.5 text-muted-foreground" />
                   <button type="button" aria-label={t("common:action.decrease")} onClick={() => setCols((c) => Math.max(2, c - 1))} disabled={cols <= 2} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Minus className="h-3.5 w-3.5" /></button>
                  <span className="w-4 text-center tabular-nums">{cols}</span>
                   <button type="button" aria-label={t("common:action.increase")} onClick={() => setCols((c) => Math.min(8, c + 1))} disabled={cols >= 8} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
                </TooltipTrigger>
                <TooltipContent>{t("shared.thumbSize")}</TooltipContent>
              </Tooltip>
              {!compact && (<>
              {/* Duo d'export compact : le panneau de droite est refermable, l'export ne doit pas
                  disparaître avec lui. Même contrôle que Collections et Timeline Live. */}
              <ExportButton
                clips={exportInputs}
                baseName={exportBaseName}
                onTimelineImport={appendSelection}
                disabled={selCount === 0 || !!busy}
                compact
              />
                <Tooltip>
                  <TooltipTrigger render={<Button size="sm" variant="outline" onClick={() => setPlayerOpen((v) => !v)} className="h-8 text-xs text-muted-foreground" />}>
                    {playerOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
                  </TooltipTrigger>
                  <TooltipContent>{playerOpen ? t("cutStudio.hidePlayer") : t("cutStudio.showPlayer")}</TooltipContent>
                </Tooltip>
              </>)}
            </div>
          )}
          {/* zone défilante : seule la grille bouge (padding pour ne pas rogner hover/anneau).
              onScroll → mesure la vélocité ; un flick met les aperçus en pause, un scroll lent les
              laisse lire (pause de l'élément <video>, jamais de son montage → lecture auto fiable). */}
          <div ref={gridScrollRef} onScroll={onGridScroll} style={{ contain: "layout paint" }} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pb-4 pt-1.5">
            {segments.length > 0 ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: cell ? `repeat(auto-fill, minmax(${Math.floor(cell)}px, 1fr))` : `repeat(${cols}, minmax(0, 1fr))` }}>
                {segments.map((s, i) => (
                  <SceneCard key={s.id} seg={s} index={i} clipPath={clip.path} clipName={clip.name} srcFrames={srcFrames} cols={actualCols} cellH={cellH}
                    active={active?.id === s.id} selected={sel.has(s.id)} play={gridPlay}
                    getProxy={(h, tok, prio) => getProxy(s, prio ?? "high", h, tok)} bustProxy={() => proxyCache.delete(s.id)} onPlay={() => playScene(s)}
                    onToggle={(mods) => toggleSel(s.id, mods)}
                    onAddToTimeline={showCardBtn ? () => runCardAction(s) : undefined}
                    addLabel={cardProfile.name}
                    pos={fmt(s.in)} dur={fmt(s.out - s.in)} />
                ))}
              </div>
            ) : detecting || cacheLoading ? (
              // Chargement du cache (réouverture d'un rush déjà découpé) OU détection en cours : on
              // montre un loader, JAMAIS l'invite « Détecter » — sinon ça clignote « non découpé »
              // pendant la remontée du cache alors que le rush l'est déjà.
              <Card className="mt-3 flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
                <Spinner className="size-6" /> {t("common:status.loading")}
              </Card>
            ) : (
              <Card className="mt-3 flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
                <Film className="h-8 w-8" />
                <span>{t("cutStudio.detectPrompt")}</span>
              </Card>
            )}
          </div>
        </CutContextMenu>

        {showPanel && (
        <div className={"flex min-h-0 bg-background " + (narrow ? "order-first w-full shrink-0 flex-col" : "h-full shrink-0")}>
        {/* poignée : glisser pour rétrécir/élargir le lecteur (gauche = +large, droite = +petit).
            Inutile en colonne (le lecteur y prend toute la largeur). */}
        {!narrow && (
        <div role="separator" aria-orientation="vertical" aria-label={t("shared.resize")}
          tabIndex={0}
          onPointerDown={startPanelDrag}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); setPanelW((w) => Math.min(560, w + 20)); }
            else if (e.key === "ArrowRight") { e.preventDefault(); setPanelW((w) => Math.max(260, w - 20)); }
          }}
          className="group relative mx-1 flex w-3 shrink-0 touch-none self-stretch cursor-col-resize items-center justify-center outline-none focus-visible:bg-primary/10">
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
          <GripVertical className="relative h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        )}

        {/* droite : lecteur + actions — FIXE, ne défile pas avec la grille, largeur réglable */}
        {/* overflow-x-hidden explicite : `overflow-y-auto` seul fait calculer l'axe X à `auto` (spec
            CSS), donc le moindre enfant trop large sortait une scrollbar horizontale en bas. */}
        <aside ref={panelRef} style={narrow ? undefined : { width: asideW }}
          className={"flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden py-3 "
            + (narrow ? "max-h-[55%] w-full pl-0" : "h-full shrink-0 pl-1")}>
          <Card className="shrink-0 overflow-hidden p-0">
            <div className="relative aspect-video">
              {/* shortcuts={false} : NetsuCut pilote le clavier (←/→ = plan préc/suiv, M = fusionner)
                  et commande la lecture via apiRef. Sans ça, le lecteur volerait les flèches. */}
              <ScenePlayer src={activeUrl} loop apiRef={playerApi} shortcuts={false} defaultVolume={0.2} />
              {active && <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">{segments.findIndex((s) => s.id === active.id) + 1}/{segments.length}</div>}
            </div>
          </Card>

          {segments.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-0.5 pt-1 text-[11px] font-semibold text-muted-foreground">
                {t("cutStudio.export")}
              </div>
              {/* Fusionner vit désormais dans la barre du haut (icône) — plus dans le panneau lecteur. */}
              {/* Sélecteur de piste audio (sous le lecteur) — visible seulement si la source a plusieurs pistes. */}
              <ExportAudioSelect profile={activeProfile} sourcePath={clip.path} size="sm" />
              <div className="timeline-insertion-container min-w-0">
                <div className="timeline-insertion-row grid min-w-0 items-center gap-2">
                  <ExportTimelineTarget profile={activeProfile} className="timeline-insertion-target w-full max-w-none min-w-0" />
                  <TimelineInsertionSelect className="timeline-insertion-select w-full min-w-0" />
                </div>
              </div>
              <ExportButton
                clips={exportInputs}
                baseName={exportBaseName}
                onTimelineImport={appendSelection}
                verb={verb}
                disabled={selCount === 0 || !!busy}
                className="w-full"
              />
              {dlBusy && <Progress value={exportProgress} />}
              {isLocal && (
                <p className="text-[11px] text-muted-foreground">{t("cutStudio.addToPoolHint")}</p>
              )}
              {connected && exported.length > 0 && <Button className="w-full" variant="ghost" onClick={importBack} disabled={!!busy}><FolderInput className="h-4 w-4" /> {t("cutStudio.importExtracts")}</Button>}
            </div>
          )}

          {/* break-words : un chemin de fichier long dans une erreur pousserait la largeur du panneau. */}
          {busy && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner /> {busy}</p>}
          {msg && <p className="break-words text-xs text-[var(--color-ok)]">{msg}</p>}
          {err && <p className="break-words text-xs text-destructive">{err}</p>}
        </aside>
        </div>)}
      </div>
      {/* messages d'état repris hors panneau quand le lecteur est masqué (sinon plus de retour visuel) */}
      {!showPanel && (busy || msg || err) && (
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs">
          {busy && <span className="flex items-center gap-1.5 text-muted-foreground"><Spinner /> {busy}</span>}
          {!busy && msg && <span className="text-[var(--color-ok)]">{msg}</span>}
          {!busy && err && <span className="text-destructive">{err}</span>}
        </div>
      )}
    </div>
  );
}
