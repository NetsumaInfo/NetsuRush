// Écran d'accueil du board (onglet Référence) : zone de dépôt, bouton « Nouveau projet » et grille
// « Récent » unique (session, fichiers .netsu et scènes internes non converties).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ImageUp, History, Settings2, FilePlus2, FolderOpen, FileCheck2, FileWarning,
  Star, Trash2, EyeOff, FolderSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { nr } from "@/lib/bridge";
import { logError } from "@/lib/appLog";
import type { NetsuRecent, RefSceneMeta } from "@/lib/bridge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ProjectThumb, SceneThumb } from "./SceneThumb";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useBoard } from "./useReferenceBoard";

const RTF = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });
function relDate(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (abs < hour) return RTF.format(Math.round(diff / min), "minute");
  if (abs < day) return RTF.format(Math.round(diff / hour), "hour");
  if (abs < 30 * day) return RTF.format(Math.round(diff / day), "day");
  return RTF.format(Math.round(diff / (30 * day)), "month");
}

const LS_FAV = "nr-ref-favorites";
const LS_HIDDEN = "nr-ref-hidden";

function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]); }
  catch { return new Set(); }
}
function saveSet(key: string, s: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...s]));
}

function sortScenes(list: RefSceneMeta[], favs: Set<string>): RefSceneMeta[] {
  return [...list].sort((a, b) => {
    const af = favs.has(a.id) ? 1 : 0;
    const bf = favs.has(b.id) ? 1 : 0;
    if (af !== bf) return bf - af;
    return b.updatedAt - a.updatedAt;
  });
}

async function revealInternalProject() {
  const storagePath = await nr.reference?.storagePath();
  if (storagePath) await nr.openPath(storagePath);
}

// ---------- Carte de scène ----------
function SceneCard({
  scene, isFavorite, onOpen, onToggleFavorite, onHide, onDelete,
}: {
  scene: RefSceneMeta;
  isFavorite: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onHide: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("reference");
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative flex flex-col gap-2" />}>
      {/* Vignette — div cliquable (pas un <button> : il contient des boutons d'action) */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        className="relative aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-colors group-hover:border-primary/50"
      >
        <SceneThumb id={scene.id} />

        {/* Overlay actions (visible au survol) */}
        <div className="absolute inset-0 flex items-start justify-between p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          {/* Favori */}
          <button
            type="button"
            aria-label={isFavorite ? t("actions.removeFavorite") : t("actions.addFavorite")}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md backdrop-blur-[2px] transition-colors",
              isFavorite
                ? "bg-primary text-primary-foreground"
                : "bg-black/50 text-white/70 hover:bg-black/70 hover:text-destructive",
            )}
          >
            <Star className="size-3.5" fill={isFavorite ? "currentColor" : "none"} />
          </button>

          {/* Supprimer — dropdown deux options */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t("home.deleteOptions")}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex size-6 items-center justify-center rounded-md bg-black/50 text-white/70 hover:bg-black/70 hover:text-destructive backdrop-blur-[2px] transition-colors"
                >
                  <Trash2 className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onHide(); }}>
                <EyeOff className="size-4" />
                {t("home.hideFromList")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                <Trash2 className="size-4" />
                {t("home.deleteScene")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Badge favori permanent (masqué au hover pour laisser les boutons visibles) */}
        {isFavorite && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground opacity-100 transition-opacity group-hover:opacity-0">
            <Star className="size-3.5" fill="currentColor" />
          </div>
        )}
      </div>

      {/* Nom + date */}
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          <p className="truncate text-sm font-medium text-foreground">{scene.name}</p>
          <p className="truncate text-xs text-muted-foreground">{t("home.modified", { date: relDate(scene.updatedAt) })}</p>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <FileCheck2 /> {t("home.openProjectFile")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void revealInternalProject()}>
          <FolderSearch /> {t("home.openProjectLocation")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onToggleFavorite}>
          <Star /> {isFavorite ? t("actions.removeFavorite") : t("actions.addFavorite")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onHide}>
          <EyeOff /> {t("home.hideFromList")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> {t("home.deleteScene")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const projectFavoriteKey = (filePath: string) => `project:${filePath}`;

function sortProjects(list: NetsuRecent[], favs: Set<string>): NetsuRecent[] {
  return [...list].sort((a, b) => {
    const af = favs.has(projectFavoriteKey(a.path)) ? 1 : 0;
    const bf = favs.has(projectFavoriteKey(b.path)) ? 1 : 0;
    if (af !== bf) return bf - af;
    return (b.modifiedAt ?? b.openedAt) - (a.modifiedAt ?? a.openedAt);
  });
}

// File-backed projects use the same card actions as internal scenes; removal only forgets the recent
// entry and never deletes the user's .netsu file.
function ProjectCard({ entry, isFavorite, onOpen, onToggleFavorite, onForget, onDelete }: {
  entry: NetsuRecent;
  isFavorite: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onForget: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("reference");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const folder = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf(entry.path.includes("\\") ? "\\" : "/")));
  const reveal = async () => {
    if (await nr.revealPath(entry.path)) return;
    if (folder) await nr.openPath(folder);
  };
  return <>
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative flex flex-col gap-2" />}>
        <button
          type="button"
          aria-label={entry.title}
          onClick={onOpen}
          disabled={entry.missing}
          className={cn(
            "flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors",
            entry.missing ? "opacity-50" : "group-hover:border-primary/50",
          )}
        >
          {entry.missing
            ? <FileWarning className="size-7 opacity-70" strokeWidth={1.5} />
            : <ProjectThumb path={entry.path} />}
        </button>

        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label={isFavorite ? t("actions.removeFavorite") : t("actions.addFavorite")}
            onClick={onToggleFavorite}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md backdrop-blur-[2px] transition-colors",
              isFavorite
                ? "bg-primary text-primary-foreground"
                : "bg-black/50 text-white/70 hover:bg-black/70 hover:text-destructive",
            )}
          >
            <Star className="size-3.5" fill={isFavorite ? "currentColor" : "none"} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t("home.deleteOptions")}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex size-6 items-center justify-center rounded-md bg-black/50 text-white/70 backdrop-blur-[2px] transition-colors hover:bg-black/70 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onForget(); }}>
                <EyeOff className="size-4" />
                {t("home.forgetProject")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" />
                {t("home.deleteProject")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isFavorite && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground opacity-100 transition-opacity group-hover:opacity-0">
            <Star className="size-3.5" fill="currentColor" />
          </div>
        )}
        <Tooltip>
          <TooltipTrigger render={<button type="button" onClick={onOpen} disabled={entry.missing} className="min-w-0 text-left" />}>
            <p className="truncate text-sm font-medium text-foreground">{entry.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {entry.missing
                ? t("home.projectMissing")
                : t("home.modified", { date: relDate(entry.modifiedAt ?? entry.openedAt) })}
            </p>
          </TooltipTrigger>
          <TooltipContent>{entry.path}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={entry.missing} onClick={onOpen}>
          <FileCheck2 /> {t("home.openProjectFile")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void reveal()}>
          <FolderSearch /> {t("home.openProjectLocation")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onForget}>
          <EyeOff /> {t("home.forgetProject")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
          <Trash2 /> {t("home.deleteProject")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={t("home.deleteProjectTitle", { name: entry.title })}
      description={t("home.deleteProjectWarning")}
      confirmLabel={t("home.deleteProject")}
      onConfirm={onDelete}
    />
  </>;
}

// ---------- Composant principal ----------
export function ReferenceHome({
  hasSession,
  onResume,
  onOpen,
  onNew,
  onNewFiles,
  onSettings,
  onOpenProject,
  onOpenRecent,
  recents,
}: {
  hasSession: boolean;
  onResume: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onNewFiles: (files: File[]) => void;
  onSettings: () => void;
  onOpenProject?: () => void;
  onOpenRecent?: (filePath: string) => void;
  recents?: () => Promise<NetsuRecent[]>;
}) {
  const { t } = useTranslation("reference");
  const [recent, setRecent] = useState<RefSceneMeta[]>([]);
  const [projects, setProjects] = useState<NetsuRecent[]>([]);
  const [over, setOver] = useState(false);
  // L'accueil n'a pas de barre d'outils : sans ce relais, une ouverture de projet ratée (dépôt,
  // carte récente) ne dirait rien du tout — la notice partait dans un store que personne n'affiche.
  const notice = useBoard((s) => s.notice);
  const [favorites, setFavorites] = useState<Set<string>>(() => loadSet(LS_FAV));
  const [hidden, setHidden] = useState<Set<string>>(() => loadSet(LS_HIDDEN));

  useEffect(() => {
    let alive = true;
    const initFavs = loadSet(LS_FAV);
    void (async () => {
      const list = (await nr.reference?.listScenes()) ?? [];
      const filtered = list.filter((s) => !s.id.startsWith("__"));
      if (alive) setRecent(sortScenes(filtered, initFavs));
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!recents) return undefined;
    let alive = true;
    const initFavs = loadSet(LS_FAV);
    void recents().then((list) => { if (alive) setProjects(sortProjects(list, initFavs)); });
    return () => { alive = false; };
  }, [recents]);

  const forgetProject = useCallback(async (filePath: string) => {
    setProjects(await (nr.reference?.forgetProject(filePath) ?? Promise.resolve([])));
  }, []);

  const deleteProject = useCallback(async (filePath: string) => {
    const result = await nr.reference?.deleteProject(filePath);
    if (!result) return;
    setProjects(result.recents);
    if (!result.ok) {
      useBoard.getState().setNotice({ text: t("notice.failedWith", { error: result.error || t("notice.unknown") }), kind: "error" });
      return;
    }
    const st = useBoard.getState();
    if (st.filePath?.toLowerCase() === filePath.toLowerCase()) {
      useBoard.setState({ filePath: null, fileReadonly: false, dirty: st.items.length > 0 });
    }
  }, [t]);

  const toggleFavorite = useCallback((id: string) => {
    const next = new Set(favorites);
    next.has(id) ? next.delete(id) : next.add(id);
    setFavorites(next);
    saveSet(LS_FAV, next);
    setRecent((r) => sortScenes(r, next));
    setProjects((p) => sortProjects(p, next));
  }, [favorites]);

  const hideScene = useCallback((id: string) => {
    const next = new Set(hidden);
    next.add(id);
    setHidden(next);
    saveSet(LS_HIDDEN, next);
  }, [hidden]);

  const deleteScene = useCallback(async (id: string) => {
    await nr.reference?.deleteScene(id);
    setRecent((prev) => prev.filter((s) => s.id !== id));
    if (!favorites.has(id)) return;
    const next = new Set(favorites);
    next.delete(id);
    setFavorites(next);
    saveSet(LS_FAV, next);
  }, [favorites]);

  const openDroppedProject = useCallback((paths: string[]): boolean => {
    const projectPath = paths.find((filePath) => filePath.toLowerCase().endsWith(".netsu"));
    if (!projectPath || !onOpenRecent) return false;
    void onOpenRecent(projectPath);
    return true;
  }, [onOpenRecent]);

  // `dragDropEnabled` est à false (cf. src-tauri/tauri.conf.json) : les fichiers lâchés depuis
  // l'Explorateur arrivent en DnD HTML5 ordinaire, jamais en événement Tauri. Le chemin disque, lui,
  // n'est pas dans l'objet `File` — il se résout par le pont WebView2 (`nr.pathsForFiles`).
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    const projectFile = dropped.find((file) => file.name.toLowerCase().endsWith(".netsu"));
    if (projectFile) {
      const [projectPath] = await nr.pathsForFiles([projectFile]);
      if (projectPath && openDroppedProject([projectPath])) return;
      // Un projet lâché ne doit JAMAIS retomber en silence : sans chemin (pont indisponible) ou sans
      // action d'ouverture, on le dit, plutôt que de laisser l'accueil immobile.
      logError("board:home", `dépôt .netsu sans ouverture — ${projectFile.name} (chemin: ${projectPath || "non résolu"})`);
      useBoard.getState().setNotice({ kind: "error", text: t("notice.dropProjectFailed", { name: projectFile.name }) });
      return;
    }
    const files = dropped.filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (files.length) onNewFiles(files);
  };

  const projectSceneIds = new Set(
    projects.map((entry) => entry.sourceSceneId).filter((id): id is string => !!id),
  );
  const visible = recent.filter((s) => !hidden.has(s.id) && !projectSceneIds.has(s.id));

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--color-bg)]"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setOver(false); }}
      onDrop={onDrop}
    >
      {/* A .netsu file is always opened as the working project. */}
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
        {onOpenProject && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t("home.openProject")}
                  onClick={onOpenProject}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                />
              }
            >
              <FolderOpen className="size-4" /> {t("home.openProject")}
            </TooltipTrigger>
            <TooltipContent>{t("home.openProjectHint")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Paramètres */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t("actions.settings")}
              onClick={onSettings}
              className="absolute right-4 top-4 z-10 inline-flex size-6 items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            />
          }
        >
          <Settings2 className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("actions.settings")}</TooltipContent>
      </Tooltip>

      {/* Héros : zone de dépôt + nouveau projet */}
      <div className="flex flex-1 items-center justify-center p-8">
        <div
          className={cn(
            "flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border-2 border-dashed px-8 py-14 text-center transition-colors",
            over ? "border-primary bg-primary/10" : "border-border",
          )}
        >
          <div
            className={cn(
              "flex size-20 items-center justify-center rounded-2xl bg-muted text-primary transition-transform",
              over && "scale-110",
            )}
          >
            <ImageUp className="size-10" strokeWidth={1.5} />
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-foreground">{t("home.dropMedia")}</p>
            <p className="text-sm text-muted-foreground">{t("home.dropHint")}</p>
          </div>

          <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>{t("home.or")}</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
          >
            <FilePlus2 className="size-4" />
            {t("home.createEmpty")}
          </button>

          {notice && (
            <p
              className={cn(
                "max-w-full text-xs",
                notice.kind === "error" ? "text-destructive" : "text-[var(--color-ok)]",
              )}
            >
              {notice.text}
            </p>
          )}
        </div>
      </div>

      {/* Section Récent */}
      {(hasSession || projects.length > 0 || visible.length > 0) && (
        <div className="border-t border-border bg-card/40 px-8 py-6">
          <h2 className="mb-4 text-sm font-semibold text-foreground">{t("home.recent")}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {/* Session en cours */}
            {hasSession && (
              <div className="group relative flex flex-col gap-2">
                <button
                  type="button"
                  aria-label={t("home.resume")}
                  onClick={onResume}
                  className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:border-primary/50"
                >
                  <History className="size-7 opacity-70" strokeWidth={1.5} />
                </button>
                <button type="button" onClick={onResume} className="min-w-0 text-left">
                  <p className="truncate text-sm font-medium text-foreground">{t("home.resume")}</p>
                  <p className="truncate text-xs text-muted-foreground">{t("home.currentBoard")}</p>
                </button>
              </div>
            )}

            {/* Projets .netsu récents — ouverts comme documents, jamais réimportés en scènes. */}
            {onOpenRecent && projects.map((entry) => (
              <ProjectCard
                key={entry.path}
                entry={entry}
                isFavorite={favorites.has(projectFavoriteKey(entry.path))}
                onOpen={() => onOpenRecent(entry.path)}
                onToggleFavorite={() => toggleFavorite(projectFavoriteKey(entry.path))}
                onForget={() => void forgetProject(entry.path)}
                onDelete={() => void deleteProject(entry.path)}
              />
            ))}

            {/* Scènes récentes */}
            {visible.map((s) => (
              <SceneCard
                key={s.id}
                scene={s}
                isFavorite={favorites.has(s.id)}
                onOpen={() => onOpen(s.id)}
                onToggleFavorite={() => toggleFavorite(s.id)}
                onHide={() => hideScene(s.id)}
                onDelete={() => void deleteScene(s.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
