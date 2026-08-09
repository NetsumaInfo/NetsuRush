// Paramètres NetsuDraft — DEUX niveaux, UN composant :
//   · mode "global" (accueil) : édite les défauts de l'app (useScriptPrefs, localStorage) ;
//   · mode "doc" (menu ⋯ du document) : édite la SURCHARGE du doc (doc.settings.prefs, partielle,
//     persistée avec le script) — un contrôle modifié écrit l'override, « Suivre les réglages
//     généraux » l'efface. Contrôles : rail (pastille/vignette), surlignage, couleurs,
//     titres, correcteur.

import { Circle, Image, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { MediaColor } from "@/lib/bridge";
import { COLOR_HEX, MEDIA_COLORS } from "./editor/mediaColors";
import { SCRIPT_PREFS_DEFAULT, useScriptPrefs, type ScriptPrefs } from "./scriptPrefs";
import { useScript } from "./useScript";

interface Props {
  mode: "global" | "doc";
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function ScriptSettings({ mode }: Props) {
  const { t } = useTranslation("script");
  const globalPrefs = useScriptPrefs((s) => s.prefs);
  const setGlobal = useScriptPrefs((s) => s.setPrefs);
  const docSettings = useScript((s) => s.doc?.settings ?? null);
  const overrides = (docSettings?.prefs ?? {}) as Partial<ScriptPrefs>;

  const prefs: ScriptPrefs = mode === "doc" ? { ...globalPrefs, ...overrides } : globalPrefs;
  const patch = (p: Partial<ScriptPrefs>) => {
    if (mode === "global") setGlobal(p);
    else useScript.getState().setDocSettings({ prefs: { ...overrides, ...p } });
  };
  const hasOverrides = mode === "doc" && Object.keys(overrides).length > 0;

  return (
    <div className="flex flex-col divide-y divide-border/60">
      {mode === "doc" && (
        <div className="flex items-center justify-between gap-3 pb-2">
          <p className="text-xs text-muted-foreground">
            {t("settings.documentPrefix")} {hasOverrides ? t("settings.overridesGeneral") : t("settings.followsGeneral")}
          </p>
          {hasOverrides && (
            <Button variant="ghost" size="sm" onClick={() => useScript.getState().setDocSettings({ prefs: {} })}>
              <RotateCcw className="size-3.5" /> {t("settings.followGeneral")}
            </Button>
          )}
        </div>
      )}

      <Row label={t("settings.leftRail")} hint={t("settings.leftRailHint")}>
        <ToggleGroup value={[prefs.railStyle]} onValueChange={(v) => v[0] && patch({ railStyle: v[0] as ScriptPrefs["railStyle"] })}>
          <ToggleGroupItem value="dot"><Circle className="size-3.5" /> {t("settings.dot")}</ToggleGroupItem>
          <ToggleGroupItem value="thumb"><Image className="size-3.5" /> {t("settings.thumbnail")}</ToggleGroupItem>
        </ToggleGroup>
      </Row>

      <Row label={t("settings.linkColors")} hint={t("settings.linkColorsHint")}>
        <Toggle pressed={prefs.hlVisible} onPressedChange={(v) => patch({ hlVisible: v })}>
          {prefs.hlVisible ? t("settings.visible") : t("settings.hidden")}
        </Toggle>
      </Row>

      <Row label={t("settings.colorAssignment")} hint={t("settings.colorAssignmentHint")}>
        <ToggleGroup value={[prefs.colorMode]} onValueChange={(v) => v[0] && patch({ colorMode: v[0] as ScriptPrefs["colorMode"] })}>
          <ToggleGroupItem value="auto">{t("settings.auto")}</ToggleGroupItem>
          <ToggleGroupItem value="role">{t("settings.labels")}</ToggleGroupItem>
        </ToggleGroup>
      </Row>

      {prefs.colorMode === "role" && (
        <Row label={t("settings.defaultColor")}>
          <div className="flex gap-1.5">
            {MEDIA_COLORS.map((c: MediaColor) => (
              <Tooltip key={c}>
                <TooltipTrigger render={
                  <button
                    type="button"
                    className="size-5 rounded-full ring-1 ring-foreground/15 transition-transform hover:scale-110"
                    style={{ background: COLOR_HEX[c], outline: c === prefs.defaultColor ? "2px solid var(--foreground)" : "none", outlineOffset: "1px" }}
                    onClick={() => patch({ defaultColor: c })}
                  />
                } />
                <TooltipContent>{t(`settings.colors.${c}`)}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </Row>
      )}

      <Row label={t("settings.multiHeadings")} hint={t("settings.multiHeadingsHint")}>
        <Toggle pressed={prefs.multiHeadings} onPressedChange={(v) => patch({ multiHeadings: v })}>
          {prefs.multiHeadings ? "H1-H3" : t("settings.single")}
        </Toggle>
      </Row>

      <Row label={t("settings.spellcheck")} hint={t("settings.spellcheckHint")}>
        <Toggle pressed={prefs.spellcheck} onPressedChange={(v) => patch({ spellcheck: v })}>
          {prefs.spellcheck ? t("settings.active") : t("settings.off")}
        </Toggle>
      </Row>

      {mode === "global" && (
        <div className="pt-2">
          <Button variant="ghost" size="sm" onClick={() => setGlobal({ ...SCRIPT_PREFS_DEFAULT })}>
            <RotateCcw className="size-3.5" /> {t("settings.resetDefaults")}
          </Button>
        </div>
      )}
    </div>
  );
}
