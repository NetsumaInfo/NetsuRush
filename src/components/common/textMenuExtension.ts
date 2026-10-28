// Surfaces that add their own entries to the text context menu (the notebook editor adds formatting
// and block actions). A surface registers its root element; a right-click inside it opens the text menu
// followed by what `render` returns. Module-level on purpose: the menu is mounted once at the app
// root, far from the surface.

import type { ReactNode } from "react";

export interface TextMenuExtension {
  root: HTMLElement;
  /** The surface cannot be edited: the menu offers Copy (and Select all when `selectAll` is set). */
  readOnly: boolean;
  /** The surface handles this right-click itself (e.g. a spelling suggestion): the menu stays out. */
  claims?: (e: MouseEvent) => boolean;
  /** Runs before the menu reads the selection (e.g. move the caret under the pointer). */
  prepare?: (e: MouseEvent) => void;
  /** Select-all of a read-only surface, where there is no field to select inside. */
  selectAll?: () => void;
  /** Extra entries, shown after the text ones. Not called for a read-only surface. */
  render: () => ReactNode;
}

const extensions = new Set<TextMenuExtension>();

export function registerTextMenuExtension(ext: TextMenuExtension): () => void {
  extensions.add(ext);
  return () => { extensions.delete(ext); };
}

export function findTextMenuExtension(target: EventTarget | null): TextMenuExtension | null {
  if (!(target instanceof Node)) return null;
  for (const ext of extensions) if (ext.root.contains(target)) return ext;
  return null;
}
