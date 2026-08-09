// Menu CLIC DROIT général de l'éditeur Script (sur le texte / un bloc — les médias ont leur propre
// menu). Même patron flottant léger que le menu des cartes média. Contenu contextuel :
//   · sélection de texte → rangée de style (gras/italique/souligné/barré) + « Lier au plan ▸ »
//     (sous-menu des médias déjà posés dans le script, pastille couleur — même liaison que le drag) ;
//   · toujours → « Transformer en ▸ » (types de bloc), Dupliquer/Supprimer le bloc, Ajouter un tag,
//     Attacher un plan/son (ouvre le tiroir Footages de gauche — plus aucun picker à droite).

import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  AudioLines, Bold, CheckSquare, ChevronRight, Copy, Film, Heading, Heading1, Heading2, Heading3,
  Italic, Lightbulb, Link2, List, ListOrdered, MessageSquare, Strikethrough, Tag, Trash2, Type, Underline,
} from "lucide-react";
import type { ScriptBlockMedia } from "@/lib/bridge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { basename } from "@/lib/utils";
import { effectivePrefs } from "../scriptPrefs";
import { useScript } from "../useScript";
import { COLOR_HEX } from "./mediaColors";
import { scriptEditorApi } from "./editorApi";

interface Props {
  editor: Editor;
  x: number;
  y: number;
  onClose: () => void;
  onAttach: () => void; // → tiroir Footages, onglet Vidéos
  onAudio: () => void;  // → tiroir Footages, onglet Audio
  onTag: (at: { left: number; top: number }) => void; // → TagPopup
}

const ITEM = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent";
const SUB = "invisible absolute left-full top-0 z-50 min-w-44 rounded-md bg-popover p-1 shadow-md ring-1 ring-foreground/10 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100";

// Tous les médias posés dans le script (pour « Lier au plan »).
function docMedias(editor: Editor): ScriptBlockMedia[] {
  const out: ScriptBlockMedia[] = [];
  editor.state.doc.descendants((n) => {
    const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
    if (m?.id) out.push(m);
    return true;
  });
  return out;
}

// Bloc de profondeur 1 portant le caret (pour dupliquer/supprimer).
function caretBlock(editor: Editor): { pos: number; node: PMNode } | null {
  const $from = editor.state.selection.$from;
  if ($from.depth < 1) return null;
  const pos = $from.before(1);
  const node = editor.state.doc.nodeAt(pos);
  return node ? { pos, node } : null;
}

export function EditorContextMenu({ editor, x, y, onClose, onAttach, onAudio, onTag }: Props) {
  const { t } = useTranslation("script");
  const run = (fn: () => void) => () => { fn(); onClose(); };
  const block = (type: string, attrs?: Record<string, unknown>) => run(() => editor.chain().focus().setNode(type, attrs).run());
  const active = (type: string, attrs?: Record<string, unknown>) => editor.isActive(type, attrs);
  const hasSelection = !editor.state.selection.empty;
  const medias = hasSelection ? docMedias(editor) : [];

  const multiHeadings = effectivePrefs(useScript.getState().doc?.settings).multiHeadings;
  const headingItems: Array<{ label: string; icon: React.ReactNode; on: () => void; active: boolean }> = multiHeadings
    ? [
        { label: t("editor.heading1"), icon: <Heading1 className="size-4" />, on: block("heading", { level: 1 }), active: active("heading", { level: 1 }) },
        { label: t("editor.heading2"), icon: <Heading2 className="size-4" />, on: block("heading", { level: 2 }), active: active("heading", { level: 2 }) },
        { label: t("editor.heading3"), icon: <Heading3 className="size-4" />, on: block("heading", { level: 3 }), active: active("heading", { level: 3 }) },
      ]
    : [{ label: t("editor.heading"), icon: <Heading className="size-4" />, on: block("heading", { level: 2 }), active: active("heading") }];

  const transforms: Array<{ label: string; icon: React.ReactNode; on: () => void; active: boolean }> = [
    { label: t("editor.text"), icon: <Type className="size-4" />, on: block("paragraph"), active: active("paragraph") },
    ...headingItems,
    { label: t("editor.bulletList"), icon: <List className="size-4" />, on: run(() => editor.chain().focus().toggleBulletList().run()), active: active("bulletList") },
    { label: t("editor.numberedList"), icon: <ListOrdered className="size-4" />, on: run(() => editor.chain().focus().toggleOrderedList().run()), active: active("orderedList") },
    { label: t("editor.todo"), icon: <CheckSquare className="size-4" />, on: run(() => editor.chain().focus().toggleTaskList().run()), active: active("taskList") },
    { label: t("editor.comment"), icon: <MessageSquare className="size-4" />, on: block("comment"), active: active("comment") },
    { label: t("editor.calloutLabel"), icon: <Lightbulb className="size-4" />, on: block("callout"), active: active("callout") },
  ];

  const marks: Array<{ label: string; icon: React.ReactNode; on: () => void; active: boolean }> = [
    { label: t("editor.bold"), icon: <Bold className="size-4" />, on: run(() => editor.chain().focus().toggleBold().run()), active: active("bold") },
    { label: t("editor.italic"), icon: <Italic className="size-4" />, on: run(() => editor.chain().focus().toggleItalic().run()), active: active("italic") },
    { label: t("editor.underline"), icon: <Underline className="size-4" />, on: run(() => editor.chain().focus().toggleUnderline().run()), active: active("underline") },
    { label: t("editor.strike"), icon: <Strikethrough className="size-4" />, on: run(() => editor.chain().focus().toggleStrike().run()), active: active("strike") },
  ];

  const duplicateBlock = run(() => {
    const b = caretBlock(editor);
    if (!b) return;
    // Copie telle quelle : le plugin BlockId ré-attribue un id neuf au doublon.
    editor.chain().insertContentAt(b.pos + b.node.nodeSize, b.node.toJSON()).focus().run();
  });
  const deleteBlock = run(() => {
    const b = caretBlock(editor);
    if (b) editor.chain().deleteRange({ from: b.pos, to: b.pos + b.node.nodeSize }).focus().run();
  });

  const linkTo = (m: ScriptBlockMedia) => run(() => {
    if (m.id) scriptEditorApi.linkMediaToSelection(m.id, m.color);
  });

  return (
    <>
      <button type="button" aria-label={t("common:action.close")} className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 min-w-52 rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: x, top: y }}
      >
        {hasSelection && (
          <>
            {/* Style du texte sélectionné — rangée compacte d'icônes. */}
            <div className="flex gap-0.5 px-1 py-1">
              {marks.map((m) => (
                <Tooltip key={m.label}>
                  <TooltipTrigger render={
                    <button
                      type="button"
                      className={`flex size-7 items-center justify-center rounded-sm hover:bg-accent ${m.active ? "bg-accent/70 text-foreground" : "text-muted-foreground"}`}
                      onClick={m.on}
                    >
                      {m.icon}
                    </button>
                  } />
                  <TooltipContent>{m.label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            {medias.length > 0 && (
              <div className="group relative">
                  <button type="button" className={ITEM}>
                  <Link2 className="size-4" /> {t("editor.linkSelection")}
                  <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                </button>
                <div className={SUB}>
                  {medias.map((m) => (
                    <button type="button" key={m.id} className={ITEM} onClick={linkTo(m)}>
                      <span className="size-3 shrink-0 rounded-full ring-1 ring-foreground/20" style={{ background: COLOR_HEX[m.color] }} />
                      <span className="max-w-52 truncate">{m.label || basename(m.filePath)}</span>
                      {m.kind === "audio" && <AudioLines className="ml-auto size-3.5 text-muted-foreground" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="my-1 h-px bg-border" />
          </>
        )}

        <div className="group relative">
          <button type="button" className={ITEM}>
            <Type className="size-4" /> {t("editor.transformInto")}
            <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
          </button>
          <div className={SUB}>
            {transforms.map((t) => (
              <button type="button" key={t.label} className={`${ITEM} ${t.active ? "bg-accent/60" : ""}`} onClick={t.on}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className={ITEM} onClick={duplicateBlock}><Copy className="size-4" /> {t("editor.duplicateBlock")}</button>

        <div className="my-1 h-px bg-border" />
        <button type="button" className={ITEM} onClick={run(() => onTag({ left: x, top: y }))}><Tag className="size-4" /> {t("editor.addTag")}</button>
        <button type="button" className={ITEM} onClick={run(onAttach)}><Film className="size-4" /> {t("editor.attachShot")}</button>
        <button type="button" className={ITEM} onClick={run(onAudio)}><AudioLines className="size-4" /> {t("editor.attachSound")}</button>

        <div className="my-1 h-px bg-border" />
        <button type="button" className={`${ITEM} text-destructive hover:bg-destructive/10`} onClick={deleteBlock}>
          <Trash2 className="size-4" /> {t("editor.deleteBlock")}
        </button>
      </div>
    </>
  );
}
