import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Play, Download, CheckSquare, Clapperboard } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { selectionRing, SelectToggle } from "@/components/common/selectable";
import { hoverLiftLayer } from "@/components/common/hoverLift";
import { AddToCollection } from "@/components/collections/AddToCollection";
import { IS_REMOTE } from "@/lib/remote";
import { type Segment } from "./cutStudioShared";
import { useSceneCardMedia } from "./useSceneCardMedia";

// En remote (panneau Adobe) : le survol est peu fiable → les icônes d'action (sélection, collection,
// envoi timeline) restent TOUJOURS visibles. Ailleurs = apparition au survol (design d'origine).
const ACT_VIS = IS_REMOTE ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";
const ACT_ALWAYS = "opacity-100";

function SceneCardImpl({
  seg, index, clipPath, clipName, srcFrames, active, selected, play, getProxy, bustProxy, peekProxy, onPlay, onToggle, onAddToTimeline, addLabel, pos, dur, alwaysChrome,
}: {
  seg: Segment; index: number; clipPath: string; clipName: string; srcFrames: number; active: boolean; selected: boolean; play: boolean;
  /** Lecture synchrone du cache d'URL de la grille : la carte monte sa <video> sans attendre une promesse. */
  peekProxy?: () => string | null;
  // Fenêtre épinglée : le survol y est trop instable (petite fenêtre, défilement) → les icônes de la
  // vignette restent posées, comme en remote, au lieu d'apparaître/disparaître pendant le scroll.
  alwaysChrome?: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>; bustProxy: () => void; onPlay: () => void;
  // `mods` porte les modificateurs du clic : Maj = étendre la plage depuis l'ancre, Ctrl = basculer.
  onToggle: (mods?: { shift?: boolean; ctrl?: boolean }) => void;
  onAddToTimeline?: () => Promise<{ ok: boolean; error?: string }>; addLabel?: string; pos: string; dur: string;
}) {
  const { t } = useTranslation("derush");
  const { rootRef, thumb, url, showVideo, videoPaused, near, interactive, hovered, onVideoError, enter, leave, focusEnter, focusLeave } =
    useSceneCardMedia({ seg, index, clipPath, play, getProxy, bustProxy, peekProxy });
  const playing = showVideo && !videoPaused;
  // Habillage de survol : monté seulement quand la carte est SOUS le pointeur (ou au clavier). En
  // remote, les icônes restent visibles au repos (cf. ACT_VIS) → il faut les monter dès la bande.
  const chrome = IS_REMOTE || alwaysChrome ? near : interactive;
  const actVis = alwaysChrome ? ACT_ALWAYS : ACT_VIS;

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
          // Repère lu par useCutShortcuts : une carte focalisée garde Entrée/Espace/P pour elle.
          data-scene-card=""
          aria-pressed={selected}
          aria-label={selected ? t("sceneCard.ariaDeselect", { n: index + 1 }) : t("sceneCard.ariaSelect", { n: index + 1 })}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={focusEnter}
          onBlur={focusLeave}
          // clic = sélectionner (toggle) ; Maj+clic = plage ; Ctrl+clic = bascule ; double-clic = lecteur
          onClick={(e) => onToggle({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
          onDoubleClick={onPlay}
          onKeyDown={(e) => {
            // Un portail Base UI (popover « Ranger », menu contextuel) fait remonter ses événements
            // dans l'ARBRE REACT, pas dans le DOM : sans cette garde, le preventDefault ci-dessous
            // mangeait l'ESPACE tapé dans le champ « nom du dossier » du popover. Cf. ClipCard.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }); }
            else if (e.key === "p" || e.key === "P") { e.preventDefault(); onPlay(); }
          }}
          // `nr-grid-card` = content-visibility + hauteur de remplacement lue dans `--nr-cell-h`,
          // posée UNE fois sur le conteneur de grille (cf. index.css) : la carte ne porte plus de
          // hauteur en prop, donc un cran de densité ne rerend aucune carte.
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
      {/* la vignette reste la couche de fond : quand la <video> se démonte (Lecture auto coupée),
          elle est déjà là dessous → aucun flash noir. La <video> se superpose le temps de jouer. */}
      {thumb && <img src={thumb} alt={t("shared.shotPreview", { n: index + 1 })} decoding="async" className="absolute inset-0 h-full w-full object-cover" />}

      {showVideo && (
        <PreviewVideo url={url!} label={t("shared.shotPreview", { n: index + 1 })} onError={onVideoError} audible={hovered} paused={videoPaused} />
      )}
      <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20">
        {!playing && <Play className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 opacity-0 drop-shadow transition-opacity group-hover:opacity-90" />}
      </div>

      {/* Tout ce qui est VISIBLE AU REPOS est rendu sans condition : le numéro et la durée sont
          apparus « après coup » tant qu'ils attendaient l'observateur de proximité — la vignette,
          elle, sort du cache renderer dès le premier rendu, donc l'image arrivait avant ses
          pastilles. Seul l'habillage RÉVÉLÉ AU SURVOL (donc invisible au repos) est différé : c'est
          lui qui coûte cher (infobulles et popover Base UI, une racine par carte), et il ne se monte
          donc QUE pour la carte sous le pointeur — jamais pour la bande entière. */}
      <span className="absolute left-1.5 top-1.5 rounded nr-chip shadow-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums">#{index + 1}</span>
      {chrome ? (
        <Tooltip>
          <TooltipTrigger render={<span className="absolute bottom-1.5 right-1.5 rounded nr-chip shadow-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums" />}>
            {dur}
          </TooltipTrigger>
          <TooltipContent>{t("sceneCard.startAt", { pos })}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="absolute bottom-1.5 right-1.5 rounded nr-chip shadow-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums">{dur}</span>
      )}
      {/* La pastille de sélection est visible quand la carte est cochée → elle ne peut pas attendre
          la bande, sinon une carte cochée hors bande perdrait sa coche. */}
      {(chrome || selected) && <SelectToggle selected={selected} onToggle={() => onToggle()} />}

      {chrome && (<>
        {/* ranger ce plan dans une collection (bibliothèque) — directement sur la vignette */}
        <Tooltip>
          <TooltipTrigger render={<span className={`absolute bottom-1.5 left-1.5 inline-flex transition-opacity ${actVis}`} />}>
            <AddToCollection
              shots={[{ path: clipPath, name: clipName, in: seg.in, out: seg.out, inFrame: seg.inFrame, outFrame: seg.outFrame, srcFrames }]}
              className="nr-chip shadow-md p-1 text-white/80 hover:text-primary"
            />
          </TooltipTrigger>
          <TooltipContent>{t("shared.rangeInCollection")}</TooltipContent>
        </Tooltip>

        {/* ajouter ce plan à la timeline ouverte (reste visible tant qu'un ajout est en cours/terminé) */}
        {onAddToTimeline && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={addLabel ?? t("shared.sendToTimeline")} onClick={doAdd}
              className={`absolute bottom-1.5 left-9 rounded nr-chip shadow-md p-1 transition-opacity ${adding !== "idle" ? "opacity-100" : actVis} ${adding === "done" ? "text-[var(--color-ok)]" : adding === "err" ? "text-destructive" : "text-white/80 hover:text-primary"}`} />}>
              {adding === "busy" ? <Spinner className="size-3.5" />
                : adding === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} />
                : <Download className="h-3.5 w-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{addLabel ?? t("shared.sendToTimeline")}</TooltipContent>
          </Tooltip>
        )}
      </>)}
      </div>
      </ContextMenuTrigger>
      {/* Clic droit : lire / (dé)sélectionner / envoyer à la timeline. */}
      {chrome && (
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={onPlay}><Play /> {t("shared.playShotMenu")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onToggle()}>
          <CheckSquare /> {selected ? t("shared.deselect") : t("shared.select")}
        </ContextMenuItem>
        {onAddToTimeline && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={(e) => doAdd(e)}>
              <Clapperboard /> {addLabel ?? t("shared.addToTimeline")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

// Mémoïsé : la grille re-rend à chaque sélection/lecture/survol d'UNE carte. On compare les seules
// props qui changent le rendu ; les callbacks (recréés à chaque rendu parent, sémantique stable,
// lus via ref dans le hook média) sont volontairement ignorés → 1 seule carte re-rend, pas 494.
export const SceneCard = memo(SceneCardImpl, (a, b) =>
  a.seg.id === b.seg.id && a.seg.in === b.seg.in && a.seg.out === b.seg.out &&
  a.index === b.index && a.clipPath === b.clipPath && a.clipName === b.clipName && a.srcFrames === b.srcFrames &&
  a.active === b.active && a.selected === b.selected && a.play === b.play &&
  a.pos === b.pos && a.dur === b.dur && a.addLabel === b.addLabel && !!a.onAddToTimeline === !!b.onAddToTimeline &&
  !!a.alwaysChrome === !!b.alwaysChrome,
);
