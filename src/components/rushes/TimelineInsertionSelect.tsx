import { Layers3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { timelineInsertionOptions, type TimelineInsertionMode } from "@/features/timeline/insertion";
import { cn } from "@/lib/utils";

const HOST_NAMES = { resolve: "DaVinci Resolve", ppro: "Premiere Pro", aeft: "After Effects" } as const;

// État partagé des deux présentations : le mode dépend de l'hôte actif (Resolve n'expose pas les
// mêmes commandes que Premiere), donc la liste des choix aussi.
function useInsertion() {
  const { t } = useTranslation("export");
  const host = useApp((state) => state.activeHost);
  const value = useApp((state) => state.timelineInsertions[host]);
  const setInsertion = useApp((state) => state.setTimelineInsertion);
  const options = timelineInsertionOptions(host);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return {
    options,
    selected,
    label: t("editor.timelineInsertion", { host: HOST_NAMES[host] }),
    pick: (next: TimelineInsertionMode) => setInsertion(host, next),
  };
}

/**
 * Mode d'insertion en icône seule : segment CENTRAL du duo d'export des barres d'outils. Un
 * `SelectTrigger` dessine toujours son chevron, il ne peut pas tenir dans un carré de 32 px —
 * d'où un menu déroulant sur un bouton d'icône, avec le mode courant en infobulle.
 */
export function TimelineInsertionButton({ className }: { className?: string }) {
  const { options, selected, label, pick } = useInsertion();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="icon-sm" aria-label={`${label} : ${selected.label}`} className={cn("text-muted-foreground", className)}>
                  <Layers3 className="size-3.5" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>{`${label} — ${selected.label}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="min-w-48">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuCheckboxItem key={option.value} checked={option.value === selected.value} onClick={() => pick(option.value)}>
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TimelineInsertionSelect({ className }: { className?: string }) {
  const { options, selected, label, pick } = useInsertion();

  return (
    <Select
      value={selected.value}
      onValueChange={(next) => pick(next as TimelineInsertionMode)}
      items={options}
    >
      <SelectTrigger size="sm" className={cn("min-w-0", className)} aria-label={label}>
        <Layers3 className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue>{selected.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
