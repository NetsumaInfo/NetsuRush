// Mark `mediaHl` : surlignage de LIAISON texte ↔ média (façon lien). Déposer un média sur une
// sélection de texte surligne ce texte de la couleur du média ; le clic ouvre un pop-up d'aperçu.
// Sérialisé en `<span class="nr-hl nr-hl-{color}" data-media-id>` — même format que l'ancien
// éditeur (le CSS .nr-hl-* existe déjà), donc les vieux documents surlignés restent lisibles.

import { Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { MEDIA_COLORS } from "../scriptShared";

// Ids de média encore PRÉSENTS dans le document : cartes `mediaCard` (media.id) et croquis
// `storyboard` (blockId — un storyboard se lie au texte par son id de bloc).
function liveIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((n) => {
    if (n.type.name === "mediaCard") {
      const id = (n.attrs.media as { id?: string } | null)?.id;
      if (id) ids.add(id);
    } else if (n.type.name === "storyboard") {
      if (typeof n.attrs.blockId === "string" && n.attrs.blockId) ids.add(n.attrs.blockId);
    }
    return true;
  });
  return ids;
}

export const MediaHlMark = Mark.create({
  name: "mediaHl",
  inclusive: false, // taper au bord du surlignage ne l'étend pas
  excludes: "", // deux liaisons (mediaId différents) peuvent se CHEVAUCHER sur le même texte

  addAttributes() {
    return {
      color: { default: "blue" },
      mediaId: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span.nr-hl",
        getAttrs: (el) => {
          const m = /nr-hl-(\w+)/.exec((el as HTMLElement).className);
          const color = m && (MEDIA_COLORS as string[]).includes(m[1]) ? m[1] : "blue";
          return { color, mediaId: (el as HTMLElement).getAttribute("data-media-id") };
        },
      },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs: Record<string, string> = { class: `nr-hl nr-hl-${mark.attrs.color}` };
    if (mark.attrs.mediaId) attrs["data-media-id"] = String(mark.attrs.mediaId);
    return ["span", mergeAttributes(HTMLAttributes, attrs), 0];
  },

  // Le surlignage vit sur le TEXTE, pas sur la carte : supprimer un média ne l'efface donc pas
  // tout seul — le passage resterait souligné pour un plan disparu. Ce plugin retire les marques
  // ORPHELINES à chaque transaction, quel que soit le chemin de suppression (croix, menu, touche
  // Suppr, couper, glisser hors du doc). Le delete+insert d'un re-drop tient dans UNE transaction
  // → la marque n'est jamais vue orpheline entre les deux.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mediaHlGc"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          const markType = newState.schema.marks.mediaHl;
          if (!markType) return null;
          const live = liveIds(newState.doc);
          const tr = newState.tr;
          let dirty = false;
          newState.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.marks) {
              if (m.type !== markType) continue;
              const id = m.attrs.mediaId ? String(m.attrs.mediaId) : "";
              if (id && !live.has(id)) { tr.removeMark(pos, pos + node.nodeSize, m); dirty = true; }
            }
          });
          return dirty ? tr : null;
        },
      }),
    ];
  },
});
