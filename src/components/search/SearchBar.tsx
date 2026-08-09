import { useTranslation } from "react-i18next";
import { ImagePlus, Ban, FolderSearch, ScanFace, Users, FolderKanban, Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { SearchIcon } from "@/components/ui/animated-icons";
import { MentionInput } from "@/components/search/MentionInput";
import { cn } from "@/lib/utils";
import type { MentionChar } from "@/components/search/mentions";
import type { SearchScope } from "@/store/search";

type Props = {
  posQuery: string;
  setPosQuery: (v: string) => void;
  searching: boolean;
  canSearch: boolean;
  onSearch: () => void;
  onImage: () => void;
  onRefPicker: () => void;
  onFace: () => void;
  onCharacters: () => void;
  roster: MentionChar[];         // personnages proposés par le sélecteur @ (roster prêt)
  negativeOpen: boolean;         // ligne d'exclusion dépliée
  onToggleNegative: () => void;
  scope: SearchScope;
  scopeLabel: string;            // projet courant, « N projets » ou « Tous les rush »
  scopeLoading?: boolean;
  scopeOpen?: boolean;
  onOpenScope: () => void;
};

// Barre unique de l'onglet Recherche : requête (+ mentions @perso), entrées alternatives (image,
// rush, visage, personnages), exclusion repliable et portée. Hauteur FIXE — c'est elle qui reste
// collée en haut, donc elle ne doit jamais changer de taille pendant le défilement.
export function SearchBar({
  posQuery, setPosQuery, searching, canSearch, onSearch, onImage, onRefPicker, onFace, onCharacters,
  roster, negativeOpen, onToggleNegative, scope, scopeLabel, scopeLoading = false, scopeOpen = false, onOpenScope,
}: Props) {
  const { t } = useTranslation("search");
  const ghost = "text-muted-foreground hover:text-foreground";
  return (
    <div className="flex h-14 items-center gap-1">
      <MentionInput
        bare
        value={posQuery}
        onChange={setPosQuery}
        onSubmit={onSearch}
        roster={roster}
        placeholder={t("searchBar.placeholder")}
      />

      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("searchBar.excludeAria")}
          aria-pressed={negativeOpen} onClick={onToggleNegative}
          className={cn(ghost, negativeOpen && "bg-accent text-foreground")} />}>
          <Ban className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.excludeTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={ghost} aria-label={t("searchBar.searchByImageAria")} onClick={onImage} />}>
          <ImagePlus className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.searchByImageTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={ghost} aria-label={t("searchBar.searchInRushesAria")} onClick={onRefPicker} />}>
          <FolderSearch className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.searchInRushesTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={ghost} aria-label={t("searchBar.faceSearchAria")} onClick={onFace} />}>
          <ScanFace className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.faceSearchTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={ghost} aria-label={t("searchBar.charactersAria")} onClick={onCharacters} />}>
          <Users className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.charactersTooltip")}</TooltipContent>
      </Tooltip>

      <span className="mx-1 h-5 w-px bg-border" aria-hidden />

      {/* Portée : seul élément textuel de la barre — c'est l'état qu'on doit lire d'un coup d'œil. */}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="sm" aria-label={t("projectScope.open")} onClick={onOpenScope}
          className={cn("max-w-48 text-muted-foreground hover:text-foreground", scopeOpen && "bg-accent text-foreground")} />}>
          {scopeLoading ? <Spinner className="size-3.5" />
            : scope === "all" ? <Library className="size-3.5" /> : <FolderKanban className="size-3.5" />}
          <span className="truncate">{scopeLabel}</span>
        </TooltipTrigger>
        <TooltipContent>{t("projectScope.openTooltip")}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger render={<Button size="icon-sm" aria-label={t("searchBar.searchAria")} disabled={!canSearch || searching} onClick={onSearch} />}>
          <SearchIcon loading={searching} />
        </TooltipTrigger>
        <TooltipContent>{t("searchBar.searchTooltip")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
