// Notebook-specific entries of the app-wide text context menu (components/common/TextContextMenu):
// inline formatting, "Turn into" and block actions. The menu itself lives at the app root; the
// editor only registers its root element and a renderer (textMenuExtension).

import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";
import {
  DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { registerTextMenuExtension } from "@/components/common/textMenuExtension";
import { TextMenuSub, TextMenuSubTrigger, TextMenuSubContent } from "@/components/common/TextMenuSub";
import { BLOCK_TYPES } from "./NoteSideMenu";
import { clipboardUrl, isConvertible, stripBlockIds } from "./noteMenuModel";

type Editor = BlockNoteEditor<any, any, any>;

const STYLES: { style: "bold" | "italic" | "underline" | "strike" | "code"; icon: IconComponent }[] = [
  { style: "bold", icon: netsuIconOf("bold") },
  { style: "italic", icon: netsuIconOf("italic") },
  { style: "underline", icon: netsuIconOf("underline") },
  { style: "strike", icon: netsuIconOf("strike") },
  { style: "code", icon: netsuIconOf("code") },
];

// The side menu's text blocks plus the two rich ones. Both keep their own props on a conversion:
// a recoloured callout stays recoloured.
const TURN_INTO: { key: string; type: string; props?: Record<string, boolean | number | string>; icon: IconComponent }[] = [
  ...BLOCK_TYPES,
  { key: "callout", type: "callout", icon: netsuIconOf("callout") },
  { key: "codeBlock", type: "codeBlock", icon: netsuIconOf("code-block") },
];

// A right-click outside the current selection moves the caret under the pointer first, like any
// text editor, so the menu acts on what was clicked.
function placeCaret(editor: Editor, e: MouseEvent) {
  try {
    const view = editor.prosemirrorView;
    if (!view) return;
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (!hit) return;
    const sel = view.state.selection;
    if (!sel.empty && hit.pos >= sel.from && hit.pos <= sel.to) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
  } catch { /* the view can be tearing down */ }
}

// `claims` lets the editor keep a right-click for itself (the spelling panel on a misspelled word).
export function useNoteTextMenu(
  editor: Editor,
  rootRef: RefObject<HTMLElement | null>,
  readOnly: boolean,
  claims?: (e: MouseEvent) => boolean,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return registerTextMenuExtension({
      root,
      readOnly,
      claims,
      prepare: (e) => placeCaret(editor, e),
      // Read-only sheet: there is no caret to select inside, so select the document's content.
      selectAll: readOnly
        ? () => {
          const doc = root.querySelector(".bn-editor");
          if (!doc) return;
          const sel = window.getSelection();
          sel?.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(doc);
          sel?.addRange(range);
        }
        : undefined,
      render: () => <NoteMenuItems editor={editor} />,
    });
  }, [editor, rootRef, readOnly, claims]);
}

interface Snapshot {
  styles: Record<string, unknown>;
  hasSelection: boolean;
  inLink: boolean;
  blocks: { id: string; type: string; props: Record<string, unknown> }[];
}

function snapshot(editor: Editor): Snapshot | null {
  try {
    const cursor = editor.getTextCursorPosition().block;
    const selected = editor.getSelection()?.blocks;
    return {
      styles: editor.getActiveStyles() as Record<string, unknown>,
      hasSelection: !!editor.getSelectedText(),
      inLink: !!editor.getSelectedLinkUrl(),
      blocks: (selected?.length ? selected : [cursor]) as Snapshot["blocks"],
    };
  } catch {
    return null;
  }
}

function NoteMenuItems({ editor }: { editor: Editor }) {
  const { t } = useTranslation("notebook");
  // Frozen when the menu opens: the entries describe the block that was right-clicked.
  const [snap] = useState(() => snapshot(editor));
  if (!snap) return null;
  const { blocks, styles } = snap;
  const convertible = blocks.every((b) => isConvertible(b.type));

  const toggle = (style: (typeof STYLES)[number]["style"]) => {
    editor.focus();
    editor.toggleStyles({ [style]: true } as never);
  };
  const link = async () => {
    let url: string | null = null;
    try { url = clipboardUrl(await navigator.clipboard.readText()); } catch { /* clipboard unreadable */ }
    if (!url) { toast.info(t("menu.linkNeedsUrl")); return; }
    editor.focus();
    editor.createLink(url);
  };
  const turnInto = (item: (typeof TURN_INTO)[number]) => {
    editor.focus();
    editor.transact(() => {
      for (const b of blocks) editor.updateBlock(b.id, { type: item.type, props: item.props } as never);
    });
  };
  const duplicate = () => {
    const last = blocks[blocks.length - 1];
    const copies = blocks.map((b) => stripBlockIds(editor.getBlock(b.id) as never));
    editor.insertBlocks(copies as never, last.id, "after");
  };
  const remove = () => editor.removeBlocks(blocks.map((b) => b.id));
  const move = (dir: "up" | "down") => {
    editor.focus();
    if (dir === "up") editor.moveBlocksUp(); else editor.moveBlocksDown();
  };

  return (
    <>
      <TextMenuSub>
        <TextMenuSubTrigger><NetsuIcon name="bold" /> {t("menu.format")}</TextMenuSubTrigger>
        <TextMenuSubContent>
          {STYLES.map(({ style, icon: Icon }) => (
            <DropdownMenuCheckboxItem key={style} checked={!!styles[style]} onCheckedChange={() => toggle(style)}>
              <Icon className="size-4" /> {t(`menu.${style}`)}
            </DropdownMenuCheckboxItem>
          ))}
          {!snap.inLink && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!snap.hasSelection} onClick={() => void link()}>
                <NetsuIcon name="link-text" /> {t("menu.link")}
              </DropdownMenuItem>
            </>
          )}
        </TextMenuSubContent>
      </TextMenuSub>
      {convertible && (
        <TextMenuSub>
          <TextMenuSubTrigger><NetsuIcon name="change-type" /> {t("sideMenu.changeType")}</TextMenuSubTrigger>
          <TextMenuSubContent>
            {TURN_INTO.map((item) => {
              const Icon = item.icon;
              const on = blocks.length === 1 && blocks[0].type === item.type
                && (item.type !== "heading" || blocks[0].props.level === item.props?.level);
              return (
                <DropdownMenuCheckboxItem key={item.key} checked={on} onCheckedChange={() => turnInto(item)}>
                  <Icon className="size-4" /> {t(`blockTypes.${item.key}`)}
                </DropdownMenuCheckboxItem>
              );
            })}
          </TextMenuSubContent>
        </TextMenuSub>
      )}
      <TextMenuSub>
        <TextMenuSubTrigger><NetsuIcon name="blocks" /> {t("menu.block")}</TextMenuSubTrigger>
        <TextMenuSubContent>
          <DropdownMenuItem onClick={duplicate}><NetsuIcon name="duplicate-block" /> {t("menu.duplicate")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => move("up")}><NetsuIcon name="move-up" /> {t("menu.moveUp")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => move("down")}><NetsuIcon name="move-down" /> {t("menu.moveDown")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={remove}><NetsuIcon name="trash" /> {t("common:action.delete")}</DropdownMenuItem>
        </TextMenuSubContent>
      </TextMenuSub>
    </>
  );
}
