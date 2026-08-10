// Repli de SECTION sur les titres (décision produit : remplace le bloc Toggle imbriqué du Carnet,
// le modèle du script est PLAT) : chevron au début de chaque titre → replie tous les blocs jusqu'au
// titre suivant (décorations display:none, le doc ne bouge pas). L'état plié est PERSISTÉ dans
// doc.settings.foldedIds (ids de bloc des titres) — rouvrir le doc restaure le repli.

import { Extension } from "@tiptap/core";
import i18n from "@/i18n";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useScript } from "../useScript";

const KEY = new PluginKey<DecorationSet>("nrSectionFold");
const REFRESH = "nrFoldRefresh";

function toggleFold(headingId: string) {
  const s = useScript.getState();
  const cur = s.doc?.settings?.foldedIds ?? [];
  const next = cur.includes(headingId) ? cur.filter((id) => id !== headingId) : [...cur, headingId];
  s.setDocSettings({ foldedIds: next });
}

function buildDecos(doc: PMNode): DecorationSet {
  const folded = new Set(useScript.getState().doc?.settings?.foldedIds ?? []);
  const decos: Decoration[] = [];
  let hiding = false;
  doc.forEach((node, offset) => {
    if (node.type.name === "heading") {
      const id = typeof node.attrs.blockId === "string" ? node.attrs.blockId : "";
      const isFolded = !!id && folded.has(id);
      hiding = isFolded;
      // Chevron posé en tête du titre (widget, hors du texte).
      decos.push(
        Decoration.widget(
          offset + 1,
          (view) => {
            const btn = document.createElement("button");
            btn.className = `nb-fold-chevron ${isFolded ? "is-folded" : ""}`;
            btn.type = "button";
            btn.contentEditable = "false";
            btn.setAttribute("aria-label", isFolded ? i18n.t("script:editor.expandSection") : i18n.t("script:editor.collapseSection"));
            btn.textContent = "▸";
            btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!id) return;
              toggleFold(id);
              // Le doc ne change pas → forcer la reconstruction des décorations.
              view.dispatch(view.state.tr.setMeta(REFRESH, true));
            };
            return btn;
          },
          { side: -1, key: `fold-${id}-${isFolded ? 1 : 0}` },
        ),
      );
      if (isFolded) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "nb-fold-head" }));
      return;
    }
    if (hiding) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "nb-folded" }));
  });
  return DecorationSet.create(doc, decos);
}

export const SectionFold = Extension.create({
  name: "sectionFold",

  addProseMirrorPlugins() {
    const plugin: Plugin<DecorationSet> = new Plugin({
      key: KEY,
      state: {
        init: (_config, state) => buildDecos(state.doc),
        apply: (tr, old) => (tr.docChanged || tr.getMeta(REFRESH) ? buildDecos(tr.doc) : old),
      },
      props: {
        decorations(state) {
          return KEY.getState(state);
        },
      },
    });
    return [plugin];
  },
});
