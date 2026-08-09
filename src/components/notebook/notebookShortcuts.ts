// Raccourcis clavier du module Carnet — rebindables (Paramètres › Raccourcis), même mécanisme que le
// board Référence : SHORTCUT_DEFS = source de vérité, combos sérialisés par comboFromEvent, matchés
// dans un keydown global. Les combos avec Ctrl/Alt marchent MÊME en frappe dans l'éditeur (Ctrl+W…) ;
// les touches nues sont ignorées quand un champ/éditeur a le focus.
import { useEffect } from "react";
import { useApp } from "@/store";
import { comboFromEvent } from "@/components/reference/referenceShared";
import i18n from "@/i18n";

export type NbShortcutAction =
  | "newPage" | "newTab" | "closeTab" | "reopenTab" | "nextTab" | "prevTab"
  | "back" | "forward" | "search" | "settings" | "save" | "trash" | "toggleSidebar";

export const NOTEBOOK_SHORTCUT_DEFS: { action: NbShortcutAction; label: string; combo: string }[] = [
  { action: "newPage", get label() { return i18n.t("notebook:settings.shortcut.newPage"); }, combo: "Ctrl+N" },
  { action: "newTab", get label() { return i18n.t("notebook:settings.shortcut.newTab"); }, combo: "Ctrl+T" },
  { action: "closeTab", get label() { return i18n.t("notebook:settings.shortcut.closeTab"); }, combo: "Ctrl+W" },
  { action: "reopenTab", get label() { return i18n.t("notebook:settings.shortcut.reopenTab"); }, combo: "Ctrl+Shift+T" },
  { action: "nextTab", get label() { return i18n.t("notebook:settings.shortcut.nextTab"); }, combo: "Ctrl+Tab" },
  { action: "prevTab", get label() { return i18n.t("notebook:settings.shortcut.prevTab"); }, combo: "Ctrl+Shift+Tab" },
  { action: "back", get label() { return i18n.t("notebook:settings.shortcut.back"); }, combo: "Alt+ArrowLeft" },
  { action: "forward", get label() { return i18n.t("notebook:settings.shortcut.forward"); }, combo: "Alt+ArrowRight" },
  { action: "search", get label() { return i18n.t("notebook:settings.shortcut.search"); }, combo: "Ctrl+P" },
  { action: "settings", get label() { return i18n.t("notebook:settings.shortcut.settings"); }, combo: "Ctrl+," },
  { action: "save", get label() { return i18n.t("notebook:settings.shortcut.save"); }, combo: "Ctrl+S" },
  { action: "trash", get label() { return i18n.t("notebook:settings.shortcut.trash"); }, combo: "Ctrl+Shift+B" },
  { action: "toggleSidebar", get label() { return i18n.t("notebook:settings.shortcut.toggleSidebar"); }, combo: "Ctrl+\\" },
];

export const DEFAULT_NOTEBOOK_SHORTCUT_KEYS: Record<string, string> =
  Object.fromEntries(NOTEBOOK_SHORTCUT_DEFS.map((d) => [d.action, d.combo]));

// Focus dans un champ de saisie / éditeur ? → les combos SANS modificateur sont ignorés.
function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

// Écouteur global : monté par NotebookPanel. openDialog pilote les modales locales du panneau
// (recherche / paramètres / corbeille) qui vivent hors store.
export function useNotebookShortcuts(openDialog: (which: "search" | "settings" | "trash") => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      const keys = st.nbPrefs.shortcutKeys;
      const combo = comboFromEvent(e);
      const action = (Object.keys(keys) as NbShortcutAction[]).find((a) => keys[a] === combo);
      if (!action) return;
      // Touche nue pendant la frappe → laisser l'éditeur la consommer.
      if (!/Ctrl|Alt/.test(combo) && isTyping(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case "newPage": void st.nbCreatePage(null); break;
        case "newTab": void st.nbCreatePage(null, { newTab: true }); break;
        case "closeTab": if (st.nbActiveTabId) st.nbCloseTab(st.nbActiveTabId); break;
        case "reopenTab": void st.nbReopenTab(); break;
        case "nextTab": st.nbCycleTab(1); break;
        case "prevTab": st.nbCycleTab(-1); break;
        case "back": void st.nbTabBack(); break;
        case "forward": void st.nbTabFwd(); break;
        case "search": openDialog("search"); break;
        case "settings": openDialog("settings"); break;
        case "trash": openDialog("trash"); break;
        case "save": void st.nbFlushPage(); break;
        case "toggleSidebar": st.nbSetPrefs({ sidebarOpen: !st.nbPrefs.sidebarOpen }); break;
      }
    };
    // Phase capture : passe avant BlockNote (Ctrl+S/Ctrl+P sinon avalés ou navigateur).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openDialog]);
}
