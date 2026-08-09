// Bloc custom « Bascule » (toggle) repliable — un chevron plie/déplie les blocs ENFANTS (indentés
// sous la bascule). L'état `open` se persiste dans les props ; le masquage des enfants se fait en CSS
// (`.bn-block-outer:has([data-toggle-open="false"]) > … > .bn-block-group`, cf. index.css).
import { createReactBlockSpec } from "@blocknote/react";
import { ChevronRight } from "lucide-react";
import i18n from "@/i18n";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export const toggleSpec = createReactBlockSpec(
  {
    type: "toggle",
    propSchema: {
      open: { default: true },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const open = block.props.open !== false;
      return (
        <div className="flex items-start gap-1" data-toggle-open={open ? "true" : "false"}>
          <Tooltip>
            <TooltipTrigger render={
              <button
                type="button"
                contentEditable={false}
                onClick={() => editor.updateBlock(block, { type: "toggle", props: { open: !open } })}
                className="mt-0.5 shrink-0 select-none rounded p-0.5 text-muted-foreground transition-transform hover:bg-muted"
                style={{ transform: open ? "rotate(90deg)" : "none" }}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            } />
            <TooltipContent>{open ? i18n.t("notebook:blocks.toggle.collapse") : i18n.t("notebook:blocks.toggle.expand")}</TooltipContent>
          </Tooltip>
          <div ref={contentRef} className="min-w-0 flex-1" />
        </div>
      );
    },
  },
)();
