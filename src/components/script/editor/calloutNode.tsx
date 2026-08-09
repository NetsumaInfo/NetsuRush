// Nœud `callout` : encadré coloré avec emoji (note d'intention, avertissement, idée) — repris du
// bloc Encadré du Carnet (DA identique), re-spécifié en nœud Tiptap. Contenu inline éditable.
// MÉTADONNÉE : exclu du minutage, des sous-titres et de la timeline (comme les commentaires //).
// Persisté : type "callout", texte inline dans block.text, {color, emoji} dans block.data (JSON).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Palette du Carnet (DB_COLORS) — mêmes teintes que les encadrés du module notebook.
export const CALLOUT_COLORS: Record<string, string> = {
  blue: "#4f86f7",
  green: "#10b981",
  yellow: "#eab308",
  red: "#ef4444",
  purple: "#a855f7",
  gray: "#8b8f98",
};
const PRESETS = [
  { emoji: "💡", color: "blue", key: "info" },
  { emoji: "✅", color: "green", key: "tip" },
  { emoji: "⚠️", color: "yellow", key: "warning" },
  { emoji: "🚨", color: "red", key: "alert" },
];

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation("script");
  const color = CALLOUT_COLORS[String(node.attrs.color)] ? String(node.attrs.color) : "blue";
  const emoji = String(node.attrs.emoji || "💡");
  const [pick, setPick] = useState(false);
  const hex = CALLOUT_COLORS[color];

  return (
    <NodeViewWrapper
      className="nb-callout"
      style={{
        background: `color-mix(in srgb, ${hex} 9%, transparent)`,
        borderLeft: `3px solid ${hex}`,
      }}
    >
      <button
        type="button"
        className="nb-callout-emoji"
        contentEditable={false}
        aria-label={t("editor.calloutStyle")}
        onClick={(e) => { e.stopPropagation(); setPick((v) => !v); }}
      >
        {emoji}
      </button>
      {pick && (
        <>
          <button type="button" aria-label={t("common:action.close")} className="fixed inset-0 z-40" contentEditable={false} onMouseDown={() => setPick(false)} />
          <div className="nb-callout-pick" contentEditable={false}>
            {PRESETS.map((p) => (
              <Tooltip key={p.key}>
                <TooltipTrigger render={<button
                  type="button"
                  aria-label={t(`editor.callout.${p.key}`)}
                  onClick={() => { updateAttributes({ emoji: p.emoji, color: p.color }); setPick(false); }}
                />}>
                  {p.emoji}
                </TooltipTrigger>
                <TooltipContent>{t(`editor.callout.${p.key}`)}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </>
      )}
      <NodeViewContent className="nb-callout-body" />
    </NodeViewWrapper>
  );
}

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      color: { default: "blue" },
      emoji: { default: "💡" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
        getAttrs: (el) => ({
          color: (el as HTMLElement).getAttribute("data-color") || "blue",
          emoji: (el as HTMLElement).getAttribute("data-emoji") || "💡",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "callout",
        "data-color": String(node.attrs.color),
        "data-emoji": String(node.attrs.emoji),
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
