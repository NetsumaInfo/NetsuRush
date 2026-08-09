// Bloc custom « Encadré » (callout) — fond teinté doux + accent latéral +
// emoji + texte inline. Menu (au survol) : préréglages (Info/Astuce/Attention/Alerte) et couleur de
// fond. createReactBlockSpec renvoie un CRÉATEUR (v0.51) → invoqué pour obtenir le BlockSpec.
import { createReactBlockSpec } from "@blocknote/react";
import i18n from "@/i18n";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Palette } from "lucide-react";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { colorOf, DB_COLORS } from "../notebookShared";

const CALLOUT_COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"] as const;

// Préréglages (emoji + couleur d'un coup).
const PRESETS: { label: string; emoji: string; color: string }[] = [
  { get label() { return i18n.t("notebook:callout.basic"); }, emoji: "📝", color: "gray" },
  { get label() { return i18n.t("notebook:callout.info"); }, emoji: "ℹ️", color: "blue" },
  { get label() { return i18n.t("notebook:callout.tip"); }, emoji: "💡", color: "green" },
  { get label() { return i18n.t("notebook:callout.warning"); }, emoji: "⚠️", color: "yellow" },
  { get label() { return i18n.t("notebook:callout.alert"); }, emoji: "❗", color: "red" },
];

export const calloutSpec = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      color: { default: "blue", values: CALLOUT_COLORS },
      emoji: { default: "💡" },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const key = String(block.props.color);
      const { bg, fg } = colorOf(key);
      const set = (props: { color?: string; emoji?: string }) => editor.updateBlock(block, { type: "callout", props } as never);
      return (
        <div
          className="group relative flex items-start gap-2.5 rounded-lg py-2.5 pl-3 pr-9"
          style={{ background: `color-mix(in srgb, ${bg} 50%, var(--color-surface))`, borderLeft: `3px solid ${bg}`, color: fg }}
        >
          <span contentEditable={false} className="mt-0.5 shrink-0">
            <Tooltip>
              <TooltipTrigger render={
                <DropdownMenu>
                  <DropdownMenuTrigger render={
                    <button type="button" className="select-none text-lg leading-6 hover:scale-110">{String(block.props.emoji)}</button>
                  } />
                  <DropdownMenuContent align="start" className="w-72 p-2">
                    <EmojiPicker onPick={(e) => set({ emoji: e })} heightClass="max-h-64" />
                  </DropdownMenuContent>
                </DropdownMenu>
              } />
              <TooltipContent>{i18n.t("notebook:callout.changeEmoji")}</TooltipContent>
            </Tooltip>
          </span>
          <div ref={contentRef} className="min-w-0 flex-1 py-0.5" />
          {/* Menu couleur / préréglage (au survol) */}
          <div contentEditable={false} className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger render={
                <DropdownMenu>
                  <DropdownMenuTrigger render={<button type="button" className="rounded p-1 opacity-70 hover:bg-foreground/10 hover:opacity-100"><Palette className="h-3.5 w-3.5" /></button>} />
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{i18n.t("notebook:callout.presets")}</DropdownMenuLabel>
                      {PRESETS.map((p) => (
                        <DropdownMenuItem key={p.label} onClick={() => set({ color: p.color, emoji: p.emoji })}>
                          <span className="mr-2">{p.emoji}</span> {p.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{i18n.t("notebook:callout.background")}</DropdownMenuLabel>
                      <div className="grid grid-cols-4 gap-1 px-2 py-1">
                        {DB_COLORS.map((c) => (
                          <Tooltip key={c.key}>
                            <TooltipTrigger render={
                              <button
                                type="button"
                                onClick={() => set({ color: c.key })}
                                className={`h-6 w-6 rounded-md border ${c.key === key ? "border-primary" : "border-transparent"}`}
                                style={{ background: c.bg }}
                              />
                            } />
                            <TooltipContent>{c.label}</TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              } />
              <TooltipContent>{i18n.t("notebook:callout.style")}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      );
    },
  },
)();
