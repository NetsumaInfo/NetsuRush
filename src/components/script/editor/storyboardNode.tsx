// Nœud `storyboard` : croquis attaché, rendu comme un MÉDIA du rail GAUCHE (même mécanique que les
// cartes média). LIABLE à une plage de texte comme un plan : le mark mediaHl référence l'id du
// BLOC storyboard — l'item prend la couleur du surlignage (gris tant que rien n'est lié), survol
// bidirectionnel identique. Le dessin s'édite dans un Dialog (StoryboardCanvas), sérialisé dans
// l'attribut `data`. Un storyboard vierge ouvre le Dialog immédiatement.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Brush, Link2, Link2Off, Pencil, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { MediaColor } from "@/lib/bridge";
import { StoryboardCanvas } from "../StoryboardCanvas";
import { StoryboardArtwork } from "../storyboardDocument";
import { mcClass } from "./mediaColors";
import { updateHlMarks } from "./mediaNode";
import { scriptEditorApi } from "./editorApi";

// Couleur du premier surlignage lié à cet id (null = rien de lié). Suivi par abonnement aux
// transactions (la NodeView est réutilisée par ProseMirror — un calcul au render se figerait).
function useLinkColor(editor: Editor, id: string): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const scan = () => {
      const markType = editor.state.schema.marks.mediaHl;
      let c: string | null = null;
      if (markType) {
        editor.state.doc.descendants((node) => {
          if (c || !node.isText) return;
          const m = node.marks.find((mk) => mk.type === markType && mk.attrs.mediaId === id);
          if (m) c = String(m.attrs.color || "blue");
        });
      }
      setColor(c);
    };
    scan();
    const onTx = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) scan(); };
    editor.on("transaction", onTx);
    return () => { editor.off("transaction", onTx); };
  }, [editor, id]);
  return color;
}

function StoryboardView({ node, updateAttributes, deleteNode, editor, selected }: NodeViewProps) {
  const { t } = useTranslation("script");
  const data = (node.attrs.data as string) || "";
  const blockId = (node.attrs.blockId as string) || "";
  const [editing, setEditing] = useState(!data); // vierge → direct en édition
  const wrapRef = useRef<HTMLDivElement>(null);
  const linkColor = useLinkColor(editor, blockId);
  const canLink = !!scriptEditorApi.linkableSelection();

  // Survol → illumine le texte lié (même geste que les plans).
  const linkHighlight = (on: boolean) => {
    if (!blockId) return;
    const root = wrapRef.current?.closest(".ProseMirror");
    root?.querySelectorAll(`.nr-hl[data-media-id="${blockId}"]`).forEach((el) => el.classList.toggle("hl-active", on));
  };

  return (
    <NodeViewWrapper className="nb-media-wrap is-mini side-left nb-storyboard-wrap" data-media-id={blockId} data-drag-handle>
      {/* Clic droit : lier/délier, éditer, supprimer (trigger imbriqué dans celui de la tooltip). */}
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger render={
            <ContextMenuTrigger render={
              <div
                ref={wrapRef}
                className={`media-card is-rail sb-thumb ${linkColor ? `${mcClass(linkColor as MediaColor)} is-linked` : "is-unlinked"} ${selected ? "sel" : ""}`}
                contentEditable={false}
                onClick={() => setEditing(true)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
                onMouseEnter={() => linkHighlight(true)}
                onMouseLeave={() => linkHighlight(false)}
                role="button"
                tabIndex={0}
              >
                <div className="mc-thumb">{data ? <StoryboardArtwork data={data} className="size-full" /> : <Brush className="sb-empty-icon" aria-hidden />}</div>
                <Tooltip>
                  <TooltipTrigger render={<span className="mc-x" role="button" tabIndex={0} aria-label={t("common.delete")} onClick={(e) => { e.stopPropagation(); deleteNode(); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); deleteNode(); } }}>×</span>} />
                  <TooltipContent>{t("common.delete")}</TooltipContent>
                </Tooltip>
              </div>
            } />
          } />
          <TooltipContent>{t("storyboard.clickToDraw")}</TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ContextMenuItem disabled={!canLink} onClick={() => { if (blockId) scriptEditorApi.linkMediaToSelection(blockId, linkColor || "purple"); }}>
            <Link2 /> {t("editor.linkSelectedText")}
          </ContextMenuItem>
          {linkColor && (
            <ContextMenuItem onClick={() => updateHlMarks(editor, blockId, null)}><Link2Off /> {t("storyboard.unlinkText")}</ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => setEditing(true)}><Pencil /> {t("common.edit")}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => deleteNode()}><Trash2 /> {t("common.delete")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={editing} onOpenChange={(o) => { if (!o) setEditing(false); }}>
        <DialogContent className="flex h-[min(82vh,900px)] w-[min(94vw,1560px)] max-w-[min(94vw,1560px)] flex-col gap-4 p-5 sm:max-w-[min(94vw,1560px)]">
          <DialogTitle className="shrink-0">{t("storyboard.title")}</DialogTitle>
          <StoryboardCanvas data={data} onCommit={(d) => updateAttributes({ data: d })} />
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { deleteNode(); }}>{t("common.delete")}</Button>
            <Button size="sm" onClick={() => setEditing(false)}>{t("common.done")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </NodeViewWrapper>
  );
}

export const StoryboardNode = Node.create({
  name: "storyboard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { data: { default: "" } };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="storyboard"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "storyboard" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(StoryboardView);
  },
});
