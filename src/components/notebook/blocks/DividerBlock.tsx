// Bloc custom « Séparateur » : ligne horizontale avec 4 styles (ligne / tirets / points / étoiles),
// cyclés au clic (bouton discret au survol). Persisté dans la prop `style`.
import { createReactBlockSpec } from "@blocknote/react";
import i18n from "@/i18n";
import { SlidersHorizontal } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const STYLES = ["line", "dashed", "dots", "stars"] as const;
type DividerStyle = (typeof STYLES)[number];

function Divider({ style, onCycle }: { style: DividerStyle; onCycle: () => void }) {
  return (
    <div className="group/div relative flex w-full items-center py-2" contentEditable={false}>
      {style === "dots" ? (
        <span className="w-full text-center text-lg leading-none tracking-[1em] text-muted-foreground/60 select-none">···</span>
      ) : style === "stars" ? (
        <span className="w-full text-center text-sm leading-none tracking-[1.2em] text-muted-foreground/60 select-none">✦ ✦ ✦</span>
      ) : (
        <hr className={`w-full border-t ${style === "dashed" ? "border-dashed" : ""} border-border`} />
      )}
      <Tooltip>
        <TooltipTrigger render={
          <button
            type="button"
            onClick={onCycle}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover/div:opacity-100"
            aria-label={i18n.t("notebook:blocksUi.changeDivider")}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        } />
        <TooltipContent>{i18n.t("notebook:blocksUi.changeDivider")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export const dividerSpec = createReactBlockSpec(
  {
    type: "divider",
    propSchema: { style: { default: "line", values: STYLES as unknown as string[] } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const cur = (STYLES.includes(block.props.style as DividerStyle) ? block.props.style : "line") as DividerStyle;
      const next = STYLES[(STYLES.indexOf(cur) + 1) % STYLES.length];
      return <Divider style={cur} onCycle={() => editor.updateBlock(block, { type: "divider", props: { style: next } } as never)} />;
    },
  },
)();
