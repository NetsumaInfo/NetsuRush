import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Play, Group, Copy, Images, ScanFace, CheckSquare, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { type SearchHit } from "@/lib/bridge";
import { useApp } from "@/store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NumberSlider } from "@/components/ui/number-slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ResultCard } from "@/components/search/ResultCard";
import { hitKey, grid } from "@/components/search/searchHelpers";
import { sendPathToBoard } from "@/components/reference/boardActions";
import { ExportButton } from "@/components/export/ExportButton";
import { usePreviewCache } from "@/components/rushes/previewCache";
import { warmResolveThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";

function fileName(p: string): string {
  return p.replace(/^.*[\\/]/, "");
}

// Plage d'aperçu d'un résultat : le plan, borné à 10 s. Cette borne fait partie de l'identité du
// proxy (elle entre dans la clé du cache partagé) → calculée ICI et nulle part ailleurs.
function previewRange(h: SearchHit): { path: string; in: number; out: number } {
  return { path: h.file_path, in: h.start_sec, out: Math.min(h.end_sec, h.start_sec + 10) };
}

const VIEWS = [
  { id: "flat", icon: Search, labelKey: "searchResults.tabFlat" },
  { id: "dedup", icon: Copy, labelKey: "searchResults.tabDedupTooltip" },
  { id: "clusters", icon: Group, labelKey: "searchResults.tabClustersTooltip" },
] as const;

// Fenêtre d'affichage de la vue plate : le backend renvoie un grand top-k (SEARCH_TOP_K),
// la grille n'en monte que `PAGE` à la fois (« Afficher plus ») — le DOM reste léger.
const PAGE = 60;

// Affichage des résultats : en-tête (seuil/tri/vue), actions de sélection (vue
// plate) et corps selon la vue (plate / doublons / groupes). Possède la sélection locale et la
// lecture « tout lire » (remises à zéro à chaque recherche) ; les aperçus viennent du cache partagé.
export function SearchResults() {
  const { t } = useTranslation("search");
  const {
    searchHits, scoreThreshold, setScoreThreshold, sortMode, setSortMode,
    resultView, setResultView, runDedup, runCluster, clusters, dedupGroups, analyzing,
    refs, findSimilar, addRef, sendHitsToTimeline, faceMode, faceChar, confirmHitAsCharacter,
  } = useApp(useShallow((s) => ({
    searchHits: s.searchHits, scoreThreshold: s.scoreThreshold,
    setScoreThreshold: s.setScoreThreshold, sortMode: s.sortMode, setSortMode: s.setSortMode,
    resultView: s.resultView, setResultView: s.setResultView, runDedup: s.runDedup, runCluster: s.runCluster,
    clusters: s.clusters, dedupGroups: s.dedupGroups, analyzing: s.analyzing,
    refs: s.refs, findSimilar: s.findSimilar, addRef: s.addRef,
    sendHitsToTimeline: s.sendHitsToTimeline, faceMode: s.faceMode,
    faceChar: s.faceChar, confirmHitAsCharacter: s.confirmHitAsCharacter,
  })));

  const [playAll, setPlayAll] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());      // sélection des résultats
  const [visible, setVisible] = useState(PAGE);                // nb de cartes montées (vue plate)
  // Cache d'aperçus PARTAGÉ avec le Découpage, Timeline Live et Collections (cf. previewCache) : il
  // est indexé par (fichier, plage), donc un résultat qui tombe sur un plan déjà lu ailleurs trouve
  // son proxy sans un seul ffmpeg de plus.
  const preview = usePreviewCache();

  // The proxy cache survives result changes; each card owns its playback cleanup.
  useEffect(() => { setSel(new Set()); setPlayAll(false); setVisible(PAGE); }, [searchHits]);

  // Amorçage des vignettes DÉJÀ générées en UN appel (rien n'est encodé ici) : les résultats
  // portent souvent des rushs déjà découpés, dont les vignettes sont sur le disque. Sans ce
  // pré-passage chaque carte émettrait sa propre requête et saturerait les sockets du core.
  useEffect(() => {
    if (!searchHits.length) return;
    void warmResolveThumbs(searchHits.map((h) => ({ path: h.file_path, time: thumbTime(h.start_sec, h.end_sec) })));
  }, [searchHits]);

  // Même chose pour les PROXIES : résolus en UN appel, sans rien encoder. Sans ce pré-passage, chaque
  // carte qui entre dans la bande réclame le sien au core (file d'encodage, sidecar réécrit) puis se
  // fait annuler en ressortant — des centaines d'allers-retours pour des fichiers déjà sur le disque,
  // pendant lesquels la grille reste sur ses vignettes. Aucune hauteur n'est passée : cette grille est
  // en colonnes CSS (pas de cellule mesurée), et le core essaie le palier par défaut puis ses voisins
  // (cf. proxyResolve) — un aperçu au palier d'à côté vaut mieux qu'une vignette figée.
  useEffect(() => {
    if (!searchHits.length) return;
    preview.warmProxies(searchHits.map(previewRange));
    // `preview` est stable pour la vue ; le lister relancerait la résolution à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchHits]);

  const getProxy = (h: SearchHit, height?: number, token?: number, priority: "high" | "low" = "high") => {
    const r = previewRange(h);
    return preview.getProxy(r.path, r.in, r.out, priority, height, token);
  };
  function toggleSel(k: string) {
    setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  // Vue plate : filtre d'affichage par seuil calibré (slider, instantané) + tri pertinence/qualité.
  // Mémoïsé : le drag du slider de seuil déclenche un render à chaque pixel — sans useMemo on
  // refiltre/retrie 60 hits + reconstruit le Set à 60 fps → saccade. Recalculé seulement quand
  // les entrées changent vraiment.
  const shown = useMemo(
    () => searchHits
      .filter((h) => h.score >= scoreThreshold)
      .slice()
      .sort((a, b) => (sortMode === "quality" ? (b.aesthetic ?? -9) - (a.aesthetic ?? -9) : 0)),
    [searchHits, scoreThreshold, sortMode],
  );
  const visibleHits = useMemo(() => shown.slice(0, visible), [shown, visible]);
  const selectedHits = useMemo(() => shown.filter((h) => sel.has(hitKey(h))), [shown, sel]);   // ne télécharge que ce qui est visible (seuil)
  const picked = selectedHits.length;
  const allPicked = picked > 0 && picked === visibleHits.length;
  const refKeys = useMemo(
    () => new Set(refs.filter((r) => r.file_path != null).map((r) => `${r.file_path}#${r.scene_index}`)),
    [refs],
  );

  function card(h: SearchHit, i: number) {
    const k = hitKey(h);
    const r = previewRange(h);
    return (
      <ResultCard
        key={k} hit={h} index={i} selected={sel.has(k)} play={playAll}
        onToggle={() => toggleSel(k)} onDownload={() => sendHitsToTimeline([h])}
        getProxy={(ph, tok, prio) => getProxy(h, ph, tok, prio)} bustProxy={() => preview.bustProxy(r.path, r.in, r.out)}
        peekProxy={() => preview.peekProxy(r.path, r.in, r.out)}
        onFindSimilar={(thumb) => findSimilar(h, thumb)}
        onAddRef={(thumb) => addRef({ file_path: h.file_path, scene_index: h.scene_index, thumb })}
        refActive={refKeys.has(`${h.file_path}#${h.scene_index}`)}
        confirmChar={faceChar?.name}
        onConfirmChar={faceChar ? () => confirmHitAsCharacter(h) : undefined}
        onSendBoard={() => void sendPathToBoard(h.file_path, fileName(h.file_path))}
      />
    );
  }

  return (
    <>
      {/* Barre d'outils COLLANTE, accrochee sous la barre de requete (hauteur fixe h-14). Meme
          grammaire que NetsuCut : un bouton-compteur qui selectionne tout, « Deselectionner » quand
          il y a une selection, puis les actions — TOUJOURS visibles, eteintes tant que rien n'est
          coche (une barre qui apparait/disparait faisait sauter la grille). */}
      <div className="sticky top-14 z-20 -mx-6 flex flex-wrap items-center gap-1.5 border-b border-border/70 bg-background px-6 py-1.5 text-xs text-muted-foreground">
        {faceMode && (
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-primary">
            <ScanFace className="size-3.5" /> {t("searchResults.faceMode")}
          </span>
        )}

        {resultView === "flat" && (
          <Tooltip>
            <TooltipTrigger render={<button
              type="button"
              onClick={() => setSel(allPicked ? new Set() : new Set(visibleHits.map(hitKey)))}
              disabled={visibleHits.length === 0}
              className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            />}>
              {allPicked ? <CheckSquare className="size-4 text-primary" /> : <Square className="size-4" />}
              <span className="tabular-nums">
                {t("searchResults.shotCount", { count: shown.length })}
                {picked > 0 && t("searchResults.selSuffix", { count: picked })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{allPicked ? t("searchResults.deselectAllTooltip") : t("searchResults.selectAllTooltip")}</TooltipContent>
          </Tooltip>
        )}
        {picked > 0 && (
          <button type="button" onClick={() => setSel(new Set())}
            className="flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {t("searchResults.deselect")}
          </button>
        )}

        {resultView === "flat" && (
          <>
            <Tooltip>
              <TooltipTrigger render={<Button size="sm" variant="outline" disabled={picked === 0}
                className="h-8 gap-1 px-2 text-xs text-muted-foreground"
                aria-label={t("searchResults.sendToBoardAria")}
                onClick={() => selectedHits.forEach((h) => void sendPathToBoard(h.file_path, fileName(h.file_path)))} />}>
                <Images className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("searchResults.sendToBoardTooltip")}</TooltipContent>
            </Tooltip>
            {/* Même duo d'export que le Découpage : icône du profil + mode d'insertion + réglages.
                Le bouton large « nom du profil » est réservé aux panneaux latéraux. */}
            <ExportButton
              clips={() => selectedHits.map((h) => ({ input: h.file_path, start: h.start_sec, end: h.end_sec }))}
              baseName="recherche"
              onTimelineImport={() => sendHitsToTimeline(selectedHits)}
              disabled={picked === 0}
              compact
            />
          </>
        )}

        <div className="flex-1" />

        {resultView === "flat" && (
          <Tooltip>
            <TooltipTrigger render={<Toggle
              size="sm"
              variant="outline"
              pressed={playAll}
              disabled={shown.length === 0}
              onPressedChange={(p) => setPlayAll(p)}
              aria-label={t("searchResults.playAllAria")}
              className="size-8 p-0 text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15"
            />}>
              <Play className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{playAll ? t("searchResults.stopPlayTooltip") : t("searchResults.playAllTooltip")}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<div className="flex items-center gap-2" />}>
            <NumberSlider min={0} max={100} suffix="%" value={[Math.round(scoreThreshold * 100)]}
              onValueChange={(v) => setScoreThreshold((Array.isArray(v) ? v[0] : v) / 100)} className="w-24" />
          </TooltipTrigger>
          <TooltipContent>{t("searchResults.relevanceThresholdTooltip")}</TooltipContent>
        </Tooltip>
        {/* Mode visage : tri Qualite (score esthetique absent des hits visage) et vues
            Doublons/Groupes (embeddings SigLIP, pas d'identite) sans objet -> masques. */}
        {!faceMode && (
          <ToggleGroup value={[sortMode]} spacing={0} variant="outline" size="sm"
            onValueChange={(v) => { const m = v[0] as "relevance" | "quality" | undefined; if (m) setSortMode(m); }}>
            {(["relevance", "quality"] as const).map((m) => (
              <ToggleGroupItem key={m} value={m}
                className="h-8 px-2.5 text-xs text-muted-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15">
                {m === "relevance" ? t("searchResults.relevance") : t("searchResults.quality")}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {/* Vues : icones seules + infobulles — trois libelles cote a cote pesaient plus que le
            reglage qu'ils portent. */}
        {!faceMode && (
          <Tabs
            value={resultView}
            onValueChange={(v) => {
              if (v === "flat") setResultView("flat");
              else if (v === "dedup") runDedup();
              else if (v === "clusters") runCluster();
            }}
          >
            <TabsList className="h-8">
              {VIEWS.map((v) => (
                <Tooltip key={v.id}>
                  <TooltipTrigger render={<TabsTrigger value={v.id} aria-label={t(v.labelKey)} className="px-2" />}>
                    <v.icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>{t(v.labelKey)}</TooltipContent>
                </Tooltip>
              ))}
            </TabsList>
          </Tabs>
        )}
      </div>

      {analyzing ? (
        // Même attente que partout ailleurs (recherche, Timeline Live, Découpage) : une grille de
        // vignettes fantômes à la place des cartes à venir. Un loader décoratif propre à cette vue
        // faisait croire à un autre type de travail.
        <div className="space-y-2">
          <div className="px-1 text-xs text-muted-foreground">{t("searchResults.analyzing")}</div>
          <div className={grid}>
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-video w-full rounded-xl" />
            ))}
          </div>
        </div>
      ) : resultView === "dedup" ? (
        dedupGroups.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">{t("searchResults.noDuplicates")}</Card>
        ) : (
          <div className="space-y-4">
            {dedupGroups.map((g, gi) => (
              <Card key={gi} className="block p-3">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Copy className="h-3.5 w-3.5" /> {t("searchResults.duplicatesCount", { count: g.size })}
                  <span className="text-primary">· {t("searchResults.mostRepresentative")}</span>
                </div>
                <div className={grid}>{g.members.map((h, i) => card(h, i))}</div>
              </Card>
            ))}
          </div>
        )
      ) : resultView === "clusters" ? (
        clusters.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">{t("searchResults.notEnoughShots")}</Card>
        ) : (
          <div className="space-y-4">
            {clusters.map((cl, ci) => (
              <Card key={ci} className="block p-3">
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <Group className="h-3.5 w-3.5 text-primary" />
                  <span className="font-medium">{cl.label}</span>
                  <span className="text-muted-foreground">· {t("searchResults.shotsCount", { count: cl.size })}</span>
                </div>
                <div className={grid}>{cl.members.map((h, i) => card(h, i))}</div>
              </Card>
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">{t("searchResults.noneAboveThreshold", { pct: Math.round(scoreThreshold * 100) })}</Card>
      ) : (
        // Révélation en CSS pur (tw-animate-css, one-shot) : pas de boucle rAF (ni GSAP ni
        // framer layout, tous deux saturaient le thread/le GPU sur cette grille). Seules les
        // nouvelles cartes (clé inédite) rejouent l'anim au montage — pas de re-flash au filtrage.
        <>
          <div className={grid}>
            {visibleHits.map((h, i) => (
              <div key={hitKey(h)} className="animate-in fade-in-0 duration-200">
                {card(h, i)}
              </div>
            ))}
          </div>
          {shown.length > visible && (
            <div className="flex items-center justify-center gap-2 pb-2">
              <Button variant="outline" size="sm" onClick={() => setVisible((v) => v + PAGE)}>
                {t("searchResults.showMore", { count: shown.length - visible })}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setVisible(shown.length)}>
                {t("searchResults.showAll")}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
