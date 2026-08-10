// Nœud `divider` : séparateur horizontal entre deux sections — repris du bloc Séparateur du
// Carnet (styles line/dashed/dots/stars). Atome, clic = style suivant. MÉTADONNÉE (exclu du
// minutage/timeline). Persisté : type "divider", style dans block.data.

import { Node, mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";

const DIVIDER_STYLES = ["line", "dashed", "dots", "stars"] as const;
type DividerStyle = (typeof DIVIDER_STYLES)[number];

export const DividerNode = Node.create({
  name: "divider",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { style: { default: "line" } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="nr-divider"]',
        getAttrs: (el) => ({ style: (el as HTMLElement).getAttribute("data-style") || "line" }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = DIVIDER_STYLES.includes(node.attrs.style) ? (node.attrs.style as DividerStyle) : "line";
    const label = style === "dots" ? "···" : style === "stars" ? "✦ ✦ ✦" : "";
    const attrs = mergeAttributes(HTMLAttributes, { "data-type": "nr-divider", "data-style": style, class: `nb-divider is-${style}` });
    const spec: DOMOutputSpec = label ? ["div", attrs, ["span", { class: "nb-divider-label" }, label]] : ["div", attrs, ["hr"]];
    return spec;
  },
});
