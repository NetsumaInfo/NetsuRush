// Carte de plan générique : MÊME machinerie média que la grille de derush (useSceneCardMedia →
// vignette lazy + aperçu proxy HEVC au survol/lecture auto, content-visibility). Réutilisée par
// Collections et Timeline Live. Actions par carte : sélection, ajouter à la timeline, Ranger
// (collection), supprimer.
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, X, Download, Check, Star, CheckSquare, Clapperboard, Crop } from "lucide-react";
import { hoverLiftLayer } from "@/components/common/hoverLift";
import { selectionRing, SelectToggle } from "@/components/common/selectable";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { AddToCollection } from "@/components/collections/AddToCollection";
import { type CollectionShot } from "@/lib/bridge";
import { type Segment } from "./cutStudioShared";
import { useSceneCardMedia } from "./useSceneCardMedia";

function ShotCardImpl({
  seg, index, clipPath, active = false, selected, play, getProxy, bustProxy, peekProxy, onPlay, onToggle,
  rangerShots, onAddToTimeline, onRemove, onTrim, badge, dur, labelColor, labelName, rating, tagCount, alwaysChrome,
}: {
  seg: Segment; index: number; clipPath: string; selected: boolean; play: boolean;
  active?: boolean;                                           // plan ouvert dans le lecteur de droite
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void; onPlay?: () => void; onToggle: () => void;
  /** Lecture synchrone du cache d'URL de la grille : la carte monte sa <video> sans attendre une promesse. */
  peekProxy?: () => string | null;
  rangerShots: CollectionShot[];                              // plan(s) à ranger via le bouton « Ranger »
  onAddToTimeline?: () => Promise<{ ok: boolean; error?: string }>; // ajouter à la timeline (destination choisie)
  onRemove?: () => void;                                      // retirer (vue détail d'une collection)
  onTrim?: () => void;                                        // rogner les bornes (vue détail d'une collection)
  badge?: string;                                             // pastille haut-gauche (numéro, score…)
  dur: string;
  labelColor?: string | null;                                // couleur du label (pastille du chip méta)
  labelName?: string;                                        // nom du label (lecture d'écran)
  rating?: number;                                           // note 0-5
  tagCount?: number;                                          // nb de tags
  // Fenêtre épinglée : survol trop instable (petite fenêtre, défilement) → l'habillage reste posé.
  alwaysChrome?: boolean;
}) {
  const { t } = useTranslation("derush");
  const { rootRef, thumb, url, showVideo, videoPaused, near, interactive, hovered, onVideoError, enter, leave, focusEnter, focusLeave } =
    useSceneCardMedia({ seg, index, clipPath, play, getProxy, bustProxy, peekProxy });
  const playing = showVideo && !videoPaused;
  const chrome = alwaysChrome ? near : interactive;

  const [adding, setAdding] = useState<"idle" | "busy" | "done" | "err">("idle");
  async function doAdd(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (adding === "busy" || !onAddToTimeline) return;
    setAdding("busy");
    try { const r = await onAddToTimeline(); setAdding(r.ok ? "done" : "err"); }
    catch { setAdding("err"); }
    setTimeout(() => setAdding("idle"), 1400);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={
        <div
          ref={rootRef}
          role="button"
          tabIndex={0}
          aria-label={selected ? t("shotCard.deselectShot", { n: index + 1 }) : t("shotCard.selectShot", { n: index + 1 })}
          aria-pressed={selected}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={focusEnter}
          onBlur={focusLeave}
          onClick={onToggle}
          onDoubleClick={onPlay}
          // `e.target !== e.currentTarget` : un portail Base UI (popover « Ranger ») remonte dans
          // l'arbre REACT — sans la garde, l'espace tapé dans son champ de nom était avalé ici.
          onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
          // `nr-grid-card` = content-visibility + hauteur de remplacement héritée du conteneur de
          // grille (`--nr-cell-h`, cf. index.css et SceneCard).
          // Coquille IMMOBILE : elle reçoit le survol, la couche visuelle en dessous se soulève
          // (cf. common/hoverLift — porté ici, le soulèvement faisait vibrer la carte).
          className="group relative aspect-video cursor-pointer nr-grid-card outline-none"
        />
      }>
      <div className={hoverLiftLayer(
        "overflow-hidden rounded-xl border bg-muted group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1",
        active ? "border-primary ring-2 ring-inset ring-primary" : selectionRing(selected, true),
      )}>
      {!thumb && <Skeleton className="absolute inset-0 rounded-none" />}
      {thumb && <img src={thumb} alt={t("shared.shotPreview", { n: index + 1 })} decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
      {showVideo && <PreviewVideo url={url!} label={t("shared.shotPreview", { n: index + 1 })} onError={onVideoError} audible={hovered} paused={videoPaused} />}
      <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20">
        {/* L'aperçu dans la carte reste réservé au survol/à la lecture auto. Ce bouton ouvre le lecteur. */}
        {onPlay && !playing && (
          <button type="button" aria-label={t("shotCard.playShot", { n: index + 1 })} onClick={(e) => { e.stopPropagation(); onPlay(); }}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-90">
            <Play className="h-7 w-7 drop-shadow" />
          </button>
        )}
      </div>
      {/* Tout ce qui est VISIBLE AU REPOS (pastille, méta) est rendu sans condition : ça apparaissait
          « après coup » tant que ça attendait l'observateur de proximité, alors que la vignette sort
          du cache renderer dès le premier rendu. Seul l'habillage révélé AU SURVOL est différé —
          c'est lui qui coûte cher (infobulles + popover Base UI, une racine par carte), et il ne se
          monte que pour la carte SOUS LE POINTEUR, jamais pour toute la bande d'anticipation. */}
      {badge && <span className="absolute left-1.5 top-1.5 rounded nr-chip px-1.5 py-0.5 text-[10px] font-medium tabular-nums">{badge}</span>}

      {/* sélection — visible dès qu'elle est cochée, donc jamais différée dans ce cas */}
      {(chrome || selected) && <SelectToggle selected={selected} onToggle={onToggle} />}

      {/* barre d'actions (bas-gauche) : ajouter timeline · ranger · retirer */}
      {chrome && (
      <div className={`absolute bottom-1.5 left-1.5 flex items-center gap-1 transition-opacity ${adding !== "idle" || alwaysChrome ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"}`}>
        {onAddToTimeline && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={t("shared.addToTimeline")} onClick={doAdd}
              className={`rounded nr-chip p-1 transition-colors ${adding === "done" ? "text-[var(--color-ok)]" : adding === "err" ? "text-destructive" : "text-white/80 hover:text-primary"}`} />}>
              {adding === "busy" ? <Spinner className="size-3.5" />
                : adding === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} />
                : <Download className="h-3.5 w-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{t("shared.addToTimeline")}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <AddToCollection shots={rangerShots} className="nr-chip p-1 text-white/80 hover:text-primary" />
          </TooltipTrigger>
          <TooltipContent>{t("shared.rangeInCollection")}</TooltipContent>
        </Tooltip>
        {onRemove && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={t("shotCard.remove")} onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="rounded nr-chip p-1 text-white/80 transition-colors hover:text-destructive" />}>
              <X className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t("shared.removeFromCollection")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      )}

      {/* Méta du plan en UN SEUL chip (bas-droite, même emplacement que la durée au Découpage) :
          label couleur · note · tags · durée. Quatre marques flottantes se disputaient la vignette,
          dont une bande de couleur pleine largeur qui coupait l'image ; ici la couleur est une
          pastille DANS le chip, donc lisible sans rien recouvrir. Rien ne s'efface au survol :
          l'ancienne pastille de note occupait la place des boutons d'action. */}
      <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1.5 rounded nr-chip px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
        {labelColor && <span role="img" aria-label={labelName} className="size-1.5 shrink-0 rounded-full" style={{ background: labelColor }} />}
        {!!rating && rating > 0 && (
          <span className="flex items-center gap-0.5"><Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />{rating}</span>
        )}
        {!!tagCount && tagCount > 0 && <span className="text-white/70">#{tagCount}</span>}
        {dur}
      </span>
      </div>
      </ContextMenuTrigger>
      {/* Clic droit : lire / (dé)sélectionner / timeline / retirer. */}
      {chrome && (
      <ContextMenuContent className="min-w-48">
        {onPlay && <ContextMenuItem onClick={onPlay}><Play /> {t("shared.playShotMenu")}</ContextMenuItem>}
        <ContextMenuItem onClick={onToggle}>
          <CheckSquare /> {selected ? t("shared.deselect") : t("shared.select")}
        </ContextMenuItem>
        {onAddToTimeline && (
          <ContextMenuItem onClick={(e) => doAdd(e)}>
            <Clapperboard /> {t("shared.addToTimeline")}
          </ContextMenuItem>
        )}
        {/* Rognage atteignable depuis la GRILLE : il ne vivait que dans le lecteur de droite, donc
            invisible panneau fermé — alors que corriger des bornes est une action de tri. */}
        {onTrim && (
          <ContextMenuItem onClick={onTrim}>
            <Crop /> {t("shared.trimShot")}
          </ContextMenuItem>
        )}
        {onRemove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onRemove}>
              <X /> {t("shared.removeFromCollection")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

export const ShotCard = memo(ShotCardImpl, (a, b) =>
  a.seg.id === b.seg.id && a.seg.in === b.seg.in && a.seg.out === b.seg.out &&
  a.index === b.index && a.clipPath === b.clipPath &&
  a.active === b.active && a.selected === b.selected && a.play === b.play && a.badge === b.badge && a.dur === b.dur &&
  a.labelColor === b.labelColor && a.labelName === b.labelName && a.rating === b.rating && a.tagCount === b.tagCount &&
  !!a.onPlay === !!b.onPlay && !!a.onAddToTimeline === !!b.onAddToTimeline && !!a.onRemove === !!b.onRemove && !!a.onTrim === !!b.onTrim &&
  !!a.alwaysChrome === !!b.alwaysChrome,
);
