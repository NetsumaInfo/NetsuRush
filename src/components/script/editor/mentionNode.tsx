// Nœud inline `pageMention` : @mention d'une page du Carnet DANS le script (liens croisés
// script ↔ notes). Chip cliquable → ouvre le Carnet sur la page. MÉTADONNÉE : exclue du minutage,
// des sous-titres et de la timeline (countWords retire les [data-page-id]). Sérialisée
// `<span class="nb-mention" data-page-id data-label>@label</span>` dans le HTML du bloc — les
// rétroliens du Carnet scannent ce motif côté core (backlinks).

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileText } from "lucide-react";
import { useApp } from "@/store";
import { useTranslation } from "react-i18next";

function MentionView({ node }: NodeViewProps) {
  const { t } = useTranslation("script");
  const pageId = String(node.attrs.pageId || "");
  const label = String(node.attrs.label || "page");
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pageId) return;
    useApp.getState().setTab("notebook");
    void useApp.getState().nbOpenPage(pageId);
  };
  return (
    <NodeViewWrapper as="span" className="nb-mention-wrap">
      <button type="button" className="nb-mention" contentEditable={false} onClick={open} aria-label={t("editor.openNotebookPage", { label })}>
        <FileText className="nb-mention-ico" aria-hidden />@{label}
      </button>
    </NodeViewWrapper>
  );
}

export const PageMentionNode = Node.create({
  name: "pageMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: "" },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-page-id]",
        getAttrs: (el) => ({
          pageId: (el as HTMLElement).getAttribute("data-page-id") || "",
          label: (el as HTMLElement).getAttribute("data-label") || (el as HTMLElement).textContent?.replace(/^@/, "") || "",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "nb-mention",
        "data-page-id": String(node.attrs.pageId),
        "data-label": String(node.attrs.label),
      }),
      `@${node.attrs.label}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView);
  },
});
