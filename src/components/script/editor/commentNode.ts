// Commentaire de montage (kind `note`) : bloc distinct du paragraphe, EXPORTÉ en marqueur timeline
// (contrairement aux titres). Se comporte comme un paragraphe stylé ; Backspace en tête le repasse en
// paragraphe (géré par le keymap de l'éditeur).

import { Node, mergeAttributes } from "@tiptap/core";

export const CommentNode = Node.create({
  name: "comment",
  group: "block",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="comment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "comment", class: "nb-comment" }), 0];
  },
});
