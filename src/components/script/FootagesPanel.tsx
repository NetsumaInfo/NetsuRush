// Tiroir gauche « Footages » : source d'ajout de médias au script. Recherche (nom / paroles),
// onglets Vidéos/Audio/Tous, liste hiérarchique des clips du Media Pool. Glisser une carte →
// éditeur (payload NR_FOOTAGE_DND, `kind` audio/video décide vignette de rail ou fine ligne).
// Trois entrées : glisser depuis l'Explorateur (chemins résolus par nr.pathsForFiles), boutons
// d'import natif (nr.chooseMediaFiles/chooseDir) vers le Media Pool. Le mode d'emploi vit dans l'ÉTAT
// VIDE, pas en permanence au-dessus de la liste.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronsLeft, Search, Loader2, House, FilePlus2, FolderPlus, Film, Folder } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nextProxyToken, nr, type Clip, type ScriptBlockMedia } from "@/lib/bridge";
import { useApp } from "@/store";
import { basename, THUMB_AUTO } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { useThumb } from "./useThumb";
import { RecordingsSection } from "./RecordingsSection";
import { AudioWaveThumb } from "./AudioWaveThumb";
import { NR_FOOTAGE_DND, isAudioPath, type FootageDrag } from "./scriptShared";
import { attachTranscriptHit, TranscriptHitRow, useTranscriptHits } from "./TranscriptSearch";
import { useScript } from "./useScript";

const isAudio = (c: Clip) => isAudioPath(c.path);

// Vignette de la ligne : image seule. La durée vit dans la ligne de méta à droite — la répéter en
// badge sur l'image était du bruit (retour user). Instant AUTO : un rush entier commence presque
// toujours par du noir → sans ça la liste est une colonne de cases noires.
function Thumb({ clip }: { clip: Clip }) {
  const audio = isAudio(clip);
  const thumb = useThumb(audio ? "" : clip.path, THUMB_AUTO);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const active = !audio && (hovered || pinned);

  useEffect(() => {
    if (!active || preview) return;
    let alive = true;
    const token = nextProxyToken();
    void nr.proxy({ input: clip.path, start: 0, end: 8, priority: "high", height: 180, token, requireVideo: true })
      .then((result) => { if (alive && result.ok && result.path) setPreview(nr.mediaUrl(result.path)); });
    return () => { alive = false; nr.proxyCancel(token); };
  }, [active, clip.path, preview]);

  if (audio) return <AudioWaveThumb path={clip.path} />;
  return (
    <button
      type="button"
      className={`footage-thumb ${pinned ? "is-playing" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPinned((value) => !value); }}
      aria-label={pinned ? "Arrêter l’aperçu" : "Lire l’aperçu"}
    >
      {thumb && <img src={nr.mediaUrl(thumb)} alt="" draggable={false} />}
      {active && preview && <PreviewVideo url={preview} label={clip.name} audible={hovered || pinned} onError={() => setPreview(null)} />}
      <span className="footage-preview-cue"><Film /></span>
    </button>
  );
}

// Pas d'infobulle sur la ligne : le nom et les métas sont déjà écrits, et « comment glisser » vit
// dans l'état vide (retour user : infobulles trop bavardes).
interface MediaEntry { clip: Clip; source: ScriptBlockMedia["source"] }

function FootageRow({ clip, source }: MediaEntry) {
  const meta = [clip.resolution, clip.fps ? `${clip.fps}fps` : "", clip.duration].filter(Boolean).join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger render={
        <div
          className="footage-item"
          draggable
          onDragStart={(e) => {
            const payload: FootageDrag = {
              filePath: clip.path,
              label: clip.name || basename(clip.path),
              fps: parseFloat(clip.fps || "") || 24,
              kind: isAudio(clip) ? "audio" : "video",
              source,
            };
            e.dataTransfer.setData(NR_FOOTAGE_DND, JSON.stringify(payload));
            e.dataTransfer.effectAllowed = "copy";
          }}
        />
      }>
        <Thumb clip={clip} />
        <div className="footage-info">
          <div className="footage-name">{clip.name || basename(clip.path)}</div>
          <div className="footage-meta">{meta}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">
        <p className="font-medium">{clip.name || basename(clip.path)}</p>
        <p className="break-all text-[10px] opacity-75">{clip.bin ? `${clip.bin} · ` : ""}{clip.path}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface MediaNode { name: string; entries: MediaEntry[]; children: Map<string, MediaNode> }
function mediaTree(entries: MediaEntry[]): MediaNode {
  const root: MediaNode = { name: "", entries: [], children: new Map() };
  for (const entry of entries) {
    let node = root;
    for (const part of (entry.clip.bin || "").split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (!child) { child = { name: part, entries: [], children: new Map() }; node.children.set(part, child); }
      node = child;
    }
    node.entries.push(entry);
  }
  return root;
}
function nodeCount(node: MediaNode): number {
  let count = node.entries.length;
  for (const child of node.children.values()) count += nodeCount(child);
  return count;
}
function MediaFolder({ node, path, depth, collapsed, toggle }: {
  node: MediaNode; path: string; depth: number; collapsed: Set<string>; toggle: (path: string) => void;
}) {
  const open = !collapsed.has(path);
  return (
    <div className="footage-folder">
      <button type="button" className="footage-folder-row" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(path)}>
        <ChevronRight className={open ? "is-open" : ""} />
        <Folder />
        <span>{node.name}</span>
        <small>{nodeCount(node)}</small>
      </button>
      {open && (
        <div>
          {node.entries.map((entry) => <FootageRow key={entry.clip.path} {...entry} />)}
          {[...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
            <MediaFolder key={child.name} node={child} path={`${path}/${child.name}`} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  );
}
function MediaList({ entries }: { entries: MediaEntry[] }) {
  const tree = useMemo(() => mediaTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) => setCollapsed((value) => {
    const next = new Set(value);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });
  return (
    <>
      {tree.entries.map((entry) => <FootageRow key={entry.clip.path} {...entry} />)}
      {[...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <MediaFolder key={child.name} node={child} path={child.name} depth={0} collapsed={collapsed} toggle={toggle} />
      ))}
    </>
  );
}

export function FootagesPanel({ collapsed, width, onHome }: { collapsed: boolean; width: number; onHome: () => void }) {
  const { t } = useTranslation("script");
  const { clips, localClips, loadClips, clipsLoading, connected, importFiles, importFolder } = useApp(
    useShallow((s) => ({
      clips: s.clips,
      localClips: s.localClips,
      loadClips: s.loadClips,
      clipsLoading: s.clipsLoading,
      connected: s.connected,
      importFiles: s.importFiles,
      importFolder: s.importFolder,
    })),
  );
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"video" | "audio" | "all">("video");
  const [source, setSource] = useState<"mediapool" | "recordings">("mediapool");
  const [searchMode, setSearchMode] = useState<"name" | "speech">("name");
  const [over, setOver] = useState(false);
  const [scriptPool, setScriptPool] = useState<Clip[] | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const selected = useScript((s) => s.selected);
  // Ouverture contextuelle : « Attacher un plan/son » et /transcript imposent l'onglet à l'ouverture
  // (le tiroir gauche est la source UNIQUE d'ajout de médias).
  const footagesMode = useScript((s) => s.footagesMode);
  useEffect(() => {
    if (collapsed) return;
    setSearchMode(footagesMode === "paroles" ? "speech" : "name");
    if (footagesMode === "videos") setTab("video");
    else if (footagesMode === "audio") setTab("audio");
  }, [collapsed, footagesMode]);
  const { hits, busy: hitsBusy, error: hitsError } = useTranscriptHits(searchMode === "speech" ? q : "");

  useEffect(() => { if (!clips.length) void loadClips(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshPool = useCallback(async () => {
    try {
      const result = await nr.script?.mediaPool();
      if (!result) return;
      setScriptPool(result.clips ?? []);
      setPoolError(result.error ?? null);
    } catch (error) {
      setPoolError(String(error));
    }
  }, []);
  useEffect(() => { if (!collapsed) void refreshPool(); }, [collapsed, connected, refreshPool]);
  useEffect(() => {
    if (collapsed) return;
    return nr.onResolveChanged((change) => { if (change.mediaPool) void refreshPool(); });
  }, [collapsed, refreshPool]);

  const pool = poolError ? clips : (scriptPool ?? clips);
  const all = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...pool.map((clip) => ({ clip, source: "mediapool" as const })),
      ...localClips.map((clip) => ({ clip, source: "folder" as const })),
    ].filter(({ clip }) => {
      const key = clip.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [localClips, pool]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(({ clip }) => {
      if (tab === "video" && isAudio(clip)) return false;
      if (tab === "audio" && !isAudio(clip)) return false;
      return !s || clip.name.toLowerCase().includes(s) || clip.path.toLowerCase().includes(s) || (clip.bin || "").toLowerCase().includes(s);
    });
  }, [all, q, tab]);

  const importPaths = useCallback(async (paths: string[]) => {
    if (!paths.length || importing) return;
    setImporting(true);
    try {
      await importFiles(paths);
    } finally {
      setImporting(false);
    }
  }, [importFiles, importing]);

  // Import natif : les fichiers rejoignent la bibliothèque persistante de NetsuRush. Elle reste
  // disponible hors Resolve et se fusionne avec les bins du Media Pool dans cette même liste.
  const addFiles = async () => {
    const paths = await nr.chooseMediaFiles();
    if (paths?.length) await importPaths(paths);
  };
  const addFolder = async () => {
    const dir = await nr.chooseDir();
    if (dir) await importFolder(dir);
  };

  // Glisser depuis l'Explorateur : les objets File sont lus tout de suite (dataTransfer est vidé à
  // la fin de l'événement), leur chemin disque se résout côté host — les octets ne sont jamais lus,
  // un rush reste où il est. Le core range ensuite les dossiers dans des bins homonymes.
  const onDropFiles = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return; // drag interne d'une carte
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    void nr.pathsForFiles(files).then((paths) => {
      const valid = paths.filter(Boolean);
      if (valid.length) { void importPaths(valid); return; }
      // WebView2 ancien/non réattaché : ouvre directement la voie native fiable, sans message mort.
      void nr.chooseMediaFiles().then((picked) => { if (picked?.length) void importPaths(picked); });
    });
  };

  return (
    <aside
      className={`sidebar-left ${collapsed ? "collapsed" : ""} ${over ? "drop-over" : ""}`}
      style={{ "--footages-width": `${width}px` } as React.CSSProperties}
      aria-label={t("footages.ariaLabel")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={onDropFiles}
    >
      {/* En-tête : accueil des scripts · ajouter des médias · fermer. Le titre du doc vit en tête de feuille. */}
      <header className="sidebar-doc">
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="collapse-btn" onClick={onHome} />}><House /></TooltipTrigger>
          <TooltipContent side="left">{t("footages.home")}</TooltipContent>
        </Tooltip>
        <span className="sidebar-title">{t("footages.title")}</span>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="collapse-btn" onClick={() => void addFiles()} />}><FilePlus2 /></TooltipTrigger>
          <TooltipContent side="left">{t("footages.addFiles")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="collapse-btn" onClick={() => void addFolder()} />}><FolderPlus /></TooltipTrigger>
          <TooltipContent side="left">{t("footages.addFolder")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="collapse-btn" onClick={() => useScript.getState().closeFootages()} />}><ChevronsLeft /></TooltipTrigger>
          <TooltipContent side="left">{t("footages.hide")}</TooltipContent>
        </Tooltip>
      </header>

      <div className="search-box">
        {searchMode === "speech" && hitsBusy ? <Loader2 className="ico animate-spin" /> : <Search className="ico" />}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchMode === "speech" ? t("footages.spokenWords") : t("footages.search")}
        />
      </div>

      <div className="media-tabs search-mode">
        <button type="button" className={`media-tab ${searchMode === "name" ? "active" : ""}`} onClick={() => setSearchMode("name")}>{t("footages.name")}</button>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className={`media-tab ${searchMode === "speech" ? "active" : ""}`} onClick={() => setSearchMode("speech")} />}>
            {t("footages.speech")}
          </TooltipTrigger>
          <TooltipContent>{t("footages.speechHint")}</TooltipContent>
        </Tooltip>
      </div>

      {searchMode === "name" && (
        <div className="media-tabs">
          <button type="button" className={`media-tab ${tab === "video" ? "active" : ""}`} onClick={() => { setTab("video"); setSource("mediapool"); }}>{t("footages.videos")}</button>
          <button type="button" className={`media-tab ${tab === "audio" ? "active" : ""}`} onClick={() => setTab("audio")}>{t("footages.audio")}</button>
          <button type="button" className={`media-tab ${tab === "all" ? "active" : ""}`} onClick={() => { setTab("all"); setSource("mediapool"); }}>{t("footages.all")}</button>
        </div>
      )}

      {searchMode === "name" && (
        <div className="media-source-tabs" role="tablist" aria-label={t("audioSources.title")}>
          <button type="button" className={source === "mediapool" ? "active" : ""} onClick={() => setSource("mediapool")}>{t("audioSources.mediaPool")}</button>
          <button type="button" className={source === "recordings" ? "active" : ""} onClick={() => { setSource("recordings"); setTab("audio"); }}>{t("audioSources.recordings")}</button>
        </div>
      )}

      {searchMode === "speech" ? (
        <div className="footage-list transcript-hits">
          {hitsError && <p className="empty-note">{hitsError}</p>}
          {!hitsError && q.trim().length < 2 && <p className="empty-note">{t("footages.speechPrompt")}</p>}
          {!hitsError && q.trim().length >= 2 && !hitsBusy && hits.length === 0 && <p className="empty-note">{t("footages.noPassage")}</p>}
          {hits.map((h) => (
            <TranscriptHitRow
              key={`${h.file}-${h.start}-${h.end}`}
              hit={h}
              draggable
              onDragStart={(e) => {
                const payload: FootageDrag = { filePath: h.file, label: basename(h.file), fps: 0, startSec: h.start, endSec: h.end };
                e.dataTransfer.setData(NR_FOOTAGE_DND, JSON.stringify(payload));
                e.dataTransfer.effectAllowed = "copy";
              }}
              onPick={() => { if (selected) void attachTranscriptHit(selected, h); }}
            />
          ))}
        </div>
      ) : (
        <>
          {source === "recordings" && <RecordingsSection query={q} />}
          {source === "mediapool" && <div className="footage-list">
            {clipsLoading && !all.length ? (
              <div className="loading-row"><span className="spinner" /> {t("footages.loadingMediaPool")}</div>
            ) : !all.length ? (
              <div className="footage-empty">
                <p>{t("footages.noFile")}</p>
                <button type="button" className="rec-pick" onClick={() => void addFiles()}><FilePlus2 /> {t("footages.addFilesEllipsis")}</button>
              </div>
            ) : filtered.length === 0 ? (
              <p className="empty-note">{t("footages.noFile")}</p>
            ) : (
              <MediaList entries={filtered} />
            )}
          </div>}
        </>
      )}
    </aside>
  );
}
