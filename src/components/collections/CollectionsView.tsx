// Onglet Collections : navigateur de DOSSIERS (hiérarchie) + collections rangées dedans ↔ détail.
// Modes d'affichage (Galerie mosaïque / Grille / Compact — plus de « Liste ») + tri + filtre par
// GROUPES (tags de collection). Cartes enrichies : mini description + tags. Créer/ranger/déplacer.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  Plus, Pencil, Trash2, Library, Search, ArrowDownUp, Images, LayoutGrid, Grid3x3,
  FolderPlus, Folder, ChevronRight, FolderInput, MoreVertical, Eye, Star,
} from "lucide-react";
import { useApp } from "@/store";
import { nr, type CollectionMeta, type CollectionPreviewShot } from "@/lib/bridge";
import { getThumb, setThumb } from "@/lib/thumbCache";
import { cn } from "@/lib/utils";
import { hoverLiftLayer, hoverLiftFlow } from "@/components/common/hoverLift";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
  DropdownMenuGroup, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { ArchiveBadge, useArchiveQueue } from "./archiveRows";
import { CollectionGlyph } from "./collectionGlyph";
import { FolderEditor } from "./FolderEditor";
import { CollectionDetail } from "./CollectionDetail";
import { FolderNameDialog } from "./FolderNameDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  sortCollections, loadListView, saveListView, loadListSort, saveListSort, folderTrail, childFolders,
  labelColor, loadCollDisplay, saveCollDisplay, loadCollFavs, saveCollFavs,
  LIST_SORT_KEYS, LIST_SORT_LABELS, type CollListView, type CollListSort, type CollDisplay,
} from "./collectionShared";

// Côté de la vignette posée en coin d'une carte Galerie.
const GLYPH_BADGE = 22;
// Côté de la vignette au centre d'une carte, par mode d'affichage : l'image est l'identité visuelle
// d'une collection, elle doit dominer la carte (le nom tient sur une ligne dessous).
const GLYPH_SIZE: Record<CollListView, number> = { gallery: 76, grid: 80, compact: 52 };
// Côté de la vignette d'un dossier dans la bande des sous-dossiers.
const FOLDER_GLYPH = 26;
const VIEW_ICON: Record<CollListView, typeof LayoutGrid> = { gallery: Images, grid: LayoutGrid, compact: Grid3x3 };
// Valeurs = clés i18n (ns « collections ») résolues au rendu.
const VIEW_LABEL: Record<CollListView, string> = { gallery: "view.gallery", grid: "view.grid", compact: "view.compact" };

// Une vignette de la mosaïque (frame du plan à `in`). Cache renderer → resservie sync au re-montage.
function MosaicThumb({ shot }: { shot: CollectionPreviewShot }) {
  const [src, setSrc] = useState<string | null>(() => getThumb(shot.path, shot.in));
  useEffect(() => {
    const cached = getThumb(shot.path, shot.in);
    if (cached) { setSrc(cached); return; }
    let alive = true;
    nr.thumbnail(shot.path, shot.in)
      .then((r) => { if (alive && typeof r === "string") { const u = nr.assetUrl(r); setThumb(shot.path, u, shot.in); setSrc(u); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [shot.path, shot.in]);
  return src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : <div className="h-full w-full bg-muted" />;
}

// Mosaïque d'aperçu d'un dossier : jusqu'à 4 frames des plans dedans (vue Galerie).
function CollectionMosaic({ preview }: { preview: CollectionPreviewShot[] }) {
  const cells = preview.slice(0, 4);
  return (
    <div className={cn("grid h-full w-full gap-px", cells.length <= 1 ? "grid-cols-1" : "grid-cols-2")}>
      {cells.map((s, i) => (
        <div key={`${s.path}-${s.in}-${i}`} className="overflow-hidden bg-muted"><MosaicThumb shot={s} /></div>
      ))}
    </div>
  );
}

// Résumé du contenu d'une collection sur la carte : pastilles de couleur (labels des plans) + tags.
// Chaque partie est masquable via les préférences d'affichage.
function CardSummary({ c, display, max = 4, center }: { c: CollectionMeta; display: CollDisplay; max?: number; center?: boolean }) {
  const labels = display.labels ? (c.labels ?? []) : [];
  const tags = display.tags ? (c.collTags?.length ? c.collTags : c.tags ?? []) : [];
  if (!labels.length && !tags.length) return null;
  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-1", center && "justify-center")}>
      {labels.map((id) => {
        const col = labelColor(id);
        return col ? <span key={id} className="size-2.5 rounded-full ring-1 ring-black/20" style={{ background: col }} /> : null;
      })}
      {tags.slice(0, max).map((t) => <span key={t} className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}
      {tags.length > max && <span className="px-0.5 text-[10px] text-muted-foreground">+{tags.length - max}</span>}
    </div>
  );
}

export function CollectionsView() {
  const { t: tr } = useTranslation(["collections", "common"]);
  const s = useApp(
    useShallow((st) => ({
      collections: st.collections, collectionsLoading: st.collectionsLoading,
      collectionsView: st.collectionsView, currentCollectionId: st.currentCollectionId,
      folders: st.collectionFolders, currentFolderId: st.currentFolderId,
      loadCollections: st.loadCollections, loadCollectionFolders: st.loadCollectionFolders,
      openCollection: st.openCollection, deleteCollection: st.deleteCollection,
      setCollectionFolder: st.setCollectionFolder, saveCollectionFolder: st.saveCollectionFolder,
      deleteCollectionFolder: st.deleteCollectionFolder, moveCollection: st.moveCollection,
    })),
  );

  const [editing, setEditing] = useState<CollectionMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [folderDialog, setFolderDialog] = useState<{ id?: string; name: string } | null>(null);
  // Confirmation in-app (window.confirm interdit sous Tauri).
  const [confirmState, setConfirmState] = useState<{ title: string; description?: string; onConfirm: () => void } | null>(null);
  const [q, setQ] = useState("");
  const [view, setViewState] = useState<CollListView>(loadListView);
  const [sort, setSortState] = useState<CollListSort>(loadListSort);
  const [display, setDisplayState] = useState<CollDisplay>(loadCollDisplay);
  const [favs, setFavs] = useState<string[]>(loadCollFavs);
  const setView = (v: CollListView) => { setViewState(v); saveListView(v); };
  const setSort = (v: CollListSort) => { setSortState(v); saveListSort(v); };
  const setDisplay = (patch: Partial<CollDisplay>) => setDisplayState((d) => { const n = { ...d, ...patch }; saveCollDisplay(n); return n; });
  const toggleFav = (id: string) => setFavs((f) => { const n = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]; saveCollFavs(n); return n; });

  useEffect(() => { void s.loadCollections(); void s.loadCollectionFolders(); }, [s.loadCollections, s.loadCollectionFolders]);
  // Un archivage différé travaille sans rien ouvrir : la carte du dossier est le seul endroit où
  // l'utilisateur peut le voir arriver.
  const queued = useArchiveQueue();

  const trail = useMemo(() => folderTrail(s.folders, s.currentFolderId), [s.folders, s.currentFolderId]);
  const subfolders = useMemo(() => childFolders(s.folders, s.currentFolderId), [s.folders, s.currentFolderId]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const inFolder = s.collections.filter((c) => (c.folderId ?? null) === s.currentFolderId);
    const filtered = inFolder.filter((c) => {
      if (needle && !c.name.toLowerCase().includes(needle) && !(c.description ?? "").toLowerCase().includes(needle) && !(c.collTags ?? []).some((t) => t.toLowerCase().includes(needle))) return false;
      return true;
    });
    return sortCollections(filtered, sort);
  }, [s.collections, s.currentFolderId, q, sort]);

  if (s.collectionsView === "detail" && s.currentCollectionId) {
    return <CollectionDetail id={s.currentCollectionId} />;
  }

  const glyphSize = GLYPH_SIZE[view];
  const gridCls =
    view === "gallery" ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    : view === "compact" ? "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
    : "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

  // Menu d'une carte : modifier / déplacer vers un dossier / supprimer.
  const cardMenu = (c: CollectionMeta) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" aria-label={tr("list.actions")} onClick={(e) => e.stopPropagation()}
        className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100" />}>
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => setEditing(c)}><Pencil className="size-3.5" /> {tr("common:action.edit")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => toggleFav(c.id)}>
          <Star className={cn("size-3.5", favs.includes(c.id) && "fill-amber-400 text-amber-400")} /> {favs.includes(c.id) ? tr("fav.remove") : tr("fav.add")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{tr("list.moveTo")}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void s.moveCollection(c.id, null)} disabled={(c.folderId ?? null) === null}>{tr("folder.root")}</DropdownMenuItem>
          {s.folders.map((f) => (
            <DropdownMenuItem key={f.id} onClick={() => void s.moveCollection(c.id, f.id)} disabled={c.folderId === f.id}>
              <Folder className="size-3.5" /> {folderTrail(s.folders, f.id).map((x) => x.name).join(" / ")}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => setConfirmState({ title: tr("list.deleteCollTitle", { name: c.name }), description: tr("list.deleteCollDesc"), onConfirm: () => void s.deleteCollection(c.id) })}>
          <Trash2 className="size-3.5" /> {tr("common:action.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Clic droit sur la carte : mêmes actions que le menu ⋮ (Ouvrir en tête).
  const cardCtxMenu = (c: CollectionMeta) => (
    <ContextMenuContent className="min-w-48">
      <ContextMenuItem onClick={() => s.openCollection(c.id)}><Eye className="size-3.5" /> {tr("common:action.open")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => setEditing(c)}><Pencil className="size-3.5" /> {tr("common:action.edit")}</ContextMenuItem>
      <ContextMenuItem onClick={() => toggleFav(c.id)}>
        <Star className={cn("size-3.5", favs.includes(c.id) && "fill-amber-400 text-amber-400")} /> {favs.includes(c.id) ? tr("fav.remove") : tr("fav.add")}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger><FolderInput className="size-3.5" /> {tr("list.moveTo")}</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => void s.moveCollection(c.id, null)} disabled={(c.folderId ?? null) === null}>{tr("folder.root")}</ContextMenuItem>
          {s.folders.map((f) => (
            <ContextMenuItem key={f.id} onClick={() => void s.moveCollection(c.id, f.id)} disabled={c.folderId === f.id}>
              <Folder className="size-3.5" /> {folderTrail(s.folders, f.id).map((x) => x.name).join(" / ")}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => setConfirmState({ title: tr("list.deleteCollTitle", { name: c.name }), description: tr("list.deleteCollDesc"), onConfirm: () => void s.deleteCollection(c.id) })}>
        <Trash2 className="size-3.5" /> {tr("common:action.delete")}
      </ContextMenuItem>
    </ContextMenuContent>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2">
        <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h1 className="text-[13px] font-medium">{tr("list.title")}</h1>
        <span className="text-[11px] text-muted-foreground">{s.collections.length || "—"}</span>
        <div className="relative ml-2 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("list.searchPlaceholder")} className="h-8 pl-8" />
        </div>
        <div className="flex-1" />
        {s.collectionsLoading && <Spinner className="size-4" />}
        <Tooltip>
          <TooltipTrigger render={<button type="button" aria-label={tr("folder.new")} onClick={() => setFolderDialog({ name: "" })}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground" />}>
            <FolderPlus className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{tr("list.newFolderHint")}</TooltipContent>
        </Tooltip>
        <Select value={sort} onValueChange={(v) => setSort(v as CollListSort)}>
          <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label={tr("list.sortColls")}>
            <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIST_SORT_KEYS.map((k) => <SelectItem key={k} value={k}>{tr(LIST_SORT_LABELS[k])}</SelectItem>)}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" aria-label={tr("list.cardInfo")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground" />}>
            <Eye className="size-3.5" /> {tr("list.display")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{tr("list.showOnCards")}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={display.labels} onCheckedChange={(v) => setDisplay({ labels: !!v })}>{tr("list.colorDots")}</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={display.tags} onCheckedChange={(v) => setDisplay({ tags: !!v })}>{tr("list.tags")}</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={display.description} onCheckedChange={(v) => setDisplay({ description: !!v })}>{tr("list.description")}</DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToggleGroup value={[view]} onValueChange={(v) => { const n = v[0] as CollListView | undefined; if (n) setView(n); }} spacing={0} variant="outline" size="sm">
          {(Object.keys(VIEW_ICON) as CollListView[]).map((v) => {
            const Icon = VIEW_ICON[v];
            return (
              <Tooltip key={v}>
                <TooltipTrigger render={<ToggleGroupItem value={v} aria-label={tr(VIEW_LABEL[v])} className="px-2 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary" />}>
                  <Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>{tr(VIEW_LABEL[v])}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </div>

      {/* Fil d'Ariane des dossiers */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <button type="button" onClick={() => s.setCollectionFolder(null)} className={cn("rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground", !s.currentFolderId && "text-foreground")}>{tr("list.all")}</button>
        {trail.map((f) => (
          <span key={f.id} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            <button type="button" onClick={() => s.setCollectionFolder(f.id)} className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">{f.name}</button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Sous-dossiers du dossier courant */}
        {subfolders.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {subfolders.map((f) => (
              <ContextMenu key={f.id}>
                <ContextMenuTrigger render={
                  <div role="button" tabIndex={0}
                    onClick={() => s.setCollectionFolder(f.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.setCollectionFolder(f.id); } }}
                    className="group relative flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/50 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
                }>
                  <span
                    className="flex shrink-0 items-center justify-center text-primary"
                    style={{
                      width: FOLDER_GLYPH, height: FOLDER_GLYPH, borderRadius: FOLDER_GLYPH * 0.28,
                      background: "color-mix(in srgb, var(--color-primary) 18%, transparent)",
                    }}
                  >
                    <Folder style={{ width: FOLDER_GLYPH * 0.55, height: FOLDER_GLYPH * 0.55 }} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button type="button" aria-label={tr("list.folderActions")} onClick={(e) => e.stopPropagation()}
                      className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100" />}>
                      <MoreVertical className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => setFolderDialog({ id: f.id, name: f.name })}><Pencil className="size-3.5" /> {tr("common:action.rename")}</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmState({ title: tr("list.deleteFolderTitle", { name: f.name }), description: tr("list.deleteFolderDesc"), onConfirm: () => void s.deleteCollectionFolder(f.id) })}>
                        <Trash2 className="size-3.5" /> {tr("common:action.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-44">
                  <ContextMenuItem onClick={() => s.setCollectionFolder(f.id)}><Folder className="size-3.5" /> {tr("common:action.open")}</ContextMenuItem>
                  <ContextMenuItem onClick={() => setFolderDialog({ id: f.id, name: f.name })}><Pencil className="size-3.5" /> {tr("common:action.rename")}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => setConfirmState({ title: tr("list.deleteFolderTitle", { name: f.name }), description: tr("list.deleteFolderDesc"), onConfirm: () => void s.deleteCollectionFolder(f.id) })}>
                    <Trash2 className="size-3.5" /> {tr("common:action.delete")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        )}

        <div className={gridCls}>
          {/* créer une collection */}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary",
              view === "gallery" ? "aspect-video" : view === "compact" ? "aspect-square" : "aspect-[4/3]")}
          >
            <Plus className={view === "compact" ? "h-5 w-5" : "h-7 w-7"} />
            {view !== "compact" && <span className="text-sm font-medium">{tr("list.newCollection")}</span>}
          </button>

          {shown.map((c) => (
            view === "gallery" ? (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger render={
                  <div role="button" tabIndex={0}
                    onClick={() => s.openCollection(c.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.openCollection(c.id); } }}
                    className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-xl" />
                }>
                  <div className={hoverLiftFlow("relative aspect-video w-full overflow-hidden rounded-xl bg-card ring-1 ring-border transition-all group-hover:ring-primary/40 group-hover:ring-2")}>
                    {c.preview && c.preview.length
                      ? <CollectionMosaic preview={c.preview} />
                      : <div className="flex h-full items-center justify-center"><CollectionGlyph icon={c.icon} color={c.color} size={GLYPH_SIZE.gallery} /></div>}
                    {/* Rayon de la plaque = celui de la vignette (28 % de son côté) + le padding,
                        sinon les angles de l'icône dépassent la plaque. */}
                    <div className="absolute left-1.5 top-1.5 bg-background/70 p-0.5 backdrop-blur-sm" style={{ borderRadius: GLYPH_BADGE * 0.28 + 2 }}>
                      <CollectionGlyph icon={c.icon} color={c.color} size={GLYPH_BADGE} />
                    </div>
                    <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm tabular-nums">
                      <ArchiveBadge archived={c.archived} status={queued.get(c.id)} />{tr("list.plansCount", { count: c.count })}
                    </span>
                    {cardMenu(c)}
                  </div>
                  <div className="mt-1.5 px-0.5">
                    <div className="flex items-center gap-1 text-sm font-medium">
                      {favs.includes(c.id) && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
                      <span className="truncate">{c.name}</span>
                    </div>
                    {display.description && c.description && <div className="truncate text-[11px] text-muted-foreground">{c.description}</div>}
                    <CardSummary c={c} display={display} />
                  </div>
                </ContextMenuTrigger>
                {cardCtxMenu(c)}
              </ContextMenu>
            ) : (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger render={
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => s.openCollection(c.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.openCollection(c.id); } }}
                    // Coquille IMMOBILE : elle reçoit le survol, la couche visuelle se soulève
                    // (cf. common/hoverLift).
                    className={cn("group relative cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                      view === "compact" ? "aspect-square" : "aspect-[4/3]")} />
                }>
                  <div className={hoverLiftLayer("flex flex-col items-center rounded-xl bg-card transition-all",
                    view === "compact" ? "justify-center gap-1.5 p-2" : "justify-center gap-2 p-3")}>
                  <CollectionGlyph icon={c.icon} color={c.color} size={glyphSize} />
                  <div className="min-w-0 max-w-full text-center">
                    <div className={cn("flex items-center justify-center gap-1 font-medium", view === "compact" ? "text-[11px]" : "text-sm")}>
                      {favs.includes(c.id) && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
                      <span className="truncate">{c.name}</span>
                    </div>
                    {view !== "compact" && (
                      <>
                        <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                          <ArchiveBadge archived={c.archived} status={queued.get(c.id)} />{tr("list.plansCount", { count: c.count })}
                        </div>
                        {display.description && c.description && <div className="truncate text-[11px] text-muted-foreground">{c.description}</div>}
                      </>
                    )}
                  </div>
                  {view !== "compact" && <CardSummary c={c} display={display} max={3} center />}
                  {cardMenu(c)}
                  </div>
                </ContextMenuTrigger>
                {cardCtxMenu(c)}
              </ContextMenu>
            )
          ))}

          {/* Chargement initial → skeletons. */}
          {s.collectionsLoading && !s.collections.length &&
            Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className={view === "compact" ? "aspect-square rounded-xl" : view === "gallery" ? "aspect-video rounded-xl" : "aspect-[4/3] rounded-xl"} />
            ))}
        </div>

        {!s.collectionsLoading && !s.collections.length && (
          <Card className="mt-4 p-6 text-sm text-muted-foreground">
            {tr("list.emptyAll")}
          </Card>
        )}
        {!s.collectionsLoading && s.collections.length > 0 && shown.length === 0 && subfolders.length === 0 && (
          <Card className="mt-4 flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <FolderInput className="size-4" /> {tr("list.folderEmpty")}{q ? tr("list.folderEmptyFilter") : ""}.
          </Card>
        )}

        <FolderEditor open={creating} onOpenChange={setCreating} />
        <FolderEditor open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }} editing={editing} />
        <FolderNameDialog
          open={!!folderDialog}
          initial={folderDialog?.name ?? ""}
          title={folderDialog?.id ? tr("folder.renameTitle") : tr("folder.new")}
          onCancel={() => setFolderDialog(null)}
          onSubmit={async (name) => { await s.saveCollectionFolder({ id: folderDialog?.id, name, parentId: folderDialog?.id ? undefined : s.currentFolderId }); setFolderDialog(null); }}
        />
        <ConfirmDialog
          open={!!confirmState}
          onOpenChange={(v) => { if (!v) setConfirmState(null); }}
          title={confirmState?.title ?? ""}
          description={confirmState?.description}
          onConfirm={() => confirmState?.onConfirm()}
        />
      </div>
    </div>
  );
}
