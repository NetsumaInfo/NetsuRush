// Page « Référence » (onglet) : board mood-board + barre d'outils + gestion de scènes +
// inspecteur d'item + sélecteur de rushs/plans du projet.

import { useCallback, useEffect, useRef, useState } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { Toolbar } from "./Toolbar";
import { BoardContextMenu } from "./BoardMenu";
import { SceneDialog } from "./SceneDialog";
import { ExportDialog } from "./ExportDialog";
import { MediaPicker } from "./MediaPicker";
import { BoardSettings } from "./BoardSettings";
import { Inspector } from "./Inspector";
import { SequencePlayer } from "./SequencePlayer";
import { CropOverlay } from "./CropOverlay";
import { ReferenceHome } from "./ReferenceHome";
import { ReferenceBoard, type BoardHandle } from "./ReferenceBoard";
import { useBoard } from "./useReferenceBoard";
import { useScenePersistence } from "./useScenePersistence";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { useProjectActions } from "./useProjectActions";
import { useReferencePush } from "./useReferencePush";
import { useAutosave } from "./useAutosave";
import { useUnsavedWarning } from "./useUnsavedWarning";

// Import en attente : posé par l'accueil (dépôt/parcourir), ingéré une fois le board monté.
type Pending = { files?: File[]; paths?: string[] };

export function ReferencePanel() {
  const boardRef = useRef<BoardHandle>(null);
  const persistence = useScenePersistence();
  const [sceneDlg, setSceneDlg] = useState(false);
  const [exportDlg, setExportDlg] = useState(false);
  const [pickDlg, setPickDlg] = useState(false);
  const [settingsDlg, setSettingsDlg] = useState(false);
  // Landing : toujours l'accueil au montage de l'onglet (le board en session reste dans le store).
  const [mode, setMode] = useState<"home" | "board">("home");
  const [pending, setPending] = useState<Pending | null>(null);
  const items = useBoard((s) => s.items);
  // Épinglé (fenêtre principale au-dessus, format coin) → board flottante NUE, comme si détachée.
  const pinned = useApp((s) => s.pinned);

  // Identité stable : les actions de document alimentent l'effet clavier, qui se réabonnerait à
  // chaque rendu si ce rappel changeait d'identité.
  const goBoard = useCallback(() => setMode("board"), []);
  const project = useProjectActions(persistence, goBoard);

  const onDetach = async () => {
    await persistence.handoff();
    nr.reference?.detach();
  };

  useBoardShortcuts(boardRef, { onSave: project.save, onSaveAs: project.saveAs, onOpenProject: project.openProject });
  useReferencePush(boardRef);
  useAutosave(persistence);
  useUnsavedWarning();

  // Démarrage d'un nouveau board depuis l'accueil : purge le board restauré puis ingère.
  const startNew = (p: Pending) => {
    useBoard.getState().newScene();
    setPending(p);
    setMode("board");
  };
  const onOpenScene = async (id: string) => {
    await persistence.open(id);
    setMode("board");
  };

  // Ingestion différée : le board n'existe qu'en mode "board" → on attend son montage.
  useEffect(() => {
    if (mode !== "board" || !pending || !boardRef.current) return;
    if (pending.files) boardRef.current.addFiles(pending.files);
    pending.paths?.forEach((p) => boardRef.current?.addPath(p));
    setPending(null);
  }, [mode, pending]);

  // Mode épinglé : board NUE (pas de barre d'outils ni d'accueil, comme la fenêtre détachée) — tout
  // passe par le clic droit ; la barre de titre de l'app sert de zone de déplacement. On rend
  // directement le board de session (pas de landing) pour un usage flottant instantané.
  if (pinned) {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-bg)]">
        <BoardContextMenu
          board={boardRef}
          onSave={persistence.available ? project.save : undefined}
          onSaveAs={persistence.available ? project.saveAs : undefined}
          onOpenProject={persistence.available ? project.openProject : undefined}
          onOpen={persistence.available ? () => setSceneDlg(true) : undefined}
          onProject={() => setPickDlg(true)}
          onDetach={nr.reference ? () => void onDetach() : undefined}
          onSettings={() => setSettingsDlg(true)}
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
    );
  }

  if (mode === "home") {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <ReferenceHome
          hasSession={items.length > 0}
          onResume={() => setMode("board")}
          onOpen={onOpenScene}
          onNew={() => startNew({})}
          onNewFiles={(files) => startNew({ files })}
          onSettings={() => setSettingsDlg(true)}
          onOpenProject={persistence.available ? project.openProject : undefined}
          onOpenRecent={persistence.available ? project.openRecent : undefined}
          recents={persistence.recentProjects}
        />
        <SceneDialog open={sceneDlg} onOpenChange={setSceneDlg} persistence={persistence} />
        <BoardSettings open={settingsDlg} onOpenChange={setSettingsDlg} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <Toolbar
        board={boardRef}
        onHome={() => setMode("home")}
        onSave={persistence.available ? project.save : undefined}
        onSaveAs={persistence.available ? project.saveAs : undefined}
        onOpen={persistence.available ? () => setSceneDlg(true) : undefined}
        onProject={() => setPickDlg(true)}
        onDetach={nr.reference ? () => void onDetach() : undefined}
        onSettings={() => setSettingsDlg(true)}
        onExport={persistence.available ? () => setExportDlg(true) : undefined}
      />
      <BoardContextMenu
        board={boardRef}
        onHome={() => setMode("home")}
        onSave={persistence.available ? project.save : undefined}
        onSaveAs={persistence.available ? project.saveAs : undefined}
        onOpen={persistence.available ? () => setSceneDlg(true) : undefined}
        onProject={() => setPickDlg(true)}
        onDetach={nr.reference ? () => void onDetach() : undefined}
        onSettings={() => setSettingsDlg(true)}
      >
        <ReferenceBoard ref={boardRef} />
        <Inspector />
        <SequencePlayer />
      </BoardContextMenu>
      <SceneDialog open={sceneDlg} onOpenChange={setSceneDlg} persistence={persistence} />
      <ExportDialog open={exportDlg} onOpenChange={setExportDlg} onExport={persistence.exportBoard} onWeigh={persistence.weigh} />
      <MediaPicker open={pickDlg} onOpenChange={setPickDlg} board={boardRef} />
      <BoardSettings open={settingsDlg} onOpenChange={setSettingsDlg} />
      <CropOverlay />
    </div>
  );
}
