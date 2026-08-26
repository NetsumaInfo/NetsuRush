import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AudioTrack } from "@/lib/bridge";
import {
  INTERP_MODELS, INTERP_FACTORS, INTERP_TARGET_FPS, type InterpSettings as InterpVals,
} from "./processShared";
import { Section, Row, Field, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
import { ModelPicker, useModelOptions } from "./ModelPicker";
import { useTranslation } from "react-i18next";

interface Props {
  settings: InterpVals;
  patch: (p: Partial<InterpVals>) => void;
  audioTracks: AudioTrack[];
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
}

// Panneau de réglages du mode interpolation (RIFE) : modèle, facteur, fps cible optionnel, ralenti,
// puis codec/audio/export partagés.
export function InterpSettings({ settings, patch, audioTracks, outDir, chooseOut, importBack, setImportBack, disabled }: Props) {
  const { t } = useTranslation("upscale");
  const targetOn = settings.targetFps != null;
  const { writesVideo } = useOutputShape(settings);
  const models = useModelOptions(INTERP_MODELS, settings.model);

  return (
    <div className="space-y-5">
      <Section>
        <ModelPicker items={models} value={settings.model} disabled={disabled}
          onChange={(id) => patch({ model: id as InterpVals["model"] })}
          empty={t("modelPicker.emptyInterpolation")} />

        <Row label={t("settings.rowFactor")}>
          <ToggleGroup value={[String(settings.factor)]} onValueChange={(v) => v[0] && patch({ factor: Number(v[0]) as InterpVals["factor"] })}>
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
              items={INTERP_TARGET_FPS.map((f) => ({ value: String(f), label: `${f} fps` }))} />
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
      </Section>

      <ProcessOutputRows v={settings} patch={patch} disabled={disabled} />
      {writesVideo && <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />}
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} v={settings} />
    </div>
  );
}
