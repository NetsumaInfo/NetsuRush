import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanFace, Search, Film, AtSign, X, Pencil, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { InlineRename } from "@/components/search/InlineRename";
import { parseMentions, removeMention } from "@/components/search/mentions";

// Rangée de personnages = palette de mentions. Clic = insère/retire « @Nom » dans la requête
// (toggle) puis lance la recherche → les résultats se restreignent au pool de plans du perso, et
// on affine en tapant du texte après. Le perso cité est surligné (miroir de la mention dans le
// texte). Double-clic (ou clic droit → Renommer) = renommage inline. Masquée si roster vide.
export function CharacterChips() {
  const { t } = useTranslation(["search", "common"]);
  const {
    characters, searchByCharacter, filterByCharacter, updateCharacter, deleteCharacter,
    posQuery, setPosQuery, runSearch,
  } = useApp(useShallow((s) => ({
    characters: s.characters, searchByCharacter: s.searchByCharacter, filterByCharacter: s.filterByCharacter,
    updateCharacter: s.updateCharacter, deleteCharacter: s.deleteCharacter,
    posQuery: s.posQuery, setPosQuery: s.setPosQuery, runSearch: s.runSearch,
  })));
  const [renamingId, setRenamingId] = useState<number | null>(null);
  // Un perso sans aucun plan étiqueté dans la portée n'appartient pas au projet affiché : le citer
  // ne ramènerait rien. `scopeShots` null = portée entière → on n'écarte personne.
  const inScope = (c: (typeof characters)[number]) => {
    const shots = c.scopeShots ?? c.scope_shots;
    return shots == null || shots > 0;
  };
  const ready = characters.filter((c) => c.total > 0 && inScope(c));
  if (ready.length === 0) return null;

  const cited = new Set(parseMentions(posQuery, characters).ids);

  function toggleMention(c: { id: number; name: string }) {
    const next = cited.has(c.id)
      ? removeMention(posQuery, c.id, characters)
      : (posQuery.trim() ? posQuery.trim() + " " : "") + "@" + c.name + " ";
    setPosQuery(next);
    void runSearch(next);
  }

  function onChipClick(c: { id: number; name: string }) {
    if (renamingId === c.id) return;
    toggleMention(c);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <span className="text-[11px] text-muted-foreground">{t("characterChips.label")}</span>
      {ready.map((c) => {
        const active = cited.has(c.id);
        return (
          <ContextMenu key={c.id}>
            <ContextMenuTrigger>
              <Tooltip>
                <TooltipTrigger render={<button
                  type="button"
                  onClick={() => onChipClick(c)}
                  onDoubleClick={() => setRenamingId(c.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    active
                      ? "border-primary bg-primary/15 text-primary hover:bg-primary/20"
                      : "border-border bg-card hover:border-primary/50 hover:bg-accent",
                  )} />}>
                  <span className="h-5 w-5 shrink-0 overflow-hidden rounded-full bg-muted" style={c.color ? { boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}>
                    {c.avatar
                      ? <img src={c.avatar} alt="" className="h-full w-full object-cover" />
                      : <ScanFace className="m-1 h-3 w-3 text-muted-foreground" />}
                  </span>
                  {renamingId === c.id ? (
                    <InlineRename
                      value={c.name}
                      onCommit={(name) => { setRenamingId(null); void updateCharacter({ id: c.id, name }); }}
                      onCancel={() => setRenamingId(null)}
                      className="w-24 bg-transparent text-xs outline-none"
                    />
                  ) : (
                    <span className="max-w-28 truncate">{c.name}</span>
                  )}
                  {active && <X className="h-3 w-3 shrink-0" />}
                </TooltipTrigger>
                <TooltipContent>
                  {active
                    ? t("characterChips.citedTooltip", { name: c.name })
                    : t("characterChips.citeTooltip", { name: c.name })}
                </TooltipContent>
              </Tooltip>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => toggleMention(c)}>
                <AtSign /> {active ? t("characterChips.remove", { name: c.name }) : t("characterChips.cite", { name: c.name })}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => searchByCharacter(c.id, c.name)}>
                <Search /> {t("characterChips.searchInRushes")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => filterByCharacter(c.id, c.name)}>
                <Film /> {t("characterChips.recognizedShots")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setRenamingId(c.id)}>
                <Pencil /> {t("characterChips.rename")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => deleteCharacter(c.id)}>
                <Trash2 /> {t("common:action.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
