import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { Film, Play, ScanSearch, Plus, Aperture, UserCheck } from "lucide-react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { SendToTimelineIcon } from "@/components/common/SendToTimelineIcon";
import { type SearchHit } from "@/lib/bridge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCardMedia } from "@/lib/useCardMedia";
import { IS_REMOTE } from "@/lib/remote";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { AddToCollection } from "@/components/collections/AddToCollection";
import { CollectionSubmenu } from "@/components/collections/CollectionSubmenu";
import { hitShot } from "@/components/search/searchHelpers";
import { cn, basename, thumbTime, fmtPercent } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { selectionRing, SelectToggle } from "@/components/common/selectable";

// The card adds a footer under its 16:9 video area: the proxy height comes from the width.
const videoAreaHeight = (el: HTMLDivElement) => el.clientWidth * 9 / 16;

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
  hit, index, selected, play, onToggle, onDownload, getProxy, bustProxy, peekProxy,
  onFindSimilar, onAddRef, refActive, confirmChar, onConfirmChar,
}: {
  hit: SearchHit;
  index: number;
  selected: boolean;
  play: boolean;
  onToggle: () => void;
  onDownload: () => void;       // ajoute ce plan à la timeline ouverte (mode append, frame-accurate)
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  /** Lecture synchrone du cache d'URL de la vue : la carte monte sa <video> sans attendre une promesse. */
  peekProxy?: () => string | null;
  // Reçoivent la vignette AFFICHÉE : le bac de références montre exactement l'image cliquée, et
  // la carte est le seul endroit qui la connaisse (le backend ne renvoie plus d'image).
  onFindSimilar?: (thumb: string | null) => void;
  onAddRef?: (thumb: string | null) => void;
  refActive?: boolean;          // ce plan est déjà dans le bac de références
  confirmChar?: string;         // recherche par personnage : nom pour « c'est bien lui »
  onConfirmChar?: () => void;   // confirme → le visage devient un échantillon du perso
}) {
  const { t } = useTranslation("search");
  // MÊME instant que la grille de plans → même entrée de cache, donc la même image sur le disque.
  const thumbAt = thumbTime(hit.start_sec, hit.end_sec);
  // Plan sérialisé pour « Ranger dans une collection » (identique au bouton du pied).
  const shots = [hitShot(hit)];
  // Keeps the hover action bar visible while the "Ranger" popover is open over it.
  const [rangeOpen, setRangeOpen] = useState(false);

  const { rootRef, thumb, thumbFailed, hovered, enter, leave, focusEnter, focusLeave, url, showVideo, videoPaused, near, interactive, onVideoError } =
    useCardMedia({ clipPath: hit.file_path, thumbAt, index, play, getProxy, bustProxy, peekProxy, measure: videoAreaHeight });
  const playing = showVideo && !videoPaused;
  // Hover chrome (tooltips, the "Ranger" popover, the context menu: one Base UI root each) mounts for
  // the card under the pointer or the keyboard only, like the shot cards. It used to follow the
  // thumbnail band, so dragging the scrollbar mounted and unmounted it for dozens of cards at once.
  // In remote the hover is unreliable, so the band stays the trigger there.
  const chrome = (IS_REMOTE ? near : interactive) || rangeOpen;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={
        <div
          ref={rootRef}
          className={cn(
            "group flex flex-col overflow-hidden rounded-xl border bg-card transition-transform [content-visibility:auto] [contain-intrinsic-size:auto_240px]",
            selectionRing(selected),
          )}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={focusEnter}
          onBlur={focusLeave}
        />
      }>
      <div className="relative aspect-video bg-muted">
        {!thumb && !thumbFailed && <Skeleton className="absolute inset-0 rounded-none" />}
        {thumb && <img src={thumb} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
        {thumbFailed && !thumb && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Film className="size-7 opacity-40" />
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
          <Play className="absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-90" />
        )}

        {/* case de sélection (toujours visible si cochée, sinon au survol) — coin haut-gauche
            car le haut-droite porte déjà le timecode. Cochée, elle est visible : jamais différée. */}
        {(chrome || selected) && <SelectToggle selected={selected} onToggle={onToggle} className="left-2 top-2 right-auto" />}

        {/* Pastilles en `nr-chip` (fond opaque), JAMAIS en `backdrop-blur` : un backdrop-filter
            posé sur une <video> qui joue force le compositeur à recopier et flouter le fond à
            CHAQUE image décodée, pour chaque carte. Avec une grille en lecture auto c'était le
            premier poste de coût du défilement. */}
        <span className="nr-chip absolute bottom-2 left-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white">
          {tc(hit.start_sec)}
        </span>
        <span className="nr-chip absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white">
          {fmtPercent(hit.score)}
        </span>
        {hit.char && (
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white"
            style={{ background: hit.char.color || "rgba(0,0,0,.8)" }}>
            {hit.char.name}
          </span>
        )}
        {hit.aesthetic != null && hit.aesthetic < 0 && (
          chrome ? (
            <Tooltip>
              <TooltipTrigger render={<span className="nr-chip absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn)]" />}>
                <Aperture className="size-3" /> {t("resultCard.blurry")}
              </TooltipTrigger>
              <TooltipContent>{t("resultCard.blurryTooltip")}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="nr-chip absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn)]">
              <Aperture className="size-3" /> {t("resultCard.blurry")}
            </span>
          )
        )}
      </div>

      {/* Pied compact : nom pleine largeur (1 ligne) ; les actions n'apparaissent qu'au survol,
          en OVERLAY (fondu gauche) → zéro troncature du nom au repos, zéro décalage de layout.
          Le pied garde sa hauteur même loin de l'écran (elle entre dans la taille mémorisée par
          `content-visibility`) ; seul son contenu interactif est différé. */}
      <div className="relative flex h-8 items-center px-2.5">
        {!chrome && <div className="min-w-0 flex-1 truncate text-xs font-medium">{basename(hit.file_path)}</div>}
        {chrome && (<>
        <Tooltip>
          <TooltipTrigger render={<div className="min-w-0 flex-1 truncate text-xs font-medium" />}>
            {basename(hit.file_path)}
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.fileAndShot", { path: hit.file_path, n: hit.scene_index + 1 })}</TooltipContent>
        </Tooltip>
        <div className={cn("absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-br-xl bg-gradient-to-l from-card from-75% via-card to-transparent pl-8 pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", rangeOpen && "opacity-100")}>
        {onAddRef && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs"
              type="button"
              onClick={() => onAddRef(thumb)}
              className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                refActive ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100")} />}>
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{refActive ? t("resultCard.alreadyRef") : t("resultCard.addAsRef")}</TooltipContent>
          </Tooltip>
        )}
        {onFindSimilar && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs"
              type="button"
              onClick={() => onFindSimilar(thumb)}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:opacity-100" />}>
              <ScanSearch className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("resultCard.similarShots")}</TooltipContent>
          </Tooltip>
        )}
        {confirmChar && onConfirmChar && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs"
              type="button"
              onClick={onConfirmChar}
              disabled={!!hit.char}
              className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                hit.char ? "text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")} />}>
              <UserCheck className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{hit.char ? t("resultCard.confirmedChar", { name: hit.char.name }) : t("resultCard.confirmChar", { name: confirmChar })}</TooltipContent>
          </Tooltip>
        )}
        {/* Off while the popover is open: focus inside it bubbles (React tree) up to this trigger. */}
        <Tooltip disabled={rangeOpen}>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <AddToCollection
              shots={shots}
              stopPropagation={false}
              onOpenChange={setRangeOpen}
              className="size-7 text-muted-foreground hover:bg-accent hover:text-foreground"
            />
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.addToCollection")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs"
            type="button"
            onClick={onDownload}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:opacity-100" />}>
            <SendToTimelineIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t("resultCard.addToTimeline")}</TooltipContent>
        </Tooltip>
        </div>
        </>)}
      </div>
      </ContextMenuTrigger>

      {/* Clic droit : mêmes actions que les boutons du survol, toutes accessibles d'un geste. */}
      {chrome && (
      <ContextMenuContent className="min-w-52">
        <ContextMenuCheckboxItem checked={selected} onClick={onToggle}>
          <NetsuIcon name="cut-select" /> {t("resultCard.select")}
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
        <ContextMenuItem onClick={onDownload}><SendToTimelineIcon /> {t("resultCard.addToTimeline")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(hit.file_path)}>
          <NetsuIcon name="copy" /> {t("resultCard.copyPath")}
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
