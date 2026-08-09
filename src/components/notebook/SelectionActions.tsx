// Boutons de la barre de mise en forme (sélection de texte) :
// « Copier » (texte sélectionné) et « Copier le lien vers ce passage » (ancre du bloc contenant la
// sélection → nbpage:<pageId>#<blockId>, collable dans n'importe quelle page). Retour visuel bref
// (icône ✓) via état local. S'insèrent dans la FormattingToolbar de NoteEditor.
import { useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import { useComponentsContext, useBlockNoteEditor } from "@blocknote/react";
import { useApp } from "@/store";
import { NBPAGE_LINK_PREFIX } from "./notebookShared";
import i18n from "@/i18n";

// Bloc contenant la sélection (1er bloc sélectionné, sinon bloc du curseur).
function selectionBlockId(editor: any): string | null {
  try {
    const sel = editor.getSelection?.();
    if (sel?.blocks?.length) return sel.blocks[0].id;
    return editor.getTextCursorPosition?.().block?.id ?? null;
  } catch { return null; }
}

export function CopyTextButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const [done, setDone] = useState(false);
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={i18n.t("notebook:finalPass.copy")}
      mainTooltip={i18n.t("notebook:finalPass.copyText")}
      icon={done ? <Check size={18} /> : <Copy size={18} />}
      onClick={() => {
        const text = editor.getSelectedText();
        if (!text) return;
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    />
  );
}

export function CopyAnchorButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const pageId = useApp((s) => s.nbActivePageId);
  const [done, setDone] = useState(false);
  if (!pageId) return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={i18n.t("notebook:finalPass.copyLink")}
      mainTooltip={i18n.t("notebook:finalPass.copyPassageLink")}
      icon={done ? <Check size={18} /> : <Link2 size={18} />}
      onClick={() => {
        const blockId = selectionBlockId(editor);
        if (!blockId) return;
        void navigator.clipboard.writeText(`${NBPAGE_LINK_PREFIX}${pageId}#${blockId}`);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    />
  );
}
