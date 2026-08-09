import { useTranslation } from "react-i18next";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";
import { Row, Field } from "./procSettingsParts";
import {
  TURBO_DEBAND, TURBO_SHARP, UP_GRAINS, nearestGrain,
  RTX_QUALITIES, RTX_HDR_CONTRAST, RTX_HDR_SATURATION, RTX_HDR_MIDGRAY, RTX_HDR_NITS,
  type UpSettings,
} from "./upscaleShared";

// Réglages experts du panier temps réel. Les deux moteurs n'ont RIEN en commun — libplacebo expose
// des filtres de rendu, le RTX Video SDK expose ses propres paramètres et encode lui-même — d'où deux
// blocs distincts plutôt qu'un panneau qui afficherait des réglages sans effet.

interface Props {
  settings: UpSettings;
  patch: (p: Partial<UpSettings>) => void;
  disabled?: boolean;
}

export function ShaderAdvanced({ settings, patch, disabled }: Props) {
  const { t } = useTranslation("upscale");
  return (
    <div className="space-y-3 border-l border-border pl-3">
      <Row label={t("settings.rowDeband")} hint={t("settings.debandNote")}>
        <Field value={settings.tDeband} disabled={disabled}
          onChange={(v) => patch({ tDeband: v as UpSettings["tDeband"] })}
          items={TURBO_DEBAND.map((d) => ({ value: d.value, label: t(`deband.${d.value}`, { defaultValue: d.label }) }))} />
      </Row>
      {settings.tDeband !== "none" && (
        <>
          <Row label={t("settings.rowGrain")} hint={t("settings.grainNote")}>
            <Field value={String(nearestGrain(settings.tGrain))} disabled={disabled}
              onChange={(v) => patch({ tGrain: Number(v) })}
              items={UP_GRAINS.map((g) => ({ value: String(g.value), label: t(`grain.${g.value}`, { defaultValue: g.label }) }))} />
          </Row>
        </>
      )}
      <Row label={t("settings.rowSharpness")} hint={t("settings.sharpNote")}>
        <ToggleGroup value={[settings.tSharp]} onValueChange={(v) => v[0] && patch({ tSharp: v[0] as UpSettings["tSharp"] })}>
          {TURBO_SHARP.map((s) => <ToggleGroupItem key={s.value} value={s.value} disabled={disabled}>{t(`sharp.${s.value}`, { defaultValue: s.label })}</ToggleGroupItem>)}
        </ToggleGroup>
      </Row>
      <Row label={t("settings.rowAntiRinging")} hint={t("settings.antiRingingNote")}>
        <Toggle pressed={settings.tSigmoid} onPressedChange={(p) => patch({ tSigmoid: p })} disabled={disabled}>
          {settings.tSigmoid ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>
      <Row label={t("settings.rowDither")} hint={t("settings.ditherNote")}>
        <Toggle pressed={settings.tDither} onPressedChange={(p) => patch({ tDither: p })} disabled={disabled}>
          {settings.tDither ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>
    </div>
  );
}

export function RtxAdvanced({ settings, patch, disabled }: Props) {
  const { t } = useTranslation("upscale");
  const steps = (values: number[], unit?: string) =>
    values.map((v) => ({ value: String(v), label: unit ? `${v} ${unit}` : String(v) }));

  return (
    <div className="space-y-3 border-l border-border pl-3">
      <Row label={t("settings.rowVsrQuality")} hint={t("settings.vsrQualityNote")}>
        <ToggleGroup value={[String(settings.rtxQuality)]}
          onValueChange={(v) => v[0] && patch({ rtxQuality: Number(v[0]) as UpSettings["rtxQuality"] })}>
          {RTX_QUALITIES.map((q) => (
            <ToggleGroupItem key={q.value} value={String(q.value)} disabled={disabled}>{q.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Row>

      <Row label={t("settings.rowTrueHdr")} hint={t("settings.trueHdrNote")}>
        <Toggle pressed={settings.rtxHdr} onPressedChange={(p) => patch({ rtxHdr: p })} disabled={disabled}>
          {settings.rtxHdr ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>

      {settings.rtxHdr && (
        <>
          <Row label={t("settings.rowHdrContrast")} hint={t("settings.hdrParamsNote")}>
            <Field value={String(settings.rtxHdrContrast)} disabled={disabled}
              onChange={(v) => patch({ rtxHdrContrast: Number(v) })} items={steps(RTX_HDR_CONTRAST)} />
          </Row>
          <Row label={t("settings.rowHdrSaturation")}>
            <Field value={String(settings.rtxHdrSaturation)} disabled={disabled}
              onChange={(v) => patch({ rtxHdrSaturation: Number(v) })} items={steps(RTX_HDR_SATURATION)} />
          </Row>
          <Row label={t("settings.rowHdrMidGray")}>
            <Field value={String(settings.rtxHdrMidGray)} disabled={disabled}
              onChange={(v) => patch({ rtxHdrMidGray: Number(v) })} items={steps(RTX_HDR_MIDGRAY)} />
          </Row>
          <Row label={t("settings.rowHdrNits")}>
            <Field value={String(settings.rtxHdrNits)} disabled={disabled}
              onChange={(v) => patch({ rtxHdrNits: Number(v) })} items={steps(RTX_HDR_NITS, "nits")} />
          </Row>
        </>
      )}
    </div>
  );
}
