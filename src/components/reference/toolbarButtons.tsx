// Buttons both board toolbars can address: identity, label, icon, order. Kept apart from the bar
// itself because two screens read this list — the bar to render what was chosen, the Settings to
// offer the choice.
//
// Render order is THIS LIST's, not the preferences': a toolbar whose layout changes between two
// sessions has to be relearned every time.
//
// What is not in it: pin, detach, reattach. Those three are the WAY OUT of the pinned format —
// making them hideable means allowing someone to end up in a corner window with no way out.

import {
  Type, Frame, Pencil, Clapperboard, SwatchBook, Pipette, LayoutGrid, Magnet, ZoomIn, ZoomOut,
  Maximize, Pause, Undo2, Redo2, MousePointerBan, Settings2, Save, SaveAll, FolderOpen, Share2,
  FilePlus2, Home,
} from "lucide-react";

export type PinnedButtonId =
  | "text" | "frame" | "draw" | "importProject" | "palette" | "extractPalette" | "tidy"
  | "snap" | "zoomOut" | "zoomIn" | "fit" | "freeze"
  | "undo" | "redo" | "mouseThrough" | "settings" | "save" | "saveAs" | "openProject"
  | "share" | "newScene" | "home";

export const PINNED_BUTTONS: { id: PinnedButtonId; labelKey: string; icon: typeof Type }[] = [
  { id: "text", labelKey: "toolbar.addText", icon: Type },
  { id: "frame", labelKey: "toolbar.addFrame", icon: Frame },
  { id: "draw", labelKey: "toolbar.draw", icon: Pencil },
  // Import from the host project (Resolve/Premiere timeline). Only NetsuRush has a host to read.
  { id: "importProject", labelKey: "toolbar.fromProject", icon: Clapperboard },
  { id: "palette", labelKey: "palette.studio.open", icon: SwatchBook },
  { id: "extractPalette", labelKey: "shortcut.extractPalette", icon: Pipette },
  { id: "tidy", labelKey: "shortcut.arrangeDefault", icon: LayoutGrid },
  { id: "snap", labelKey: "toolbar.snap", icon: Magnet },
  { id: "zoomOut", labelKey: "actions.zoomOut", icon: ZoomOut },
  { id: "zoomIn", labelKey: "actions.zoomIn", icon: ZoomIn },
  { id: "fit", labelKey: "actions.fitAll", icon: Maximize },
  { id: "freeze", labelKey: "toolbar.freeze", icon: Pause },
  { id: "undo", labelKey: "actions.undo", icon: Undo2 },
  { id: "redo", labelKey: "actions.redo", icon: Redo2 },
  { id: "mouseThrough", labelKey: "mouseThrough.on", icon: MousePointerBan },
  { id: "settings", labelKey: "actions.settings", icon: Settings2 },
  { id: "save", labelKey: "toolbar.saveScene", icon: Save },
  { id: "saveAs", labelKey: "toolbar.saveAs", icon: SaveAll },
  { id: "openProject", labelKey: "toolbar.openScene", icon: FolderOpen },
  { id: "share", labelKey: "toolbar.share", icon: Share2 },
  { id: "newScene", labelKey: "actions.newScene", icon: FilePlus2 },
  { id: "home", labelKey: "toolbar.home", icon: Home },
];

// Pinned bar by default: enough to place, look and undo. The document (save, open, home) stays in
// the right-click menu, which already carries it.
export const DEFAULT_PINNED_BUTTONS: PinnedButtonId[] = [
  "text", "frame", "draw", "importProject", "palette", "snap", "zoomOut", "zoomIn", "fit", "freeze",
];

// Anchored to the OTHER end by default: what repairs, and what touches the window, away from the
// placing tools.
export const DEFAULT_PINNED_BUTTONS_END: PinnedButtonId[] = ["undo", "redo", "mouseThrough"];

// FULL bar (normal window): same buttons, same two ends, around the project name.
export const DEFAULT_BAR_BUTTONS: PinnedButtonId[] = [
  "home", "text", "frame", "draw", "importProject", "palette", "extractPalette", "tidy",
  "snap", "zoomOut", "zoomIn", "fit", "freeze",
];
export const DEFAULT_BAR_BUTTONS_END: PinnedButtonId[] = [
  "undo", "redo", "newScene", "save", "saveAs", "openProject", "share", "mouseThrough", "settings",
];

// Window edge the pinned bar sits on. Left/right make it vertical.
export type PinnedSide = "top" | "bottom" | "left" | "right";
export const PINNED_SIDES: { id: PinnedSide; labelKey: string }[] = [
  { id: "top", labelKey: "settings.sideTop" },
  { id: "bottom", labelKey: "settings.sideBottom" },
  { id: "left", labelKey: "settings.sideLeft" },
  { id: "right", labelKey: "settings.sideRight" },
];

export function isVerticalSide(side: PinnedSide): boolean {
  return side === "left" || side === "right";
}
