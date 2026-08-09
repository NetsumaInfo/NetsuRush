// Gouttière de bloc : au survol d'une ligne, deux contrôles flottent à sa gauche —
// « + » (insérer un bloc en dessous) et « ⠿ » (poignée : glisser pour réordonner, cliquer pour le
// menu d'actions). Rendu et positionnement gérés par l'extension officielle Tiptap DragHandle
// (drag natif ProseMirror = réordre fiable). Deux petits pop-up : insérer (types de bloc + médias)
// et actions (transformer / dupliquer / supprimer). Le bloc visé vient de `onNodeChange`.

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plus, GripVertical, Type, Heading1, Heading2, Heading3, MessageSquare, Copy, Trash2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useViewportAnchor } from "@/lib/useViewportAnchor";
import { BlockMenuList } from "../BlockMenu";
import { slashCommands, type SlashCommand } from "../scriptShared";

interface Props {
  editor: Editor;
  onAttachAt: (pos: number) => void; // « + » → Attacher un plan (ouvre le panneau Footages gauche)
  onAudioAt: (pos: number) => void;  // « + » → Attacher un son
}

interface Hovered { pos: number; node: PMNode }
type MenuKind = "insert" | "actions";

// Encombrement des deux menus : sert au calcul de placement (bascule au-dessus du bouton quand il
// n'y a plus la place en dessous) — pas une contrainte de style.
const MENU_SIZE = { insert: { width: 256, height: 288 }, actions: { width: 208, height: 288 } };

// Commandes du « + » : types de bloc + attacher plan/son (pas les actions inline tag/transcript).
// Nœud Tiptap à insérer pour un type de bloc donné.
function nodeForType(id: string): Record<string, unknown> | null {
  switch (id) {
    case "text": return { type: "paragraph" };
    case "heading1": return { type: "heading", attrs: { level: 1 } };
    case "heading2": return { type: "heading", attrs: { level: 2 } };
    case "heading3": return { type: "heading", attrs: { level: 3 } };
    case "bullet": return { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] };
    case "numbered": return { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] };
    case "note": return { type: "comment" };
    case "todo": return { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }] };
    case "storyboard": return { type: "storyboard" };
    default: return null;
  }
}

const TEXTBLOCKS = new Set(["paragraph", "heading", "comment"]);

export function BlockGutter({ editor, onAttachAt, onAudioAt }: Props) {
  const { t } = useTranslation("script");
  const insertCommands = slashCommands().filter((c) => c.type || c.action === "attach" || c.action === "audio");
  const hover = useRef<Hovered | null>(null);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [insertIndex, setInsertIndex] = useState(0);
  // Le menu est ancré au BOUTON, pas à un couple de coordonnées figé : la gouttière vit dans une
  // zone qui défile, et un menu posé en `fixed` sur la position du clic restait planté à l'écran —
  // il finissait par recouvrir la barre du haut et les panneaux voisins.
  const anchor = useRef<HTMLElement | null>(null);
  const getAnchorRect = useCallback(() => anchor.current?.getBoundingClientRect() ?? null, []);
  const position = useViewportAnchor(menu !== null, getAnchorRect, {
    ...MENU_SIZE[menu ?? "actions"],
    gap: 6,
  });

  const openAt = (e: React.MouseEvent, kind: MenuKind) => {
    e.stopPropagation();
    anchor.current = e.currentTarget as HTMLElement;
    setInsertIndex(0);
    setMenu(kind);
  };

  const close = () => setMenu(null);
  const endOfHovered = () => (hover.current ? hover.current.pos + hover.current.node.nodeSize : null);

  const runInsert = (cmd: SlashCommand) => {
    const at = endOfHovered();
    close();
    if (at == null) return;
    if (cmd.action === "attach") { onAttachAt(at); return; }
    if (cmd.action === "audio") { onAudioAt(at); return; }
    const json = cmd.type ? nodeForType(cmd.id) : null;
    if (!json) return;
    editor.chain().insertContentAt(at, json).focus().run();
  };

  const transform = (type: string, attrs?: Record<string, unknown>) => {
    const h = hover.current;
    close();
    if (!h) return;
    editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(h.pos, editor.schema.nodes[type], { ...h.node.attrs, ...attrs }); return true; }).run();
  };

  const duplicate = () => {
    const h = hover.current;
    close();
    if (!h) return;
    editor.chain().insertContentAt(h.pos + h.node.nodeSize, h.node.toJSON()).run();
  };

  const remove = () => {
    const h = hover.current;
    close();
    if (!h) return;
    editor.chain().deleteRange({ from: h.pos, to: h.pos + h.node.nodeSize }).run();
  };

  const canTransform = hover.current && TEXTBLOCKS.has(hover.current.node.type.name);

  return (
    <>
      <DragHandle
        editor={editor}
        className="nb-gutter"
        onNodeChange={({ node, pos }) => { hover.current = node ? { node, pos } : null; }}
      >
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" className="nb-gutter-btn" aria-label={t("editor.insertBlock")} onClick={(e) => openAt(e, "insert")}>
              <Plus aria-hidden />
            </button>
          } />
          <TooltipContent>{t("editor.insertBlock")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" className="nb-gutter-btn nb-gutter-grip" aria-label={t("editor.blockActions")} onClick={(e) => openAt(e, "actions")}>
              <GripVertical aria-hidden />
            </button>
          } />
          <TooltipContent>{t("editor.dragActions")}</TooltipContent>
        </Tooltip>
      </DragHandle>

      {menu && (
        <>
          <button type="button" aria-label={t("common:action.close")} className="fixed inset-0 z-40" onMouseDown={close} />
          <div style={{ position: "fixed", left: position.left, top: position.top, zIndex: 50 }}>
            {menu === "insert" ? (
              <div
                className="w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
                style={{ maxHeight: position.maxHeight }}
              >
                <BlockMenuList commands={insertCommands} activeIndex={insertIndex} onSelect={runInsert} onHover={setInsertIndex} />
              </div>
            ) : (
              <div
                className="w-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
                style={{ maxHeight: position.maxHeight }}
              >
                {canTransform && (
                  <>
                    <div className="px-2.5 py-1 text-xs text-muted-foreground">{t("editor.transformInto")}</div>
                    <GutterAction icon={Type} label={t("slash.text.label")} onClick={() => transform("paragraph")} />
                    <GutterAction icon={Heading1} label={t("editor.heading1")} onClick={() => transform("heading", { level: 1 })} />
                    <GutterAction icon={Heading2} label={t("editor.heading2")} onClick={() => transform("heading", { level: 2 })} />
                    <GutterAction icon={Heading3} label={t("editor.heading3")} onClick={() => transform("heading", { level: 3 })} />
                    <GutterAction icon={MessageSquare} label={t("editor.comment")} onClick={() => transform("comment")} />
                    <div className="my-1 h-px bg-border" />
                  </>
                )}
                <GutterAction icon={Copy} label={t("common.duplicate")} onClick={duplicate} />
                <GutterAction icon={Trash2} label={t("common.delete")} danger onClick={remove} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function GutterAction({ icon: Icon, label, onClick, danger }: { icon: typeof Type; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-accent hover:text-accent-foreground"}`}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1">{label}</span>
    </button>
  );
}
