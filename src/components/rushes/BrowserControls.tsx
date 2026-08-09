// Contrôles de navigateur PARTAGÉS (mêmes boutons PARTOUT : Derush, Timeline Live, page Timeline) →
// cohérence garantie. `SortSelect` = tri (Select large, jamais tronqué) ; `FoldersToggle` = bascule
// affichage par dossiers Media Pool.
import { useTranslation } from "react-i18next";
import { ArrowDownUp, FolderTree } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SortOption { value: string; label: string }

// Sélecteur de tri unifié. `min-w` + `whitespace-nowrap` → le libellé n'est jamais coupé.
export function SortSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: SortOption[] }) {
  const { t } = useTranslation("derush");
  return (
    <Select value={value} onValueChange={(v) => onChange(v as string)}>
      <SelectTrigger size="sm" className="w-auto min-w-[9.5rem] gap-1.5 whitespace-nowrap" aria-label={t("browser.sort")}>
        <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// Bascule « Dossiers » unifiée (affichage par dossiers du Media Pool ↔ liste à plat).
export function FoldersToggle({ pressed, onPressedChange }: { pressed: boolean; onPressedChange: (v: boolean) => void }) {
  const { t } = useTranslation("derush");
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Toggle size="sm" variant="outline" pressed={pressed} onPressedChange={onPressedChange}
          className="text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15" />
      }>
        <FolderTree className="size-3.5" /> {t("browser.folders")}
      </TooltipTrigger>
      <TooltipContent>{t("browser.foldersTip")}</TooltipContent>
    </Tooltip>
  );
}

// Options de tri communes aux navigateurs de TIMELINES (page Timeline + Timeline Live).
// `labelKey` = clé i18n (ns « derush ») résolue au rendu par le consommateur.
export const TIMELINE_SORT_DEFS: { value: string; labelKey: string }[] = [
  { value: "az", labelKey: "browser.sortNameAsc" },
  { value: "za", labelKey: "browser.sortNameDesc" },
];
