// Menu contextuel (clic droit) du board : actions sur l'item visé OU actions générales du board.
// Clic droit sur un item → le sélectionne d'abord (actions item) ; clic droit sur le vide →
// actions board. Partagé par l'onglet et la fenêtre détachée (où il remplace la barre d'outils).

import { useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ImagePlus, Video, Globe, Type, Frame, Film, Pencil, Clapperboard, ZoomIn, ZoomOut, Maximize,
  FilePlus2, Save, SaveAll, FileSymlink, FolderOpen, ClipboardPaste, BoxSelect, Play, Pause, Grid2x2, Square,
  Copy, FlipHorizontal, FlipVertical, Crop, BringToFront, SendToBack, Trash2,
  PictureInPicture2, Minimize2, Home, Pin, Layers, Download, AppWindow, Undo2, Redo2, Settings2,
  FolderSearch,
} from "lucide-react";
import { convertToEmbed, downloadMediaFromEmbed, relocateMissingMedia } from "./boardMediaActions";
import { iconForLink } from "./brandIcons";
import { nr } from "@/lib/bridge";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuCheckboxItem,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useBoard } from "./useReferenceBoard";
import { AddLinkDialog } from "./AddLinkDialog";
import type { BoardHandle } from "./ReferenceBoard";

export function BoardContextMenu({
  board,
  children,
  onSave,
  onSaveAs,
  onOpenProject,
  onOpen,
  onProject,
  onHome,
  onDetach,
  onAttach,
  onSettings,
  pinned,
  onTogglePin,
}: {
  board: RefObject<BoardHandle | null>;
  children: ReactNode;
  onSave?: () => void;
  onSaveAs?: () => void;
  onOpenProject?: () => void;
  onOpen?: () => void;
  onProject?: () => void;
  onHome?: () => void;
  onDetach?: () => void;
  onAttach?: () => void;
  onSettings?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const { t } = useTranslation("reference");
  const item = useBoard((s) => s.items.find((i) => i.id === s.selectedId && s.selectedIds.length === 1) ?? null);
  const hasItems = useBoard((s) => s.items.some((i) => i.kind !== "draw"));
  // Groupable en séquence : ≥2 items image sélectionnés.
  const groupable = useBoard(
    (s) => s.selectedIds.filter((id) => s.items.find((i) => i.id === id)?.kind === "image").length >= 2,
  );
  const frozen = useBoard((s) => s.frozen);
  const drawMode = useBoard((s) => s.drawMode);
  const drawBack = useBoard((s) => s.drawBack);
  const hasDraw = useBoard((s) => s.items.some((i) => i.kind === "draw" && (i.shapes?.length ?? 0) > 0));
  const background = useBoard((s) => s.background);
  const canUndo = useBoard((s) => s.past.length > 0);
  const canRedo = useBoard((s) => s.future.length > 0);
  // Board reçu d'ailleurs : ses rushs référencés sont ailleurs sur le disque de celui qui l'ouvre.
  const missingCount = useBoard((s) => s.items.filter((i) => !!i.missing && i.kind !== "sequence").length);
  const [ytOpen, setYtOpen] = useState(false);

  const store = useBoard.getState;

  // Avant ouverture du menu : sélectionne l'item sous le curseur (ou désélectionne sur le vide).
  const onContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-board-item]");
    const id = el?.getAttribute("data-board-item") ?? null;
    if (id) store().select(id);
    else store().select(null);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="relative min-h-0 flex-1" onContextMenuCapture={onContextMenu}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {item && (
            <>
              <ContextMenuItem onClick={() => store().duplicateItem(item.id)}>
                <Copy /> {t("actions.duplicate")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => store().patchItem(item.id, { flipH: !item.flipH })}>
                <FlipHorizontal /> {t("actions.flipH")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => store().patchItem(item.id, { flipV: !item.flipV })}>
                <FlipVertical /> {t("actions.flipV")}
              </ContextMenuItem>
              {(item.kind === "image" || item.kind === "video") && (
                <ContextMenuItem onClick={() => store().setCropping(item.id)}>
                  <Crop /> {t("actions.crop")}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => store().bringToFront(item.id)}>
                <BringToFront /> {t("actions.bringToFront")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => store().sendToBack(item.id)}>
                <SendToBack /> {t("actions.sendToBack")}
              </ContextMenuItem>
              {(() => {
                const linkUrl =
                  item.kind === "youtube" ? `https://www.youtube.com/watch?v=${item.ref}`
                  : item.kind === "embed" ? item.ref
                  : item.sourceUrl || null;
                if (!linkUrl) return null;
                const LinkIcon = iconForLink(linkUrl);
                return (
                  <ContextMenuItem onClick={() => void nr.openExternal(linkUrl)}>
                    <LinkIcon /> {t("actions.openLink")}
                  </ContextMenuItem>
                );
              })()}
              {item.kind === "embed" && (
                <ContextMenuItem onClick={() => void downloadMediaFromEmbed(item.id)}>
                  <Download /> {item.localMedia ? t("actions.restoreDownload") : t("boardMenu.downloadMedia")}
                </ContextMenuItem>
              )}
              {(item.kind === "image" || item.kind === "video") && item.sourceUrl && (
                <ContextMenuItem onClick={() => convertToEmbed(item.id)}>
                  <AppWindow /> {t("boardMenu.showAsEmbed")}
                </ContextMenuItem>
              )}
              <ContextMenuItem variant="destructive" onClick={() => store().removeItem(item.id)}>
                <Trash2 /> {t("common:action.delete")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          {groupable && (
            <>
              <ContextMenuItem onClick={() => store().groupSequence(store().selectedIds)}>
                <Film /> {t("arrange.groupSequence")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          <ContextMenuSub>
            <ContextMenuSubTrigger><ImagePlus /> {t("common:action.add")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={async () => (await nr.chooseImages())?.forEach((p) => board.current?.addPath(p))}>
                <ImagePlus /> {t("boardMenu.image")}
              </ContextMenuItem>
              <ContextMenuItem onClick={async () => (await nr.chooseFiles())?.forEach((p) => board.current?.addPath(p))}>
                <Video /> {t("boardMenu.video")}
              </ContextMenuItem>
              <ContextMenuItem onClick={async () => { const p = await nr.chooseImages(); if (p?.length) board.current?.addSequence(p); }}>
                <Film /> {t("boardMenu.imageSequence")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setYtOpen(true)}>
                <Globe /> {t("boardMenu.onlineVideo")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => board.current?.addText()}>
                <Type /> {t("boardMenu.text")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => board.current?.addFrame()}>
                <Frame /> {t("boardMenu.frame")}
              </ContextMenuItem>
              {onProject && (
                <ContextMenuItem onClick={onProject}><Clapperboard /> {t("boardMenu.fromProject")}</ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => board.current?.pasteClipboard()}>
            <ClipboardPaste /> {t("boardMenu.paste")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem disabled={!canUndo} onClick={() => store().undo()}>
            <Undo2 /> {t("actions.undo")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!canRedo} onClick={() => store().redo()}>
            <Redo2 /> {t("actions.redo")}
          </ContextMenuItem>
          {missingCount > 0 && (
            <ContextMenuItem onClick={() => void relocateMissingMedia()}>
              <FolderSearch /> {t("boardMenu.relocateMissing", { count: missingCount })}
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem disabled={!hasItems} onClick={() => store().selectAll()}>
            <BoxSelect /> {t("boardMenu.selectAll")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasItems} onClick={() => board.current?.fit()}>
            <Maximize /> {t("actions.fitAll")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => board.current?.zoomBy(1.25)}>
            <ZoomIn /> {t("actions.zoomIn")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => board.current?.zoomBy(0.8)}>
            <ZoomOut /> {t("actions.zoomOut")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuCheckboxItem checked={!frozen} onCheckedChange={() => store().toggleFrozen()}>
            {frozen ? <Play /> : <Pause />} {t("boardMenu.autoplay")}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={background.mode === "dots"}
            onCheckedChange={() => store().setBackground({ mode: background.mode === "dots" ? "solid" : "dots" })}
          >
            {background.mode === "dots" ? <Grid2x2 /> : <Square />} {t("boardMenu.dotBg")}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked={drawMode} onCheckedChange={() => store().setDrawMode(!drawMode)}>
            <Pencil /> {t("boardMenu.drawMode")}
          </ContextMenuCheckboxItem>
          {hasDraw && (
            <ContextMenuCheckboxItem checked={drawBack} onCheckedChange={() => store().setDrawBack(!drawBack)}>
              <Layers /> {t("boardMenu.drawBack")}
            </ContextMenuCheckboxItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={() => store().newScene()}>
            <FilePlus2 /> {t("actions.newScene")}
          </ContextMenuItem>
          {onSave && <ContextMenuItem onClick={onSave}><Save /> {t("common:action.save")}</ContextMenuItem>}
          {onSaveAs && <ContextMenuItem onClick={onSaveAs}><SaveAll /> {t("toolbar.saveAs")}</ContextMenuItem>}
          {onOpenProject && <ContextMenuItem onClick={onOpenProject}><FileSymlink /> {t("boardMenu.openProject")}</ContextMenuItem>}
          {onOpen && <ContextMenuItem onClick={onOpen}><FolderOpen /> {t("boardMenu.openScene")}</ContextMenuItem>}

          {(onHome || onDetach || onAttach || onTogglePin || onSettings) && <ContextMenuSeparator />}
          {onSettings && <ContextMenuItem onClick={onSettings}><Settings2 /> {t("actions.settings")}</ContextMenuItem>}
          {onHome && <ContextMenuItem onClick={onHome}><Home /> {t("boardMenu.backHome")}</ContextMenuItem>}
          {onDetach && <ContextMenuItem onClick={onDetach}><PictureInPicture2 /> {t("actions.detach")}</ContextMenuItem>}
          {onTogglePin && (
            <ContextMenuCheckboxItem checked={!!pinned} onCheckedChange={onTogglePin}>
              <Pin /> {t("boardMenu.alwaysOnTop")}
            </ContextMenuCheckboxItem>
          )}
          {onAttach && <ContextMenuItem onClick={onAttach}><Minimize2 /> {t("actions.attach")}</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>

      <AddLinkDialog board={board} open={ytOpen} onOpenChange={setYtOpen} />
    </>
  );
}
