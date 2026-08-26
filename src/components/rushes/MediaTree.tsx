import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Folder, HardDriveDownload, FolderOpen, FolderPlus, FolderInput, Pencil, Trash2, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useApp } from "@/store";
import { nr, type Clip, type LibraryFolder } from "@/lib/bridge";
import { ClipGrid, CLIP_DND } from "./ClipCard";
import { hasOsFiles, importDroppedFiles } from "./libraryDrop";
import { useDropZone } from "@/lib/dropZone";
import { FolderNameDialog } from "@/components/collections/FolderNameDialog";
import { LIB_ROOT, folderPath, buildClipTree, countTreeClips, type ClipTreeNode } from "./libraryShared";

type TreeNode = ClipTreeNode;

// Fichiers disparus : UN bandeau, pas N badges. Un disque externe débranché met des centaines de
// rushs hors ligne d'un coup — et relinkDir les répare tous en un passage, donc l'action est globale.
function OfflineBanner({ count }: { count: number }) {
  const { t } = useTranslation("derush");
  const relinkLibraryDir = useApp((s) => s.relinkLibraryDir);
  const [busy, setBusy] = useState(false);
  const relocate = async () => {
    const dir = await nr.chooseDir();
    if (!dir) return;
    setBusy(true);
    try { await relinkLibraryDir(dir); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <Unlink className="h-4 w-4 shrink-0 text-destructive" />
      <span className="flex-1 text-muted-foreground">{t("library.offlineBanner", { count })}</span>
      <Button variant="outline" size="sm" onClick={relocate} disabled={busy}>{t("library.relocate")}</Button>
    </div>
  );
}

// Une rangée de dossier de la bibliothèque : repliable, cible de dépôt d'un rush, et point d'entrée
// des actions de rangement. Les bins Resolve, eux, ne portent aucune de ces affordances — c'est
// exactement ce qui distingue « à moi » de « au projet », sans séparateur ni étiquette décorative.
function LibFolderRow({ node, depth, isOpen, toggle, folder }: {
  node: TreeNode; depth: number; isOpen: boolean; toggle: () => void; folder: LibraryFolder | null;
}) {
  const { t } = useTranslation(["derush", "common"]);
  const { moveLibraryItem, saveLibraryFolder, deleteLibraryFolder, importFolder, libraryItems } = useApp(
    useShallow((s) => ({
      moveLibraryItem: s.moveLibraryItem, saveLibraryFolder: s.saveLibraryFolder,
      deleteLibraryFolder: s.deleteLibraryFolder, importFolder: s.importFolder, libraryItems: s.libraryItems,
    })),
  );
  // Rangée de dossier : elle GARDE le dépôt (stopPropagation), sinon la page le reprendrait pour la
  // racine. Le liseré s'éteint à la fin du glissé où qu'elle survienne (cf. useDropZone).
  const [dialog, setDialog] = useState<"new" | "rename" | "delete" | null>(null);
  // Décoché par défaut : le geste sûr (les rushs remontent au parent) reste celui qu'on obtient en
  // validant sans réfléchir. Cocher est un acte délibéré.
  const [withItems, setWithItems] = useState(false);
  const isRoot = folder === null;
  const inFolder = countTreeClips(node);

  const drop = useDropZone({
    accept: (dt) => dt.types.includes(CLIP_DND) || hasOsFiles(dt),
    // Fichiers de l'Explorateur = ajout (copie) ; carte déjà en bibliothèque = rangement.
    effect: (dt) => (hasOsFiles(dt) ? "copy" : "move"),
    stopPropagation: true,
    onDrop: (e) => {
      // Fichiers de l'Explorateur lâchés SUR une rangée : ils se rangent dans CE dossier, pas à la racine.
      if (hasOsFiles(e.dataTransfer)) {
        void importDroppedFiles(Array.from(e.dataTransfer.files), folder?.id ?? null);
        return;
      }
      const id = e.dataTransfer.getData(CLIP_DND);
      if (!id) return;
      const it = libraryItems.find((x) => x.id === id);
      if (!it || it.folderId === (folder?.id ?? null)) return;
      void moveLibraryItem(id, folder?.id ?? null);
    },
  });

  const pickDir = async () => { const d = await nr.chooseDir(); if (d) void importFolder(d); };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={
          <div
            role="button"
            tabIndex={0}
            onClick={toggle}
            // `e.target !== e.currentTarget` : la rangée contient un vrai <button> ; sans ce garde, son
            // keydown bulle ici et le preventDefault annule son activation native (Entrée replierait le
            // dossier au lieu d'ouvrir le dialogue).
            onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
            {...drop.dropProps}
            style={{ paddingLeft: depth * 14 + 4 }}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-2 text-sm text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
              drop.over && "bg-primary/10 ring-1 ring-primary",
            )} />
        }>
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
          {/* Accent réservé à l'état : marque « c'est à moi, ça persiste », même vocabulaire que le
              badge des clips locaux. Les bins du projet gardent l'icône neutre. */}
          {isRoot
            ? <HardDriveDownload className="h-4 w-4 shrink-0 text-primary" />
            : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate font-medium">{isRoot ? t("library.rootName") : node.name}</span>
          <span className="text-xs text-muted-foreground">{countTreeClips(node)}</span>
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger render={<Button
              variant="ghost" size="icon-sm"
              aria-label={t("library.newFolder")}
              onClick={(e) => { e.stopPropagation(); setDialog("new"); }}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />}>
              <FolderPlus />
            </TooltipTrigger>
            <TooltipContent>{t("library.newFolder")}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem onClick={toggle}>
            <FolderOpen /> {isOpen ? t("shared.collapseFolder") : t("shared.expandFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setDialog("new")}><FolderPlus /> {t("library.newFolder")}</ContextMenuItem>
          {isRoot && <ContextMenuItem onClick={() => void pickDir()}><FolderInput /> {t("library.importFolder")}</ContextMenuItem>}
          {!isRoot && (
            <>
              <ContextMenuItem onClick={() => setDialog("rename")}><Pencil /> {t("library.renameFolder")}</ContextMenuItem>
              <ContextMenuSeparator />
              {/* Confirmation : le sort des rushs contenus se décide là, pas ici. */}
              <ContextMenuItem variant="destructive" onClick={() => { setWithItems(false); setDialog("delete"); }}>
                <Trash2 /> {t("library.deleteFolder")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <FolderNameDialog
        open={dialog === "new" || dialog === "rename"}
        initial={dialog === "rename" && folder ? folder.name : ""}
        title={dialog === "rename" ? t("library.renameFolder") : t("library.newFolder")}
        onSubmit={(name) => {
          if (dialog === "rename" && folder) void saveLibraryFolder({ id: folder.id, name });
          else void saveLibraryFolder({ name, parentId: folder?.id ?? null });
          setDialog(null);
        }}
        onCancel={() => setDialog(null)}
      />
      <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.deleteFolderTitle", { name: node.name })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {inFolder > 0 ? t("library.deleteFolderBody", { count: inFolder }) : t("library.deleteFolderEmpty")}
          </p>
          {inFolder > 0 && (
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border p-3 text-sm">
              <Checkbox checked={withItems} onCheckedChange={(v) => setWithItems(v === true)} />
              <span>{t("library.deleteFolderWithItems", { count: inFolder })}</span>
            </label>
          )}
          <p className="text-[11px] text-muted-foreground">{t("library.deleteFolderSafe")}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{t("common:action.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => { if (folder) void deleteLibraryFolder(folder.id, withItems); setDialog(null); }}
            >
              <Trash2 /> {t("library.deleteFolder")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FolderView({ node, path, depth, collapsed, toggle, lib, folderByPath, onPick, onToggle, selectedPath, selectedPaths }: {
  node: TreeNode; path: string; depth: number; collapsed: Set<string>; toggle: (p: string) => void;
  lib?: boolean; folderByPath?: Map<string, LibraryFolder>;
  onPick?: (c: Clip) => void; onToggle?: (c: Clip) => void; selectedPath?: string; selectedPaths?: Set<string>;
}) {
  const { t } = useTranslation("derush");
  const isOpen = !collapsed.has(path);
  const pad = depth * 14 + 4;
  const sub = { collapsed, toggle, lib, folderByPath, onPick, onToggle, selectedPath, selectedPaths };
  const empty = node.clips.length === 0 && node.children.size === 0;
  return (
    <div>
      {lib ? (
        <LibFolderRow
          node={node} depth={depth} isOpen={isOpen} toggle={() => toggle(path)}
          folder={folderByPath?.get(path) ?? null}
        />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger render={
            <button type="button" onClick={() => toggle(path)}
              style={{ paddingLeft: pad }}
              className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-sm text-foreground hover:bg-accent/60" />
          }>
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{node.name}</span>
            <span className="text-xs text-muted-foreground">{countTreeClips(node)}</span>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            <ContextMenuItem onClick={() => toggle(path)}>
              <FolderOpen /> {isOpen ? t("shared.collapseFolder") : t("shared.expandFolder")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {isOpen && (
        <div className="mt-2 space-y-3" style={{ paddingLeft: pad + 18 }}>
          {/* Dossier vide : on l'AFFICHE (il vient d'être créé, le masquer donnerait l'impression
              d'un bug) et il reste une cible de dépôt valide. */}
          {lib && empty && <p className="py-1 text-xs text-muted-foreground">{t("library.dropHere")}</p>}
          {node.clips.length > 0 && <ClipGrid clips={node.clips} onPick={onPick} onToggle={onToggle} selectedPath={selectedPath} selectedPaths={selectedPaths} />}
          {[...node.children.values()].map((child) => (
            <FolderView key={child.name} node={child} path={`${path}/${child.name}`} depth={depth + 1} {...sub} />
          ))}
        </div>
      )}
    </div>
  );
}

// onPick = sélection simple ; onToggle + selectedPaths = multi-sélection (cases). Sinon clic = ouvrir.
// flat = ignore l'arbre de dossiers → une seule grille à plat (bascule « Dossiers »).
export function MediaTree({ clips, flat, onPick, onToggle, selectedPath, selectedPaths }:
  { clips: Clip[]; flat?: boolean; onPick?: (c: Clip) => void; onToggle?: (c: Clip) => void; selectedPath?: string; selectedPaths?: Set<string> }) {
  const { t } = useTranslation("derush");
  const local = useMemo(() => clips.filter((c) => c.source === "local"), [clips]);
  const pool = useMemo(() => clips.filter((c) => c.source !== "local"), [clips]);
  const folders = useApp((s) => s.libraryFolders);
  const offlineCount = useApp((s) => s.libraryOffline.size);
  const libraryFocus = useApp((s) => s.libraryFocus);
  const libItemCount = useApp((s) => s.libraryItems.length);
  // Chemin d'arbre → dossier, pour que chaque rangée sache quel dossier elle manipule. Sans ambiguïté
  // possible : le core refuse les « / » dans un nom et les homonymes entre frères.
  const folderPaths = useMemo(() => folders.map((f) => folderPath(folders, f.id)), [folders]);
  const folderByPath = useMemo(
    () => new Map(folders.map((f, i) => [folderPaths[i], f])),
    [folders, folderPaths],
  );
  // Les rushs importés passent par le MÊME buildTree que les bins (leur `bin` porte déjà
  // « Importés/Anime/OP »), mais ensemencé des dossiers pour que les vides existent aussi.
  const libTree = useMemo(() => buildClipTree(local, [LIB_ROOT, ...folderPaths]), [local, folderPaths]);
  const tree = useMemo(() => buildClipTree(pool), [pool]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const fv = { onPick, onToggle, selectedPath, selectedPaths };
  const libRoot = libTree.children.get(LIB_ROOT);

  // Une puce de l'accueil a demandé un dossier → on le déplie (lui et ses ancêtres).
  useEffect(() => {
    if (!libraryFocus) return;
    setCollapsed((s) => {
      const n = new Set(s);
      const parts = libraryFocus.split("/");
      for (let i = 1; i <= parts.length; i++) n.delete(parts.slice(0, i).join("/"));
      return n;
    });
  }, [libraryFocus]);

  // Mode à plat : toutes les vidéos (importées + Media Pool) dans une seule grille, sans dossiers.
  if (flat) return <ClipGrid clips={clips} {...fv} />;

  return (
    <div className="space-y-3">
      {/* Dès UN rush hors ligne : c'est le seul point d'entrée vers la relocalisation, le masquer
          rendrait une entrée isolée irréparable. */}
      {offlineCount > 0 && <OfflineBanner count={offlineCount} />}
      {/* Bibliothèque en tête, toujours : elle survit à la fermeture du logiciel de montage, les bins
          non. Rien ne l'annonce — sa seule présence suffit. */}
      {libRoot && (libItemCount > 0 || folders.length > 0) && (
        <FolderView node={{ ...libRoot, name: t("library.rootName") }} path={LIB_ROOT} depth={0} collapsed={collapsed} toggle={toggle} lib folderByPath={folderByPath} {...fv} />
      )}
      {tree.clips.length > 0 && <ClipGrid clips={tree.clips} {...fv} />}
      {[...tree.children.values()].map((node) => (
        <FolderView key={node.name} node={node} path={node.name} depth={0} collapsed={collapsed} toggle={toggle} {...fv} />
      ))}
    </div>
  );
}
