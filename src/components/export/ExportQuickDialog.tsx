// Réglages d'export RAPIDES : petite fenêtre flottante (Dialog) ouverte par l'engrenage du bouton
// d'export. Tout se paramètre ici — choisir/créer/éditer un profil + le bouton de vignette — SANS
// quitter la vue ni recharger (contrairement à la page Paramètres). shadcn flavor Base UI.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Copy, Trash2, Settings2 } from "lucide-react";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { getActiveExportProfile } from "@/features/export/profiles";
import { ProfileEditor } from "./ProfileEditor";
import { ExportProfileIcon } from "./exportIcons";
import { CardActionPicker } from "./CardActionPicker";

// `compact` = engrenage d'une barre d'outils (h-8, moitié droite du duo d'export) ; sans lui,
// gabarit du bouton pleine largeur des panneaux (h-9).
export function ExportQuickDialog({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation(["export", "common"]);
  const [open, setOpen] = useState(false);
  const profiles = useApp((s) => s.exportProfiles);
  const activeId = useApp((s) => s.activeExportProfileId);
  const setActive = useApp((s) => s.setActiveExportProfile);
  const addProfile = useApp((s) => s.addExportProfile);
  const duplicate = useApp((s) => s.duplicateExportProfile);
  const remove = useApp((s) => s.removeExportProfile);

  const active = getActiveExportProfile(profiles, activeId);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="outline" size={compact ? "icon-sm" : "icon"} className={cn("rounded-l-none border-l-0", compact && "text-muted-foreground")} aria-label={t("settings.title")} onClick={() => setOpen(true)} />}
        >
          <Settings2 className={compact ? "size-3.5" : "size-4"} />
        </TooltipTrigger>
        <TooltipContent>{t("settings.title")}</TooltipContent>
      </Tooltip>

      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("settings.title")}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-1.5">
                <Select value={active.id} onValueChange={(v) => setActive(v as string)} items={profiles.map((p) => ({ value: p.id, label: p.name }))}>
                  <SelectTrigger className="flex-1">
                    <SelectValue>
                      <span className="flex items-center gap-2">
                        <ExportProfileIcon profile={active} className="size-4 shrink-0" />
                        <span className="truncate">{active.name}</span>
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline" size="icon" onClick={() => addProfile()} aria-label={t("settings.newProfile")} />}><Plus className="size-4" /></TooltipTrigger>
                  <TooltipContent>{t("settings.new")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline" size="icon" onClick={() => duplicate(activeId)} aria-label={t("settings.duplicateProfile")} />}><Copy className="size-4" /></TooltipTrigger>
                  <TooltipContent>{t("settings.duplicate")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon" disabled={profiles.length <= 1} onClick={() => remove(activeId)} aria-label={t("settings.deleteProfile")} />}><Trash2 className="size-4" /></TooltipTrigger>
                  <TooltipContent>{t("common:action.delete")}</TooltipContent>
                </Tooltip>
              </div>

              <Separator />

              <ProfileEditor profile={active} />

              <Separator />

              <div className="flex items-center justify-between gap-3">
                <span className="text-[0.8125rem] text-muted-foreground">{t("settings.cardButton")}</span>
                <div className="w-[56%] shrink-0"><CardActionPicker /></div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
