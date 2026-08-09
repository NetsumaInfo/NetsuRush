// Chips de tags INLINE : décorations ProseMirror (widget en fin de bloc) rendant les tags d'un bloc
// visibles dans le texte — clic = filtre par ce tag, × = retire le tag (mutation VIA l'éditeur,
// sinon la resérialisation écrase). Décorations recalculées seulement quand le doc change ; seuls
// les blocs taggés en portent (coût nul sur un doc sans tags).

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useScript } from "../useScript";
import { scriptEditorApi } from "./editorApi";
import i18n from "@/i18n";

// Types de bloc pouvant porter des tags (miroir de BLOCK_TYPES de blockId.ts, atomes exclus).
const TAGGED_TYPES = new Set(["paragraph", "heading", "comment", "taskItem", "listItem"]);

function chipsWidget(tags: string[], blockId: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "nb-tagchips";
  wrap.contentEditable = "false";
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "nb-tagchip";
    chip.title = i18n.t("script:tags.filter");
    const label = document.createElement("button");
    label.type = "button";
    label.className = "nb-tagchip-label";
    label.textContent = `#${t}`;
    label.onmousedown = (e) => e.preventDefault(); // ne vole pas le caret
    label.onclick = (e) => { e.preventDefault(); useScript.getState().setTagFilter(t); };
    const x = document.createElement("button");
    x.type = "button";
    x.className = "nb-tagchip-x";
    x.textContent = "×";
    x.title = i18n.t("script:tags.remove");
    x.onmousedown = (e) => e.preventDefault();
    x.onclick = (e) => { e.preventDefault(); scriptEditorApi.removeTag(blockId, t); };
    chip.append(label, x);
    wrap.appendChild(chip);
  }
  return wrap;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!TAGGED_TYPES.has(node.type.name)) return;
    const tags = node.attrs.tags as string[] | undefined;
    const blockId = node.attrs.blockId as string | null;
    if (!Array.isArray(tags) || !tags.length || !blockId) return;
    decos.push(
      Decoration.widget(pos + node.nodeSize - 1, () => chipsWidget(tags, blockId), {
        side: 1,
        key: `tags-${blockId}-${tags.join("\u0000")}`,
      }),
    );
  });
  return DecorationSet.create(doc, decos);
}

export const TagChips = Extension.create({
  name: "tagChips",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tagChips"),
        state: {
          init: (_cfg, state) => buildDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) { return this.getState(state); },
        },
      }),
    ];
  },
});
