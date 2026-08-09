import { AlertTriangle, Cpu, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { DetectionModelSelect } from "@/components/rushes/DetectionControls";
import { DetectionAdvancedSettings } from "@/components/rushes/DetectionAdvancedSettings";
import { MAX_PATCHES_CHOICES, VRAM_PROFILES, needsReindex } from "@/lib/searchPerf";
import { CompactSelect, SettingRow } from "./rows";

// Tout ce qui décide de la fabrication de l'index de recherche, dans l'ordre où ça s'applique :
// on découpe le rush en plans, on embed ces plans, puis on accélère ce qui n'est pas SigLIP. Le
// modèle de découpe vivait sous « Médias » alors qu'il commande le même travail — séparés, deux
// réglages qui périment le MÊME index se réglaient depuis deux pages.
// Deux règles tiennent la page : ce qui ne change PAS un vecteur est actif d'office ; ce qui en
// change un le DIT, parce que l'index déjà construit cesse alors d'être reconnu.
export function IndexingSettings() {
  const { t } = useTranslation("settings");
  const cutModel = useApp((s) => s.searchCutModel);
  const setCutModel = useApp((s) => s.setSearchCutModel);
  const perf = useApp((s) => s.searchPerf);
  const setPerf = useApp((s) => s.setSearchPerf);
  const resetPerf = useApp((s) => s.resetSearchPerf);

  return (
    <section className="flex flex-col gap-7">
      <header>
        <h2 className="text-sm font-medium">{t("indexing.title")}</h2>
        <p className="mt-1 max-w-[68ch] text-xs text-muted-foreground">{t("indexing.subtitle")}</p>
      </header>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("indexing.cutTitle")}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DetectionModelSelect model={cutModel} onChange={setCutModel} className="w-56" />
          <DetectionAdvancedSettings model={cutModel} compact />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t("detection.reindexHint")}</p>
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("performance.indexingTitle")}</h3>
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          <SettingRow label={t("performance.shotDecode")} hint={t("performance.shotDecodeHint")}>
            <Toggle className="ml-auto flex" pressed={perf.shotDecode} onPressedChange={(shotDecode) => setPerf({ shotDecode })}>
              <Zap className="size-3.5" />
              {t(perf.shotDecode ? "performance.enabled" : "performance.disabled")}
            </Toggle>
          </SettingRow>
          <SettingRow label={t("performance.vramProfile")} hint={t("performance.vramProfileHint")}>
            <CompactSelect
              value={perf.vramProfile}
              choices={VRAM_PROFILES.map((value) => ({ value, label: t(`performance.vram.${value}`) }))}
              onChange={(vramProfile) => setPerf({ vramProfile })}
            />
          </SettingRow>
          <SettingRow label={t("performance.maxPatches")} hint={t("performance.maxPatchesHint")}>
            <CompactSelect
              value={perf.maxPatches}
              choices={MAX_PATCHES_CHOICES.map((value) => ({
                value,
                label: value === 256 ? t("performance.patchesDefault", { value }) : String(value),
              }))}
              onChange={(maxPatches) => setPerf({ maxPatches })}
            />
          </SettingRow>
        </div>
        {needsReindex(perf) && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive" />
            {t("performance.reindexWarning")}
          </p>
        )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("performance.accelerationTitle")}</h3>
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          <SettingRow label={t("performance.onnxGpu")} hint={t("performance.onnxGpuHint")}>
            <Toggle className="ml-auto flex" pressed={perf.onnxGpu} onPressedChange={(onnxGpu) => setPerf({ onnxGpu })}>
              <Cpu className="size-3.5" />
              {t(perf.onnxGpu ? "performance.enabled" : "performance.disabled")}
            </Toggle>
          </SettingRow>
        </div>
      </div>

      <div className="flex justify-end border-t border-border pt-4">
        <Button variant="ghost" size="sm" onClick={resetPerf}>{t("performance.reset")}</Button>
      </div>
    </section>
  );
}
