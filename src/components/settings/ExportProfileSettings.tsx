import { Check, Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProfileEditor } from "@/components/export/ProfileEditor";
import { ExportProfileIcon } from "@/components/export/exportIcons";
import { CardActionPicker } from "@/components/export/CardActionPicker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_EXPORT_PROFILES, getActiveExportProfile, getExportProfileSummary } from "@/features/export/profiles";

export function ExportProfileSettings() {
  const { t } = useTranslation("settings");
  const profiles = useApp((s) => s.exportProfiles);
  const activeId = useApp((s) => s.activeExportProfileId);
  const setActive = useApp((s) => s.setActiveExportProfile);
  const addProfile = useApp((s) => s.addExportProfile);
  const duplicate = useApp((s) => s.duplicateExportProfile);
  const remove = useApp((s) => s.removeExportProfile);
  const restore = useApp((s) => s.restoreDefaultExportProfiles);

  const active = getActiveExportProfile(profiles, activeId);
  const missingPresets = DEFAULT_EXPORT_PROFILES.some((preset) => !profiles.some((p) => p.id === preset.id));

  return (
    <section>
      <h2 className="text-sm font-medium">{t("exportProfiles.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("exportProfiles.subtitle")}</p>

      <div className="mt-4 grid grid-cols-[minmax(0,12rem)_1fr] gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            {profiles.map((profile) => {
              const on = profile.id === activeId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => setActive(profile.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8125rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                  )}
                >
                  <ExportProfileIcon profile={profile} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                  {on && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => addProfile()}><Plus className="size-3.5" /> {t("exportProfiles.new")}</Button>
            <Button variant="outline" size="sm" onClick={() => duplicate(activeId)}><Copy className="size-3.5" /> {t("exportProfiles.duplicate")}</Button>
            <Button variant="ghost" size="icon-sm" disabled={profiles.length <= 1} onClick={() => remove(activeId)} aria-label={t("exportProfiles.deleteAria")}>
              <Trash2 className="size-3.5" />
            </Button>
            {/* Les préréglages livrés avec une mise à jour n'apparaissent pas tout seuls dans une liste
                déjà enregistrée : les greffer d'office ferait revenir ceux supprimés exprès. */}
            {missingPresets && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => restore()}>
                      <RotateCcw className="size-3.5" /> {t("exportProfiles.restore")}
                    </Button>
                  }
                />
                <TooltipContent>{t("exportProfiles.restoreHint")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-lg border border-border p-4">
            <ProfileEditor profile={active} />
            <p className="mt-3 text-[11px] text-muted-foreground">{getExportProfileSummary(active)}</p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-4">
            <div className="min-w-0">
              <span className="block text-[0.8125rem]">{t("exportProfiles.cardButton")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t("exportProfiles.cardButtonHint")}</span>
            </div>
            <div className="w-[44%] shrink-0"><CardActionPicker /></div>
          </div>
        </div>
      </div>
    </section>
  );
}
