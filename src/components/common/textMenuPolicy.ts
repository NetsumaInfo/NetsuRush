// Pure decisions behind the app-wide text context menu: which menu a right-click opens, and which
// of its entries are shown or greyed. No DOM here, so the rules are unit-tested.

// Field types that behave like text. Sliders, colours and checkboxes have nothing to cut or paste.
export const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

export type TextAction = "cut" | "copy" | "paste" | "pastePlain" | "selectAll";

// Shortcut hints shown beside the entries (key combos are not translated).
export const TEXT_SHORTCUTS: Record<TextAction, string> = {
  cut: "Ctrl+X",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  pastePlain: "Ctrl+Shift+V",
  selectAll: "Ctrl+A",
};

export type MenuOwner = "text" | "selection" | "own" | "none";

export interface MenuContext {
  /** The target is an editable field (input, textarea, contenteditable). */
  editable: boolean;
  /** The target sits inside a surface that carries its own <ContextMenu>. */
  inOwnMenu: boolean;
  /** The target sits inside a registered extension surface (e.g. the notebook editor). */
  extension: boolean;
  /** A text selection exists at the target. */
  selectionHere: boolean;
}

// Which menu a right-click opens. An editable field always gets the text menu, even inside a surface
// that has its own menu: that menu is meant for items, not for the text being typed. Elsewhere
// a surface with its own menu keeps it; a bare surface gets a Copy menu only over a selection.
export function resolveMenu(c: MenuContext): MenuOwner {
  if (c.editable) return "text";
  if (c.extension) return "selection";
  if (c.inOwnMenu) return "own";
  return c.selectionHere ? "selection" : "none";
}

export interface TextTarget {
  field: "input" | "editable" | "none";
  readOnly: boolean;
  /** Password field: its content never goes through the menu. */
  secret: boolean;
  empty: boolean;
  hasSelection: boolean;
  /** The clipboard can be read from here (Paste would work). */
  canPaste: boolean;
  /** Select all works outside a field (read-only note). */
  selectable: boolean;
}

export interface PlanItem { action: TextAction; disabled: boolean }

// Entries of the text menu, in display order, with their disabled state.
export function textMenuPlan(t: TextTarget): PlanItem[] {
  if (t.field === "none") {
    const plan: PlanItem[] = [{ action: "copy", disabled: !t.hasSelection }];
    if (t.selectable) plan.push({ action: "selectAll", disabled: t.empty });
    return plan;
  }
  const plan: PlanItem[] = [];
  const noPaste = t.readOnly || !t.canPaste;
  if (!t.secret) {
    plan.push({ action: "cut", disabled: t.readOnly || !t.hasSelection });
    plan.push({ action: "copy", disabled: !t.hasSelection });
  }
  plan.push({ action: "paste", disabled: noPaste });
  if (t.field === "editable") plan.push({ action: "pastePlain", disabled: noPaste });
  plan.push({ action: "selectAll", disabled: t.empty });
  return plan;
}
