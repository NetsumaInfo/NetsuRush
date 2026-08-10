// Carte d'un rush (vignette + nom + métas) et sa vignette. Extraits de MediaTree où ils étaient
// privés au module : la bande « récents » de l'accueil en a besoin aussi, et dupliquer une seconde
// carte aurait fait diverger les deux au premier ajustement.
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, HardDriveDownload, Clapperboard, Scissors, CheckSquare, Folder, FolderInput, Images, Trash2, Unlink } from "lucide-react";
import { cn, basename } from "@/lib/utils";
import { selectionRing, SelectCheck } from "@/components/common/selectable";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuLabel, ContextMenuGroup } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/store";
import { nr, type Clip } from "@/lib/bridge";
import { getThumb, setThumb } from "@/lib/thumbCache";
import { hostImport } from "@/lib/host";
import { sendPathToBoard } from "@/components/reference/boardActions";
import { folderTrail } from "./libraryShared";
import { TimelineSendDialog } from "./TimelineSendDialog";

// Type MIME du glisser interne d'un rush vers un dossier de bibliothèque. Le DnD HTML5 fonctionne
// parce que la fenêtre est en dragDropEnabled:false ; les fichiers lâchés depuis l'Explorateur
// arrivent donc en drop HTML5 normal, et leur chemin disque se résout via nr.pathsForFiles.
export const CLIP_DND = "text/nr-clip";

function Thumb({ path, dim }: { path: string; dim?: boolean }) {
  const [src, setSrc] = useState<string | null>(() => getThumb(path));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const cached = getThumb(path);
    if (cached) { setSrc(cached); return; }   // déjà en cache renderer → instantané, pas d'IPC
    let alive = true;
    nr.thumbnail(path)
      .then((r) => {
        if (!alive) return;
        if (typeof r === "string") { const u = nr.mediaUrl(r); setThumb(path, u); setSrc(u); } else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [path]);
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted">
      {src ? <img src={src} alt="" draggable={false} className={cn("h-full w-full select-none object-cover", dim && "opacity-40")} />
        : failed ? <Film className="h-7 w-7 text-muted-foreground" />
        : <Skeleton className="absolute inset-0 rounded-none" />}
    </div>
  );
}

type ClipCardProps = { clip: Clip; onPick?: (c: Clip) => void; onToggle?: (c: Clip) => void; selectedPath?: string; selectedPaths?: Set<string> };

// Mode picker : onPick (sélection simple) ou onToggle (multi, cases) → clic ne sélectionne pas
// (pas d'ouverture CutStudio ni bouton Timeline).
function ClipCardImpl({ clip, onPick, onToggle, selectedPath, selectedPaths }: ClipCardProps) {
  const { t } = useTranslation("derush");
  const open = useApp((s) => s.open);
  const connected = useApp((s) => s.connected);
  const activeHost = useApp((s) => s.activeHost);
  const offline = useApp((s) => s.libraryOffline.has(clip.path));
  const folders = useApp((s) => s.libraryFolders);
  const moveLibraryItem = useApp((s) => s.moveLibraryItem);
  const removeLibraryItem = useApp((s) => s.removeLibraryItem);
  const removeLibraryItems = useApp((s) => s.removeLibraryItems);
  // La carte reçoit un Clip (pas d'id) ; l'entrée de bibliothèque se retrouve par chemin. Le `find`
  // vit dans un useMemo et NON dans le sélecteur : un sélecteur re-tourne à CHAQUE set() du store, quelle
  // que soit la slice — la recherche coûterait N cartes × M entrées à chaque tick de progression d'une
  // découpe en lot. Ici le sélecteur ne rend qu'une ref de tableau stable.
  const libraryItems = useApp((s) => s.libraryItems);
  const item = useMemo(
    () => (clip.source === "local" ? libraryItems.find((i) => i.path === clip.path) : undefined),
    [libraryItems, clip.source, clip.path],
  );
  const [picker, setPicker] = useState(false);
  const picking = !!onPick || !!onToggle;
  const selected = onToggle ? !!selectedPaths?.has(clip.path) : (!!onPick && selectedPath === clip.path);
  const act = () => (onToggle ? onToggle(clip) : onPick ? onPick(clip) : open(clip));
  // Envoi-vers-timeline : seulement les rush du Media Pool (les "local" n'y sont pas).
  // Pas de drag : Resolve refuse les fichiers déposés sur la timeline (seul le Media Pool les
  // accepte) → on passe par l'API (bouton), qui ouvre le choix découpe/destination/nom.
  const canSend = !picking && connected && clip.source !== "local";
  const isLib = clip.source === "local" && !!item;
  // Retrait EN LOT quand on fait un clic droit sur une carte qui fait partie de la multi-sélection.
  // La sélection est une liste de CHEMINS ; seuls ceux qui ont une entrée de bibliothèque comptent
  // (un rush du Media Pool n'en a pas — rien à en retirer).
  const bulkIds = useMemo(() => {
    if (!selectedPaths?.size || !selectedPaths.has(clip.path)) return [];
    return libraryItems.filter((i) => selectedPaths.has(i.path)).map((i) => i.id);
  }, [selectedPaths, libraryItems, clip.path]);
  const bulk = bulkIds.length > 1;
  const folderOpts = useMemo(
    () => folders.map((f) => ({ id: f.id, label: folderTrail(folders, f.id).map((x) => x.name).join(" / ") })),
    [folders],
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={
          <div
            role="button"
            tabIndex={0}
            draggable={isLib}
            onDragStart={(e) => { if (item) { e.dataTransfer.setData(CLIP_DND, item.id); e.dataTransfer.effectAllowed = "move"; } }}
            onClick={act}
            // Garde identique à celui de MediaTree : la carte contient un <button> (envoi timeline).
            // Sans ça, Entrée dessus ouvrait CutStudio au lieu du dialogue.
            onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } }}
            className={cn(
              "group block cursor-pointer select-none overflow-hidden rounded-xl border bg-card text-left transition-transform hover:-translate-y-0.5 hover:border-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              selectionRing(selected),
            )} />
        }>
        <div className="relative">
          <Thumb path={clip.path} dim={offline} />
          {selected && <SelectCheck />}
          {/* Fichier disparu : vignette éteinte + étiquette discrète. Pas de carte rouge saturée —
              un état inactif ne mérite pas de crier ; et quand tout un disque saute, c'est le bandeau
              de l'arbre qui prend le relais (200 badges = bruit). */}
          {offline && (
            <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              <Unlink className="h-3 w-3" /> {t("library.offlineBadge")}
            </span>
          )}
          {/* Ouvre le choix : découpe en cache (modèle au choix) ou rush entier, vers une nouvelle
              timeline ou celle ouverte, avec un nom. Tout via l'API (sans rien écraser). */}
          {canSend && (
            <Tooltip>
              <TooltipTrigger render={<button
                type="button"
                aria-label={t("mediaTree.sendToTimeline")}
                onClick={(e) => { e.stopPropagation(); setPicker(true); }}
                className="absolute right-1.5 top-1.5 flex items-center rounded-md bg-black/75 p-1.5 text-white opacity-0 transition-all hover:bg-primary group-hover:opacity-100" />}>
                <Clapperboard className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("mediaTree.sendToTimeline")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="space-y-0.5 p-2">
          <div className="flex items-center gap-1.5">
            {clip.source === "local" && <HardDriveDownload className="h-3 w-3 shrink-0 text-primary" />}
            <Tooltip>
              <TooltipTrigger render={<div className="truncate text-sm font-medium" />}>
                {clip.name}
              </TooltipTrigger>
              <TooltipContent>{clip.name}</TooltipContent>
            </Tooltip>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[clip.resolution, clip.duration].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        </ContextMenuTrigger>
        {/* Clic droit : mêmes actions que la carte (ouvrir / choisir / (dé)sélectionner / timeline). */}
        <ContextMenuContent className="min-w-48">
          {!picking && <ContextMenuItem onClick={() => open(clip)}><Scissors /> {t("mediaTree.openInDerush")}</ContextMenuItem>}
          {onPick && <ContextMenuItem onClick={() => onPick(clip)}><CheckSquare /> {t("mediaTree.pickRush")}</ContextMenuItem>}
          {onToggle && (
            <ContextMenuItem onClick={() => onToggle(clip)}>
              <CheckSquare /> {selected ? t("shared.deselect") : t("shared.select")}
            </ContextMenuItem>
          )}
          {canSend && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setPicker(true)}><Clapperboard /> {t("mediaTree.sendToTimeline")}</ContextMenuItem>
            </>
          )}
          {isLib && (
            <>
              <ContextMenuSeparator />
              {/* Envoi ponctuel vers le Media Pool de l'hôte ACTIF : la bibliothèque ne passe plus par
                  le projet à l'import, mais on garde la passerelle à la demande. */}
              {connected && (
                <ContextMenuItem onClick={() => void hostImport(activeHost, [clip.path])}>
                  <HardDriveDownload /> {t("library.addToPool")}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => void sendPathToBoard(clip.path, basename(clip.path))}>
                <Images /> {t("library.sendToBoard")}
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger><FolderInput /> {t("library.moveTo")}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {/* Label DANS un Group : Base UI le rattache au contexte de groupe, sinon il jette
                      (« MenuGroupContext is missing ») et le sous-menu ne s'ouvre pas. */}
                  <ContextMenuGroup>
                    <ContextMenuLabel>{t("library.moveTo")}</ContextMenuLabel>
                    <ContextMenuItem disabled={item!.folderId === null} onClick={() => void moveLibraryItem(item!.id, null)}>
                      {t("library.rootName")}
                    </ContextMenuItem>
                    {folderOpts.map((f) => (
                      <ContextMenuItem key={f.id} disabled={item!.folderId === f.id} onClick={() => void moveLibraryItem(item!.id, f.id)}>
                        <Folder className="size-3.5" /> {f.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              {/* Retire l'entrée, jamais le fichier : la bibliothèque n'est qu'un index de chemins. */}
              <ContextMenuItem
                variant="destructive"
                onClick={() => void (bulk ? removeLibraryItems(bulkIds) : removeLibraryItem(item!.id))}
              >
                <Trash2 /> {bulk ? t("library.removeManyFromLibrary", { count: bulkIds.length }) : t("library.removeFromLibrary")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {/* Hors du <div onClick> : Base UI portale le DOM mais l'event React remonterait l'arbre
          → un clic dans la modale rouvrirait le clip (CutStudio). En frère, plus de fuite. */}
      {picker && <TimelineSendDialog clip={clip} onClose={() => setPicker(false)} />}
    </>
  );
}

// Mémoïsé : un toggle de sélection re-rend la grille entière, or chaque carte coûte cher (abonnements
// store + menus + tooltips + bulkIds sur libraryItems). On ne re-rend que la carte dont l'appartenance
// à la sélection change — plus les cartes SÉLECTIONNÉES à chaque évolution du Set (leur clic droit
// « retirer N » se calcule dessus, il doit rester frais). Les callbacks (recréés à chaque rendu parent,
// sémantique stable via setState fonctionnel) sont volontairement ignorés.
const isSelected = (p: ClipCardProps) =>
  p.onToggle ? !!p.selectedPaths?.has(p.clip.path) : !!p.onPick && p.selectedPath === p.clip.path;

export const ClipCard = memo(ClipCardImpl, (a, b) => {
  if (a.clip !== b.clip || !!a.onPick !== !!b.onPick || !!a.onToggle !== !!b.onToggle) return false;
  const sa = isSelected(a), sb = isSelected(b);
  if (sa !== sb) return false;
  return !sb || a.selectedPaths === b.selectedPaths;
});

export function ClipGrid({ clips, onPick, onToggle, selectedPath, selectedPaths }:
  { clips: Clip[]; onPick?: (c: Clip) => void; onToggle?: (c: Clip) => void; selectedPath?: string; selectedPaths?: Set<string> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      {clips.map((c, i) => <ClipCard key={`${c.path}-${i}`} clip={c} onPick={onPick} onToggle={onToggle} selectedPath={selectedPath} selectedPaths={selectedPaths} />)}
    </div>
  );
}
