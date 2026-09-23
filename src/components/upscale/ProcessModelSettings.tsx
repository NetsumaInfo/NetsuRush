// MODEL rows of the hub ops, without the output / encoding / export blocks that surround them in the
// Traitements panel. Twin of `UpscaleModelSettings` for interpolation and depth: an export profile
// already carries its codec, its container and its destination, so it can only reuse this part —
// and reusing it is the point, since a copy would drift at the first option added.
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTranslation } from "react-i18next";
import { Row, Field } from "./procSettingsParts";
import { ModelPicker, useModelOptions } from "./ModelPicker";
import { fmtFps } from "@/lib/utils";
import {
  INTERP_MODELS, INTERP_FACTORS, INTERP_TARGET_FPS, DEPTH_MODELS, DEPTH_COLORS,
  type InterpSettings, type DepthSettings,
} from "./processShared";

export function InterpModelSettings({ settings, patch, disabled }: {
  settings: InterpSettings;
  patch: (p: Partial<InterpSettings>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const targetOn = settings.targetFps != null;
  const models = useModelOptions(INTERP_MODELS, settings.model);

  return (
    <>
      <ModelPicker items={models} value={settings.model} disabled={disabled}
        onChange={(id) => patch({ model: id as InterpSettings["model"] })}
        empty={t("modelPicker.emptyInterpolation")} />

      <Row label={t("settings.rowFactor")}>
        <ToggleGroup value={[String(settings.factor)]} onValueChange={(v) => v[0] && patch({ factor: Number(v[0]) as InterpSettings["factor"] })}>
          {INTERP_FACTORS.map((f) => <ToggleGroupItem key={f} value={String(f)} disabled={disabled}>{f}×</ToggleGroupItem>)}
        </ToggleGroup>
      </Row>

      <Row label={t("settings.rowTargetFps")}>
        <Toggle
          pressed={targetOn}
          onPressedChange={(on) => patch({ targetFps: on ? INTERP_TARGET_FPS[2] : null })}
          disabled={disabled}
        >
          {targetOn ? t("settings.yes") : t("settings.targetFpsFactorOnly")}
        </Toggle>
      </Row>
      {targetOn && (
        <Row label={t("settings.rowFps")}>
          <Field value={String(settings.targetFps)} disabled={disabled}
            onChange={(v) => patch({ targetFps: Number(v) })}
            items={INTERP_TARGET_FPS.map((f) => ({ value: String(f), label: fmtFps(f) }))} />
        </Row>
      )}

      <Row label={t("settings.rowSlowmo")}>
        <Toggle pressed={settings.slowmo} onPressedChange={(on) => patch({ slowmo: on })} disabled={disabled}>
          {settings.slowmo ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>

      <Row label={t("settings.rowDeadFrames")}>
        <Toggle pressed={settings.dedup} onPressedChange={(on) => patch({ dedup: on })} disabled={disabled}>
          {settings.dedup ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>
    </>
  );
}

export function DepthModelSettings({ settings, patch, disabled }: {
  settings: DepthSettings;
  patch: (p: Partial<DepthSettings>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const models = useModelOptions(DEPTH_MODELS, settings.model);

  return (
    <>
      <ModelPicker items={models} value={settings.model} disabled={disabled}
        onChange={(id) => patch({ model: id as DepthSettings["model"] })}
        empty={t("modelPicker.emptyDepth")} />

      <Row label={t("settings.rowColormap")}>
        <Field value={settings.colormap} disabled={disabled}
          onChange={(v) => patch({ colormap: v as DepthSettings["colormap"] })}
          items={DEPTH_COLORS.map((c) => ({ value: c.id, label: t(`depthColor.${c.id}`, { defaultValue: c.label }) }))} />
      </Row>

      <Row label={t("settings.rowDeadFrames")}>
        <Toggle pressed={settings.dedup} onPressedChange={(on) => patch({ dedup: on })} disabled={disabled}>
          {settings.dedup ? t("settings.deadFramesRemove") : t("settings.deadFramesKeep")}
        </Toggle>
      </Row>
    </>
  );
}
