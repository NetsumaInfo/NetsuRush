// Identité stable des blocs. ProseMirror ne garde pas d'id ; on ajoute un attribut global `blockId`
// (+ `tags`) aux nœuds de bloc et un plugin qui, à chaque transaction, attribue un id aux nœuds qui
// en manquent ou en DUPLIQUENT un (un split/copie recopie les attrs → il faut ré-attribuer). Ainsi la
// resérialisation vers le modèle garde des ids stables (sélection, tags, timeline ne churnent pas).

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { uid } from "../scriptShared";

const BLOCK_TYPES = ["paragraph", "heading", "comment", "storyboard", "taskItem", "listItem", "callout", "divider"];

export const BlockId = Extension.create({
  name: "blockId",

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
          tags: {
            default: [],
            parseHTML: (el) => {
              try { return JSON.parse(el.getAttribute("data-tags") || "[]"); } catch { return []; }
            },
            renderHTML: (attrs) => (attrs.tags?.length ? { "data-tags": JSON.stringify(attrs.tags) } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockId"),
        appendTransaction: (_transactions, _oldState, newState) => {
          const seen = new Set<string>();
          let tr = newState.tr;
          let modified = false;
          newState.doc.descendants((node, pos) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return;
            const id = node.attrs.blockId as string | null;
            if (!id || seen.has(id)) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: uid() });
              modified = true;
            } else {
              seen.add(id);
            }
          });
          return modified ? tr : null;
        },
      }),
    ];
  },
});
