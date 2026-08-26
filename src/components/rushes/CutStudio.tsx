import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, Scissors, FolderInput, CheckSquare, Square,
  Combine, Film, Play, Minus, Plus, LayoutGrid, GripVertical, Image as ImageIcon, Zap,
  PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { basename } from "@/store/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { ScenePlayer, type ScenePlayerApi } from "@/components/player/ScenePlayer";
import { autoplayCeiling, canFewerCols, canMoreCols, fmt, gridContainerStyle, gridMetrics, setMaxPlaying, stepCols, type Segment } from "./cutStudioShared";
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
import { flowOffsets } from "./cutFlow";
import { CutFlowNav } from "./CutFlowNav";

// Seuils de mise en page (px) : sous NARROW_W la vue passe en colonne, et la grille garde toujours
// au moins MIN_GRID_W — sinon la barre d'outils n'a plus de place et ses boutons s'empilent.
const NARROW_W = 640;
const MIN_GRID_W = 260;

// Séparateur d'identité du flux : un chemin ne peut pas contenir de saut de ligne, donc joindre
// les chemins avec lui rend une clé stable et sans collision.
const SEP = "\n";

export function CutStudio() {
  const { t } = useTranslation(["derush", "common"]);
  const { selected, storeFlow, close, connected, pinned } = useApp(
    useShallow((s) => ({ selected: s.selected, storeFlow: s.flow, close: s.close, connected: s.connected, pinned: s.pinned })),
  );
  const clip = selected!;
  // Le FLUX est la vue générale : un rush ouvert seul en est un d'un seul élément. Toute la suite
  // (détection, aperçus, sélection, export) travaille dessus sans jamais distinguer les deux cas —
  // c'est ce qui garantit qu'une grille de quatre rushs se comporte comme une grille d'un.
  const flow = storeFlow.length ? storeFlow : [clip];
  const flowKey = flow.map((c) => c.path).join(SEP);
  const paths = useMemo(() => flowKey.split(SEP), [flowKey]);
  const clipOf = useMemo(() => new Map(flow.map((c) => [c.path, c])), [flowKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Repli sur le nom de fichier, jamais sur le chemin entier : ce nom sert aussi à baptiser les
  // extraits, et un chemin complet y produirait un nom de fichier inutilisable.
  const nameOf = (path: string) => clipOf.get(path)?.name ?? basename(path);
  const isLocalPath = (path: string) => clipOf.get(path)?.source === "local";
  const isLocal = flow.every((c) => c.source === "local");
  // Fenêtre épinglée → mode compact : entête de détection et lecteur masqués pour tenir dans un coin
  // de l'écran. La barre d'outils reste ENTIÈRE (sélection, aperçus, lecture, export) : c'est la
  // seule surface cliquable qui reste, la reléguer au clic droit rendait l'épinglé inutilisable.
  const compact = pinned;

  const det = useShotDetection(paths);
  const {
    info, duration, segments, detecting, cacheLoading, progress,
    active, activeUrl, sourceOf, pathOf,
    err, setErr, preset, setPreset, model, setModel,
    getProxy, peekProxy, bustProxy, warmProxies, playScene, detect,
    generateProxies: genProxies, generateThumbs: genThumbs, proxyGen, thumbsGen,
    hasEdits, clearEdits, undoEdit, redoEdit,
  } = det;
  const srcFramesOf = (path: string) => sourceOf(path).srcFrames;

  const { cols, setCols, panelW, panelRef, resizingRef, startPanelDrag, handleRef, edgeRef, startEdgeDrag, onHandleKeyDown, playerOpen, setPlayerOpen } = usePanelLayout();
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

  const { sel, setSel, toggleSel, selectAll, deselect, mergeSelected, removeSelected } = useCutActions(det, flowKey);
  const [gridPlay, setGridPlay] = useState(() => useApp.getState().cutGridPlay);
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
  // Grille à COLONNES TENUES (cf. gridMetrics) : rétrécir la zone rétrécit les vignettes, le nombre
  // de colonnes ne bouge pas. Le +/- règle ce nombre.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  // La zone défilante est AUSSI tenue en état : le repérage dans le flux s'abonne à son scroll, et
  // un abonnement a besoin de l'élément au moment du montage, pas d'une ref lue trop tôt.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const attachGrid = (el: HTMLDivElement | null) => { gridScrollRef.current = el; setGridEl(el); };
  const [gridW, setGridW] = useState(0);
  const { actualCols, cell, maxCols } = gridMetrics(gridW, cols, narrow);
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

  // Résout d'un coup les proxies DÉJÀ encodés de tous les plans → chaque carte connaît l'URL de son
  // aperçu avant même d'entrer à l'écran, donc le défilement ne déclenche plus un RPC par carte.
  // Relancé sur un changement de densité : le palier de hauteur entre dans la clé de cache, une
  // cellule plus grande vise donc d'autres fichiers.
  useEffect(() => {
    if (!segments.length || !cell) return;
    warmProxies(segments, Math.round(((cell * 9) / 16) * (window.devicePixelRatio || 1)));
  }, [segments, cell, warmProxies]);

  // Repérage dans le flux. Le studio calcule les PALIERS (où commence chaque rush) et les rushs pas
  // encore découpés — deux dérivés des plans, donc stables entre deux défilements. Le rush COURANT,
  // lui, appartient à `CutFlowNav` : c'est la seule chose qui suit le scroll, et la garder ici
  // re-rendait les centaines de vignettes de la grille à chaque frontière franchie.
  //
  // Les deux dérivés se calculent EN UN SEUL passage : sur un flux, `segments` compte des milliers
  // d'entrées et deux balayages séparés valaient un balayage de trop.
  const isFlow = flow.length > 1;
  const { offsets, uncut } = useMemo(() => {
    const seen = new Set<string>();
    for (const s of segments) seen.add(s.path ?? paths[0]);
    return { offsets: flowOffsets(segments, paths), uncut: paths.filter((p) => !seen.has(p)) };
  }, [segments, paths]);

  const selectedList = () => segments.filter((s) => sel.has(s.id));
  // Les aperçus peuvent cibler tout le rush, mais les actions d'export exigent une sélection.
  const targetList = () => {
    const list = selectedList();
    return list.length ? list : segments;
  };

  // Vide la sélection (héritée des plans précédents) avant de relancer la détection.
  function runDetect() { setSel(new Set()); detect(); }

  // Un flux dont un rush n'est pas encore découpé se contenterait sinon de ne pas le montrer : on
  // défilerait sans jamais l'atteindre, et rien ne dirait pourquoi. Les découper ne retouche pas les
  // autres (cf. detect(only)).
  function detectUncut() { setSel(new Set()); void detect(uncut); }

  const exp = useCutExport({
    pathOf,
    srcFramesOf,
    nameOf,
    baseName: clip.name,
    targetList,
    hasSelection: () => selectedList().length > 0,
    setErr,
  });
  const { busy, exported, createTimeline, appendSelection, addToTimeline, importBack } = exp;
  const { download, busy: dlBusy } = useExport();
  const exportProfiles = useApp((s) => s.exportProfiles);
  const cardActionProfileId = useApp((s) => s.cardActionProfileId);
  const activeExportProfileId = useApp((s) => s.activeExportProfileId);
  const exportBaseName = clip.name.replace(/\.[^.]+$/, "");
  // Le choix de piste audio vit dans le profil actif (résolu côté core par resolveClipAudio) — pas
  // d'état local qui divergerait de ce que montrent les Réglages d'export.
  const activeProfile = getActiveExportProfile(exportProfiles, activeExportProfileId);
  const exportInputs = () => selectedList().map((s) => ({ input: pathOf(s), start: s.in, end: s.out }));

  // Petit bouton de chaque vignette : applique le profil configuré (import timeline OU fichier).
  const cardProfile = getActiveExportProfile(exportProfiles, cardActionProfileId);
  const cardIsTimeline = isTimelineImport(cardProfile.workflow);
  // Le bouton d'envoi timeline dépend du rush de LA CARTE : un flux peut mêler rushs du Media Pool
  // et rushs importés du disque, et seuls les premiers savent rejoindre une timeline de l'hôte.
  const showCardBtn = (s: Segment) => (cardIsTimeline ? connected && !isLocalPath(pathOf(s)) : true);
  const runCardAction = (s: Segment) =>
    cardIsTimeline
      ? addToTimeline(s)
      : download({ clips: [{ input: pathOf(s), start: s.in, end: s.out }], baseName: exportBaseName, profileId: cardActionProfileId });

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

  // Liste VIVANTE pour les pré-générations sans sélection : la ref est réécrite à chaque rendu, donc
  // un run suit les plans affichés (fusion, retrait, re-détection) au lieu de rester sur ceux du clic.
  // Une sélection reste gelée au clic — cf. TimelineLiveView.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const genSource = () => {
    const picked = selectedList();
    return picked.length ? picked : () => segmentsRef.current;
  };

  // Boutons « pré-générer » : pools bornés, arrêt par re-clic, comptes et bilan — implémentation
  // partagée avec Timeline Live et Collections (cf. previewCache). La hauteur passée est celle de la
  // cellule mesurée, donc le palier de cache est exactement celui que la lecture auto ira relire.
  function generateProxies() {
    const list = targetList();
    if (!list.length) return;
    setErr(null);
    const el = gridScrollRef.current;
    const height = el?.clientWidth
      ? Math.round(((gridMetrics(el.clientWidth, cols, narrow).cell * 9) / 16) * (window.devicePixelRatio || 1))
      : undefined;
    void genProxies(genSource(), height);
  }

  function generateThumbs() {
    const list = targetList();
    if (!list.length) return;
    setErr(null);
    void genThumbs(genSource());
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
            {/* Flux : le nom affiché est celui du rush qu'on a SOUS LES YEUX, et il change en défilant.
                L'entête garde exactement sa forme — seul son contenu suit le défilement, donc rien ne
                bouge dans la page pendant qu'on descend. */}
            {isFlow ? (
              <CutFlowNav flow={flow} offsets={offsets} cell={cell} cols={actualCols}
                scrollEl={gridEl} sourceOf={sourceOf} total={duration} />
            ) : (
              <>
                <div className="truncate text-[13px] font-medium leading-tight">{clip.name}</div>
                {info && <div className="text-[11px] leading-tight text-muted-foreground">{info.width}×{info.height} · {fmt(duration)}</div>}
              </>
            )}
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
          gridPlay={gridPlay} setGridPlay={setGridPlayback} cols={actualCols} maxCols={maxCols} setCols={setCols}
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
              {isFlow && uncut.length > 0 && (
                <Tooltip>
                  <TooltipTrigger render={
                    <Button size="sm" variant="outline" onClick={detectUncut} disabled={detecting}
                      className="h-8 gap-1 border-primary/40 px-2 text-xs text-primary hover:text-primary" />
                  }>
                    <Scissors className="size-3.5" /> {t("cutStudio.flowUncut", { count: uncut.length })}
                  </TooltipTrigger>
                  <TooltipContent>{t("cutStudio.flowUncutTip")}</TooltipContent>
                </Tooltip>
              )}
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
              {/* Le ressort sépare ce qui FABRIQUE la grille (à gauche : sélection, fusion, découpe,
                  vignettes, aperçus, lecture) de ce qui la CADRE ou la SORT — même partage qu'en
                  Timeline Live, où ces trois boutons ont toujours été du côté gauche. */}
              <div className="flex-1" />
              <Tooltip>
                <TooltipTrigger render={<div className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-card px-1 text-xs" />}>
                  <LayoutGrid className="mr-0.5 h-3.5 w-3.5 text-muted-foreground" />
                   <button type="button" aria-label={t("common:action.decrease")} onClick={() => setCols(stepCols(actualCols, -1, maxCols))} disabled={!canFewerCols(actualCols)} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Minus className="h-3.5 w-3.5" /></button>
                  <span className="w-4 text-center tabular-nums">{actualCols}</span>
                   <button type="button" aria-label={t("common:action.increase")} onClick={() => setCols(stepCols(actualCols, 1, maxCols))} disabled={!canMoreCols(actualCols, maxCols)} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
                </TooltipTrigger>
                <TooltipContent>{t("shared.thumbSize")}</TooltipContent>
              </Tooltip>
              {/* Trio d'export compact (profil + insertion + réglages) : le panneau de droite est
                  refermable et absent en épinglé, l'export ne doit pas disparaître avec lui. Même
                  contrôle que Collections et Timeline Live. */}
              <ExportButton
                clips={exportInputs}
                baseName={exportBaseName}
                onTimelineImport={appendSelection}
                disabled={selCount === 0 || !!busy}
                compact
              />
              {!compact && (
                <Tooltip>
                  <TooltipTrigger render={<Button size="sm" variant="outline" onClick={() => setPlayerOpen((v) => !v)} className="h-8 text-xs text-muted-foreground" />}>
                    {playerOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
                  </TooltipTrigger>
                  <TooltipContent>{playerOpen ? t("cutStudio.hidePlayer") : t("cutStudio.showPlayer")}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          {/* Zone défilante : seule la grille bouge. Retrait ASYMÉTRIQUE assumé — la gouttière gauche
              garde son écart d'origine (4 px), la droite est réduite au minimum pour que la dernière
              colonne vienne contre le lecteur : 2 px, la barre de défilement, le trait de poignée. */}
          {/* Pinned: no player, no resize edge — the grid owns the right edge, so it breaks out of
              the 20px gutter (px-4 + pr-1) and its scrollbar sits against the window like a real one. */}
          <div ref={attachGrid} style={{ contain: "layout paint" }} className={"min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-1 pr-2 pb-4 pt-1.5" + (compact ? " -mr-5" : "")}>
            {segments.length > 0 ? (
              <div className="grid gap-3" style={gridContainerStyle(actualCols, cell)}>
                {segments.map((s, i) => {
                  // Chaque carte porte SON rush : dans un flux, deux vignettes voisines peuvent venir
                  // de fichiers différents, et tout ce qui suit (vignette, proxy, collection, envoi
                  // timeline) doit viser le bon.
                  const path = pathOf(s);
                  return (
                    <SceneCard key={s.id} seg={s} index={i} clipPath={path} clipName={nameOf(path)} srcFrames={srcFramesOf(path)}
                      active={active?.id === s.id} selected={sel.has(s.id)} play={gridPlay}
                      getProxy={(h, tok, prio) => getProxy(s, prio ?? "high", h, tok)} bustProxy={() => bustProxy(s)} peekProxy={() => peekProxy(s)} onPlay={() => playScene(s)}
                      onToggle={(mods) => toggleSel(s.id, mods)}
                      onAddToTimeline={showCardBtn(s) ? () => runCardAction(s) : undefined}
                      addLabel={cardProfile.name}
                      alwaysChrome={compact}
                      pos={fmt(s.in)} dur={fmt(s.out - s.in)} />
                  );
                })}
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

        {/* Lecteur fermé : il reste son trait, qui reprend les mêmes gestes à l'envers — molette ou
            glissé vers la GAUCHE le rouvre. Sans lui, le geste qui ferme n'aurait pas de retour. */}
        {!showPanel && !narrow && !compact && (
          <div role="separator" aria-orientation="vertical" aria-label={t("cutStudio.showPlayer")}
            tabIndex={0}
            ref={edgeRef}
            onPointerDown={startEdgeDrag}
            onDoubleClick={() => setPlayerOpen(true)}
            onKeyDown={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); setPlayerOpen(true); } }}
            className="group relative w-px shrink-0 touch-none self-stretch cursor-col-resize bg-border/60 transition-colors hover:bg-primary outline-none focus-visible:bg-primary">
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        )}

        {showPanel && (
        <div className={"flex min-h-0 bg-background " + (narrow ? "order-first w-full shrink-0 flex-col" : "h-full shrink-0")}>
        {/* poignée : glisser pour rétrécir/élargir le lecteur (gauche = +large, droite = +petit).
            Inutile en colonne (le lecteur y prend toute la largeur). */}
        {!narrow && (
        <div role="separator" aria-orientation="vertical" aria-label={t("shared.resize")}
          tabIndex={0}
          ref={handleRef}
          onPointerDown={startPanelDrag}
          onKeyDown={onHandleKeyDown}
          className="group relative w-px shrink-0 touch-none self-stretch cursor-col-resize bg-border transition-colors hover:bg-primary outline-none focus-visible:bg-primary">
          {/* Zone de PRÉHENSION élargie mais SANS largeur de layout : la grille et le lecteur
              restent collés au trait, seul le curseur dispose de quelques pixels de chaque côté. */}
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
          <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        )}

        {/* droite : lecteur + actions — FIXE, ne défile pas avec la grille, largeur réglable */}
        {/* overflow-x-hidden explicite : `overflow-y-auto` seul fait calculer l'axe X à `auto` (spec
            CSS), donc le moindre enfant trop large sortait une scrollbar horizontale en bas. */}
        <aside ref={panelRef} style={narrow ? undefined : { width: asideW }}
          className={"flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden py-3 "
            + (narrow ? "max-h-[55%] w-full pl-0" : "h-full shrink-0 pl-5")}>
          <Card className="shrink-0 overflow-hidden p-0">
            <div className="relative aspect-video">
              {/* shortcuts={false} : NetsuCut pilote le clavier (←/→ = plan préc/suiv, M = fusionner)
                  et commande la lecture via apiRef. Sans ça, le lecteur volerait les flèches. */}
              <ScenePlayer src={activeUrl} apiRef={playerApi} shortcuts={false} defaultVolume={0.2} />
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
              {isLocal && (
                <p className="text-[11px] text-muted-foreground">{t("cutStudio.addToPoolHint")}</p>
              )}
              {connected && exported.length > 0 && <Button className="w-full" variant="ghost" onClick={importBack} disabled={!!busy}><FolderInput className="h-4 w-4" /> {t("cutStudio.importExtracts")}</Button>}
            </div>
          )}

          {/* « Ça exporte » vit dans la pastille (cf. ExportStatusToast), pas ici : le panneau peut
              être fermé, et le message de fin arrive de toute façon en pastille.
              break-words : un chemin de fichier long dans une erreur pousserait la largeur du panneau. */}
          {err && <p className="break-words text-xs text-destructive">{err}</p>}
        </aside>
        </div>)}
      </div>
      {/* Erreur reprise hors panneau quand le lecteur est masqué (sinon plus de retour visuel). Le
          voyant « ça exporte », lui, est passé en pastille — cf. ExportStatusToast. */}
      {!showPanel && err && (
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs">
          <span className="text-destructive">{err}</span>
        </div>
      )}
    </div>
  );
}
