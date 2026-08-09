// Bloc « Sous-page » : rangée pleine largeur pointant vers une page ENFANT réelle de
// l'arbre (créée par le slash « Sous-page » ou « Transformer en sous-page »). Icône + titre lus EN
// DIRECT dans l'arbre (nbPages) → suivent les renommages. Clic = ouvre la page ; page envoyée à la
// corbeille → rangée grisée « page supprimée ».
import { createReactBlockSpec } from "@blocknote/react";
import { FileText, CornerDownRight } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useApp } from "@/store";
import { renderPageIcon } from "../IconPicker";
import i18n from "@/i18n";

function SubpageView({ pageId }: { pageId: string }) {
  const page = useApp((s) => s.nbPages.find((p) => p.id === pageId));
  const openPage = useApp((s) => s.nbOpenPage);
  if (!page) {
    return (
      <span className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-muted-foreground/60 italic">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0" /> {i18n.t("notebook:tree.deletedSubpage")}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button
          type="button"
          contentEditable={false}
          onClick={() => void openPage(page.id)}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void openPage(page.id, { newTab: true }); } }}
          className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {page.icon ? renderPageIcon(page.icon, "h-4 w-4", "text-sm") : <FileText className="h-4 w-4 text-muted-foreground" />}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium underline decoration-border underline-offset-4">{page.title || i18n.t("notebook:panel.untitled")}</span>
        </button>
      } />
      <TooltipContent>{i18n.t("notebook:subpage.openHint")}</TooltipContent>
    </Tooltip>
  );
}

export const subpageSpec = createReactBlockSpec(
  {
    type: "subpage",
    propSchema: {
      pageId: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => <SubpageView pageId={String(block.props.pageId)} />,
  },
)();
