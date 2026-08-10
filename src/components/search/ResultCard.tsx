import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Film, Play, ScanSearch, Plus, Aperture, Clapperboard, UserCheck, Images, CheckSquare, Copy } from "lucide-react";
import { type SearchHit } from "@/lib/bridge";
import { Skeleton } from "@/components/ui/skeleton";
import { useResultPreview } from "@/components/search/useResultPreview";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { AddToCollection } from "@/components/collections/AddToCollection";
import { CollectionSubmenu } from "@/components/collections/CollectionSubmenu";
import { cn, basename, thumbTime } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { selectionRing, SelectToggle } from "@/components/common/selectable";

function tc(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const b = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${b}` : b;
}

// Carte de résultat (qualité grille derush) : vignette du cache PARTAGÉ avec le découpage → aperçu
// proxy HEVC au survol ou « Tout lire ». Sélection + ajout à la timeline ouverte (append).
function ResultCardImpl({
  hit, index, selected, play, onToggle, onDownload, getProxy, bustProxy,
  onFindSimilar, onAddRef, refActive, confirmChar, onConfirmChar, onSendBoard,
}: {
  hit: SearchHit;
  index: number;
  selected: boolean;
  play: boolean;
  onToggle: () => void;
  onDownload: () => void;       // ajoute ce plan à la timeline ouverte (mode append, frame-accurate)
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  // Reçoivent la vignette AFFICHÉE : le bac de références montre exactement l'image cliquée, et
  // la carte est le seul endroit qui la connaisse (le backend ne renvoie plus d'image).
  onFindSimilar?: (thumb: string | null) => void;
  onAddRef?: (thumb: string | null) => void;
  refActive?: boolean;          // ce plan est déjà dans le bac de références
  confirmChar?: string;         // recherche par personnage : nom pour « c'est bien lui »
  onConfirmChar?: () => void;   // confirme → le visage devient un échantillon du perso
  onSendBoard?: () => void;     // envoie le rush au board de référence
}) {
  const { t } = useTranslation("search");
  // MÊME instant que la grille de plans → même entrée de cache, donc la même image sur le disque.
  const thumbAt = thumbTime(hit.start_sec, hit.end_sec);
  // Plan sérialisé pour « Ranger dans une collection » (identique au bouton du pied).
  const shots = [{ path: hit.file_path, name: basename(hit.file_path), in: hit.start_sec, out: hit.end_sec, inFrame: hit.start_frame, outFrame: hit.end_frame, srcFrames: hit.src_frames, fps: hit.fps }];

  const { rootRef, thumb, thumbErr, hovered, setHovered, url, showVideo, videoPaused, near, resetUrl } =
    useResultPreview({ filePath: hit.file_path, thumbAt, index, play, getProxy, bustProxy });
  const playing = showVideo && !videoPaused;

  function onVideoError() { bustProxy(); resetUrl(); }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={
        <div
          ref={rootRef}
          className={cn(
            "group flex flex-col overflow-hidden rounded-xl border bg-card transition-transform [content-visibility:auto] [contain-intrinsic-size:auto_240px]",
            selectionRing(selected),
          )}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        />
      }>
      <div className="relative aspect-video bg-muted">
        {!thumb && !thumbErr && <Skeleton className="absolute inset-0 rounded-none" />}
        {thumb && <img src={thumb} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
        {thumbErr && !thumb && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Film className="h-7 w-7 opacity-40" />
          </div>
        )}
        {showVideo && (
          <PreviewVideo
            url={url!}
            label={t("resultCard.previewAria")}
            onError={onVideoError}
            audible={hovered}
            paused={videoPaused}
            className="absolute inset-0 h-full w-full bg-black object-cover"
          />
        )}
        {!playing && (
          <Play className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-90" />
        )}

        {/* case de sélection (toujours visible si cochée, sinon au survol) — coin haut-gauche
            car le haut-droite porte déjà le timecode. Cochée, elle est visible : jamais différée. */}
        {(near || selected) && <SelectToggle selected={selected} onToggle={onToggle} className="left-2 top-2 right-auto" />}

        {/* Pastilles en `nr-chip` (fond opaque), JAMAIS en `backdrop-blur` : un backdrop-filter
            posé sur une <video> qui joue force le compositeur à recopier et flouter le fond à
            CHAQUE image décodée, pour chaque carte. Avec une grille en lecture auto c'était le
            premier poste de coût du défilement. */}
        <span className="nr-chip absolute bottom-2 left-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white">
          {tc(hit.start_sec)}
        </span>
        <span className="nr-chip absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white">
          {Math.round(hit.score * 100)}%
        </span>
        {hit.char && (
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white"
            style={{ background: hit.char.color || "rgba(0,0,0,.8)" }}>
            {hit.char.name}
          </span>
        )}
        {hit.aesthetic != null && hit.aesthetic < 0 && (
          near ? (
            <Tooltip>
              <TooltipTrigger render={<span className="nr-chip absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn)]" />}>
                <Aperture className="h-3 w-3" /> {t("resultCard.blurry")}
              </TooltipTrigger>
              <TooltipContent>{t("resultCard.blurryTooltip")}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="nr-chip absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn)]">
              <Aperture className="h-3 w-3" /> {t("resultCard.blurry")}
            </span>
          )
        )}
      </div>

      {/* Pied compact : nom pleine largeur (1 ligne) ; les actions n'apparaissent qu'au survol,
          en OVERLAY (fondu gauche) → zéro troncature du nom au repos, zéro décalage de layout.
          Le pied garde sa hauteur même loin de l'écran (elle entre dans la taille mémorisée par
          `content-visibility`) ; seul son contenu interactif est différé. */}
      <div className="relative flex h-8 items-center px-2.5">
        {!near && <div className="min-w-0 flex-1 truncate text-xs font-medium">{basename(hit.file_path)}</div>}
        {near && (<>
        <Tooltip>
          <TooltipTrigger render={<div className="min-w-0 flex-1 truncate text-xs font-medium" />}>
            {basename(hit.file_path)}
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.fileAndShot", { path: hit.file_path, n: hit.scene_index + 1 })}</TooltipContent>
        </Tooltip>
        <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-br-xl bg-gradient-to-l from-card from-75% via-card to-transparent pl-8 pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onAddRef && (
          <Tooltip>
            <TooltipTrigger render={<button
              type="button"
              onClick={() => onAddRef(thumb)}
              className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                refActive ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100")} />}>
              <Plus className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{refActive ? t("resultCard.alreadyRef") : t("resultCard.addAsRef")}</TooltipContent>
          </Tooltip>
        )}
        {onFindSimilar && (
          <Tooltip>
            <TooltipTrigger render={<button
              type="button"
              onClick={() => onFindSimilar(thumb)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:opacity-100" />}>
              <ScanSearch className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t("resultCard.similarShots")}</TooltipContent>
          </Tooltip>
        )}
        {confirmChar && onConfirmChar && (
          <Tooltip>
            <TooltipTrigger render={<button
              type="button"
              onClick={onConfirmChar}
              disabled={!!hit.char}
              className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                hit.char ? "text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")} />}>
              <UserCheck className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{hit.char ? t("resultCard.confirmedChar", { name: hit.char.name }) : t("resultCard.confirmChar", { name: confirmChar })}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <AddToCollection
              shots={[{ path: hit.file_path, name: basename(hit.file_path), in: hit.start_sec, out: hit.end_sec, inFrame: hit.start_frame, outFrame: hit.end_frame, srcFrames: hit.src_frames, fps: hit.fps }]}
              stopPropagation={false}
              className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
            />
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.addToCollection")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button
            type="button"
            onClick={onDownload}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:opacity-100" />}>
            <Clapperboard className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.addToTimeline")}</TooltipContent>
        </Tooltip>
        </div>
        </>)}
      </div>
      </ContextMenuTrigger>

      {/* Clic droit : mêmes actions que les boutons du survol, toutes accessibles d'un geste. */}
      {near && (
      <ContextMenuContent className="min-w-52">
        <ContextMenuCheckboxItem checked={selected} onClick={onToggle}>
          <CheckSquare /> {t("resultCard.select")}
        </ContextMenuCheckboxItem>
        {(onAddRef || onFindSimilar || (confirmChar && onConfirmChar)) && <ContextMenuSeparator />}
        {onAddRef && (
          <ContextMenuItem onClick={() => onAddRef(thumb)} disabled={refActive}>
            <Plus /> {refActive ? t("resultCard.alreadyRef") : t("resultCard.addAsRef")}
          </ContextMenuItem>
        )}
        {onFindSimilar && (
          <ContextMenuItem onClick={() => onFindSimilar(thumb)}><ScanSearch /> {t("resultCard.similarShots")}</ContextMenuItem>
        )}
        {confirmChar && onConfirmChar && (
          <ContextMenuItem onClick={onConfirmChar} disabled={!!hit.char}>
            <UserCheck /> {hit.char ? t("resultCard.confirmedChar", { name: hit.char.name }) : t("resultCard.confirmCharShort", { name: confirmChar })}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <CollectionSubmenu shots={shots} />
        {onSendBoard && <ContextMenuItem onClick={onSendBoard}><Images /> {t("resultCard.sendToBoard")}</ContextMenuItem>}
        <ContextMenuItem onClick={onDownload}><Clapperboard /> {t("resultCard.addToTimeline")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(hit.file_path)}>
          <Copy /> {t("resultCard.copyPath")}
        </ContextMenuItem>
      </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

// Mémoïsé : la grille de résultats re-rend à chaque sélection/lecture/seuil. On compare les seules
// props de rendu ; les callbacks (recréés chaque rendu, sémantique stable, lus via ref dans le hook)
// sont ignorés → seule la carte concernée re-rend.
export const ResultCard = memo(ResultCardImpl, (a, b) =>
  a.hit.file_path === b.hit.file_path && a.hit.scene_index === b.hit.scene_index &&
  a.hit.score === b.hit.score &&
  (a.hit.char?.id ?? null) === (b.hit.char?.id ?? null) &&
  a.index === b.index && a.selected === b.selected && a.play === b.play &&
  a.refActive === b.refActive && a.confirmChar === b.confirmChar,
);
