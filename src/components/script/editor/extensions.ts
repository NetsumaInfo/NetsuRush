// Liste des extensions Tiptap de l'éditeur Script — extraite de NotebookEditor pour garder le
// composant court. Titres H1-H3 + listes à puces/numérotées sont PERSISTÉS (round-trip serialize +
// colonne `level` SQLite) ; blockquote/code/hr restent désactivés (non sérialisés → perte au reload).
// ⚠ Dev : tout changement ici exige un RELOAD COMPLET de la page (Tiptap ne hot-swap pas ses extensions).

import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { BlockId } from "./blockId";
import { MarkdownShortcuts } from "./markdownRules";
import { CommentNode } from "./commentNode";
import { MediaCardNode } from "./mediaNode";
import { MediaHlMark } from "./highlightMark";
import { StoryboardNode } from "./storyboardNode";
import { TagChips } from "./tagChips";
import { CalloutNode } from "./calloutNode";
import { DividerNode } from "./dividerNode";
import { SectionFold } from "./sectionFold";
import { PageMentionNode } from "./mentionNode";
import { SpellcheckExtension, type SpellPluginOptions } from "@/lib/spell/spellPlugin";
import i18n from "@/i18n";

export function buildScriptExtensions(spell: SpellPluginOptions) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      // Marks non sérialisés (serialize.ts ne gère que bold/italic/underline/strike/mediaHl) :
      // les laisser actifs = perte silencieuse au reload.
      link: false,
      code: false,
    }),
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "heading"
          ? i18n.t("script:editor.headingPlaceholder")
          : node.type.name === "comment"
            ? i18n.t("script:editor.commentPlaceholder")
            : i18n.t("script:editor.textPlaceholder"),
      showOnlyWhenEditable: true,
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    CommentNode,
    MediaCardNode,
    StoryboardNode,
    CalloutNode,
    DividerNode,
    PageMentionNode,
    MediaHlMark,
    BlockId,
    MarkdownShortcuts,
    TagChips,
    SectionFold,
    // Correcteur partagé avec le Carnet : souligne les fautes ET porte les suggestions, que le
    // menu contextuel natif (supprimé partout dans l'app) ne peut plus offrir.
    SpellcheckExtension.configure(spell),
  ];
}
