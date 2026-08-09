// Fenêtre détachée : board de référence flottante, indépendante de la fenêtre principale.
// Chargée via le hash #reference (App route dessus). Sans cadre (frameless) → la barre d'outils
// sert de zone de déplacement. Au montage, reprend le board figé par le handoff de la fenêtre mère.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, Minimize2 } from "lucide-react";
import { nr } from "@/lib/bridge";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { BoardContextMenu } from "./BoardMenu";
import { SceneDialog } from "./SceneDialog";
import { MediaPicker } from "./MediaPicker";
import { BoardSettings } from "./BoardSettings";
import { Inspector } from "./Inspector";
import { SequencePlayer } from "./SequencePlayer";
import { CropOverlay } from "./CropOverlay";
import { ReferenceBoard, type BoardHandle } from "./ReferenceBoard";
import { useScenePersistence } from "./useScenePersistence";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { useProjectActions } from "./useProjectActions";
import { useReferencePush } from "./useReferencePush";
import { useAutosave } from "./useAutosave";
import { useUnsavedWarning } from "./useUnsavedWarning";

// Fenêtre frameless : bande mince = zone de déplacement (sinon la fenêtre sans cadre ne bouge plus).
// Au survol, la bande révèle deux icônes (épingler, rattacher) ; la bande reste déplaçable, seules
// les icônes sont « no-drag ». Tout le reste passe par le clic droit.
const DRAG: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function ReferenceWindow() {
  const { t } = useTranslation("reference");
  const boardRef = useRef<BoardHandle>(null);
  const persistence = useScenePersistence();
  const [sceneDlg, setSceneDlg] = useState(false);
  const [pickDlg, setPickDlg] = useState(false);
  const [settingsDlg, setSettingsDlg] = useState(false);
  const [pinned, setPinned] = useState(true);

  // Reprend le board transféré par la fenêtre principale (handoff) au premier rendu.
  useEffect(() => {
    void persistence.loadHandoff();
    nr.reference?.setAlwaysOnTop(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = useProjectActions(persistence);
  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    nr.reference?.setAlwaysOnTop(next);
  };

  useBoardShortcuts(boardRef, { onSave: project.save, onSaveAs: project.saveAs, onOpenProject: project.openProject });
  useReferencePush(boardRef);
  // Autosave SANS restauration (le board initial vient du handoff, pas de l'autosave).
  useAutosave(persistence, { restore: false });
  useUnsavedWarning();

  return (
    <TooltipProvider delay={600}>
      <div className="relative flex h-screen flex-col overflow-hidden bg-[var(--color-bg)]">
        {/* Bande de déplacement (frameless). Poignée toujours visible ; au survol, deux icônes
            apparaissent (épingler / rattacher). La bande reste déplaçable, seules les icônes non. */}
        <div className="group flex h-6 shrink-0 items-center px-2" style={DRAG}>
          <div className="flex-1" />
          <span className="h-1 w-10 rounded-full bg-border transition-opacity group-hover:opacity-0" />
          <div className="flex flex-1 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100" style={NO_DRAG}>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label={pinned ? t("actions.unpin") : t("actions.pin")} aria-pressed={pinned} onClick={togglePin} />}
              >
                {pinned ? <Pin /> : <PinOff />}
              </TooltipTrigger>
              <TooltipContent>{pinned ? t("actions.unpin") : t("actions.pin")}</TooltipContent>
            </Tooltip>
            {nr.reference && (
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label={t("actions.attach")} onClick={() => nr.reference!.attach()} />}
                >
                  <Minimize2 />
                </TooltipTrigger>
                <TooltipContent>{t("actions.attach")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <BoardContextMenu
          board={boardRef}
          onSave={persistence.available ? project.save : undefined}
          onSaveAs={persistence.available ? project.saveAs : undefined}
          onOpenProject={persistence.available ? project.openProject : undefined}
          onOpen={persistence.available ? () => setSceneDlg(true) : undefined}
          onProject={() => setPickDlg(true)}
          onAttach={nr.reference ? () => nr.reference!.attach() : undefined}
          onSettings={() => setSettingsDlg(true)}
          pinned={pinned}
          onTogglePin={togglePin}
        >
          <ReferenceBoard ref={boardRef} />
          <Inspector />
          <SequencePlayer />
        </BoardContextMenu>
        <SceneDialog open={sceneDlg} onOpenChange={setSceneDlg} persistence={persistence} />
        <MediaPicker open={pickDlg} onOpenChange={setPickDlg} board={boardRef} />
        <BoardSettings open={settingsDlg} onOpenChange={setSettingsDlg} />
        <CropOverlay />
      </div>
    </TooltipProvider>
  );
}
