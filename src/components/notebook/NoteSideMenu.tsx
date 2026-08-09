// Menu de la poignée de bloc (⋮⋮) — items par défaut (supprimer, couleurs, en-têtes de table) +
// « Copier le lien du bloc » (ancre `nbpage:<pageId>#<blockId>`, collable dans n'importe quelle
// page → le clic saute au bloc) et « Transformer en sous-page » (le bloc devient une page enfant,
// remplacé par un bloc sous-page).
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  SideMenuController, SideMenu, DragHandleMenu, RemoveBlockItem, BlockColorsItem,
  TableRowHeaderItem, TableColumnHeaderItem,
  useComponentsContext, useBlockNoteEditor, useExtensionState,
} from "@blocknote/react";
import { useApp } from "@/store";
import { NBPAGE_LINK_PREFIX } from "./notebookShared";
import i18n from "@/i18n";
import { CheckSquare2, Heading1, Heading2, Heading3, List, ListOrdered, Pilcrow, Quote, Replace, type LucideIcon } from "lucide-react";

const BLOCK_TYPES: { key: string; type: string; props?: Record<string, boolean | number | string>; icon: LucideIcon }[] = [
  { key: "paragraph", type: "paragraph", icon: Pilcrow },
  { key: "heading1", type: "heading", props: { level: 1, isToggleable: false }, icon: Heading1 },
  { key: "heading2", type: "heading", props: { level: 2, isToggleable: false }, icon: Heading2 },
  { key: "heading3", type: "heading", props: { level: 3, isToggleable: false }, icon: Heading3 },
  { key: "bulletList", type: "bulletListItem", icon: List },
  { key: "numberedList", type: "numberedListItem", icon: ListOrdered },
  { key: "checkList", type: "checkListItem", icon: CheckSquare2 },
  { key: "quote", type: "quote", icon: Quote },
];

function ChangeBlockTypeItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block === undefined || !BLOCK_TYPES.some((item) => item.type === block.type)) return null;

  const changeType = (item: (typeof BLOCK_TYPES)[number]) => {
    const selection = editor.getSelection()?.blocks;
    const supportsChange = (selected: { type: string }) => BLOCK_TYPES.some((candidate) => candidate.type === selected.type);
    const blocks = selection?.some((selected) => selected.id === block.id) && selection.every(supportsChange) ? selection : [block];
    editor.transact(() => {
      for (const selected of blocks) editor.updateBlock(selected, { type: item.type as never, props: item.props as never });
    });
    editor.focus();
  };

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger icon={<Replace className="h-4 w-4" />}>
          {i18n.t("notebook:sideMenu.changeType")}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown" sub>
        {BLOCK_TYPES.map((item) => {
          const Icon = item.icon;
          const selected = item.type === block.type && (!item.props || Object.entries(item.props).every(([key, value]) => block.props[key] === value));
          return (
            <Components.Generic.Menu.Item key={item.key} className="bn-menu-item" checked={selected} icon={<Icon className="h-4 w-4" />} onClick={() => changeType(item)}>
              {i18n.t(`notebook:blockTypes.${item.key}`)}
            </Components.Generic.Menu.Item>
          );
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

// Item custom : copie le lien-ancre du bloc survolé dans le presse-papier.
function CopyBlockLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const pageId = useApp((s) => s.nbActivePageId);
  if (block === undefined || !pageId) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        void navigator.clipboard.writeText(`${NBPAGE_LINK_PREFIX}${pageId}#${block.id}`);
      }}
    >
      {i18n.t("notebook:sideMenu.copyBlockLink")}
    </Components.Generic.Menu.Item>
  );
}

// Item custom : déplace le bloc survolé (ou la sélection) dans une NOUVELLE page enfant, et le
// remplace par un bloc sous-page pointant dessus.
function TurnIntoSubpageItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const createPage = useApp((s) => s.nbCreatePage);
  const pageId = useApp((s) => s.nbActivePageId);
  if (block === undefined || !pageId) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        void (async () => {
          const sel = editor.getSelection()?.blocks;
          const blocks = sel && sel.some((b) => b.id === block.id) ? sel : [block];
          // Titre = début du texte du 1er bloc (repli « Sous-page »).
          const text = blocks.map((b) => Array.isArray(b.content) ? b.content.map((c) => (c as { text?: string }).text || "").join("") : "").join(" ").trim();
          const title = (text.slice(0, 60) || i18n.t("notebook:tree.subpage")).trim();
          const id = await createPage(pageId, { title, blocks: blocks as never[], silent: true });
          if (!id) return;
          editor.replaceBlocks(blocks, [{ type: "subpage", props: { pageId: id } }] as never);
        })();
      }}
    >
      {i18n.t("notebook:sideMenu.turnIntoSubpage")}
    </Components.Generic.Menu.Item>
  );
}

export function NoteSideMenu() {
  return (
    <SideMenuController
      sideMenu={(props) => (
        <SideMenu
          {...props}
          dragHandleMenu={() => (
            <DragHandleMenu>
              <ChangeBlockTypeItem />
              <CopyBlockLinkItem />
              <TurnIntoSubpageItem />
              <RemoveBlockItem>{i18n.t("notebook:dbBasics.delete")}</RemoveBlockItem>
              <BlockColorsItem>{i18n.t("notebook:sideMenu.colors")}</BlockColorsItem>
              <TableRowHeaderItem>{i18n.t("notebook:sideMenu.rowHeader")}</TableRowHeaderItem>
              <TableColumnHeaderItem>{i18n.t("notebook:sideMenu.columnHeader")}</TableColumnHeaderItem>
            </DragHandleMenu>
          )}
        />
      )}
    />
  );
}
