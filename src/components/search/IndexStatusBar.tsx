import { useTranslation } from "react-i18next";
import { Database, ScanFace } from "lucide-react";
import { RefreshIcon } from "@/components/ui/animated-icons";
import NumberFlow from "@number-flow/react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Props = {
  loading?: boolean;
  warming?: boolean;
  indexed: number;
  frames: number;
  faces?: number;                 // visages indexés (0 = rien → compte masqué)
  indexing: boolean;              // indexation des plans en cours
  facing?: boolean;               // indexation des visages en cours (indépendante)
  pickerOpen?: boolean;           // le sélecteur de plans est ouvert (bouton actif)
  faceIdxPickerOpen?: boolean;    // le sélecteur de visages est ouvert (bouton actif)
  onRefresh: () => void;
  onOpenPicker: () => void;
  onIndexFaces: () => void;
};

// Ligne d'état de l'index : ce que contient la portée courante + les deux entrées d'indexation.
// Volontairement NON collante — c'est du contexte, pas un outil de navigation : elle s'efface au
// défilement pour laisser toute la hauteur aux résultats.
export function IndexStatusBar({
  loading = false, warming = false, indexed, frames, faces = 0, indexing, facing = false,
  pickerOpen = false, faceIdxPickerOpen = false, onRefresh, onOpenPicker, onIndexFaces,
}: Props) {
  const { t } = useTranslation("search");
  const action = "h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {loading ? (
        <span className="inline-flex items-center gap-2"><Spinner className="size-3.5" /> {t("indexStatusBar.loadingData")}</span>
      ) : (
        <span className="tabular-nums">
          <NumberFlow value={indexed} /> {t("indexStatusBar.clips", { count: indexed })}
          <span className="px-1 opacity-40">·</span>
          <NumberFlow value={frames} /> {t("indexStatusBar.plansIndexed", { count: frames })}
          {faces > 0 && (
            <>
              <span className="px-1 opacity-40">·</span>
              <NumberFlow value={faces} /> {t("indexStatusBar.facesCount", { count: faces })}
            </>
          )}
        </span>
      )}
      {warming && !loading && (
        <span className="inline-flex items-center gap-1.5 text-primary">
          <Spinner className="size-3" /> {t("indexProgress.readyingSearch")}
        </span>
      )}

      <div className="flex-1" />

      {/* Infobulles vers le BAS : cette ligne est collée sous la barre de recherche collante, et une
          bulle par défaut (côté haut) s'ouvre PAR-DESSUS elle — ça se lit comme un encart qui
          s'entrouvre dans la barre au simple survol. Sous la ligne, la place est libre. */}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
          onClick={onRefresh} disabled={indexing || facing} aria-label={t("indexStatusBar.refreshTooltip")} />}>
          <RefreshIcon size={13} spinning={loading || indexing || facing} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("indexStatusBar.refreshTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="sm" aria-label={t("indexStatusBar.indexRushAria")} onClick={onOpenPicker} disabled={indexing}
          className={cn(action, pickerOpen && "bg-accent text-foreground")} />}>
          {indexing ? <Spinner className="size-3.5" /> : <Database className="size-3.5" />}
          {indexing ? t("indexStatusBar.indexingPlans") : t("indexStatusBar.index")}
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("indexStatusBar.indexTooltip")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="sm" aria-label={t("indexStatusBar.indexFacesAria")} onClick={onIndexFaces} disabled={facing}
          className={cn(action, faceIdxPickerOpen && "bg-accent text-foreground")} />}>
          {facing ? <Spinner className="size-3.5" /> : <ScanFace className="size-3.5" />}
          {facing ? t("indexStatusBar.indexingFaces") : t("indexStatusBar.faces")}
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("indexStatusBar.indexFacesTooltip")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
