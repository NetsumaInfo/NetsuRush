// Page « Référence » (onglet) : board mood-board + barre d'outils + gestion de scènes +
// inspecteur d'item + sélecteur de rushs/plans du projet.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
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
import { PaletteStudio } from "./PaletteStudio";
import { useBoard } from "./useReferenceBoard";
import { useScenePersistence } from "./useScenePersistence";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { useProjectActions } from "./useProjectActions";
import { useReferencePush } from "./useReferencePush";
import { useAutosave } from "./useAutosave";
import { useUnsavedWarning } from "./useUnsavedWarning";
import { useDeselectOnBlur } from "./useAppFocus";
import { isTouchFirst, onPenSeen, probeDevices } from "./tabletInput";
import { isVerticalSide } from "./toolbarButtons";

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
  // Épinglé (fenêtre principale au-dessus, format coin) → board flottante, barre d'outils réduite.
  const pinned = useApp((s) => s.pinned);
  const pinnedToolbar = useBoard((s) => s.prefs.pinnedToolbar);
  const pinnedSide = useBoard((s) => s.prefs.pinnedSide);
  const togglePinned = useApp((s) => s.togglePinned);
  const touchUi = useBoard((s) => s.prefs.touchUi);
  const bigTargets = useBoard((s) => s.prefs.bigTargets);

  // Identité stable : les actions de document alimentent l'effet clavier, qui se réabonnerait à
  // chaque rendu si ce rappel changeait d'identité.
  const goBoard = useCallback(() => setMode("board"), []);
  const project = useProjectActions(persistence, goBoard);

  const onDetach = async () => {
    await persistence.handoff();
    nr.reference?.detach();
  };

  useBoardShortcuts(boardRef, {
    onSave: project.save,
    onSaveAs: project.saveAs,
    onOpenProject: project.openProject,
    onSettings: () => setSettingsDlg(true),
    onTogglePin: togglePinned,
  });
  useReferencePush(boardRef);
  useAutosave(persistence);
  useUnsavedWarning();
  useDeselectOnBlur();

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

  // Épinglé, c'est le BOARD qui est à l'écran — l'accueil n'y est jamais rendu. On l'enregistre dans
  // `mode`, sinon l'état resté sur "home" ressort au dépinglage et renvoie à l'accueil la planche
  // qu'on vient de manipuler en flottant. Cas courant : l'épinglage est persisté d'un lancement à
  // l'autre, donc `mode` valait encore "home" alors que le board était affiché depuis le démarrage.
  useEffect(() => { if (pinned) setMode("board"); }, [pinned]);

  // Réglages Stylet portés sur <html> : ils touchent des écrans hors board (accueil, dialogues,
  // barre de fenêtre), donc c'est la racine du document qui les porte, pas la planche. `auto` =
  // ce que dit la machine — un stylet déjà vu, ou un tactile sans souris (cf. probeDevices).
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-big-targets", bigTargets);
    const apply = () => {
      const d = probeDevices();
      root.toggleAttribute("data-touch-ui", touchUi === "auto" ? d.penSeen || isTouchFirst(d) : touchUi === "on");
    };
    apply();
    // Le premier contact du stylet est la SEULE façon d'apprendre qu'une tablette est branchée :
    // aucune media query ne la déclare. `auto` bascule donc en cours de session, pas au montage.
    return onPenSeen(apply);
  }, [touchUi, bigTargets]);

  // Ingestion différée : le board n'existe qu'en mode "board" → on attend son montage.
  useEffect(() => {
    if (mode !== "board" || !pending || !boardRef.current) return;
    if (pending.files) boardRef.current.addFiles(pending.files);
    pending.paths?.forEach((p) => boardRef.current?.addPath(p));
    setPending(null);
  }, [mode, pending]);

  // Pinning changes ONLY the window format: it does not navigate. On the home screen one stays on
  // the home screen, on a board one stays on the board — both ways round. Rendering the board
  // unconditionally while pinned sent the user back home on unpinning, because `mode` had stayed
  // on "home" the whole time.
  if (mode === "home") {
    return (
      <div className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", pinned && "nr-shell-bg bg-[var(--color-bg)]")}>
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

  // ONE tree for both formats, pinned included. Two separate trees unmounted the crop overlay and
  // the palette generator on every toggle — an open popup vanished — and flashed the whole page at
  // the exact moment the window changes size.
  //
  // Pinned: the app title bar is the drag area and the toolbar is REDUCED (place, draw, frame,
  // undo) — the document and the way home stay in the right-click menu — and the `pinnedToolbar`
  // setting removes it entirely for a completely bare board.
  //
  // Pinned bar edge: left/right make it vertical, bottom/right put it AFTER the board. The full bar
  // stays on top.
  const vertical = pinned && isVerticalSide(pinnedSide);
  const barAfter = pinned && (pinnedSide === "bottom" || pinnedSide === "right");
  const bar = (!pinned || pinnedToolbar) ? (
    // `key`: the two bars do not hold the same content, so the new one fades in rather than
    // replacing the old one outright while the window changes format.
    <Toolbar
      key={pinned ? "compact" : "full"}
      board={boardRef}
      compact={pinned}
      className="animate-in fade-in duration-200"
      onHome={() => setMode("home")}
      onSave={persistence.available ? project.save : undefined}
      onSaveAs={persistence.available ? project.saveAs : undefined}
      onOpen={persistence.available ? () => setSceneDlg(true) : undefined}
      onProject={() => setPickDlg(true)}
      onDetach={nr.reference ? () => void onDetach() : undefined}
      onSettings={() => setSettingsDlg(true)}
      onExport={!pinned && persistence.available ? () => setExportDlg(true) : undefined}
    />
  ) : null;
  return (
    <div className={cn(
      "relative flex h-full min-h-0 overflow-hidden",
      vertical ? "flex-row" : "flex-col",
      pinned && "nr-shell-bg bg-[var(--color-bg)]",
    )}>
      {!barAfter && bar}
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
        <ReferenceBoard ref={boardRef} onOpenProjectFile={persistence.available ? (p) => void project.openRecent(p) : undefined} />
        <Inspector />
        <SequencePlayer />
      </BoardContextMenu>
      {barAfter && bar}
      <SceneDialog open={sceneDlg} onOpenChange={setSceneDlg} persistence={persistence} />
      <ExportDialog open={exportDlg} onOpenChange={setExportDlg} onExport={persistence.exportBoard} onWeigh={persistence.weigh} />
      <MediaPicker open={pickDlg} onOpenChange={setPickDlg} board={boardRef} />
      <BoardSettings open={settingsDlg} onOpenChange={setSettingsDlg} />
      <CropOverlay />
      {/* Mounted here, beside the board rather than inside the toolbar or the inspector: those
          two re-render and unmount with the selection, and picking images on the board is part
          of using this panel. */}
      <PaletteStudio />
    </div>
  );
}
