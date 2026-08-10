import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Home, FileVideo, FolderInput, Scissors, Search, ListChecks, Undo2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { RefreshIcon } from "@/components/ui/animated-icons";
import { useApp } from "@/store";
import { nr, type Clip, type DetectModel } from "@/lib/bridge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { SORT_KEYS, SORT_LABEL_KEYS, sortClips, loadSortKey, saveSortKey, type SortKey } from "./rushSort";
import { hostOfflineHint } from "@/lib/host";
import { comboFromEvent, isTyping } from "@/lib/shortcuts";
import { MediaTree } from "./MediaTree";
import { SortSelect, FoldersToggle } from "./BrowserControls";
import { TimelineDrop } from "./TimelineDrop";
import { BatchDetectBar, BatchDetectProgress } from "./BatchDetect";
import { PRESETS } from "./cutStudioShared";

export function RushGrid() {
  const { t } = useTranslation("derush");
  const { clips, localClips, clipsLoading, clipsRevalidating, clipsError, connected, loadClips, importFiles, importFolder, backHome, runBatchDetect, batchRunning, activeHost, openCutTimeline, libraryError } = useApp(
    useShallow((s) => ({
      clips: s.clips, localClips: s.localClips, clipsLoading: s.clipsLoading, clipsRevalidating: s.clipsRevalidating, clipsError: s.clipsError,
      connected: s.connected, loadClips: s.loadClips, importFiles: s.importFiles, importFolder: s.importFolder, backHome: s.backHome,
      runBatchDetect: s.runBatchDetect, batchRunning: !!s.batchDetect?.running, activeHost: s.activeHost, openCutTimeline: s.openCutTimeline,
      libraryError: s.libraryError,
    })),
  );
  const libraryNotice = useApp((s) => s.libraryNotice);
  const canUndoLibrary = useApp((s) => s.libraryUndo.length > 0);
  const undoLibraryDelete = useApp((s) => s.undoLibraryDelete);
  const undoCombo = useApp((s) => s.cutKeys.undo);
  const libraryItems = useApp((s) => s.libraryItems);
  const removeLibraryItems = useApp((s) => s.removeLibraryItems);

  // Annulation d'un retrait au clavier. Même combo que l'annulation du studio (« annuler », partout le
  // même sens) : les deux vues ne sont jamais montées en même temps, donc aucun conflit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(document.activeElement)) return;   // le champ de recherche est un input
      if (comboFromEvent(e) !== undoCombo) return;
      e.preventDefault();
      void undoLibraryDelete();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoCombo, undoLibraryDelete]);
  const all = useMemo(() => [...clips, ...localClips], [clips, localClips]);

  const [q, setQ] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batchModel, setBatchModel] = useState<DetectModel>(() => useApp.getState().cutModel);
  const [batchPreset, setBatchPreset] = useState(() => useApp.getState().cutPreset);
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);
  const [folders, setFolders] = useState(true);   // affichage par dossiers Media Pool ↔ liste à plat

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const matched = !s ? all : all.filter((c) => c.name.toLowerCase().includes(s) || (c.bin ?? "").toLowerCase().includes(s));
    return sortClips(matched, sortKey);
  }, [all, q, sortKey]);

  const toggleSel = (c: Clip) =>
    setSel((s) => { const n = new Set(s); n.has(c.path) ? n.delete(c.path) : n.add(c.path); return n; });
  const exitSelect = () => { setSelectMode(false); setSel(new Set()); };

  // La sélection est une liste de CHEMINS ; le retrait prend des ids de bibliothèque. Seuls les rushs
  // importés en ont un (ceux du Media Pool n'y sont pas → rien à retirer pour eux).
  const removableIds = useMemo(
    () => libraryItems.filter((i) => sel.has(i.path)).map((i) => i.id),
    [libraryItems, sel],
  );
  const removeSelected = () => {
    if (!removableIds.length) return;
    void removeLibraryItems(removableIds);
    exitSelect();   // la notice « N rushs retirés · Annuler » prend le relais
  };
  function runBatch() {
    if (!sel.size) return;
    void runBatchDetect([...sel], PRESETS[batchPreset].thr, batchModel);   // OmniShotCut ignore le seuil (auto)
    exitSelect();   // le panneau de progression prend le relais
  }

  // Import direct dans la bibliothèque. « Ajouter au Media Pool » et « Envoyer au board » restent
  // accessibles au clic droit d'un rush, une fois qu'il est là.
  async function pickFiles() {
    const paths = await nr.chooseFiles();
    if (paths && paths.length) void importFiles(paths);
  }
  // Seule voie vers l'import récursif : le drop de dossiers OS est impossible (Tauri impose un choix
  // exclusif entre drop OS et DnD HTML5, et le board a besoin du second).
  async function pickDir() {
    const dir = await nr.chooseDir();
    if (dir) void importFolder(dir);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={backHome} aria-label={t("rushGrid.home")} />}>
            <Home />
          </TooltipTrigger>
          <TooltipContent>{t("rushGrid.home")}</TooltipContent>
        </Tooltip>
        <h1 className="text-[13px] font-medium">{t("home.title")}</h1>
        <span className="text-[11px] text-muted-foreground">{all.length || "—"}</span>
        <div className="relative ml-2 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("rushGrid.searchPlaceholder")} className="h-8 pl-8" />
        </div>
        {all.length > 0 && <FoldersToggle pressed={folders} onPressedChange={setFolders} />}
        {all.length > 0 && (
          <SortSelect value={sortKey} onChange={(v) => { setSortKey(v as SortKey); saveSortKey(v as SortKey); }} options={SORT_KEYS.map((k) => ({ value: k, label: t(SORT_LABEL_KEYS[k]) }))} />
        )}
        <div className="flex-1" />
        {all.length > 0 && (
          <Tooltip>
            <TooltipTrigger render={<Button variant={selectMode ? "default" : "outline"} size="icon-sm" onClick={() => (selectMode ? exitSelect() : setSelectMode(true))} aria-label={t("rushGrid.select")} />}>
              <ListChecks className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{selectMode ? t("rushGrid.exitSelect") : t("rushGrid.selectBatch")}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={pickFiles} aria-label={t("rushGrid.import")} />}>
            <FileVideo className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("home.import")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={pickDir} aria-label={t("library.importFolder")} />}>
            <FolderInput className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("library.importFolder")}</TooltipContent>
        </Tooltip>
        {connected && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={openCutTimeline} aria-label={t("home.cutTimeline")} />}>
              <Scissors className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t("home.cutTimeline")}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={loadClips} disabled={clipsLoading} aria-label={t("shared.reload")} />}>
            <RefreshIcon spinning={clipsLoading || clipsRevalidating} />
          </TooltipTrigger>
          <TooltipContent>{t("shared.reload")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {selectMode && (
        <BatchDetectBar
          total={filtered.length}
          count={sel.size}
          model={batchModel}
          setModel={setBatchModel}
          presetIdx={batchPreset}
          setPresetIdx={setBatchPreset}
          onSelectAll={() => setSel(new Set(filtered.map((c) => c.path)))}
          onClear={() => setSel(new Set())}
          onRun={runBatch}
          onRemove={removeSelected}
          removeCount={removableIds.length}
          onExit={exitSelect}
          busy={batchRunning}
        />
      )}

      <BatchDetectProgress />

      {libraryError && <p className="text-sm text-destructive">{libraryError}</p>}

      {libraryNotice && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{libraryNotice}</span>
          {canUndoLibrary && (
            <Button variant="outline" size="sm" onClick={() => void undoLibraryDelete()}>
              <Undo2 className="size-3.5" /> {t("library.undo")}
            </Button>
          )}
        </div>
      )}

      {all.length > 0 && filtered.length > 0 && (
        <MediaTree clips={filtered} flat={!folders} {...(selectMode ? { onToggle: toggleSel, selectedPaths: sel } : {})} />
      )}

      {all.length > 0 && filtered.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">{t("rushGrid.noRushFor", { q })}</Card>
      )}

      {/* Scan du Media Pool en cours (connexion fraîche) → skeletons, pas de message « vide ». */}
      {clipsLoading && all.length === 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video rounded-xl" />
          ))}
        </div>
      )}

      {/* Hors ligne signalé par la puce du header ; ici juste l'action quand AUCUN rush (jamais enterré
          sous la grille). La bibliothèque compte dans `all` → dès qu'elle contient quelque chose, plus
          aucun message : l'app ne s'excuse pas d'un logiciel de montage fermé, c'est sa raison d'être. */}
      {!connected && all.length === 0 && !clipsLoading && (
        <Card className="block p-6 text-sm text-muted-foreground">
          {hostOfflineHint(activeHost)}
          {clipsError && <p className="mt-2 text-xs">{clipsError}</p>}
        </Card>
      )}

      {connected && all.length === 0 && !clipsLoading && clipsError && (
        <Card className="block p-6 text-sm text-muted-foreground">{clipsError}</Card>
      )}

      {connected && all.length === 0 && !clipsLoading && !clipsError && (
        <Card className="p-6 text-sm text-muted-foreground">{t("rushGrid.poolEmpty")}</Card>
      )}

      <TimelineDrop />
      </div>
    </div>
  );
}
