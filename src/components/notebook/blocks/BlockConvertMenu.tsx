// Menu « Convertir en » d'un bloc média (youtube / embed / signet).
// Bouton discret en haut à droite (visible au survol du bloc) → change la forme du lien en réutilisant
// son url (Mention / Lien / Signet / Intégration). Logique dans notebookPaste (convertBlockTo).
import type { BlockNoteEditor } from "@blocknote/core";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";
import i18n from "@/i18n";
import { LINK_AS_OPTIONS, convertBlockTo, type LinkAs } from "../notebookPaste";

const ICONS: Record<LinkAs, IconComponent> = { mention: netsuIconOf("mention"), url: netsuIconOf("link"), bookmark: netsuIconOf("bookmark"), embed: netsuIconOf("web") };

export function BlockConvertMenu({ editor, block, url }: { editor: BlockNoteEditor<any, any, any>; block: unknown; url: string }) {
  return (
    <div contentEditable={false} onClick={(e) => e.stopPropagation()} className="absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <button type="button" className="rounded bg-background/80 p-1 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
                    <NetsuIcon name="repeat" className="h-3.5 w-3.5" />
                  </button>
                }
              />
            }
          />
          <TooltipContent>{i18n.t("notebook:finalPass.convertOptions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{i18n.t("notebook:finalPass.convertTo")}</DropdownMenuLabel>
            {LINK_AS_OPTIONS.map((o) => {
              const Icon = ICONS[o.key];
              return (
                <DropdownMenuItem key={o.key} onClick={() => convertBlockTo(editor, block, url, o.key)}>
                  <Icon className="mr-2 h-3.5 w-3.5" /> {o.label}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem className="text-destructive" onClick={() => editor.removeBlocks([block as never])}>
              <NetsuIcon name="trash" className="mr-2 h-3.5 w-3.5" /> {i18n.t("notebook:dbBasics.delete")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
