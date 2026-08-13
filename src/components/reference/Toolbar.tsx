// Barre d'outils du board : ajout (image / vidéo / YouTube), zoom, cadrage, nouvelle scène,
// et actions de scène (sauver / ouvrir) + détacher (injectées par le parent selon le contexte).

import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ImagePlus, Type, Frame, Pencil, Clapperboard, ZoomIn, ZoomOut, Maximize, FilePlus2,
  Save, SaveAll, FileCheck2, FolderOpen, Share2, PictureInPicture2, Minimize2, Pin, PinOff, Play, Pause,
  Settings2, Home, Undo2, Redo2, RotateCw, Magnet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import { fileLabel } from "./useScenePersistence";
import { recoverAllOnlineMedia, recoverableOnlineItems } from "./boardMediaActions";
import type { BoardHandle } from "./ReferenceBoard";

function IconBtn({ icon: Icon, label, onClick, disabled, active }: {
  icon: typeof ImagePlus; label: string; onClick: () => void; disabled?: boolean; active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant={active ? "default" : "ghost"} size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active} />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Toolbar({
  board,
  onHome,
  onSave,
  onSaveAs,
  onOpen,
  onDetach,
  onAttach,
  onProject,
  onSettings,
  onExport,
  pinned,
  onTogglePin,
  draggable,
}: {
  board: RefObject<BoardHandle | null>;
  onHome?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onOpen?: () => void;
  onDetach?: () => void;
  onAttach?: () => void;
  onProject?: () => void;
  onSettings?: () => void;
  onExport?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  draggable?: boolean; // fenêtre détachée sans cadre : la barre sert de zone de déplacement
}) {
  const { t } = useTranslation("reference");
  const sceneName = useBoard((s) => s.sceneName);
  const filePath = useBoard((s) => s.filePath);
  const dirty = useBoard((s) => s.dirty);
  const notice = useBoard((s) => s.notice);
  const items = useBoard((s) => s.items);
  const frozen = useBoard((s) => s.frozen);
  const toggleFrozen = useBoard((s) => s.toggleFrozen);
  const drawMode = useBoard((s) => s.drawMode);
  const setDrawMode = useBoard((s) => s.setDrawMode);
  const newScene = useBoard((s) => s.newScene);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const canUndo = useBoard((s) => s.past.length > 0);
  const canRedo = useBoard((s) => s.future.length > 0);
  const [recovering, setRecovering] = useState(false);
  const recoverableCount = recoverableOnlineItems(items).length;
  const snap = useBoard((s) => s.prefs.snap);
  const setPrefs = useBoard((s) => s.setPrefs);

  // Choisir un autre outil/ajout quitte le mode dessin (revient au curseur normal).
  const leaveDraw = () => { if (useBoard.getState().drawMode) setDrawMode(false); };
  const retryMissing = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      const result = await recoverAllOnlineMedia();
      if (result.recovered > 0) onSave?.();
      useBoard.getState().setNotice({
        kind: result.failed ? "error" : "ok",
        text: t("notice.recoveryResult", result),
      });
    } finally {
      setRecovering(false);
    }
  };

  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center gap-1 border-b border-border bg-card/80 px-2 backdrop-blur",
        draggable && "select-none",
      )}
      style={draggable ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
    >
      {/* zone interactive : les contrôles ne doivent pas hériter du drag de la barre */}
      <div
        className="flex items-center gap-1"
        style={draggable ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
      {onHome && (
        <>
          <IconBtn icon={Home} label={t("toolbar.home")} onClick={onHome} />
          <Separator orientation="vertical" className="mx-1 h-5" />
        </>
      )}
      {/* Ajouter une image / une vidéo / une séquence / un lien ne vit plus ici : glisser-déposer
          pour les fichiers, Ctrl+V pour un lien, et le clic droit garde les quatre entrées. */}
      <IconBtn icon={Type} label={t("toolbar.addText")} onClick={() => { leaveDraw(); board.current?.addText(); }} />
      <IconBtn icon={Frame} label={t("toolbar.addFrame")} onClick={() => { leaveDraw(); board.current?.addFrame(); }} />
      <IconBtn
        icon={Pencil}
        label={drawMode ? t("toolbar.exitDraw") : t("toolbar.draw")}
        active={drawMode}
        onClick={() => setDrawMode(!drawMode)}
      />
      {onProject && <IconBtn icon={Clapperboard} label={t("toolbar.fromProject")} onClick={() => { leaveDraw(); onProject(); }} />}

      <Separator orientation="vertical" className="mx-1 h-5" />

      <IconBtn icon={Undo2} label={t("actions.undo")} onClick={undo} disabled={!canUndo} />
      <IconBtn icon={Redo2} label={t("actions.redo")} onClick={redo} disabled={!canRedo} />

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* Aimant : accrochage bords/centres/coins et collage bord à bord. Alt le suspend le temps
          d'un geste ; ce bouton, lui, l'éteint durablement. */}
      <IconBtn icon={Magnet} label={snap ? t("toolbar.snapOff") : t("toolbar.snapOn")} active={snap} onClick={() => setPrefs({ snap: !snap })} />
      <IconBtn icon={ZoomOut} label={t("actions.zoomOut")} onClick={() => board.current?.zoomBy(0.8)} />
      <IconBtn icon={ZoomIn} label={t("actions.zoomIn")} onClick={() => board.current?.zoomBy(1.25)} />
      <IconBtn icon={Maximize} label={t("actions.fitAll")} onClick={() => board.current?.fit()} />
      <IconBtn
        icon={frozen ? Play : Pause}
        label={frozen ? t("toolbar.playAll") : t("toolbar.freezeAll")}
        onClick={toggleFrozen}
      />

      <Separator orientation="vertical" className="mx-1 h-5" />

      <IconBtn icon={FilePlus2} label={t("actions.newScene")} onClick={() => newScene()} />
      {onSave && <IconBtn icon={Save} label={t("toolbar.saveScene")} onClick={onSave} />}
      {onSaveAs && <IconBtn icon={SaveAll} label={t("toolbar.saveAs")} onClick={onSaveAs} />}
      {onOpen && <IconBtn icon={FolderOpen} label={t("toolbar.openScene")} onClick={onOpen} />}
      {onExport && <IconBtn icon={Share2} label={t("toolbar.share")} onClick={onExport} />}

        <div className="ml-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {/* Un projet lié à un fichier affiche SON nom et, en infobulle, son chemin complet : savoir
              où il est enregistré est la raison d'être du format. */}
          {filePath ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 items-center gap-1 truncate" />}>
                <FileCheck2 className="size-3.5 shrink-0" />
                <span className="truncate">{fileLabel(filePath)}</span>
              </TooltipTrigger>
              <TooltipContent>{filePath}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="truncate">{sceneName}</span>
          )}
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t("toolbar.unsaved")} />}
          {notice && (
            <span className={cn("truncate", notice.kind === "error" ? "text-destructive" : "text-[var(--color-ok)]")}>
              · {notice.text}
            </span>
          )}
          {recoverableCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              disabled={recovering}
              onClick={() => void retryMissing()}
              aria-label={t("notice.redownloadAll", { count: recoverableCount })}
            >
              <RotateCw className={cn(recovering && "animate-spin")} />
              {t("notice.redownloadAll", { count: recoverableCount })}
            </Button>
          )}
        </div>
      </div>

      {/* zone centrale : reste draggable (fenêtre détachée) pour saisir la barre */}
      <div className="flex-1" />

      <div
        className="flex items-center gap-1"
        style={draggable ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
        {onSettings && <IconBtn icon={Settings2} label={t("actions.settings")} onClick={onSettings} />}
        {onTogglePin && (
          <IconBtn
            icon={pinned ? Pin : PinOff}
            label={pinned ? t("actions.unpin") : t("actions.pin")}
            onClick={onTogglePin}
          />
        )}
        {onDetach && (
          <IconBtn icon={PictureInPicture2} label={t("actions.detach")} onClick={onDetach} />
        )}
        {onAttach && (
          <IconBtn icon={Minimize2} label={t("actions.attach")} onClick={onAttach} />
        )}
      </div>

    </div>
  );
}
