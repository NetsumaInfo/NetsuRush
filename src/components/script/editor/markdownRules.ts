// Raccourcis markdown : taper « # »/« ## »/« ### » + espace en début de
// ligne convertit CETTE ligne en titre — pendant qu'on écrit, seule cette ligne devient titre.
// UN SEUL niveau par défaut (un script n'a pas besoin de 3 grandeurs : #, ## et ### donnent le
// même titre) ; la préférence multiHeadings rétablit la hiérarchie 1-3. Entrée en fin de titre
// repart en paragraphe. Les listes (`- ` / `1. `) sont gérées nativement par StarterKit.

import { Extension, textblockTypeInputRule } from "@tiptap/core";
import { effectivePrefs } from "../scriptPrefs";
import { useScript } from "../useScript";

export const MarkdownShortcuts = Extension.create({
  name: "markdownShortcuts",

  addInputRules() {
    const heading = this.editor.schema.nodes.heading;
    if (!heading) return [];
    return [
      textblockTypeInputRule({
        find: /^(#{1,3})\s$/,
        type: heading,
        getAttributes: (match) => ({
          level: effectivePrefs(useScript.getState().doc?.settings).multiHeadings ? match[1].length : 2,
        }),
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Entrée en FIN de titre → nouvelle ligne paragraphe (le titre ne se prolonge pas).
      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type.name !== "heading") return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        const at = $from.after();
        return this.editor.chain().insertContentAt(at, { type: "paragraph" }).setTextSelection(at + 1).run();
      },
    };
  },
});
