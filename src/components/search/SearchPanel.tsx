import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Database, AlertTriangle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nr, type FaceStatus } from "@/lib/bridge";
import { useApp } from "@/store";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ReferencePicker } from "@/components/search/ReferencePicker";
import { FaceRefPicker } from "@/components/search/FaceRefPicker";
import { CharacterChips } from "@/components/search/CharacterChips";
import { FaceModelsBanner } from "@/components/search/FaceModelsBanner";
import { ProjectScopeSheet } from "@/components/search/ProjectScopeSheet";
import { FaceHubDialog } from "@/components/search/FaceHubDialog";
import { SearchBar } from "@/components/search/SearchBar";
import { RefTray } from "@/components/search/RefTray";
import { IndexStatusBar } from "@/components/search/IndexStatusBar";
import { ExcludeRow } from "@/components/search/ExcludeRow";
import { IndexPicker } from "@/components/search/IndexPicker";
import { FaceIndexPicker } from "@/components/search/FaceIndexPicker";
import { IndexProgress } from "@/components/search/IndexProgress";
import { SearchResults } from "@/components/search/SearchResults";
import { TimelineDrop } from "@/components/rushes/TimelineDrop";
import { ScrollTopButton } from "@/components/common/ScrollTopButton";
import { IMAGE_RE, ipcErr, grid } from "@/components/search/searchHelpers";

// Recherche de plans par langage naturel / image (SigLIP 2).
// L'index = 1 embedding par plan détecté (réutilise la détection NetsuRush), cache SQLite.
export function SearchPanel() {
  const { t } = useTranslation("search");
  const {
    searchHits, searching, searchError, searchNotice, searchQuery, searchStatusInfo, indexBusy, indexCancel, faceBusy, faceCancel,
    refreshSearchStatus, runSearch, indexClips, cancelIndexing, cancelFaceIndexing,
    posQuery, setPosQuery, negativeQuery, setNegativeQuery,
    refs, addImageRefs, removeRef, clearRefs, indexFaces, openFaceHub,
    characters,
    searchScope, loadClips, clipsLoading, clipsRevalidating, activeHost,
    scopePaths, selectedProjects, projectScope, projectScopeOpen, loadProjectScope, setProjectScopeOpen, clips,
  } = useApp(useShallow((s) => ({
    searchHits: s.searchHits, searching: s.searching, searchError: s.searchError, searchNotice: s.searchNotice, searchQuery: s.searchQuery,
    searchStatusInfo: s.searchStatusInfo, indexBusy: s.indexBusy, indexCancel: s.indexCancel, faceBusy: s.faceBusy, faceCancel: s.faceCancel,
    refreshSearchStatus: s.refreshSearchStatus, runSearch: s.runSearch, indexClips: s.indexClips, cancelIndexing: s.cancelIndexing, cancelFaceIndexing: s.cancelFaceIndexing,
    posQuery: s.posQuery, setPosQuery: s.setPosQuery, negativeQuery: s.negativeQuery, setNegativeQuery: s.setNegativeQuery,
    refs: s.refs, addImageRefs: s.addImageRefs, removeRef: s.removeRef, clearRefs: s.clearRefs,
    indexFaces: s.indexFaces, openFaceHub: s.openFaceHub,
    characters: s.characters,
    searchScope: s.searchScope, loadClips: s.loadClips,
    clipsLoading: s.clipsLoading, clipsRevalidating: s.clipsRevalidating, activeHost: s.activeHost,
    scopePaths: s.scopePaths, selectedProjects: s.selectedProjects, projectScope: s.projectScope,
    projectScopeOpen: s.projectScopeOpen, loadProjectScope: s.loadProjectScope,
    setProjectScopeOpen: s.setProjectScopeOpen, clips: s.clips,
  })));

  const [pickerOpen, setPickerOpen] = useState(false);   // sélecteur de rush à indexer ouvert
  const [faceIdxPicker, setFaceIdxPicker] = useState(false);   // sélecteur de rush pour l'indexation des visages
  const [dragOver, setDragOver] = useState(false);       // image externe en cours de drop
  const [refPicker, setRefPicker] = useState(false);     // picker de référence (médias / découpes)
  const [faceStat, setFaceStat] = useState<FaceStatus | null>(null);   // visages indexés (compteur)
  const [searchWarming, setSearchWarming] = useState(false);
  const [projectScopeReady, setProjectScopeReady] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);   // ligne d'exclusion dépliée à la demande
  const warmStarted = useRef(false);
  const dragDepth = useRef(0);
  const dragWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compteur de visages : même portée que le reste (sinon il annonçait les visages de TOUS les projets).
  // Clé STABLE de la portée : `scopePaths` est un tableau neuf à chaque rendu du store, le prendre
  // en dépendance relancerait la lecture en boucle.
  const faceScopeKey = searchScope === "all" ? "" : scopePaths.join("|");
  const refreshFaceStatus = useCallback(() => {
    const filePaths = faceScopeKey ? faceScopeKey.split("|") : undefined;
    nr.faceStatus({ filePaths }).then(setFaceStat).catch(() => {});
  }, [faceScopeKey]);
  // Une exclusion déjà saisie (recherche rejouée, retour sur l'onglet) doit rester visible.
  useEffect(() => { if (negativeQuery) setExcludeOpen(true); }, [negativeQuery]);

  const refreshCharacters = useApp((s) => s.refreshCharacters);
  useEffect(() => { refreshSearchStatus(); refreshCharacters(); }, [refreshSearchStatus, refreshCharacters]);
  useEffect(() => { refreshFaceStatus(); }, [refreshFaceStatus]);
  // Le registre projet → rushs se lit au montage : la portée par défaut (projet actuel) doit être
  // résolue AVANT la première recherche, même si l'utilisateur n'ouvre jamais le panneau.
  // Relu APRÈS le Media Pool : c'est cette lecture qui enregistre le projet courant côté core, donc
  // au tout premier lancement le registre est encore vide au montage.
  useEffect(() => { void loadProjectScope(); }, [loadProjectScope, activeHost, clips.length, projectScopeReady]);
  useEffect(() => {
    let live = true;
    setProjectScopeReady(false);
    void loadClips().finally(() => { if (live) setProjectScopeReady(true); });
    return () => { live = false; };
  }, [loadClips, activeHost]);

  const indexed = searchStatusInfo?.clips ?? 0;
  const frames = searchStatusInfo?.frames ?? 0;
  const indexing = !!indexBusy;        // indexation des plans en cours
  const facing = !!faceBusy;           // indexation des visages en cours (indépendante)

  // Après le rendu rapide des compteurs SQLite, prépare en arrière-plan le modèle et l'index RAM.
  // L'utilisateur peut lire/saisir pendant ce temps ; sa première requête n'hérite plus du cold-start.
  useEffect(() => {
    if (warmStarted.current || frames <= 0 || indexBusy) return;
    warmStarted.current = true;
    setSearchWarming(true);
    void nr.warmSearchIndex().catch(() => {}).finally(() => setSearchWarming(false));
  }, [frames, indexBusy]);

  async function onImage() {
    try {
      const files = await nr.chooseImages();
      if (files && files.length) { addImageRefs(files.filter((p) => IMAGE_RE.test(p))); await runSearch(); }
    } catch (e) { ipcErr(e); }
  }

  async function onIndexFacesSelection(paths: string[], force: boolean) {
    try {
      if (paths.length) await indexFaces(paths, force);
      refreshFaceStatus();
    } catch (e) { ipcErr(e); }
  }

  const clearFileDrag = useCallback(() => {
    dragDepth.current = 0;
    if (dragWatchdog.current) clearTimeout(dragWatchdog.current);
    dragWatchdog.current = null;
    setDragOver(false);
  }, []);

  const keepFileDragAlive = useCallback(() => {
    if (dragWatchdog.current) clearTimeout(dragWatchdog.current);
    // WebView2 peut perdre dragleave/drop quand le curseur sort de la fenêtre ou que le drag OS
    // est annulé. Tant qu'un vrai drag survole la vue, dragover réarme continuellement ce garde-fou.
    dragWatchdog.current = setTimeout(clearFileDrag, 600);
  }, [clearFileDrag]);

  useEffect(() => {
    const reset = () => clearFileDrag();
    const resetWhenHidden = () => { if (document.visibilityState !== "visible") reset(); };
    window.addEventListener("dragend", reset, true);
    window.addEventListener("drop", reset, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", resetWhenHidden);
    return () => {
      window.removeEventListener("dragend", reset, true);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", resetWhenHidden);
      dragDepth.current = 0;
      if (dragWatchdog.current) clearTimeout(dragWatchdog.current);
      dragWatchdog.current = null;
    };
  }, [clearFileDrag]);

  // Vrai seulement pour des fichiers OS : ignore texte, liens et payloads internes NetsuRush.
  function isFileDrag(dataTransfer: DataTransfer | null) {
    if (!dataTransfer || !Array.from(dataTransfer.types || []).includes("Files")) return false;
    const items = Array.from(dataTransfer.items || []);
    const files = items.filter((item) => item.kind === "file");
    return files.length === 0 || files.some((item) => !item.type || item.type.startsWith("image/"));
  }

  function onDrop(e: React.DragEvent) {
    const files = Array.from(e.dataTransfer?.files || []);
    const valid = isFileDrag(e.dataTransfer) && files.length > 0;
    clearFileDrag();
    if (!valid) return;
    e.preventDefault();
    // Les File sont lus MAINTENANT (dataTransfer est vidé à la fin de l'événement) ; leur chemin
    // disque se résout côté host — Chromium ne l'expose pas.
    void nr.pathsForFiles(files).then((all) => {
      const paths = all.filter((p) => p && IMAGE_RE.test(p));
      if (paths.length) { addImageRefs(paths); runSearch(); }
    });
  }

  const canSearch = !!posQuery.trim() || refs.length > 0;
  const projectScopeLoading = searchScope === "project"
    && (!projectScopeReady || clipsLoading || clipsRevalidating);
  // Libellé du bouton de portée : « Tous les rush », le nom du projet unique, ou « N projets ».
  const scopeNames = selectedProjects.length ? selectedProjects : (projectScope?.current ? [projectScope.current] : []);
  const scopeLabel = searchScope === "all" ? t("searchBar.scopeAll")
    : scopeNames.length === 1 ? scopeNames[0]
      : scopeNames.length ? t("projectScope.countBadge", { count: scopeNames.length })
        : t("projectScope.open");

  // Roster proposé par le sélecteur @ : personnages avec au moins un échantillon (les autres ont
  // un pool vide → mention inutile). id/nom/couleur/avatar suffisent au menu de mention.
  const roster = characters
    .filter((c) => c.total > 0)
    .map((c) => ({ id: c.id, name: c.name, color: c.color || undefined, avatar: c.avatar }));

  return (
    <div
      className="relative space-y-3 px-6 pb-6"
      onDragEnter={(e) => {
        if (!isFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current += 1;
        keepFileDragAlive();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        keepFileDragAlive();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => {
        if (dragDepth.current > 0) dragDepth.current -= 1;
        if (dragDepth.current === 0) clearFileDrag();
        else keepFileDragAlive();
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-bg/70 backdrop-blur-sm animate-in fade-in-0 duration-150">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-primary/60 bg-card/80 px-10 py-8 shadow-xl ring-1 ring-primary/20 animate-in zoom-in-98 duration-150">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary">
              <ImagePlus className="h-7 w-7" />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium text-foreground">{t("searchPanel.dropImage")}</div>
              <div className="text-xs text-muted-foreground">{t("searchPanel.dropImageHint")}</div>
            </div>
          </div>
        </div>
      )}

      {/* Barre COLLANTE : hauteur FIXE (h-14) → la barre d'outils des résultats peut s'y accrocher
          en `top-14`, sans mesure ni recalage. Fond opaque, un simple filet en bas. */}
      <div className="sticky top-0 z-30 -mx-6 border-b border-border/70 bg-background px-6">
        <SearchBar
          posQuery={posQuery} setPosQuery={setPosQuery}
          searching={searching} canSearch={canSearch && !projectScopeLoading}
          onSearch={() => runSearch()} onImage={onImage}
          onRefPicker={() => setRefPicker(true)} onFace={() => openFaceHub("gallery")}
          onCharacters={() => openFaceHub("roster")}
          roster={roster}
          negativeOpen={excludeOpen} onToggleNegative={() => setExcludeOpen((v) => !v)}
          scope={searchScope} scopeLabel={scopeLabel} scopeLoading={projectScopeLoading}
          scopeOpen={projectScopeOpen} onOpenScope={() => setProjectScopeOpen(!projectScopeOpen)}
        />
      </div>

      {excludeOpen && (
        <ExcludeRow
          value={negativeQuery} setValue={setNegativeQuery}
          onSubmit={() => runSearch()} onClose={() => setExcludeOpen(false)}
        />
      )}

      <CharacterChips />

      <RefTray
        refs={refs} searching={searching}
        onSearch={() => runSearch()}
        removeRef={removeRef} clearRefs={clearRefs}
      />

      <IndexStatusBar
        loading={searchStatusInfo === null}
        warming={searchWarming}
        indexed={indexed} frames={frames} faces={faceStat?.faces ?? 0}
        indexing={indexing} facing={facing}
        pickerOpen={pickerOpen} faceIdxPickerOpen={faceIdxPicker}
        onRefresh={() => { void loadProjectScope(); refreshSearchStatus(); refreshFaceStatus(); }}
        onOpenPicker={() => setPickerOpen((v) => !v)}
        onIndexFaces={() => setFaceIdxPicker((v) => !v)}
      />

      {refPicker && <ReferencePicker onClose={() => setRefPicker(false)} />}
      <FaceRefPicker />
      <FaceHubDialog />

      <IndexPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onIndex={(paths, force, frames) => indexClips(paths, force, frames)}
      />

      <FaceIndexPicker
        open={faceIdxPicker}
        onClose={() => setFaceIdxPicker(false)}
        onIndex={onIndexFacesSelection}
      />

      {indexBusy && <IndexProgress busy={indexBusy} onCancel={cancelIndexing} canceling={indexCancel} kindLabel={t("indexProgress.kindPlans")} />}
      {faceBusy && <IndexProgress busy={faceBusy} onCancel={cancelFaceIndexing} canceling={faceCancel} kindLabel={t("indexProgress.kindFaces")} />}

      <ProjectScopeSheet />

      <FaceModelsBanner />

      {searchNotice && (
        <Card className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0 text-primary" />
          {searchNotice}
        </Card>
      )}

      {searchError ? (
        <Card className="p-4 text-sm text-destructive">{searchError}</Card>
      ) : searching ? (
        <div className="space-y-2">
          <div className="px-1 text-xs text-muted-foreground">{t("searchPanel.searching")}</div>
          <div className={grid}>
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-video w-full rounded-xl" />
            ))}
          </div>
        </div>
      ) : searchHits.length > 0 ? (
        <SearchResults />
      ) : searchQuery ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">{t("searchPanel.noResults", { query: searchQuery })}</Card>
      ) : searchStatusInfo === null ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          <Spinner className="size-6" />
          <div className="text-sm font-medium">{t("searchPanel.loadingData")}</div>
          <p className="text-xs text-muted-foreground">{t("searchPanel.loadingDataHint")}</p>
        </Card>
      ) : !pickerOpen ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          <Database className="h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium">{indexed > 0 ? t("searchPanel.readyToSearch") : t("searchPanel.indexNotBuilt")}</div>
          <p className="max-w-md text-xs text-muted-foreground">
            {indexed > 0
              ? t("searchPanel.readyHint")
              : t("searchPanel.emptyHint")}
          </p>
          {indexed === 0 && <Badge>{t("searchPanel.clickIndex")}</Badge>}
        </Card>
      ) : null}

      <TimelineDrop />
      <ScrollTopButton />
    </div>
  );
}
